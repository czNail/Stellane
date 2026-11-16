import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ClientConfig } from 'pg';
import { StellaneCore } from '../src/core/index.ts';
import { NeonProvider } from '../src/providers/neon.ts';
import { WriteOutcomeError } from '../src/providers/postgres.ts';
import type { Actor, BranchOperation, QueryPreview } from '../src/shared/models.ts';
import type { NeonRemoval, NeonSource } from '../src/shared/neon-models.ts';
import { describeEnvironment } from '../src/shared/capabilities.ts';
import { Store } from '../src/core/store.ts';
import { KnowledgeMemory } from '../src/core/knowledge.ts';
import type { ContextRecord, DatabaseMetadata } from '../src/shared/context-models.ts';

// This models Neon's documented Management API, not a live Neon cloud account.
// PostgreSQL and Stello integration suites separately exercise actual databases.
const signal = new AbortController().signal;
const owner: Actor = { kind: 'user', id: 'owner' };
const credential = 'test-only-neon-api-key';
process.env.STELLANE_NEON_CONTRACT_KEY = credential;
const sqlPassword = 'test-only-sql-password';
const projectId = 'test-project';
type Schema = { $ref?: string; type?: string; enum?: unknown[]; pattern?: string; minLength?: number; maxLength?: number;
  properties?: Record<string, Schema>; additionalProperties?: Schema; required?: string[]; items?: Schema; allOf?: Schema[] };
const official = JSON.parse(await readFile(new URL('./fixtures/neon-api-contract.json', import.meta.url), 'utf8')) as {
  createBranch: Schema; components: { schemas: Record<string, Schema> };
};
function validateContract(value: unknown, schema: Schema): void {
  if (schema.$ref) return validateContract(value, official.components.schemas[schema.$ref.split('/').at(-1)!]!);
  if (schema.allOf) { for (const item of schema.allOf) validateContract(value, item); return; }
  if (schema.type === 'object') {
    assert(value && typeof value === 'object' && !Array.isArray(value));
    for (const key of schema.required ?? []) assert(key in value, `Required API field ${key}`);
    for (const [key, item] of Object.entries(value)) {
      const property = schema.properties?.[key] ?? schema.additionalProperties;
      if (property) validateContract(item, property);
    }
  } else if (schema.type === 'array') {
    assert(Array.isArray(value));
    for (const item of value) if (schema.items) validateContract(item, schema.items);
  } else if (schema.type === 'string') {
    assert.equal(typeof value, 'string');
    if (schema.pattern) assert(new RegExp(schema.pattern).test(value as string));
    if (schema.minLength) assert((value as string).length >= schema.minLength);
    if (schema.maxLength) assert((value as string).length <= schema.maxLength);
  }
  if (schema.enum) assert(schema.enum.includes(value));
}
type Branch = { id: string; project_id: string; name: string; created_at: string; current_state: string;
  parent_id?: string; parent_lsn?: string; last_reset_at?: string; default?: boolean };
type Endpoint = { id: string; project_id: string; branch_id: string; host: string; type: 'read_only' | 'read_write' };

function fixture() {
  const branches = new Map<string, Branch>();
  const endpoints = new Map<string, Endpoint>();
  const annotations = new Map<string, Record<string, string>>();
  const values = new Map<string, number>();
  const receipts = new Map<string, QueryPreview>();
  const requests: { method: string; path: string; body?: Record<string, unknown> }[] = [];
  let sequence = 0;
  let loseCreation = false;
  let loseWrite = false;
  let failOperation = false;
  let mismatchUri = false;
  let failProbe = false;
  let rejectCreation = 0;
  let malformedUri = false;
  branches.set('br-source', { id: 'br-source', project_id: projectId, name: 'production',
    created_at: '2026-01-01T00:00:00Z', current_state: 'ready', default: true });
  endpoints.set('ep-source', { id: 'ep-source', project_id: projectId, branch_id: 'br-source', host: 'ep-source.test.neon.tech', type: 'read_write' });
  values.set('br-source', 120);
  const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
  const fetcher: typeof fetch = async (input, init) => {
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${credential}`);
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://console.neon.tech');
    assert.equal(init?.redirect, 'error');
    const path = url.pathname.replace(`/api/v2/projects/${projectId}`, '');
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    requests.push({ method, path, body });
    if (method === 'POST' && path === '/branches') {
      validateContract(body, official.createBranch);
      assert.deepEqual(Object.keys(body!).sort(), ['annotation_value', 'branch', 'endpoints']);
      if (rejectCreation) { const status = rejectCreation; rejectCreation = 0; return response({}, status); }
      sequence++;
      const requested = body!.branch as { name: string; parent_id: string };
      const parent = branches.get(requested.parent_id);
      assert(parent);
      const branch: Branch = { id: `br-child-${sequence}`, project_id: projectId, name: requested.name,
        created_at: `2026-01-02T00:00:${String(sequence).padStart(2, '0')}Z`, current_state: 'ready',
        parent_id: parent.id, parent_lsn: '0/1234' };
      branches.set(branch.id, branch);
      annotations.set(branch.id, body!.annotation_value as Record<string, string>);
      values.set(branch.id, values.get(parent.id)!);
      const endpoint: Endpoint = { id: `ep-child-${sequence}`, project_id: projectId, branch_id: branch.id,
        host: `ep-child-${sequence}.test.neon.tech`, type: (body!.endpoints as Endpoint[])[0]!.type };
      endpoints.set(endpoint.id, endpoint);
      if (loseCreation) { loseCreation = false; throw new Error('simulated dropped response'); }
      return response({ branch, endpoints: [endpoint], operations: [{ id: `op-${sequence}`, project_id: projectId, status: 'running' }] }, 201);
    }
    if (method === 'GET' && path === '/branches') {
      return response({ branches: [...branches.values()].filter(branch => branch.name.includes(url.searchParams.get('search') ?? '')),
        pagination: {} });
    }
    if (method === 'GET' && path.startsWith('/operations/')) {
      return response({ operation: { id: path.split('/').at(-1), project_id: projectId, status: failOperation ? 'error' : 'finished' } });
    }
    if (method === 'GET' && path === '/connection_uri') {
      const endpoint = endpoints.get(url.searchParams.get('endpoint_id')!);
      assert(endpoint);
      assert.equal(endpoint.branch_id, url.searchParams.get('branch_id'));
      assert.equal(url.searchParams.get('pooled'), 'false');
      assert.equal(url.searchParams.get('database_name'), 'neondb');
      assert.equal(url.searchParams.get('role_name'), 'reader');
      return response({ uri: `postgresql://reader:${malformedUri ? '%FF' : sqlPassword}@${mismatchUri ? 'evil.invalid' : endpoint.host}/neondb?sslmode=require` });
    }
    const branchId = path.match(/^\/branches\/([^/]+)$/)?.[1];
    if (method === 'GET' && branchId) {
      const branch = branches.get(branchId);
      return branch ? response({ branch, annotation: { value: annotations.get(branchId) ?? {} } }) : response({}, 404);
    }
    const endpointBranchId = path.match(/^\/branches\/([^/]+)\/endpoints$/)?.[1];
    if (method === 'GET' && endpointBranchId) {
      return response({ endpoints: [...endpoints.values()].filter(endpoint => endpoint.branch_id === endpointBranchId) });
    }
    if (method === 'DELETE' && branchId) {
      if ([...branches.values()].some(branch => branch.parent_id === branchId)) return response({}, 409);
      if (branches.get(branchId)?.default) return response({}, 403);
      branches.delete(branchId);
      for (const endpoint of endpoints.values()) if (endpoint.branch_id === branchId) endpoints.delete(endpoint.id);
      return response({ operations: [{ id: `delete-${branchId}`, project_id: projectId, status: 'running' }] });
    }
    const endpointId = path.match(/^\/endpoints\/([^/]+)$/)?.[1];
    if (method === 'DELETE' && endpointId) {
      endpoints.delete(endpointId);
      return response({ operations: [{ id: `delete-${endpointId}`, project_id: projectId, status: 'running' }] });
    }
    throw new Error(`Unexpected simulated API route ${method} ${path}`);
  };
  const provider = new NeonProvider(fetcher);
  const preview = (value: number): QueryPreview => ({ columns: ['value'], rows: [{ value }], rowCount: 1, truncated: false,
    target: { database: 'neondb', user: 'reader', address: '10.0.0.1', port: 5432 } });
  const branchFor = (connection: ClientConfig) => {
    const endpoint = [...endpoints.values()].find(endpoint => endpoint.host === connection.host);
    assert(endpoint);
    return endpoint.branch_id;
  };
  provider.sql.query = async (connection, input) => {
    if (failProbe && input.sql === 'SELECT 1 AS connected') throw new Error('SQL permission denied');
    return preview(values.get(branchFor(connection))!);
  };
  provider.sql.execute = async (connection, _input, receipt) => {
    const branchId = branchFor(connection);
    assert.notEqual(branchId, 'br-source');
    values.set(branchId, 181);
    const result = preview(181);
    receipts.set(receipt.runId, result);
    if (loseWrite) { loseWrite = false; throw new WriteOutcomeError(true, 'response lost after commit'); }
    return result;
  };
  provider.sql.receipt = async (_connection, _environmentId, runId) => receipts.get(runId);
  return { provider, branches, endpoints, annotations, values, requests,
    loseCreation: () => { loseCreation = true; }, loseWrite: () => { loseWrite = true; },
    failOperation: () => { failOperation = true; }, mismatchUri: () => { mismatchUri = true; }, failProbe: () => { failProbe = true; },
    rejectCreation: (status: number) => { rejectCreation = status; }, malformedUri: () => { malformedUri = true; } };
}
function source(projectPath = '/tmp'): NeonSource {
  return { id: randomUUID(), name: 'Neon test', projectPath, projectId, branchId: 'br-source', database: 'neondb', user: 'reader',
    apiKeyRef: 'env:STELLANE_NEON_CONTRACT_KEY', createdAt: new Date().toISOString() };
}
function operation(providerId: string, kind: 'checkpoint' | 'fork' = 'checkpoint'): BranchOperation {
  const operationId = randomUUID();
  return { id: operationId, kind, providerId, providerKind: 'neon', parentEnvironmentId: randomUUID(),
    resource: `stellane-${operationId}`, actor: owner, status: 'pending', createdAt: new Date().toISOString(),
    environment: { id: randomUUID(), name: 'test', projectPath: '/tmp', mode: kind === 'checkpoint' ? 'fixed' : 'branch',
      access: kind === 'checkpoint' ? 'read-only' : 'read-write', createdAt: new Date().toISOString() } };
}

test('Neon verifies source, SQL destination, certificates and reset identity', async () => {
  const f = fixture(); const s = source();
  const binding = await f.provider.sourceBinding(s, signal);
  const connection = await f.provider.connect(s, binding, signal);
  assert.deepEqual(connection.ssl, { rejectUnauthorized: true });
  assert.equal(connection.host, 'ep-source.test.neon.tech');
  f.mismatchUri();
  await assert.rejects(f.provider.connect(s, binding, signal), /连接与已验证/);
  f.branches.get('br-source')!.last_reset_at = '2026-02-01T00:00:00Z';
  await assert.rejects(f.provider.connect(s, binding, signal), /身份或恢复位置/);
});

test('Neon dropped creation response reconciles ownership without replaying POST', async () => {
  const f = fixture(); const s = source();
  const parent = await f.provider.sourceBinding(s, signal);
  const op = operation(s.id);
  f.loseCreation();
  await assert.rejects(f.provider.create(s, parent, op, request => { op.request = structuredClone(request); }, signal), /未确认/);
  assert(op.request);
  const recovered = await f.provider.resumeCreation(s, op, signal);
  assert.equal(recovered.checkpoint, true);
  assert.equal(recovered.managed, true);
  assert.equal(f.requests.filter(request => request.method === 'POST').length, 1);
  f.annotations.get(recovered.branchId)!['stellane-operation-id'] = randomUUID();
  await assert.rejects(f.provider.resumeCreation(s, op, signal), /不属于原创建/);
  await assert.rejects(f.provider.remove(s, recovered, randomUUID(), undefined, () => {}, signal), /身份或恢复位置/);
  assert.equal(f.requests.filter(request => request.method === 'DELETE').length, 0);
});

test('Neon checkpoints reject new writable computes and failed operations stay unresolved', async () => {
  const f = fixture(); const s = source();
  const parent = await f.provider.sourceBinding(s, signal);
  const op = operation(s.id);
  const checkpoint = await f.provider.create(s, parent, op, request => { op.request = structuredClone(request); }, signal);
  f.endpoints.set('ep-external', { id: 'ep-external', project_id: projectId, branch_id: checkpoint.branchId,
    host: 'ep-external.test.neon.tech', type: 'read_write' });
  await assert.rejects(f.provider.connect(s, checkpoint, signal), /可写 compute/);
  const fork = operation(s.id, 'fork');
  await assert.rejects(f.provider.create(s, checkpoint, fork, request => { fork.request = request; }, signal), /可写 compute/);
  assert.equal(fork.request, undefined);
  assert.equal(f.requests.filter(request => request.method === 'POST').length, 1);
  const failed = operation(s.id);
  f.failOperation();
  await assert.rejects(f.provider.create(s, parent, failed, request => { failed.request = structuredClone(request); }, signal), /后台操作失败/);
  await assert.rejects(f.provider.resumeCreation(s, failed, signal), /后台操作失败/);
  assert.equal(f.requests.filter(request => request.method === 'POST').length, 2);
});

test('Neon cleanup waits for known operations even after a branch or compute disappears', async () => {
  for (const kind of ['branch', 'compute'] as const) {
    const f = fixture(); const s = source();
    const parent = await f.provider.sourceBinding(s, signal);
    const op = operation(s.id);
    const checkpoint = await f.provider.create(s, parent, op, request => { op.request = structuredClone(request); }, signal);
    let saved: NeonRemoval | undefined;
    f.failOperation();
    await assert.rejects(f.provider.remove(s, checkpoint, op.environment.id, saved, value => { saved = structuredClone(value); }, signal, kind), /后台操作失败/);
    assert(saved?.operationIds?.length);
    assert.equal(kind === 'branch' ? f.branches.has(checkpoint.branchId) : f.endpoints.has(checkpoint.endpointId), false);
    await assert.rejects(f.provider.remove(s, checkpoint, op.environment.id, saved, () => {}, signal, kind), /后台操作失败/);
    assert.equal(f.requests.filter(request => request.method === 'DELETE').length, 1);
  }
});

test('Neon reset during a lost creation acknowledgement is never adopted as the original result', async () => {
  const f = fixture(); const s = source();
  const parent = await f.provider.sourceBinding(s, signal);
  const op = operation(s.id);
  f.loseCreation();
  await assert.rejects(f.provider.create(s, parent, op, request => { op.request = structuredClone(request); }, signal));
  f.branches.get('br-child-1')!.last_reset_at = '2026-02-01T00:00:00Z';
  await assert.rejects(f.provider.resumeCreation(s, op, signal), /已被重置/);
  assert.equal(f.requests.filter(request => request.method === 'POST').length, 1);
});

test('Neon errors do not echo API secrets or untrusted server messages', async () => {
  const provider = new NeonProvider(async () => new Response(JSON.stringify({ message: credential, password: sqlPassword }), { status: 401 }));
  await assert.rejects(provider.sourceBinding(source(), signal), error => {
    assert(error instanceof Error);
    assert.match(error.message, /401/);
    assert(!error.message.includes(credential));
    assert(!error.message.includes(sqlPassword));
    return true;
  });
  const invalid = new NeonProvider(async () => new Response(JSON.stringify({ branch: { id: credential }, annotation: { value: { [sqlPassword]: 1 } } })));
  await assert.rejects(invalid.sourceBinding(source(), signal), error => {
    assert(error instanceof Error);
    assert.match(error.message, /不符合预期/);
    assert(!error.message.includes(credential) && !error.message.includes(sqlPassword));
    return true;
  });
  const f = fixture(); const s = source(); const binding = await f.provider.sourceBinding(s, signal);
  f.malformedUri();
  await assert.rejects(f.provider.connect(s, binding, signal), /无效连接/);
});

test('Neon archived sources are explicitly rejected', async () => {
  const f = fixture();
  f.branches.get('br-source')!.current_state = 'archived';
  await assert.rejects(f.provider.sourceBinding(source(), signal), /不支持已归档/);
  assert.equal(f.requests.length, 1);
});

test('connectNeon accepts a read-only replica URL and keeps only private API key references', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stellane-neon-onboarding-'));
  const directory = join(root, 'state');
  const f = fixture();
  f.endpoints.set('ep-replica', { id: 'ep-replica', project_id: projectId, branch_id: 'br-source',
    host: 'ep-replica.test.neon.tech', type: 'read_only' });
  const core = new StellaneCore(directory, undefined, undefined, f.provider);
  try {
    const url = `postgresql://reader:${sqlPassword}@ep-replica-pooler.test.neon.tech/neondb?sslmode=require&channel_binding=require`;
    const environment = await core.connectNeon({ name: 'replica', projectPath: root, connectionString: url,
      projectId, branchId: 'br-source', apiKey: credential });
    assert.equal(environment.neon!.endpointId, 'ep-replica');
    const saved = core.snapshot().neonSources![0]!;
    assert(saved.apiKeyRef.startsWith('file:'));
    assert.equal((await stat(saved.apiKeyRef.slice(5))).mode & 0o777, 0o600);
    assert.equal((await readFile(saved.apiKeyRef.slice(5), 'utf8')).trimEnd(), credential);
    assert.equal((await stat(join(directory, 'credentials'))).mode & 0o777, 0o700);
    const serialized = JSON.stringify(core.snapshot());
    assert(!serialized.includes(credential) && !serialized.includes(sqlPassword) && !serialized.includes(url));
    assert.equal(environment.mode, 'live');
    assert.equal(environment.access, 'read-only');
  } finally { await core.close(); await rm(root, { recursive: true, force: true }); }
});

test('connectNeon rolls back registration and credentials on host mismatch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stellane-neon-onboarding-failure-'));
  const directory = join(root, 'state'); const f = fixture();
  const core = new StellaneCore(directory, undefined, undefined, f.provider);
  try {
    await assert.rejects(core.connectNeon({ name: 'wrong branch', projectPath: root,
      connectionString: `postgresql://reader:${sqlPassword}@ep-unrelated.test.neon.tech/neondb?sslmode=require`,
      projectId, branchId: 'br-source', apiKey: credential }), /项目或分支不一致/);
    assert.equal(core.snapshot().neonSources!.length, 0);
    assert.equal(core.snapshot().environments.length, 0);
    assert.deepEqual(await readdir(join(directory, 'credentials')), []);
    assert(!f.requests.some(request => request.path === '/connection_uri'));
  } finally { await core.close(); await rm(root, { recursive: true, force: true }); }
});

test('Core requires SQL access before registering a Neon source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stellane-neon-probe-'));
  const f = fixture(); f.failProbe();
  const core = new StellaneCore(join(root, 'state'), undefined, undefined, f.provider);
  try {
    const { id: _id, createdAt: _createdAt, ...input } = source(root);
    await assert.rejects(core.saveNeon(input), /SQL permission denied/);
    assert.equal(core.snapshot().environments.length, 0);
    assert.equal(core.snapshot().neonSources!.length, 0);
  } finally { await core.close(); await rm(root, { recursive: true, force: true }); }
});

test('Core Neon experiments isolate sessions, reconcile commits and retain dependency storage honestly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stellane-neon-lifecycle-'));
  const f = fixture();
  let core = new StellaneCore(join(root, 'state'), undefined, undefined, f.provider);
  try {
    const { id: _id, createdAt: _createdAt, ...input } = source(root);
    const sourceEnvironment = await core.saveNeon(input);
    const actor: Actor = { kind: 'agent', id: 'experiment-session', projectPath: root, callId: 'start' };
    const peer = { ...actor, id: 'unrelated-session' };
    const detail = await core.startConversationExperiment({ environmentId: sourceEnvironment.id, name: 'Compare a change' }, actor);
    assert.equal(detail.experiment.status, 'active');
    assert.equal(describeEnvironment(detail.baseline!).checkpointGuarantee, 'managed-read-only');
    assert.equal(describeEnvironment(sourceEnvironment).canExperiment, true);
    assert.equal(describeEnvironment(detail.work!).canExperiment, false);
    assert.equal((await core.environments(peer)).length, 1);
    await assert.rejects(core.query({ environmentId: detail.work!.id, sql: 'SELECT 1' }, peer), /无权/);
    await assert.rejects(core.write({ environmentId: sourceEnvironment.id, sql: 'UPDATE records SET value=181' }, actor), /只能写入/);
    f.loseWrite();
    const write = await core.write({ environmentId: detail.work!.id, sql: 'UPDATE records SET value=181' }, { ...actor, callId: 'write' });
    assert.equal(write.status, 'unknown');
    assert.equal((await core.reconcileRun(write.id, actor)).status, 'succeeded');
    assert.equal(f.values.get('br-source'), 120);
    const result = await core.captureExperiment({ id: detail.experiment.id, summary: '181 in isolated branch', sql: 'SELECT value FROM records' }, undefined, actor);
    assert.equal(result.delivered!.run.preview!.rows[0]!.value, 181);
    const closed = await core.finishExperiment(detail.experiment.id, undefined, actor);
    assert.equal(closed.experiment.status, 'closed');
    assert.match(closed.experiment.retentionNote!, /存储仍保留/);
    assert.match(closed.work!.retainedReason!, /compute 已移除/);
    assert(closed.work!.removedAt);
    assert(closed.baseline!.removedAt);
    assert(f.branches.has(closed.work!.neon!.branchId));
    assert(!f.endpoints.has(closed.work!.neon!.endpointId));
    assert(f.endpoints.has(closed.result!.neon!.endpointId));
    assert.equal((await core.query({ environmentId: closed.result!.id, sql: 'SELECT value FROM records' }, owner)).preview!.rows[0]!.value, 181);
    await assert.rejects(core.query({ environmentId: closed.work!.id, sql: 'SELECT 1' }, owner), /已清理/);
    assert(!JSON.stringify(core.snapshot()).includes(credential));
    assert(!JSON.stringify(core.snapshot()).includes(sqlPassword));
    await core.close();
    core = new StellaneCore(join(root, 'state'), undefined, undefined, f.provider);
    assert.equal(core.experimentDetail(detail.experiment.id).experiment.status, 'closed');
    assert.equal(f.requests.filter(request => request.method === 'POST').length, 3);
  } finally { await core.close(); await rm(root, { recursive: true, force: true }); }
});

test('Core recovers an interrupted Neon experiment by the original creation request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stellane-neon-recovery-'));
  const f = fixture();
  let core = new StellaneCore(join(root, 'state'), undefined, undefined, f.provider);
  try {
    const { id: _id, createdAt: _createdAt, ...input } = source(root);
    const environment = await core.saveNeon(input);
    const request = { id: randomUUID(), environmentId: environment.id, name: 'Interrupted trial' };
    f.loseCreation();
    assert.equal((await core.startExperiment(request)).experiment.status, 'preparing');
    assert.equal(core.snapshot().operations[0]!.status, 'unknown');
    await core.close();
    core = new StellaneCore(join(root, 'state'), undefined, undefined, f.provider);
    const recovered = await core.startExperiment(request);
    assert.equal(recovered.experiment.status, 'active');
    assert.equal(f.requests.filter(item => item.method === 'POST').length, 2);
    // Owner can discard an unfinished experiment. Delete descendants before parents.
    const closed = await core.finishExperiment(request.id);
    assert.equal(closed.experiment.status, 'closed');
    assert.equal(closed.experiment.retentionNote, undefined);
    assert.equal(f.branches.size, 1);
    assert(f.branches.has('br-source'));
  } finally { await core.close(); await rm(root, { recursive: true, force: true }); }
});

test('confirmed Neon creation rejection can be retried or abandoned without an unknown resource', async () => {
  for (const action of ['retry', 'discard']) {
    const root = await mkdtemp(join(tmpdir(), 'stellane-neon-rejected-')); const f = fixture();
    const core = new StellaneCore(join(root, 'state'), undefined, undefined, f.provider);
    try {
      const { id: _id, createdAt: _createdAt, ...input } = source(root);
      const environment = await core.saveNeon(input);
      const request = { id: randomUUID(), environmentId: environment.id, name: 'Permission corrected' };
      f.rejectCreation(403);
      const rejected = await core.startExperiment(request);
      assert.equal(rejected.experiment.status, 'preparing');
      assert.equal(core.snapshot().operations[0]!.status, 'failed');
      assert.equal(core.snapshot().operations[0]!.rejectedAttempts?.[0]?.status, 403);
      assert.equal(f.branches.size, 1);
      if (action === 'retry') {
        assert.equal((await core.startExperiment(request)).experiment.status, 'active');
        assert.equal(f.requests.filter(item => item.method === 'POST').length, 3);
        assert(core.snapshot().operations.some(item => item.status === 'succeeded' && item.rejectedAttempts?.[0]?.status === 403));
      }
      assert.equal((await core.finishExperiment(request.id)).experiment.status, 'closed');
      assert.equal(f.branches.size, 1);
    } finally { await core.close(); await rm(root, { recursive: true, force: true }); }
  }
});

test('knowledge on a retained Neon read-only branch is rechecked and survives compute address changes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stellane-neon-memory-'));
  const store = new Store(directory);
  try {
    const f = fixture(); const s = source(); const parent = await f.provider.sourceBinding(s, signal);
    const op = operation(s.id);
    const neon = await f.provider.create(s, parent, op, request => { op.request = structuredClone(request); }, signal);
    const metadata: DatabaseMetadata = { databaseOid: '11', snapshot: '1:2:', profileTables: ['101'], lineage: [],
      relations: [{ oid: '101', schema: 'public', name: 'events', kind: 'r', comment: null, view: null, constraints: [],
        columns: [{ ordinal: 1, name: 'event_id', type: 'integer', typeOid: '23', nullable: false, default: null,
          comment: null, identity: '', generated: '', collationOid: '0' }] }] };
    const target = { database: 'neondb', user: 'reader', address: '10.0.0.1', port: 5432 };
    const context: ContextRecord = { id: randomUUID(), environmentId: op.environment.id, projectPath: directory,
      dataSourceId: s.id, sourceFingerprint: 'source-proof', schemaFingerprint: 'schema-proof', catalogFingerprint: 'catalog-proof',
      runId: randomUUID(), state: { environmentId: op.environment.id, dataSourceId: s.id, mode: 'fixed', observedAt: new Date().toISOString(),
        target, databaseOid: '11', neon, identityBasis: 'neon-branch', dataVersion: { kind: 'observation', snapshot: metadata.snapshot } } };
    const memory = new KnowledgeMemory(store);
    const learned = await memory.learn({ kind: 'row-key', target: { schema: 'public', table: 'events', columns: ['event_id'] } },
      context, metadata, async () => ({ id: randomUUID(), environmentId: context.environmentId, projectPath: directory,
        actor: owner, sql: 'key profile', values: [], status: 'succeeded', startedAt: context.state.observedAt,
        finishedAt: context.state.observedAt, target, neon, preview: { columns: ['metadata', 'source'],
          rows: [{ metadata, source: { rows: '3', nullRows: '0', duplicateKeys: '0' } }], rowCount: 1, truncated: false, target } }), signal);
    assert(learned.accepted);
    assert.equal(memory.view(context, metadata)[0]!.status, 'needs-check');
    const resumed: ContextRecord = { ...context, state: { ...context.state, target: { ...target, address: '10.0.0.2' } } };
    assert.equal(memory.view(resumed, metadata)[0]!.status, 'needs-check');
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});
