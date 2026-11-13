import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { BranchOperation, Connection, Delivery, Environment, Run, StelloSource } from '../shared/models.ts';
import type { CatalogImport, ContextRecord, SemanticDefinition } from '../shared/context-models.ts';
import type { ProfiledKnowledge } from '../shared/knowledge-models.ts';

interface Records { connections: Connection; environments: Environment; runs: Run; providers: StelloSource; operations: BranchOperation; deliveries: Delivery;
  contexts: ContextRecord; definitions: SemanticDefinition; catalogImports: CatalogImport; knowledge: ProfiledKnowledge }

export class Store {
  private readonly db: DatabaseSync;
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    const filename = join(directory, 'state.sqlite');
    this.db = new DatabaseSync(filename);
    chmodSync(filename, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS connections (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS environments (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS providers (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS contexts (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS definitions (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS definitions_scope ON definitions(json_extract(body,'$.projectPath'),json_extract(body,'$.dataSourceId'));
      CREATE TABLE IF NOT EXISTS catalogImports (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS knowledge (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS knowledge_environment ON knowledge(json_extract(body,'$.environmentId'));
      PRAGMA user_version=4;`);
    const unfinished = this.db.prepare("SELECT body FROM runs WHERE json_extract(body, '$.status') = 'running'").all();
    for (const row of unfinished) {
      const run = JSON.parse(row.body as string) as Run;
      this.put('runs', {
        ...run, status: run.kind === 'execute' ? 'unknown' : 'interrupted', finishedAt: new Date().toISOString(),
        error: run.kind === 'execute' ? '宿主退出时写入结果未确认，请核对原回执；不要重放 SQL。'
          : '宿主上次退出时查询尚未完成，请检查记录后重新发起只读查询。',
      });
    }
    for (const row of this.db.prepare("SELECT body FROM operations WHERE json_extract(body, '$.status') = 'pending'").all()) {
      const operation = JSON.parse(row.body as string) as BranchOperation;
      this.put('operations', { ...operation, status: 'unknown', error: '宿主退出时派生尚未确认，请核对原资源。' });
    }
  }
  list<K extends keyof Records>(table: K, limit = 500): Records[K][] {
    return this.db.prepare(`SELECT body FROM ${table} ORDER BY rowid DESC LIMIT ?`).all(Math.max(1, Math.min(limit, 500)))
      .map(row => JSON.parse(row.body as string));
  }
  get<K extends keyof Records>(table: K, id: string): Records[K] {
    const value = this.find(table, id);
    if (!value) throw new Error('记录不存在。');
    return value;
  }
  find<K extends keyof Records>(table: K, id: string): Records[K] | undefined {
    const row = this.db.prepare(`SELECT body FROM ${table} WHERE id = ?`).get(id);
    return row ? JSON.parse(row.body as string) : undefined;
  }
  environmentCount(projectPath: string): number {
    const environments = this.db.prepare("SELECT count(*) AS n FROM environments WHERE json_extract(body, '$.projectPath') = ?").get(projectPath)!;
    const pending = this.db.prepare(`SELECT count(*) AS n FROM operations o
      WHERE json_extract(o.body, '$.environment.projectPath') = ? AND json_extract(o.body, '$.status') IN ('pending','unknown')
      AND NOT EXISTS (SELECT 1 FROM environments e WHERE e.id = json_extract(o.body, '$.environment.id'))`).get(projectPath)!;
    return Number(environments.n) + Number(pending.n);
  }
  definitions(projectPath: string, dataSourceId: string): SemanticDefinition[] {
    return this.db.prepare("SELECT body FROM definitions WHERE json_extract(body,'$.projectPath')=? AND json_extract(body,'$.dataSourceId')=? ORDER BY rowid DESC")
      .all(projectPath,dataSourceId).map(row=>JSON.parse(row.body as string));
  }
  knowledge(environmentId: string): ProfiledKnowledge[] {
    return this.db.prepare("SELECT body FROM knowledge WHERE json_extract(body,'$.environmentId')=? ORDER BY rowid DESC")
      .all(environmentId).map(row => JSON.parse(row.body as string));
  }
  transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result=work(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  put<K extends keyof Records>(table: K, value: Records[K]): void {
    this.db.prepare(`INSERT INTO ${table} (id, body) VALUES (?, ?)
      ON CONFLICT(id) DO UPDATE SET body = excluded.body`).run(value.id, JSON.stringify(value));
  }
  close(): void { this.db.close(); }
}
