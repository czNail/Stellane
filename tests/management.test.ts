import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ClientConfig } from 'pg';
import { StellaneCore } from '../src/core/index.ts';
import { Store } from '../src/core/store.ts';
import { PostgresProvider, secret, type QueryProvider } from '../src/providers/postgres.ts';
import { StelloProvider } from '../src/providers/stello.ts';
import { NeonProvider } from '../src/providers/neon.ts';
import type { NeonBinding, NeonRemoval, NeonSource } from '../src/shared/neon-models.ts';
import type { Actor, BranchBinding, BranchOperation, BranchRemoval, Cell, ConnectionInput, QueryInput, QueryPreview, StelloSource } from '../src/shared/models.ts';
import type { DatabaseMetadata } from '../src/shared/context-models.ts';

const owner: Actor = { kind: 'user', id: 'owner' };
const target = { database: 'app', user: 'reader', address: '127.0.0.1', port: 5432 };
const preview = (): QueryPreview => ({ columns: ['value'], rows: [{ value: 1 }], rowCount: 1, truncated: false, target });
const connection = (projectPath: string): ConnectionInput => ({ name: 'test', projectPath, host: 'localhost', port: 5432,
  database: 'app', user: 'reader', passwordRef: 'env:STELLANE_MANAGEMENT_TEST', tls: 'disable' });
const provider: QueryProvider = { async probe() { return target; }, async query() { return preview(); } };
const input = (projectPath: string, password = 'initial') => ({ name: 'demo', projectPath, connectionString: `postgresql://reader:${password}@localhost/app` });

test('owner management fences disabled sources and rotates credentials only after a successful probe', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stellane-management-'));
  let fail = false;
  const passwords: string[] = [];
  const core = new StellaneCore(root, { ...provider, async probe(value) {
    passwords.push(await secret(value.passwordRef));
    if (fail) throw new Error('probe failed');
    return target;
  } });
  try {
    const source = await core.connectPostgres(input(root));
    const original = core.snapshot().connections[0]!.passwordRef;
    const evidence = await core.query({ environmentId: source.id, sql: 'SELECT 1' }, owner);
    const agent: Actor = { kind: 'agent', id: 'chat', projectPath: root };
    assert.throws(() => core.management(agent), /所有者/);
    await assert.rejects(core.manage({ action: 'set-source-enabled', environmentId: source.id, enabled: false }, agent), /所有者/);
    await core.manage({ action: 'set-source-enabled', environmentId: source.id, enabled: false });
    assert.deepEqual(await core.environments(agent), []);
    await assert.rejects(core.query({ environmentId: source.id, sql: 'SELECT 1' }, owner), /停用/);
    assert.deepEqual(core.evidence(evidence.id), evidence);
    assert.throws(() => core.createEnvironment({ connectionId: source.connectionId, name: 'bypass' }), /停用/);
    fail = true;
    await assert.rejects(core.manage({ action: 'rotate-postgres', environmentId: source.id, connectionString: input(root, 'rejected').connectionString }), /probe failed/);
    assert.equal(core.snapshot().connections[0]!.passwordRef, original);
    assert.equal((await readdir(join(root, 'credentials'))).length, 1);
    fail = false;
    await assert.rejects(core.manage({ action: 'rotate-postgres', environmentId: source.id, connectionString: 'postgres://reader:new@localhost/other' }), /不能改变/);
    await core.manage({ action: 'rotate-postgres', environmentId: source.id, connectionString: input(root, 'replacement').connectionString });
    const changed = core.snapshot().connections[0]!.passwordRef;
    assert.notEqual(changed, original);
    assert.equal(await secret(changed), 'replacement');
    await assert.rejects(stat(original.slice(5)), { code: 'ENOENT' });
    assert(!JSON.stringify(core.snapshot()).includes('replacement'));
    await core.manage({ action: 'set-source-enabled', environmentId: source.id, enabled: true });
    assert.equal((await core.query({ environmentId: source.id, sql: 'SELECT 1' }, agent)).status, 'succeeded');
    assert.deepEqual(passwords, ['initial', 'rejected', 'replacement']);
  } finally { await core.close(); await rm(root, { recursive: true, force: true }); }
});

test('credential rotation preserves certificate verification and required channel binding before probing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stellane-management-transport-'));
  const probes: Array<{ password: string; tls: string; binding?: string }> = [];
  let fail = false;
  const core = new StellaneCore(root, { ...provider, async probe(value) {
    probes.push({ password: await secret(value.passwordRef), tls: value.tls, binding: value.channelBinding });
    if (fail) throw new Error('replacement rejected');
    return target;
  } });
  const secure = (password: string) => `${input(root, password).connectionString}?sslmode=verify-full&channel_binding=require`;
  try {
    const source = await core.connectPostgres({ ...input(root), connectionString: secure('initial') });
    const original = core.snapshot().connections[0]!;
    for (const connectionString of [
      `${input(root, 'new').connectionString}?sslmode=disable`,
      `${input(root, 'new').connectionString}?sslmode=verify-full&channel_binding=prefer`,
    ]) {
      await assert.rejects(core.manage({ action: 'rotate-postgres', environmentId: source.id, connectionString }), /原 TLS 和通道绑定/);
      assert.deepEqual(core.snapshot().connections[0], original);
      assert.equal(await secret(original.passwordRef), 'initial');
      assert.equal((await readdir(join(root, 'credentials'))).length, 1);
    }
    assert.equal(probes.length, 1, 'a changed transport must never receive the replacement secret');
    fail = true;
    await assert.rejects(core.manage({ action: 'rotate-postgres', environmentId: source.id, connectionString: secure('rejected') }), /replacement rejected/);
    assert.deepEqual(core.snapshot().connections[0], original);
    assert.equal((await readdir(join(root, 'credentials'))).length, 1);
    fail = false;
    await core.manage({ action: 'rotate-postgres', environmentId: source.id, connectionString: secure('replacement') });
    const updated = core.snapshot().connections[0]!;
    assert.equal(updated.tls, 'verify-full');
    assert.equal(updated.channelBinding, 'require');
    assert.equal(await secret(updated.passwordRef), 'replacement');
    assert.notEqual(updated.passwordRef, original.passwordRef);
    assert.deepEqual(probes.map(value => value.password), ['initial', 'rejected', 'replacement']);
    assert(probes.every(value => value.tls === 'verify-full' && value.binding === 'require'));
  } finally { await core.close(); await rm(root, { recursive: true, force: true }); }
});

test('remove preserves evidence, purge requires the source name, and external/shared credentials are never deleted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stellane-purge-'));
  const core = new StellaneCore(join(root, 'state'), provider);
  const external = join(root, 'external-secret');
  await writeFile(external, 'external', { mode: 0o600 });
  try {
    const source = await core.connectPostgres(input(root));
    const reference = core.snapshot().connections[0]!.passwordRef;
    const shared = await core.saveConnection({ ...connection(root), passwordRef: reference });
    const evidence = await core.query({ environmentId: source.id, sql: 'SELECT 1' }, owner);
    await assert.rejects(core.manage({ action: 'remove-source', environmentId: source.id }), /先停用/);
    await core.manage({ action: 'set-source-enabled', environmentId: source.id, enabled: false });
    await core.manage({ action: 'remove-source', environmentId: source.id });
    assert.equal(await secret(reference), 'initial', 'another registration still references the owned file');
    assert.deepEqual(core.evidence(evidence.id), evidence);
    await assert.rejects(core.manage({ action: 'purge-source', environmentId: source.id, confirmation: source.name }), /其他连接/);
    const sharedSource = core.createEnvironment({ connectionId: shared.id, name: 'shared reference' });
    await core.manage({ action: 'rotate-postgres', environmentId: sharedSource.id, connectionString: input(root, 'independent').connectionString });
    await assert.rejects(core.manage({ action: 'purge-source', environmentId: source.id, confirmation: 'wrong' }), /准确输入/);
    await core.manage({ action: 'purge-source', environmentId: source.id, confirmation: source.name });
    assert.throws(() => core.evidence(evidence.id), /不存在/);
    assert.notEqual(core.snapshot().connections.find(item => item.id === shared.id)?.passwordRef, reference);
    await assert.rejects(stat(reference.slice(5)), { code: 'ENOENT' });
    const externalSource = await core.connectPostgres({ ...connection(root), name: 'external', passwordRef: `file:${external}` });
    await core.manage({ action: 'set-source-enabled', environmentId: externalSource.id, enabled: false });
    await core.manage({ action: 'purge-source', environmentId: externalSource.id, confirmation: 'external' });
    assert.equal(await readFile(external, 'utf8'), 'external');
  } finally { await core.close(); await rm(root, { recursive: true, force: true }); }
});

test('management does not remove a source while a query or an unknown outcome is live', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stellane-management-busy-'));
  let entered!: () => void; let release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const wait = new Promise<void>(resolve => { release = resolve; });
  let core = new StellaneCore(root, { ...provider, async query() { entered(); await wait; return preview(); } });
  try {
    const source = await core.connectPostgres(input(root));
    const pending = core.query({ environmentId: source.id, sql: 'SELECT 1' }, owner);
    await started;
    await assert.rejects(core.manage({ action: 'set-source-enabled', environmentId: source.id, enabled: false }), /正在执行/);
    release(); const done = await pending;
    await core.close();
    const store = new Store(root);
    store.put('runs', { ...done, status: 'unknown', kind: 'execute' });
    store.close(); core = new StellaneCore(root, provider);
    await core.manage({ action: 'set-source-enabled', environmentId: source.id, enabled: false });
    await assert.rejects(core.manage({ action: 'purge-source', environmentId: source.id, confirmation: source.name }), /未核实/);
    assert.equal(core.evidence(done.id).status, 'unknown');
  } finally { release(); await core.close(); await rm(root, { recursive: true, force: true }); }
});

const metadata: DatabaseMetadata = { databaseOid: '1', snapshot: '2:2:', profileTables: ['42'], lineage: [], relations: [{
  oid: '42', schema: 'public', name: 'events', kind: 'r', comment: null, view: null, constraints: [],
  columns: [{ ordinal: 1, name: 'id', type: 'integer', typeOid: '23', nullable: false, default: null, comment: null,
    identity: '', generated: '', collationOid: '0' }],
}] };
const metadataProvider: QueryProvider = { ...provider, async query() {
  return { ...preview(), rows: [{ metadata: metadata as unknown as Cell, source: { rows: '3', nullRows: '0', duplicateKeys: '0' } }] };
} };

test('archiving releases capacity without reviving old definitions or removing recorded evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stellane-archive-'));
  let core = new StellaneCore(root, metadataProvider);
  const claim = { kind: 'row-key', target: { schema: 'public', table: 'events', columns: ['id'] } };
  try {
    const source = await core.connectPostgres(input(root));
    const learned = await core.learn({ environmentId: source.id, claim }, owner);
    assert(learned.accepted);
    const context = await core.context({ environmentId: source.id }, owner);
    const definition = (content: string, expectedVersion: number) => ({ key: 'events.count', title: 'Event count', kind: 'metric',
      content, expectedVersion, targets: [{ schema: 'public', table: 'events', columns: ['id'] }] });
    const first = await core.importCatalog({ environmentId: source.id, baseContextId: context.context.id, requestId: randomUUID(),
      document: { source: { name: 'test' }, entries: [definition('first', 0)] } }, owner);
    const second = await core.importCatalog({ environmentId: source.id, baseContextId: context.context.id, requestId: randomUUID(),
      document: { source: { name: 'test' }, entries: [definition('second', 1)] } }, owner);
    await core.manage({ action: 'archive-definition', id: second[0]!.id });
    assert.equal((await core.context({ environmentId: source.id }, owner)).definitions.length, 0);
    assert.equal((await core.catalogView(source.id, owner)).versions.find(item => item.definition.id === first[0]!.id)?.status, 'superseded');
    await core.close();
    const store = new Store(root);
    const original = store.get('knowledge', learned.knowledge.id);
    for (let index = 0; index < 127; index++) store.put('knowledge', { ...original, id: randomUUID(), key: `other-${index}` });
    for (let index = 0; index < 127; index++) store.put('definitions', { ...first[0]!, id: randomUUID(), key: `other.${index}` });
    store.close(); core = new StellaneCore(root, metadataProvider);
    const thirdRequest = { environmentId: source.id, baseContextId: context.context.id, requestId: randomUUID(),
      document: { source: { name: 'test' }, entries: [definition('third', 2)] } };
    await assert.rejects(core.importCatalog(thirdRequest, owner), /128/);
    await core.manage({ action: 'archive-definition', id: first[0]!.id });
    const third = await core.importCatalog(thirdRequest, owner);
    assert.equal(third[0]!.version, 3);
    await core.manage({ action: 'archive-knowledge', id: original.id });
    const repeated = await core.learn({ environmentId: source.id, claim }, owner);
    assert(repeated.accepted && 'version' in repeated.knowledge);
    assert.notEqual(repeated.knowledge.id, original.id);
    assert.equal(repeated.knowledge.version, 2);
    assert.equal(core.evidence(original.evidence.runId).status, 'succeeded');
    assert(core.management().knowledge.find(item => item.id === original.id)?.archivedAt);
    assert(!(await core.context({ environmentId: source.id }, owner)).knowledge.some(item => item.id === original.id));
  } finally { await core.close(); await rm(root, { recursive: true, force: true }); }
});

class Branches extends StelloProvider {
  failRemoval = true;
  calls: { id: string; saved?: BranchRemoval }[] = [];
  override readonly sql = new class extends PostgresProvider {
    override async query(_connection: ConnectionInput | ClientConfig, _input: QueryInput) { return preview(); }
  }();
  override async inspect(_source: StelloSource, resource: string) {
    return { name: resource, identity: { service: 'demo', slot: 0, incarnation: 1 }, resource_id: resource, mode: 'writable' as const,
      fork_lsn: '0/1', complete: true, state: 'ready' };
  }
  override async connect(_source: StelloSource, _binding: BranchBinding): Promise<ClientConfig> { return { host: 'localhost' }; }
  override async create(source: StelloSource, _parent: BranchBinding, operation: BranchOperation,
    prepared: (request: Record<string, unknown>) => void): Promise<BranchBinding> {
    prepared({ identity: { service: 'demo', slot: this.calls.length + 1, incarnation: 1 } });
    return { providerId: source.id, resource: operation.resource, identity: { service: 'demo', slot: 1, incarnation: 1 },
      resourceId: operation.id, forkLsn: '0/2', managed: true, creationId: operation.id };
  }
  override async remove(_source: StelloSource, binding: BranchBinding, id: string, saved: BranchRemoval | undefined,
    persist: (removal: BranchRemoval) => void): Promise<void> {
    this.calls.push({ id, saved });
    const intent = saved ?? { id, name: binding.resource, identity: binding.identity, expected_revision: 1, operation_id: id.replaceAll('-', '') };
    if (!saved) persist(intent);
    if (this.failRemoval) { this.failRemoval = false; throw new Error('removal reply lost'); }
    assert.deepEqual(saved, this.calls[0]?.id === id ? intent : saved);
  }
}

test('retained resource removal is owner-only, leaf-first, identity-bound and retries the original deletion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stellane-resources-'));
  const branches = new Branches();
  const core = new StellaneCore(root, provider, branches);
  try {
    const source = await core.saveStello({ name: 'source', projectPath: root, configPath: '/unused', resource: 'demo/main' });
    const baseline = await core.derive('checkpoint', { environmentId: source.id, name: 'shared' }, owner);
    const work = await core.derive('fork', { environmentId: baseline.id, name: 'path' }, owner);
    const result = await core.derive('checkpoint', { environmentId: work.id, name: 'result' }, owner);
    await assert.rejects(core.manage({ action: 'remove-resource', environmentId: source.id }), /不能删除来源/);
    await assert.rejects(core.manage({ action: 'remove-resource', environmentId: baseline.id }), /子分支/);
    await assert.rejects(core.manage({ action: 'remove-resource', environmentId: work.id }), /子分支/);
    assert.equal(branches.calls.length, 0);
    const proof = await core.query({ environmentId: result.id, sql: 'SELECT 1' }, owner);
    await core.manage({ action: 'set-source-enabled', environmentId: source.id, enabled: false });
    await assert.rejects(core.query({ environmentId: result.id, sql: 'SELECT 1' }, owner), /停用/);
    await assert.rejects(core.manage({ action: 'remove-resource', environmentId: result.id }), /reply lost/);
    await assert.rejects(core.query({ environmentId: result.id, sql: 'SELECT 1' }, owner), /回收结果尚未确认/);
    await core.manage({ action: 'remove-resource', environmentId: result.id });
    assert(branches.calls[1]!.saved);
    assert.equal(branches.calls[1]!.saved!.id, result.id);
    assert.equal(core.evidence(proof.id).status, 'succeeded');
    await core.manage({ action: 'remove-resource', environmentId: work.id });
    await core.manage({ action: 'remove-resource', environmentId: baseline.id });
    assert.equal(core.management().resources.length, 0);
    await core.manage({ action: 'remove-source', environmentId: source.id });
    assert.equal(core.management().sources[0]!.removed, true);
    assert.equal(core.evidence(proof.id).status, 'succeeded');
    assert(branches.calls.every(item => item.id !== source.id));
  } finally { await core.close(); await rm(root, { recursive: true, force: true }); }
});

class NeonBranches extends NeonProvider {
  readonly bindings = new Map<string, NeonBinding>();
  readonly deletes: { branchId: string; kind: string; saved?: NeonRemoval }[] = [];
  failBranchDelete = true;
  override readonly sql = new class extends PostgresProvider {
    override async query(_connection: ConnectionInput | ClientConfig, _input: QueryInput) { return preview(); }
  }();
  override async sourceBinding(source: NeonSource): Promise<NeonBinding> {
    const binding: NeonBinding = { providerId: source.id, projectId: source.projectId, branchId: source.branchId,
      endpointId: 'ep-source', createdAt: '2026-01-01', managed: false, checkpoint: false };
    this.bindings.set(binding.branchId, binding); return binding;
  }
  override async connect(_source: NeonSource, binding: NeonBinding): Promise<ClientConfig> {
    assert(this.bindings.has(binding.branchId)); return { host: 'localhost' };
  }
  override async create(source: NeonSource, parent: NeonBinding, operation: BranchOperation,
    prepared: (request: Record<string, unknown>) => void): Promise<NeonBinding> {
    prepared({ original: operation.id });
    const binding: NeonBinding = { providerId: source.id, projectId: source.projectId, branchId: `br-${operation.id}`,
      endpointId: `ep-${operation.id}`, createdAt: new Date().toISOString(), parentId: parent.branchId, parentLsn: '0/1',
      managed: true, checkpoint: operation.kind === 'checkpoint', operationId: operation.id };
    this.bindings.set(binding.branchId, binding); return binding;
  }
  override async remove(_source: NeonSource, binding: NeonBinding, id: string, saved: NeonRemoval | undefined,
    persist: (removal: NeonRemoval) => void, _signal: AbortSignal, kind: NeonRemoval['kind'] = 'branch') {
    assert(binding.managed);
    this.deletes.push({ branchId: binding.branchId, kind, saved });
    const intent: NeonRemoval = saved ?? { id, kind, projectId: binding.projectId, branchId: binding.branchId, endpointId: binding.endpointId };
    assert.equal(intent.kind, kind);
    if (!saved) persist(intent);
    if (kind === 'compute') return;
    assert(![...this.bindings.values()].some(child => child.parentId === binding.branchId), 'Neon parents still have dependants');
    if (this.failBranchDelete) {
      this.failBranchDelete = false; persist({ ...intent, operationIds: ['original-delete-operation'] });
      throw new Error('asynchronous deletion unfinished');
    }
    this.bindings.delete(binding.branchId);
  }
}

test('Neon retained parents are reclaimed leaf-first with a separate branch intent and original asynchronous operation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stellane-neon-management-'));
  const neon = new NeonBranches();
  const core = new StellaneCore(root, provider, new Branches(), neon);
  try {
    const source = await core.saveNeon({ name: 'Neon source', projectPath: root, projectId: 'test-project', branchId: 'br-source',
      database: 'app', user: 'reader', apiKeyRef: 'env:STELLANE_MANAGEMENT_TEST' });
    const experiment = await core.startExperiment({ id: randomUUID(), environmentId: source.id, name: 'retained result' });
    const captured = await core.captureExperiment({ id: experiment.experiment.id, summary: 'evidence', sql: 'SELECT 1' });
    assert(captured.delivered);
    const finished = await core.finishExperiment(experiment.experiment.id);
    assert.equal(finished.experiment.status, 'closed');
    assert(finished.work?.retainedReason && finished.baseline?.retainedReason);
    assert.equal(core.management().resources.length, 3);
    await assert.rejects(core.manage({ action: 'remove-resource', environmentId: finished.baseline!.id }), /子分支/);
    await assert.rejects(core.manage({ action: 'remove-resource', environmentId: finished.result!.id }), /unfinished/);
    await core.manage({ action: 'remove-resource', environmentId: finished.result!.id });
    const retried = neon.deletes.filter(item => item.branchId === finished.result!.neon!.branchId);
    assert.deepEqual(retried[1]?.saved?.operationIds, ['original-delete-operation']);
    await core.manage({ action: 'remove-resource', environmentId: finished.work!.id });
    await core.manage({ action: 'remove-resource', environmentId: finished.baseline!.id });
    assert.equal(core.management().resources.length, 0);
    assert.equal(neon.bindings.size, 1);
    assert(neon.bindings.has('br-source'));
    assert.equal(core.evidence(captured.delivered.run.id).status, 'succeeded');
    await core.manage({ action: 'set-source-enabled', environmentId: source.id, enabled: false });
    await core.manage({ action: 'purge-source', environmentId: source.id, confirmation: source.name });
    assert.equal(core.management().sources.length, 0);
  } finally { await core.close(); await rm(root, { recursive: true, force: true }); }
});
