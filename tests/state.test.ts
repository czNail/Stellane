import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Store } from '../src/core/store.ts';
import { STATE_SCHEMA_VERSION } from '../src/core/state-schema.ts';
import type { BranchOperation, Run } from '../src/shared/models.ts';

const storeUrl = new URL('../src/core/store.ts', import.meta.url).href;
const currentVersion = (db: DatabaseSync) => Number(db.prepare('PRAGMA user_version').get()!.user_version);
const legacySchema = `CREATE TABLE connections (id TEXT PRIMARY KEY, body TEXT NOT NULL);
  CREATE TABLE environments (id TEXT PRIMARY KEY, body TEXT NOT NULL);
  CREATE TABLE runs (id TEXT PRIMARY KEY, body TEXT NOT NULL); PRAGMA user_version=1;`;

async function startOwner(directory: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', `
    import { Store } from ${JSON.stringify(storeUrl)};
    const store = new Store(process.argv[1]);
    store.put('runs', { id: 'write', kind: 'execute', status: 'running' });
    process.on('message', message => { if (message === 'close') { store.close(); process.exit(0); } });
    process.send('ready');
  `, directory], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let diagnostic = '';
  child.stderr?.on('data', chunk => { diagnostic += String(chunk); });
  await new Promise<void>((resolve, reject) => {
    const exited = () => reject(new Error(`State owner exited before readiness: ${diagnostic}`));
    child.once('exit', exited);
    child.once('error', reject);
    child.once('message', message => {
      if (message === 'ready') { child.off('exit', exited); resolve(); }
      else reject(new Error('Unexpected child readiness message.'));
    });
  });
  return child;
}
async function stopOwner(child: ChildProcess, crash = false) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  if (crash) child.kill('SIGKILL');
  else child.send('close');
  await exited;
}

test('one directory has one writer; rejection cannot interrupt an active same-process run', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stellane-state-owner-'));
  const first = new Store(directory);
  try {
    first.put('runs', { id: 'query', kind: 'query', status: 'running' } as Run);
    assert.throws(() => new Store(directory), /另一个 Host/);
    assert.equal(first.get('runs', 'query').status, 'running');
    first.close(); first.close();
    const reopened = new Store(directory);
    try { assert.equal(reopened.get('runs', 'query').status, 'interrupted'); }
    finally { reopened.close(); }
  } finally { first.close(); await rm(directory, { recursive: true, force: true }); }
});

for (const crash of [false, true]) {
  test(`another process cannot open active state; ${crash ? 'crash' : 'normal exit'} releases its OS lock`, { timeout: 15_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stellane-state-process-'));
    const child = await startOwner(directory);
    try {
      assert.throws(() => new Store(directory), /另一个 Host/);
      const observer = new DatabaseSync(join(directory, 'state.sqlite'), { readOnly: true });
      try { assert.equal(JSON.parse(observer.prepare("SELECT body FROM runs WHERE id='write'").get()!.body as string).status, 'running'); }
      finally { observer.close(); }
      await stopOwner(child, crash);
      const reopened = new Store(directory);
      try {
        assert.equal(reopened.get('runs', 'write').status, 'unknown');
        assert.match(reopened.get('runs', 'write').error!, /不要重放/);
      } finally { reopened.close(); }
    } finally { await stopOwner(child, true); await rm(directory, { recursive: true, force: true }); }
  });
}

test('different state directories can be used concurrently', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stellane-state-independent-'));
  const first = new Store(join(directory, 'one'));
  const second = new Store(join(directory, 'two'));
  try {
    first.put('runs', { id: 'query', kind: 'query', status: 'running' } as Run);
    assert.equal(second.find('runs', 'query'), undefined);
    assert.equal(first.get('runs', 'query').status, 'running');
  } finally { second.close(); first.close(); await rm(directory, { recursive: true, force: true }); }
});

test('future state is rejected before changing its version, records or database bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stellane-state-future-'));
  const filename = join(directory, 'state.sqlite');
  const db = new DatabaseSync(filename);
  db.exec("CREATE TABLE future_private (body TEXT); INSERT INTO future_private VALUES ('keep'); PRAGMA user_version=99;");
  db.close();
  const before = await readFile(filename);
  try {
    assert.throws(() => new Store(directory), /更新的数据格式/);
    assert.deepEqual(await readFile(filename), before);
    assert.throws(() => new Store(directory), /更新的数据格式/, 'A rejected constructor must release its lock.');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('legacy v1 upgrades transactionally and backs up committed WAL data before recovery', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stellane-state-migrate-'));
  const filename = join(directory, 'state.sqlite');
  const writer = new DatabaseSync(filename);
  writer.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; ${legacySchema}`);
  writer.prepare('INSERT INTO connections VALUES (?, ?)').run('connection', JSON.stringify({ id: 'connection', name: 'Existing connection' }));
  writer.prepare('INSERT INTO runs VALUES (?, ?)').run('pending-write', JSON.stringify({ id: 'pending-write', kind: 'execute', status: 'running' }));
  // Keep this fixture connection open so its latest commit remains in WAL.
  assert((await stat(`${filename}-wal`)).size > 0);
  let store: Store | undefined;
  try {
    store = new Store(directory);
    assert.equal(store.get('connections', 'connection').name, 'Existing connection');
    assert.equal(store.get('runs', 'pending-write').status, 'unknown');
    assert(store.migrationBackup);
    const backup = new DatabaseSync(store.migrationBackup, { readOnly: true });
    try {
      assert.equal(currentVersion(backup), 1);
      assert.equal(JSON.parse(backup.prepare("SELECT body FROM runs WHERE id='pending-write'").get()!.body as string).status, 'running');
      assert.equal(JSON.parse(backup.prepare("SELECT body FROM connections WHERE id='connection'").get()!.body as string).name, 'Existing connection');
      assert.equal(backup.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='neonSources'").get()!.n, 0);
      assert.equal(backup.prepare('PRAGMA quick_check').get()!.quick_check, 'ok');
    } finally { backup.close(); }
    assert.equal(currentVersion(writer), STATE_SCHEMA_VERSION);
    if (process.platform !== 'win32') assert.equal((await stat(store.migrationBackup)).mode & 0o777, 0o600);
    store.close();
    const reopened = new Store(directory);
    try { assert.equal(reopened.migrationBackup, undefined); }
    finally { reopened.close(); }
    assert.equal((await readdir(join(directory, 'backups'))).length, 1);
  } finally { store?.close(); writer.close(); await rm(directory, { recursive: true, force: true }); }
});

test('failed migration rolls back schema and version and retains a valid original backup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stellane-state-rollback-'));
  const filename = join(directory, 'state.sqlite');
  const db = new DatabaseSync(filename);
  db.exec(`${legacySchema} CREATE VIEW knowledge AS SELECT 'conflict' AS id, '{}' AS body;`);
  db.prepare('INSERT INTO connections VALUES (?,?)').run('saved', '{"id":"saved","name":"keep"}');
  try {
    assert.throws(() => new Store(directory), /状态升级未完成/);
    assert.equal(currentVersion(db), 1);
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='definitions'").get()!.n, 0);
    assert.equal(db.prepare("SELECT body FROM connections WHERE id='saved'").get()!.body, '{"id":"saved","name":"keep"}');
    const backups = await readdir(join(directory, 'backups'));
    assert.equal(backups.length, 1);
    const backup = new DatabaseSync(join(directory, 'backups', backups[0]!), { readOnly: true });
    try { assert.equal(currentVersion(backup), 1); assert.equal(backup.prepare('PRAGMA quick_check').get()!.quick_check, 'ok'); }
    finally { backup.close(); }
    db.exec('DROP VIEW knowledge');
    const retried = new Store(directory);
    try { assert.equal(retried.get('connections', 'saved').name, 'keep'); }
    finally { retried.close(); }
  } finally { db.close(); await rm(directory, { recursive: true, force: true }); }
});

test('current state preserves data and recovers unfinished operations without creating a migration backup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stellane-state-current-'));
  const first = new Store(directory);
  first.put('operations', { id: 'branch', status: 'pending' } as BranchOperation);
  first.close();
  const next = new Store(directory);
  try {
    assert.equal(next.migrationBackup, undefined);
    assert.equal(next.get('operations', 'branch').status, 'unknown');
    assert.equal(next.listAll('operations').length, 1);
    assert.equal(next.delete('operations', 'branch'), true);
    assert.equal(next.delete('operations', 'branch'), false);
  } finally { next.close(); await rm(directory, { recursive: true, force: true }); }
});

test('v6 is backed up before adopting lifecycle visibility semantics', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stellane-state-v6-'));
  const seed = new Store(directory);
  seed.put('runs', { id: 'saved', kind: 'query', status: 'succeeded' } as Run);
  seed.close();
  const legacy = new DatabaseSync(join(directory, 'state.sqlite'));
  legacy.exec('PRAGMA user_version=6');
  legacy.close();
  const upgraded = new Store(directory);
  try {
    assert(upgraded.migrationBackup);
    assert.equal(upgraded.get('runs', 'saved').status, 'succeeded');
    const backup = new DatabaseSync(upgraded.migrationBackup, { readOnly: true });
    try {
      assert.equal(currentVersion(backup), 6);
      assert.equal(JSON.parse(backup.prepare("SELECT body FROM runs WHERE id='saved'").get()!.body as string).status, 'succeeded');
    } finally { backup.close(); }
  } finally { upgraded.close(); await rm(directory, { recursive: true, force: true }); }
});
