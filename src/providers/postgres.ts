import { readFile, stat } from 'node:fs/promises';
import { Client } from 'pg';
import type { Cell, ConnectionInput, DatabaseTarget, QueryInput, QueryPreview } from '../shared/models.ts';

export interface QueryProvider {
  probe(connection: ConnectionInput, signal: AbortSignal): Promise<DatabaseTarget>;
  query(connection: ConnectionInput, input: QueryInput, signal: AbortSignal): Promise<QueryPreview>;
}
class PreviewLimitError extends Error {}

async function password(reference: string): Promise<string> {
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

function publicError(error: unknown): Error {
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
  private async withClient<T>(connection: ConnectionInput, signal: AbortSignal, work: (client: Client) => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    const client = new Client({
      host: connection.host, port: connection.port, database: connection.database,
      user: connection.user, password: await password(connection.passwordRef),
      ssl: connection.tls === 'verify-full' ? { rejectUnauthorized: true } : false,
      connectionTimeoutMillis: 5000, query_timeout: 7000,
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
  async query(connection: ConnectionInput, input: QueryInput, signal: AbortSignal): Promise<QueryPreview> {
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
      const used = new Set<string>();
      const columns = result.fields.map(field => {
        let name = field.name;
        for (let suffix = 2; used.has(name); suffix++) name = `${field.name} (${suffix})`;
        used.add(name);
        return name;
      });
      const preview: QueryPreview = {
        columns,
        rows: result.rows.slice(0, 200).map(row => Object.fromEntries(columns.map((name, index) => [name, cell(row[index])]))),
        rowCount: Math.min(result.rows.length, 200), truncated: result.rows.length > 200, target,
      };
      if (Buffer.byteLength(JSON.stringify(preview)) > 128 * 1024) throw new PreviewLimitError('查询预览超过 128 KiB，请缩小查询范围。');
      return preview;
    });
  }
}
