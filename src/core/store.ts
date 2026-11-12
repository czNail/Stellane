import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { BranchOperation, Connection, Delivery, Environment, Run, StelloSource } from '../shared/models.ts';

interface Records { connections: Connection; environments: Environment; runs: Run; providers: StelloSource; operations: BranchOperation; deliveries: Delivery }

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
      PRAGMA user_version=1;`);
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
  put<K extends keyof Records>(table: K, value: Records[K]): void {
    this.db.prepare(`INSERT INTO ${table} (id, body) VALUES (?, ?)
      ON CONFLICT(id) DO UPDATE SET body = excluded.body`).run(value.id, JSON.stringify(value));
  }
  close(): void { this.db.close(); }
}
