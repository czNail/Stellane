import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Connection, Environment, Run } from '../shared/models.ts';

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
      PRAGMA user_version=1;`);
    const unfinished = this.db.prepare("SELECT body FROM runs WHERE json_extract(body, '$.status') = 'running'").all();
    for (const row of unfinished) {
      const run = JSON.parse(row.body as string) as Run;
      this.put('runs', {
        ...run, status: 'interrupted', finishedAt: new Date().toISOString(),
        error: '宿主上次退出时查询尚未完成，请检查记录后重新发起只读查询。',
      });
    }
  }
  list(table: 'connections'): Connection[];
  list(table: 'environments'): Environment[];
  list(table: 'runs'): Run[];
  list(table: 'connections' | 'environments' | 'runs'): (Connection | Environment | Run)[] {
    return this.db.prepare(`SELECT body FROM ${table} ORDER BY rowid DESC LIMIT 500`)
      .all().map(row => JSON.parse(row.body as string));
  }
  get(table: 'connections', id: string): Connection;
  get(table: 'environments', id: string): Environment;
  get(table: 'runs', id: string): Run;
  get(table: 'connections' | 'environments' | 'runs', id: string): Connection | Environment | Run {
    const row = this.db.prepare(`SELECT body FROM ${table} WHERE id = ?`).get(id);
    if (!row) throw new Error('记录不存在。');
    return JSON.parse(row.body as string);
  }
  put(table: 'connections', value: Connection): void;
  put(table: 'environments', value: Environment): void;
  put(table: 'runs', value: Run): void;
  put(table: 'connections' | 'environments' | 'runs', value: Connection | Environment | Run): void {
    this.db.prepare(`INSERT INTO ${table} (id, body) VALUES (?, ?)
      ON CONFLICT(id) DO UPDATE SET body = excluded.body`).run(value.id, JSON.stringify(value));
  }
  close(): void { this.db.close(); }
}
