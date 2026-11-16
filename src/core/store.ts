import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { acquireStateLock } from './state-lock.ts';
import { checkStateVersion, migrateState } from './state-schema.ts';
import type { BranchOperation, BranchRemoval, Connection, ConversationScope, Delivery, Environment, Experiment, Run, StelloSource } from '../shared/models.ts';
import type { CatalogImport, ContextRecord, SemanticDefinition } from '../shared/context-models.ts';
import type { ProfiledKnowledge } from '../shared/knowledge-models.ts';
import type { NeonSource, NeonRemoval } from '../shared/neon-models.ts';

export interface Records { connections: Connection; environments: Environment; runs: Run; providers: StelloSource; operations: BranchOperation; deliveries: Delivery;
  contexts: ContextRecord; definitions: SemanticDefinition; catalogImports: CatalogImport; knowledge: ProfiledKnowledge;
  experiments: Experiment; scopes: ConversationScope; removals: BranchRemoval; neonSources: NeonSource; neonRemovals: NeonRemoval }

export class Store {
  private readonly db: DatabaseSync;
  private readonly releaseLock: () => void;
  private closed = false;
  readonly migrationBackup?: string;
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    this.releaseLock = acquireStateLock(directory);
    let db: DatabaseSync | undefined;
    try {
      const filename = join(directory, 'state.sqlite');
      const previousVersion = checkStateVersion(filename);
      db = new DatabaseSync(filename);
      this.db = db;
      chmodSync(filename, 0o600);
      db.exec('PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON;');
      this.migrationBackup = migrateState(db, directory, previousVersion);
      db.exec('PRAGMA journal_mode=WAL;');
      this.recoverInterrupted();
    } catch (error) {
      try { db?.close(); } finally { this.releaseLock(); }
      throw error;
    }
  }
  private recoverInterrupted(): void {
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
  listAll<K extends keyof Records>(table: K): Records[K][] {
    return this.db.prepare(`SELECT body FROM ${table} ORDER BY rowid DESC`).all()
      .map(row => JSON.parse(row.body as string));
  }
  delete<K extends keyof Records>(table: K, id: string): boolean {
    return this.db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id).changes > 0;
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
    const environments = this.db.prepare("SELECT count(*) AS n FROM environments WHERE json_extract(body, '$.projectPath') = ? AND json_extract(body, '$.removedAt') IS NULL").get(projectPath)!;
    const pending = this.db.prepare(`SELECT count(*) AS n FROM operations o
      WHERE json_extract(o.body, '$.environment.projectPath') = ? AND json_extract(o.body, '$.status') IN ('pending','unknown')
      AND NOT EXISTS (SELECT 1 FROM environments e WHERE e.id = json_extract(o.body, '$.environment.id'))`).get(projectPath)!;
    return Number(environments.n) + Number(pending.n);
  }
  environments(): Environment[] {
    return this.db.prepare("SELECT body FROM environments WHERE json_extract(body,'$.removedAt') IS NULL ORDER BY rowid DESC LIMIT 500")
      .all().map(row => JSON.parse(row.body as string));
  }
  experimentRuns(environmentId: string, unresolved = false): Run[] {
    const status = unresolved ? "AND json_extract(body,'$.status') = 'unknown'" : "AND json_extract(body,'$.purpose') IS NULL";
    return this.db.prepare(`SELECT body FROM runs WHERE json_extract(body,'$.environmentId') = ? ${status} ORDER BY rowid DESC LIMIT 30`)
      .all(environmentId).map(row => JSON.parse(row.body as string));
  }
  conversationExperiments(projectPath: string, sessionId: string): Experiment[] {
    return this.db.prepare(`SELECT body FROM experiments
      WHERE json_extract(body,'$.projectPath') = ? AND json_extract(body,'$.sessionId') = ?
      ORDER BY rowid DESC LIMIT 20`).all(projectPath, sessionId).map(row => JSON.parse(row.body as string));
  }
  openConversationExperiment(projectPath: string, sessionId: string, sourceId: string, name: string): Experiment | undefined {
    const row = this.db.prepare(`SELECT body FROM experiments
      WHERE json_extract(body,'$.projectPath') = ? AND json_extract(body,'$.sessionId') = ?
      AND json_extract(body,'$.sourceId') = ? AND json_extract(body,'$.name') = ?
      AND json_extract(body,'$.status') != 'closed' ORDER BY rowid DESC LIMIT 1`).get(projectPath, sessionId, sourceId, name);
    return row ? JSON.parse(row.body as string) : undefined;
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
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try { this.db.close(); } finally { this.releaseLock(); }
  }
}
