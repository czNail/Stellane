import assert from 'node:assert/strict';
import { mkdtemp, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { StellaneCore } from '../src/core/index.ts';
import { Store } from '../src/core/store.ts';
import { PostgresProvider, WriteOutcomeError, type QueryProvider } from '../src/providers/postgres.ts';
import type { ClientConfig } from 'pg';
import { encodeResource, StelloProvider, StelloRequestError } from '../src/providers/stello.ts';
import type { Actor, BranchIdentity, BranchOperation, ConnectionInput, QueryInput, QueryPreview, StelloSource } from '../src/shared/models.ts';

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

for (const response of ['busy', 'result_unknown'] as const) test(`Stello ${response} after admission observes the original ticket without replaying creation`, async () => {
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
      if (body.action === 'branch_create') throw response === 'busy'
        ? new StelloRequestError(409, 'branch_rejected', 'resource lifecycle busy; retry')
        : new StelloRequestError(504, 'result_unknown');
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

test('an admitted Stello delete is observed through a late rejection without replaying or changing its identity', async () => {
  const id = randomUUID(); const providerId = randomUUID();
  const identity = { service: 'test-service', slot: 1, incarnation: 1 };
  const source = { id: providerId, name: 'test', projectPath: '/test', configPath: '/unused', resource: 'test/main', createdAt: new Date().toISOString() };
  const binding = { providerId, resource: 'test/work', resourceId: 'work', identity, forkLsn: '0/1', managed: true };
  const actions: string[] = []; let admitted = false; let observed = 0; let persisted = false;
  class RemovalProvider extends StelloProvider {
    override async operation(_source: StelloSource, body: Record<string, unknown>): Promise<unknown> {
      actions.push(String(body.action));
      if (body.action === 'branch_change') {
        assert(persisted); assert.equal(body.operation_id, id.replaceAll('-', ''));
        assert.deepEqual(body.identity, identity); admitted = true;
        throw new StelloRequestError(409, 'branch_rejected', 'resource lifecycle busy; retry');
      }
      assert.equal(body.action, 'branch_get');
      const complete = !admitted || observed++ > 0;
      return { identity, resource_id: 'work', revision: admitted ? 2 : 1,
        state: admitted ? complete ? 'deleted' : 'deleting' : 'ready', complete,
        operation_id: admitted ? id.replaceAll('-', '') : undefined };
    }
  }
  await new RemovalProvider().remove(source, binding, id, undefined, () => { persisted = true; }, AbortSignal.timeout(5000));
  assert.equal(actions.filter(action => action === 'branch_change').length, 1);
  assert.equal(actions.filter(action => action === 'branch_get').length, 3);
});

test('experiment recovers its original resources, scopes its conversation and preserves fixed evidence after cleanup', async () => {
  const project = await mkdtemp(join(tmpdir(), 'stellane-experiment-'));
  const root = { service: 'test-service', slot: 0, incarnation: 1 };
  const name = encodeResource('test/main');
  interface Branch {
    name: string; identity: BranchIdentity; resource_id: string; mode: 'writable' | 'fixed'; fork_lsn: string;
    complete: boolean; state: string; revision: number; creation_id?: string; parent_identity?: BranchIdentity; operation_id?: string;
  }
  const resources = new Map<string, Branch>([[name, { name, identity: root, resource_id: 'root', mode: 'writable',
    fork_lsn: '0/1', complete: true, state: 'ready', revision: 1 }]]);
  const deleteCalls: Record<string, unknown>[] = [];
  let lostCreation = true;
  let lostDeletion = true;
  let lostWrite = true;
  let allowReceipt = false;
  let writes = 0;
  class ExperimentProvider extends StelloProvider {
    override readonly sql = new class extends PostgresProvider {
      override async query(_connection: ClientConfig | ConnectionInput, input: QueryInput) {
        if (input.sql === 'SELECT missing') throw new Error('missing column');
        return preview();
      }
      override async execute() {
        writes++;
        if (lostWrite) { lostWrite = false; throw new WriteOutcomeError(true, 'commit reply lost'); }
        return preview();
      }
      override async receipt() { return allowReceipt ? preview() : undefined; }
    }();
    override async operation(_source: StelloSource, body: Record<string, unknown>) {
      const name = String(body.name);
      if (body.action === 'prepare_resource') {
        const request = body.request as { parent: string };
        return { identity: { ...root, slot: resources.size }, database: root, parent_identity: resources.get(request.parent)!.identity, source_history: 'source' };
      }
      if (body.action === 'branch_create') {
        assert(!resources.has(name));
        const identity = body.identity as BranchIdentity;
        resources.set(name, { name, identity, resource_id: name, mode: body.mode as Branch['mode'], fork_lsn: '0/A',
          complete: true, state: 'ready', revision: 1, creation_id: String(body.creation_id), parent_identity: body.parent_identity as BranchIdentity });
        if (lostCreation) { lostCreation = false; throw new Error('create reply lost'); }
        return resources.get(name);
      }
      const branch = resources.get(name)!;
      if (body.action === 'branch_change') {
        deleteCalls.push(body);
        assert.deepEqual(body.identity, branch.identity);
        if (lostDeletion) { lostDeletion = false; throw new Error('delete reply lost before admission'); }
        branch.state = 'deleted';
        branch.revision++;
        branch.operation_id = String(body.operation_id);
        return branch;
      }
      if (body.action === 'branch_connect') return { ...branch, connection: { ...preview().target, host: 'localhost', ca: 'example', password: 'test' } };
      assert.equal(body.action, 'branch_get');
      return branch;
    }
  }
  const directory = join(project, 'state');
  const branches = new ExperimentProvider();
  let core = new StellaneCore(directory, provider, branches);
  try {
    const source = await core.saveStello({ name: 'source', projectPath: project, configPath: '/unused', resource: 'test/main' });
    const request = { id: randomUUID(), name: 'comparison', environmentId: source.id };
    assert.match((await core.startExperiment(request)).experiment.error!, /create reply lost/);
    assert.equal(resources.size, 2);
    await core.close();
    core = new StellaneCore(directory, provider, branches);
    const ready = await core.startExperiment(request);
    const work = ready.work!;
    const options = { environmentId: work.id, sql: 'UPDATE sample_data SET value = 2' };
    assert.equal(ready.experiment.status, 'active');
    assert.equal(resources.size, 3);
    const agent: Actor = { kind: 'agent', id: 'experiment-session', projectPath: project, callId: 'mutation' };
    const other: Actor = { ...agent, id: 'same-project-other-session' };
    await assert.rejects(core.query(options, other), /无权/);
    assert.deepEqual((await core.environments(other)).map(e => e.id), [source.id]);
    assert.equal(core.bindConversation(work.id, agent.id), agent.id);
    assert.throws(() => core.bindConversation(source.id, agent.id), /另一个/);
    assert.deepEqual((await core.environments(agent)).map(e => e.id), [work.id]);
    await assert.rejects(core.query({ ...options, environmentId: source.id }, agent), /无权/);
    const unknown = await core.write(options, agent);
    assert.equal(unknown.status, 'unknown');
    await assert.rejects(core.finishExperiment(request.id), /核对/);
    assert.equal((await core.reconcileRun(unknown.id, owner)).status, 'unknown');
    allowReceipt = true;
    assert.equal((await core.reconcileRun(unknown.id, owner)).status, 'succeeded');
    assert.equal(writes, 1);

    const capture = await core.captureExperiment({ id: request.id, summary: 'findings', sql: 'SELECT missing' });
    assert(capture.result);
    assert.match(capture.experiment.error!, /补查/);
    const recorded = await core.captureExperiment({ id: request.id, summary: 'findings', sql: 'SELECT 1' });
    assert.equal(recorded.delivered?.environment.id, capture.result.id);
    assert.equal(resources.size, 4);
    assert.deepEqual(await core.results(source.id, other), []);

    const closing = await core.finishExperiment(request.id);
    assert.equal(closing.experiment.status, 'closing');
    assert.match(closing.experiment.error!, /delete reply lost/);
    await assert.rejects(core.query({ ...options, sql: 'SELECT 1' }, agent), /无权/);
    const branch = resources.get(encodeResource(work.stello!.resource))!;
    const originalIdentity = branch.identity;
    branch.identity = { ...originalIdentity, incarnation: originalIdentity.incarnation + 1 };
    assert.match((await core.finishExperiment(request.id)).experiment.error!, /同名资源/);
    assert.equal(deleteCalls.length, 1);
    branch.identity = originalIdentity;
    await core.close();
    core = new StellaneCore(directory, provider, branches);
    const ended = await core.finishExperiment(request.id);
    assert.equal(ended.experiment.status, 'closed');
    assert.deepEqual(deleteCalls[0], deleteCalls[1]);
    assert.equal(resources.get(name)?.state, 'ready');
    assert(ended.work?.removedAt);
    assert(ended.baseline?.removedAt);
    assert.deepEqual(core.snapshot().environments.map(e => e.id).sort(), [source.id, capture.result.id].sort());
    await assert.rejects(core.query({ ...options, sql: 'SELECT 1' }, owner), /已清理/);
    assert.equal((await core.query({ environmentId: capture.result.id, sql: 'SELECT 1' }, owner)).status, 'succeeded');

    const chat: Actor = { kind: 'agent', id: 'ordinary-project-session', projectPath: project, callId: 'start' };
    const sibling: Actor = { ...chat, id: 'sibling-project-session' };
    const chatRequest = { environmentId: source.id, name: '试算新规则' };
    const stateBefore = resources.size;
    lostCreation = true;
    const pending = await core.startConversationExperiment(chatRequest, chat);
    assert.equal(pending.experiment.sessionId, chat.id);
    assert.equal(pending.experiment.status, 'preparing');
    const started = await core.startConversationExperiment(chatRequest, { ...chat, callId: 'retry-start' });
    assert.equal(started.experiment.id, pending.experiment.id);
    assert.equal(started.experiment.status, 'active');
    assert.equal(resources.size, stateBefore + 2);
    const experimentId = started.experiment.id;
    const workId = started.work!.id;
    const proof = { id: experimentId, sql: 'SELECT $1::int', summary: '试算结果', values: [1] };
    assert.deepEqual(await core.conversationExperiments(sibling), []);
    await assert.rejects(core.conversationExperiments(sibling, experimentId), /无权/);
    await assert.rejects(core.captureExperiment(proof, undefined, sibling), /无权/);
    await assert.rejects(core.finishExperiment(experimentId, undefined, sibling), /无权/);
    await assert.rejects(core.finishExperiment(experimentId, undefined, chat), /先固定并交付/);
    await assert.rejects(core.write({ ...options, environmentId: workId }, sibling), /无权/);
    assert.equal((await core.query({ environmentId: source.id, sql: 'SELECT 1' }, chat)).status, 'succeeded');
    assert.equal((await core.write({ ...options, environmentId: workId }, chat)).status, 'succeeded');
    const published = await core.captureExperiment(proof, undefined, chat);
    assert.equal(published.delivered?.run.actor.id, chat.id);
    assert.deepEqual(published.delivered?.run.values, [1]);
    const finished = await core.finishExperiment(experimentId, undefined, chat);
    assert.equal(finished.experiment.status, 'closed');
    assert(finished.work?.removedAt);
    assert.equal(finished.delivered?.run.id, published.delivered?.run.id);
    assert.deepEqual((await core.environments(chat)).map(item => item.id), [source.id]);
    assert.deepEqual(await core.conversationExperiments(chat, experimentId), finished);
  } finally {
    await core.close();
    await rm(project, { recursive: true, force: true });
  }
});

test('metric evidence retains full totals on ambiguous attribution and fences relation IDs by environment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stellane-metric-'));
  const directory = join(root, 'state');
  const source = await mkdtemp(join(root, 'project-'));
  const other = await mkdtemp(join(root, 'other-'));
  const metricsProvider: QueryProvider = {
    ...provider,
    async query(_connection, input) {
      assert.match(input.sql, /LEFT JOIN ONLY "public"."stations" t1 ON k1.hits = 1/);
      assert.deepEqual(input.values, ['alert']);
      return { ...preview(), rows: [{
        snapshot: '40:40:', safe: true, groupCount: '2',
        groups: [{ bucket: 'north', orders: '1', amount: '0' }, { bucket: null, orders: '2', amount: '0' }],
        counts: { total: '3', attributed: '1', unattributed: '2', nullAmounts: '0',
          totalAmount: '0', attributedAmount: '0', unattributedAmount: '0' },
        checks: [{ eligible: '3', missing: '0', ambiguous: '2', nullSourceKeys: '0' }],
      }] };
    },
  };
  let core = new StellaneCore(directory, metricsProvider);
  try {
    const original = core.createEnvironment({ connectionId: (await core.saveConnection(input(source))).id, name: 'events' });
    const sibling = core.createEnvironment({ connectionId: (await core.saveConnection(input(source))).id, name: 'sibling' });
    const id = randomUUID();
    const sourceRunId = randomUUID();
    await core.close();
    const store = new Store(directory);
    try {
      store.put('knowledge', { id, environmentId: original.id, key: 'relation', version: 1, dependencyFingerprint: 'demo',
        fact: { kind: 'join', from: { schema: 'public', table: 'events', columns: ['station'] },
          to: { schema: 'public', table: 'stations', columns: ['external_key'] }, cardinality: 'many-to-one',
          source: { rows: '3', nullRows: '0', duplicateKeys: '1' }, target: { rows: '2', nullRows: '0', duplicateKeys: '0' }, unmatchedRows: '0' },
        evidence: { runId: sourceRunId, contextId: randomUUID(), observedAt: new Date().toISOString(), method: 'join-profile', snapshot: '39:39:' },
      });
    } finally { store.close(); }
    core = new StellaneCore(directory, metricsProvider);
    const agent: Actor = { kind: 'agent', id: 'metric-agent', projectPath: source };
    const spec = { environmentId: original.id, relationshipIds: [id], groupColumn: 'area', name: '区域告警',
      filter: { column: 'kind', value: 'alert' } };
    await assert.rejects(core.metric(spec, { ...agent, projectPath: other }), /无权/);
    await assert.rejects(core.metric({ ...spec, environmentId: sibling.id }, agent), /当前环境/);
    const run = await core.metric(spec, agent);
    assert.equal(run.metric?.status, 'unverified');
    assert.equal(run.metric?.snapshot, '40:40:');
    assert.equal(run.metric?.counts?.total, '3');
    assert.equal(run.metric?.checks?.[0]?.ambiguous, '2');
    assert.equal(run.metric?.plan.relationships[0]?.sourceRunId, sourceRunId);
    assert.deepEqual(run.preview?.columns, ['归属', '记录数']);
    assert.deepEqual(core.evidence(run.id), run);
    assert.equal((await core.metric({ ...spec, name: '设备区域事件数' }, agent)).metric?.version, run.metric?.version);
  } finally {
    await core.close();
    await rm(root, { recursive: true, force: true });
  }
});
