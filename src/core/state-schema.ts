import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const STATE_SCHEMA_VERSION = 7;

const table = (name: string) => `CREATE TABLE IF NOT EXISTS ${name} (id TEXT PRIMARY KEY, body TEXT NOT NULL);`;
// Versions follow the committed releases. Early v1 builds optionally contained
// branch tables, so v2 adds them idempotently along with the semantic catalog.
const migrations = [
  ['connections', 'environments', 'runs'].map(table).join('\n'),
  ['providers', 'operations', 'deliveries', 'contexts', 'definitions', 'catalogImports'].map(table).join('\n')
    + "CREATE INDEX IF NOT EXISTS definitions_scope ON definitions(json_extract(body,'$.projectPath'),json_extract(body,'$.dataSourceId'));",
  table('knowledge'),
  "CREATE INDEX IF NOT EXISTS knowledge_environment ON knowledge(json_extract(body,'$.environmentId'));",
  ['experiments', 'scopes', 'removals'].map(table).join('\n'),
  ['neonSources', 'neonRemovals'].map(table).join('\n'),
  // Lifecycle visibility (disabled sources and archived memory) changes record
  // semantics even though the JSON table layout stays the same.
  '-- State ownership and lifecycle semantics require a guarded reader.\n',
];
const introduced = [
  ['connections', 'environments', 'runs'],
  ['providers', 'operations', 'deliveries', 'contexts', 'definitions', 'catalogImports'],
  ['knowledge'], [], ['experiments', 'scopes', 'removals'], ['neonSources', 'neonRemovals'], [],
];

function validateStructure(db: DatabaseSync, current: number): void {
  for (const name of introduced.slice(0, current).flat()) {
    const columns = db.prepare(`PRAGMA table_info(${name})`).all();
    if (!columns.some(column => column.name === 'id' && column.type === 'TEXT' && column.pk === 1)
      || !columns.some(column => column.name === 'body' && column.type === 'TEXT' && column.notnull === 1)) {
      throw new Error(`状态表 ${name} 不符合版本 ${current} 的格式。原数据未被替换，请从备份恢复或检查原版本。`);
    }
  }
}

function version(db: DatabaseSync): number {
  return Number(db.prepare('PRAGMA user_version').get()!.user_version);
}

/** Inspect first, so a newer state is never opened for modification by older code. */
export function checkStateVersion(filename: string): number {
  if (!existsSync(filename)) return 0;
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    const current = version(db);
    if (current > STATE_SCHEMA_VERSION) {
      throw new Error(`此状态目录使用更新的数据格式（${current}），当前插件仅支持 ${STATE_SCHEMA_VERSION}。请升级插件；不要覆盖或降级此目录。`);
    }
    validateStructure(db, current);
    return current;
  } finally { db.close(); }
}

/** VACUUM INTO creates a complete committed snapshot, including data still in WAL.
 * It leaves the original database untouched and avoids unsafe copies of live WAL files.
 */
export function migrateState(db: DatabaseSync, directory: string, expectedVersion: number): string | undefined {
  if (version(db) !== expectedVersion) throw new Error('状态版本在打开时发生变化，已停止升级。请确认没有其他程序写入该目录。');
  if (expectedVersion === STATE_SCHEMA_VERSION) return undefined;
  const existing = Number(db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get()!.count) > 0;
  let backup: string | undefined;
  if (existing) {
    const backups = join(directory, 'backups');
    mkdirSync(backups, { recursive: true, mode: 0o700 });
    chmodSync(backups, 0o700);
    backup = join(backups, `schema-v${expectedVersion}-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}.sqlite`);
    const temporary = `${backup}.tmp`;
    db.prepare('VACUUM INTO ?').run(temporary);
    chmodSync(temporary, 0o600);
    const snapshot = new DatabaseSync(temporary, { readOnly: true });
    try {
      if (snapshot.prepare('PRAGMA quick_check').get()!.quick_check !== 'ok' || version(snapshot) !== expectedVersion) {
        throw new Error('升级前备份未通过完整性检查，原状态未修改。');
      }
    } finally { snapshot.close(); }
    renameSync(temporary, backup);
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    for (let next = expectedVersion + 1; next <= STATE_SCHEMA_VERSION; next++) {
      db.exec(migrations[next - 1]!);
      db.exec(`PRAGMA user_version=${next}`);
    }
    validateStructure(db, STATE_SCHEMA_VERSION);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw new Error(`状态升级未完成，原数据和版本已保留。${backup ? `升级前备份：${backup}。` : ''}请检查原数据库结构后重试。`, { cause: error });
  }
  return backup;
}
