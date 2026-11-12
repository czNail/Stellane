import { readFile, stat } from 'node:fs/promises';
import { Client, type ClientConfig, type QueryResult } from 'pg';
import type { Cell, ConnectionInput, DatabaseTarget, QueryInput, QueryPreview } from '../shared/models.ts';

export interface QueryProvider {
  probe(connection: ConnectionInput, signal: AbortSignal): Promise<DatabaseTarget>;
  query(connection: ConnectionInput, input: QueryInput, signal: AbortSignal): Promise<QueryPreview>;
}
class PreviewLimitError extends Error {}

export async function secret(reference: string): Promise<string> {
  if (reference.startsWith('env:')) {
    const value = process.env[reference.slice(4)];
    if (!value) throw new Error('指定的密码环境变量尚未配置。');
    return value;
  }
  const filename = reference.slice(5);
  const info = await stat(filename).catch(() => { throw new Error('密码引用文件无法读取。'); });
  if (!info.isFile() || info.size > 8192 || (info.mode & 0o077) !== 0) {
    throw new Error('密码文件须为不超过 8 KiB、仅当前用户可访问的普通文件（权限 600）。');
  }
  const value = (await readFile(filename, 'utf8')).trimEnd();
  if (!value) throw new Error('密码引用文件为空。');
  return value;
}

export function publicError(error: unknown): Error {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
  return new Error(code && /^[A-Z0-9_]{2,40}$/.test(code)
    ? `数据库操作失败（${code}），请检查连接、权限或查询。`
    : '数据库连接或查询失败，请检查配置、密码引用及网络。');
}

function cell(value: unknown): Cell {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return `[binary: ${value.byteLength} bytes]`;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (Array.isArray(value)) return value.map(cell);
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cell(item)]));
  return String(value);
}

export class PostgresProvider implements QueryProvider {
  private async withClient<T>(connection: ConnectionInput | ClientConfig, signal: AbortSignal, work: (client: Client) => Promise<T>, timeout = 7000): Promise<T> {
    signal.throwIfAborted();
    const options: ClientConfig = 'passwordRef' in connection ? {
      host: connection.host, port: connection.port, database: connection.database,
      user: connection.user, password: await secret(connection.passwordRef),
      ssl: connection.tls === 'verify-full' ? { rejectUnauthorized: true } : false,
    } : connection;
    const client = new Client({
      ...options,
      connectionTimeoutMillis: 5000, query_timeout: timeout,
      application_name: 'stellane',
    });
    client.on('error', () => {});
    const abort = () => { void client.end().catch(() => {}); };
    signal.addEventListener('abort', abort, { once: true });
    try {
      signal.throwIfAborted();
      await client.connect();
      signal.throwIfAborted();
      return await work(client);
    } catch (error) {
      if (signal.aborted) throw new Error('查询已取消。');
      if (error instanceof WriteOutcomeError) throw error;
      if (error instanceof PreviewLimitError) throw error;
      throw publicError(error);
    } finally {
      signal.removeEventListener('abort', abort);
      await client.end().catch(() => {});
    }
  }
  private async target(client: Client): Promise<DatabaseTarget> {
    const response = await client.query(`SELECT current_database() AS database, current_user AS "user",
      inet_server_addr()::text AS address, inet_server_port() AS port`);
    return response.rows[0] as DatabaseTarget;
  }
  probe(connection: ConnectionInput, signal: AbortSignal): Promise<DatabaseTarget> {
    return this.withClient(connection, signal, client => this.target(client));
  }
  async query(connection: ConnectionInput | ClientConfig, input: QueryInput, signal: AbortSignal): Promise<QueryPreview> {
    return this.withClient(connection, signal, async client => {
      await client.query('BEGIN READ ONLY');
      await client.query('SET LOCAL statement_timeout = 5000');
      await client.query('SET LOCAL idle_in_transaction_session_timeout = 5000');
      const target = await this.target(client);
      // Extended protocol rejects multiple commands, including transaction escapes.
      // The outer limit bounds preview rows without truncating the stored input SQL.
      const sql = input.sql.trim().replace(/;\s*$/, '');
      const query = {
        text: `SELECT * FROM (${sql}\n) AS stellane_preview LIMIT 201`,
        values: input.values, queryMode: 'extended', rowMode: 'array' as const,
      };
      const result = await client.query<unknown[]>(query);
      signal.throwIfAborted();
      await client.query('COMMIT');
      return preview(result, target);
    });
  }
  async execute(connection: ClientConfig, input: QueryInput, receipt: { runId: string; digest: string }, signal: AbortSignal): Promise<QueryPreview> {
    assertTransactionalStatement(input.sql);
    let submitted = false;
    let committing = false;
    let phase = '事务准备';
    try {
      return await this.withClient(connection, signal, async client => {
        await client.query('BEGIN');
        await client.query('SET LOCAL statement_timeout = 30000');
        await client.query('SET LOCAL idle_in_transaction_session_timeout = 10000');
        const target = await this.target(client);
        phase = '回执初始化';
        await client.query('CREATE SCHEMA IF NOT EXISTS stellane_internal');
        await client.query(`CREATE TABLE IF NOT EXISTS stellane_internal.receipts (
          environment_id uuid NOT NULL, run_id uuid NOT NULL, digest text NOT NULL, preview jsonb NOT NULL,
          PRIMARY KEY (environment_id, run_id))`);
        submitted = true;
        try {
          phase = '业务语句';
          const query = { text: input.sql, values: input.values, queryMode: 'extended', rowMode: 'array' as const };
          const result = await client.query<unknown[]>(query);
          const output = preview(result, target);
          signal.throwIfAborted();
          phase = '写入回执';
          await client.query('INSERT INTO stellane_internal.receipts VALUES ($1,$2,$3,$4)',
            [input.environmentId, receipt.runId, receipt.digest, JSON.stringify(output)]);
          committing = true;
          phase = '提交事务';
          await client.query('COMMIT');
          return output;
        } catch (error) {
          // Acknowledged rollback makes failure definite. Otherwise the receipt
          // is the only positive evidence of commit; never resubmit the SQL.
          if (!committing) {
            try { await client.query('ROLLBACK'); submitted = false; } catch { /* Outcome remains unknown. */ }
          }
          throw error;
        }
      }, 35000);
    } catch (error) {
      throw new WriteOutcomeError(submitted, `${phase}：${error instanceof Error ? error.message : '写入失败。'}`);
    }
  }
  async receipt(connection: ClientConfig, environmentId: string, runId: string, digest: string, signal: AbortSignal): Promise<QueryPreview | undefined> {
    return this.withClient(connection, signal, async client => {
      const exists = await client.query("SELECT to_regclass('stellane_internal.receipts') AS name");
      if (!exists.rows[0].name) return undefined;
      const response = await client.query('SELECT digest, preview FROM stellane_internal.receipts WHERE environment_id=$1 AND run_id=$2', [environmentId, runId]);
      if (!response.rows.length) return undefined;
      if (response.rows[0].digest !== digest) throw new Error('写入回执与原请求不匹配。');
      return response.rows[0].preview as QueryPreview;
    });
  }
}

export class WriteOutcomeError extends Error {
  readonly unknown: boolean;
  constructor(unknown: boolean, message: string) { super(message); this.unknown = unknown; }
}

function preview(result: QueryResult<unknown[]>, target: DatabaseTarget): QueryPreview {
  const used = new Set<string>();
  const columns = result.fields.map(field => {
    let name = field.name;
    for (let suffix = 2; used.has(name); suffix++) name = `${field.name} (${suffix})`;
    used.add(name);
    return name;
  });
  const output: QueryPreview = {
    columns, rows: result.rows.slice(0, 200).map(row => Object.fromEntries(columns.map((name, index) => [name, cell(row[index])]))),
    rowCount: Math.min(result.rows.length, 200), truncated: result.rows.length > 200, target,
    command: result.command, affectedRows: result.rowCount ?? 0,
  };
  if (Buffer.byteLength(JSON.stringify(output)) > 128 * 1024) throw new PreviewLimitError('查询预览超过 128 KiB，请缩小查询范围。');
  return output;
}

export function assertTransactionalStatement(sql: string): void {
  // Only these statement families can run inside our transaction. Extended
  // protocol independently rejects additional statements and transaction escapes.
  let index = 0;
  while (index < sql.length) {
    if (/\s/.test(sql[index]!)) { index++; continue; }
    if (sql.startsWith('--', index)) { const end = sql.indexOf('\n', index + 2); index = end < 0 ? sql.length : end + 1; continue; }
    if (sql.startsWith('/*', index)) {
      let depth = 1; index += 2;
      while (index < sql.length && depth) {
        if (sql.startsWith('/*', index)) { depth++; index += 2; }
        else if (sql.startsWith('*/', index)) { depth--; index += 2; }
        else index++;
      }
      continue;
    }
    break;
  }
  const keyword = sql.slice(index).match(/^[a-z]+/i)?.[0].toUpperCase();
  if (!keyword || !['SELECT', 'WITH', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'ALTER', 'DROP', 'TRUNCATE'].includes(keyword)) {
    throw new Error('写入步骤仅支持单条 SELECT / WITH / DDL / DML；事务控制、SET、CALL 和多语句不受支持。');
  }
}
