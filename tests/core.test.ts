import assert from 'node:assert/strict';
import { mkdtemp, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { StellaneCore } from '../src/core/index.ts';
import { Store } from '../src/core/store.ts';
import type { QueryProvider } from '../src/providers/postgres.ts';
import type { Actor, ConnectionInput, QueryPreview } from '../src/shared/models.ts';

const owner: Actor = { kind: 'user', id: 'owner' };
const preview = (database = 'test'): QueryPreview => ({ columns: ['value'], rows: [{ value: 1 }], rowCount: 1, truncated: false,
  target: { database, user: 'reader', address: '127.0.0.1', port: 5432 } });
const provider: QueryProvider = {
  async probe() { return preview().target; },
  async query(connection) { await new Promise(resolve => setTimeout(resolve, 5)); return preview(connection.database); },
};
function input(projectPath: string, database = 'test'): ConnectionInput {
  return { name: 'test', projectPath, host: '127.0.0.1', port: 5432, database, user: 'reader', passwordRef: 'env:STELLANE_TEST_PASSWORD', tls: 'disable' };
}

test('connection, environment and execution survive reopening the local store', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stellane-persist-'));
  try {
    const directory = join(root, 'state');
    const core = new StellaneCore(directory, provider);
    const connection = await core.saveConnection(input(root));
    const environment = core.createEnvironment({ connectionId: connection.id, name: 'parent' });
    const run = await core.query({ environmentId: environment.id, sql: 'SELECT 1' }, owner);
    assert.equal(run.status, 'succeeded');
    await core.close();
    const reopened = new StellaneCore(directory, provider);
    assert.equal(reopened.snapshot().connections[0]?.passwordRef, 'env:STELLANE_TEST_PASSWORD');
    assert.equal(reopened.snapshot().environments[0]?.mode, 'live');
    assert.deepEqual(reopened.snapshot().runs[0], run);
    await reopened.close();
    assert.equal((await stat(join(directory, 'state.sqlite'))).mode & 0o077, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Agent project identity fences environment discovery and SQL execution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stellane-authorize-'));
  const other = await mkdtemp(join(tmpdir(), 'stellane-other-'));
  const core = new StellaneCore(join(root, 'state'), provider);
  try {
    const connection = await core.saveConnection(input(root));
    const environment = core.createEnvironment({ connectionId: connection.id, name: 'private' });
    const actor: Actor = { kind: 'agent', id: 'agent-1', projectPath: other };
    assert.deepEqual(await core.environments(actor), []);
    await assert.rejects(core.query({ environmentId: environment.id, sql: 'SELECT 1' }, actor), /无权/);
    assert.equal(core.snapshot().runs.length, 0);
    const allowed = await core.query({ environmentId: environment.id, sql: 'SELECT 1' }, { ...actor, projectPath: root });
    assert.equal(allowed.actor.id, 'agent-1');
    assert.equal(allowed.status, 'succeeded');
  } finally { await core.close(); await rm(root, { recursive: true, force: true }); await rm(other, { recursive: true, force: true }); }
});

test('parallel calls retain distinct environments, targets and run identities', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stellane-parallel-'));
  const core = new StellaneCore(join(root, 'state'), provider);
  try {
    const connections = await Promise.all(['alpha', 'beta'].map(database => core.saveConnection(input(root, database))));
    const environments = connections.map(connection => core.createEnvironment({ connectionId: connection.id, name: connection.database }));
    const runs = await Promise.all(environments.map(environment => core.query({ environmentId: environment.id, sql: 'SELECT 1' }, owner)));
    assert.equal(new Set(runs.map(run => run.id)).size, 2);
    for (let i = 0; i < runs.length; i++) {
      assert.equal(runs[i]!.environmentId, environments[i]!.id);
      assert.equal(runs[i]!.target!.database, connections[i]!.database);
    }
  } finally { await core.close(); await rm(root, { recursive: true, force: true }); }
});

test('unfinished runs become interrupted after restart and are never replayed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stellane-recovery-'));
  try {
    const core = new StellaneCore(root, provider);
    const connection = await core.saveConnection(input(root));
    const environment = core.createEnvironment({ connectionId: connection.id, name: 'env' });
    const run = await core.query({ environmentId: environment.id, sql: 'SELECT 1' }, owner);
    await core.close();
    const store = new Store(root);
    store.put('runs', { ...run, status: 'running', preview: undefined, target: undefined, durationMs: undefined, finishedAt: undefined });
    // Recovery must also cover work older than the bounded history projection.
    for (let index = 0; index < 501; index++) store.put('runs', { ...run, id: randomUUID() });
    store.close();
    let called = false;
    const reopened = new StellaneCore(root, { ...provider, async query() { called = true; return preview(); } });
    assert.equal(called, false);
    await reopened.close();
    const recovered = new Store(root);
    assert.equal(recovered.get('runs', run.id).status, 'interrupted');
    recovered.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});
