import assert from 'node:assert/strict';
import { mkdtemp, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { StellaneCore } from '../src/core/index.ts';
import { Store } from '../src/core/store.ts';
import type { QueryProvider } from '../src/providers/postgres.ts';
import { encodeResource, StelloProvider, StelloRequestError } from '../src/providers/stello.ts';
import type { Actor, BranchOperation, ConnectionInput, QueryPreview, StelloSource } from '../src/shared/models.ts';

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
    await assert.rejects(core.write({ environmentId: environment.id, sql: 'DELETE FROM sample_data' }, { ...actor, projectPath: root }), /只能写入/);
    await assert.rejects(core.derive('fork', { environmentId: environment.id, name: 'unsupported' }, { ...actor, projectPath: root }), /没有分支/);
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

test('Stello busy after admission observes the original ticket without replaying creation', async () => {
  const id = randomUUID();
  const providerId = randomUUID();
  const parentIdentity = { service: 'test-service', slot: 0, incarnation: 1 };
  const childIdentity = { ...parentIdentity, slot: 1 };
  const parent = { providerId, resource: 'test/main', resourceId: 'parent', identity: parentIdentity, forkLsn: '0/1', managed: false };
  const createdAt = new Date().toISOString();
  const actions: string[] = [];
  let observations = 0;
  const operation: BranchOperation = {
    id, kind: 'checkpoint', providerId, parentEnvironmentId: randomUUID(), resource: 'test/cut', actor: owner,
    status: 'pending', createdAt,
    environment: { id: randomUUID(), name: 'cut', projectPath: '/test', mode: 'fixed', access: 'read-only', createdAt },
  };
  class BusyProvider extends StelloProvider {
    override async operation(_source: StelloSource, body: Record<string, unknown>, _signal: AbortSignal): Promise<unknown> {
      actions.push(String(body.action));
      if (body.action === 'prepare_resource') return {
        identity: childIdentity, database: parentIdentity, parent_identity: parentIdentity, source_history: 'history',
      };
      if (body.action === 'branch_create') throw new StelloRequestError(409, 'branch_rejected', 'resource lifecycle busy; retry');
      assert.equal(body.action, 'branch_get');
      if (body.name === encodeResource(parent.resource)) return {
        name: body.name, identity: parentIdentity, resource_id: 'parent', mode: 'writable', fork_lsn: '0/1', complete: true, state: 'ready',
      };
      if (observations++ === 0) throw new StelloRequestError(409, 'branch_rejected', 'resource lifecycle busy; retry');
      return {
        name: body.name, identity: childIdentity, resource_id: 'child', mode: 'fixed', fork_lsn: '0/A', complete: true, state: 'ready',
        creation_id: id.replaceAll('-', ''), parent_identity: parentIdentity,
      };
    }
  }
  const source = { id: providerId, name: 'test', projectPath: '/test', configPath: '/unused', resource: 'test/main', createdAt };
  const result = await new BusyProvider().create(source, parent, operation, request => { operation.request = request; }, AbortSignal.timeout(5000));
  assert.equal(result.forkLsn, '0/A');
  assert.equal(actions.filter(action => action === 'branch_create').length, 1);
  assert(actions.every(action => ['branch_get', 'prepare_resource', 'branch_create'].includes(action)));
});
