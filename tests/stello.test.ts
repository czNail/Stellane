import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import { test } from 'node:test';
import { StellaneCore } from '../src/core/index.ts';
import { Store } from '../src/core/store.ts';
import { encodeResource, sameIdentity, StelloProvider, StelloRequestError } from '../src/providers/stello.ts';
import type { Actor, BranchIdentity, Environment, StelloSource } from '../src/shared/models.ts';

const configPath = process.env.STELLANE_STELLO_CONFIG ?? fileURLToPath(new URL('../.stellane-dev/stello/provider.json', import.meta.url));
const input = JSON.parse(await readFile(configPath, 'utf8'));
const owner: Actor = { kind: 'user', id: 'owner' };

test('real Stello inheritance, sibling isolation, fixed delivery and unknown-write reconciliation', { timeout: 300000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'stellane-branches-'));
  const branches = new StelloProvider();
  let core = new StellaneCore(root);
  let provider: StelloSource | undefined;
  const owned = new Map<string, BranchIdentity>();
  const remember = () => {
    for (const env of core.snapshot().environments) if (env.stello?.managed) owned.set(env.stello.resource, env.stello.identity);
    for (const op of core.snapshot().operations) if (op.request) owned.set(op.resource, op.request.identity as BranchIdentity);
  };
  const query = async (environment: Environment, sql = 'SELECT value FROM sample_data WHERE id=1') => {
    const run = await core.query({ environmentId: environment.id, sql }, owner);
    assert.equal(run.status, 'succeeded', run.error); return run;
  };
  const write = async (environment: Environment, sql: string, actor = owner) => {
    const run = await core.write({ environmentId: environment.id, sql }, actor);
    assert.equal(run.status, 'succeeded', run.error); return run;
  };
  const derive = async (kind: 'checkpoint' | 'fork', environment: Environment, name: string) => {
    const result = await core.derive(kind, { environmentId: environment.id, name }, owner); remember(); return result;
  };
  try {
    const baseline = await core.saveStello(input);
    provider = core.snapshot().providers[0]!;
    assert.equal((await query(baseline)).preview?.rows[0]?.value, 120);
    await assert.rejects(core.write({ environmentId: baseline.id, sql: 'UPDATE sample_data SET value=0' }, owner), /只能写入/);
    const fixed = await derive('checkpoint', baseline, 'base');
    const parent = await derive('fork', fixed, 'parent');
    const parentActor: Actor = { kind: 'agent', id: 'integration-parent', projectPath: input.projectPath, callId: 'stable-write-call' };
    const statement = 'UPDATE sample_data SET value=value+1 WHERE id=1 RETURNING value';
    const changed = await write(parent, statement, parentActor);
    const duplicate = await write(parent, statement, parentActor);
    assert.equal(duplicate.id, changed.id);
    await assert.rejects(core.write({ environmentId: parent.id, sql: 'DELETE FROM sample_data' }, parentActor), /原调用标识/);
    assert.equal(changed.preview?.affectedRows, 1);
    await write(parent, 'CREATE TABLE task_notes (note text NOT NULL)');
    await write(parent, "INSERT INTO task_notes VALUES ('父任务已调查')");
    const semanticContext = await core.context({ environmentId: parent.id }, owner);
    await core.importCatalog({ environmentId: parent.id, baseContextId: semanticContext.context.id, requestId: randomUUID(),
      document: { source: { name: 'Generic fixture dictionary' }, entries: [{ key: 'sample.value', title: 'Sample value', kind: 'description',
        content: 'The value field is a numeric measurement.', targets: [{ schema: 'public', table: 'sample_data', columns: ['value'] }] }] } }, owner);
    const cut = await derive('checkpoint', parent, 'parent-cut');
    const fixedContext = await core.context({ environmentId: cut.id, query: 'Sample value' }, owner);
    assert.equal(fixedContext.context.state.dataVersion.kind, 'fixed-position');
    assert.equal(fixedContext.context.state.dataVersion.position, cut.stello!.forkLsn);
    assert.equal(fixedContext.definitions.length, 1);
    const rowKey = { kind: 'row-key', target: { schema: 'public', table: 'sample_data', columns: ['id'] } };
    const fixedKey = await core.learn({ environmentId: cut.id, claim: rowKey }, parentActor);
    assert(fixedKey.accepted);
    assert.equal((await core.context({ environmentId: cut.id, query: 'sample_data' }, parentActor)).knowledge[0]?.status, 'observed');
    const [a, b] = await Promise.all([derive('fork', cut, 'child-a'), derive('fork', cut, 'child-b')]);
    const branchContext = await core.context({ environmentId: a.id, query: 'Sample value' }, owner);
    assert.equal(branchContext.context.state.dataVersion.kind, 'observation');
    assert.equal(branchContext.context.state.dataVersion.position, undefined);
    assert.equal(branchContext.definitions[0]?.version, 1);
    assert.deepEqual(branchContext.knowledge, []);
    const branchKey = await core.learn({ environmentId: a.id, claim: rowKey }, parentActor);
    assert(branchKey.accepted);
    assert.equal((await core.context({ environmentId: a.id, query: 'sample_data' }, parentActor)).knowledge[0]?.status, 'needs-check');
    assert.deepEqual((await core.context({ environmentId: b.id, query: 'sample_data' }, parentActor)).knowledge, []);
    assert.equal((await query(a)).preview?.rows[0]?.value, 121);
    assert.deepEqual((await query(b, 'SELECT note FROM task_notes')).preview?.rows, [{ note: '父任务已调查' }]);
    await write(parent, 'UPDATE sample_data SET value=122 WHERE id=1');
    const child: Actor = { kind: 'agent', id: 'integration-child-a', projectPath: input.projectPath };
    await Promise.all([write(a, 'UPDATE sample_data SET value=201 WHERE id=1', child),
      write(b, 'UPDATE sample_data SET value=301 WHERE id=1')]);
    assert.equal((await query(baseline)).preview?.rows[0]?.value, 120);
    assert.equal((await query(parent)).preview?.rows[0]?.value, 122);
    assert.equal((await query(cut)).preview?.rows[0]?.value, 121);
    assert.equal((await query(a)).preview?.rows[0]?.value, 201);
    assert.equal((await query(b)).preview?.rows[0]?.value, 301);
    const foreign: Actor = { kind: 'agent', id: 'foreign-agent', projectPath: root };
    await assert.rejects(core.derive('checkpoint', { environmentId: a.id, name: 'denied' }, foreign), /无权/);
    await assert.rejects(core.write({ environmentId: a.id, sql: 'DELETE FROM sample_data' }, foreign), /无权/);
    const stale = structuredClone(provider);
    const staleBinding = structuredClone(a.stello!); staleBinding.identity.incarnation++;
    await assert.rejects(branches.connect(stale, staleBinding, new AbortController().signal), /身份已变化/);
    const delivered = await core.deliver({ environmentId: a.id, recipientEnvironmentId: parent.id,
      summary: '方案 A：父状态加上子任务的独立调整', sql: 'SELECT value FROM sample_data WHERE id=1' }, child);
    remember();
    assert.equal(delivered.run.preview?.rows[0]?.value, 201);
    await write(a, 'UPDATE sample_data SET value=202 WHERE id=1');
    assert.equal((await query(delivered.environment)).preview?.rows[0]?.value, 201);
    const grandchild = await derive('fork', delivered.environment, 'grandchild');
    assert.equal((await query(grandchild)).preview?.rows[0]?.value, 201);
    const results = await core.results(parent.id, owner);
    assert.equal(results[0]?.delivery.runId, delivered.run.id);
    assert.equal(results[0]?.environment.stello?.forkLsn, delivered.environment.stello?.forkLsn);
    await assert.rejects(core.results(parent.id, foreign), /无权/);
    for (const sql of ['COMMIT', '/* outer /* nested */ */ ROLLBACK', 'BEGIN', 'SELECT 1; COMMIT;',
      'WITH changed AS (UPDATE sample_data SET value=0 RETURNING *) SELECT * FROM changed; COMMIT']) {
      const rejected = await core.write({ environmentId: b.id, sql }, owner);
      assert.equal(rejected.status, 'failed', sql);
    }
    assert.equal((await query(b)).preview?.rows[0]?.value, 301);
    await core.close();
    const store = new Store(root);
    store.put('runs', { ...changed, status: 'running', preview: undefined, target: undefined });
    store.close();
    core = new StellaneCore(root);
    assert.equal(core.snapshot().runs.find(run => run.id === changed.id)?.status, 'unknown');
    assert.equal((await core.write({ environmentId: parent.id, sql: statement }, parentActor)).status, 'unknown');
    const reconciled = await core.reconcileRun(changed.id, owner);
    assert.equal(reconciled.status, 'succeeded');
    assert.equal(reconciled.preview?.rows[0]?.value, 121);
    assert.equal((await query(parent)).preview?.rows[0]?.value, 122);
    assert.equal((await core.results(parent.id, owner))[0]?.delivery.id, delivered.delivery.id);
    await writeFile(join(dirname(configPath), 'integration-report.json'), JSON.stringify({
      parent: parent.id, childA: a.id, childB: b.id, delivery: delivered.delivery.id,
      sourceLsn: cut.stello!.forkLsn, checks: ['inheritance', 'sibling-isolation', 'fixed-delivery', 'nested-fork', 'identity-fence', 'project-fence', 'transaction-fence', 'receipt-without-replay'],
    }, null, 2), { mode: 0o600 });
  } finally {
    remember(); await core.close();
    // Only test-created resource identities are eligible for cleanup.
    if (provider) for (const [resource, identity] of [...owned].reverse()) {
      const signal = AbortSignal.timeout(60000);
      const name = encodeResource(resource);
      let observed;
      try { observed = await branches.operation(provider, { action: 'branch_get', name }, signal) as { identity: BranchIdentity; revision: number; state: string }; }
      catch (error) { if (error instanceof StelloRequestError && error.status === 404 && error.code === 'not_found') continue; throw error; }
      assert(sameIdentity(observed.identity, identity), 'Refuse cleanup of a replacement identity');
      if (observed.state === 'deleted') continue;
      await branches.operation(provider, { action: 'branch_change', name, identity, expected_revision: observed.revision,
        operation: 'delete', operation_id: randomUUID().replaceAll('-', '') }, signal);
      while (true) {
        const state = await branches.operation(provider, { action: 'branch_get', name }, signal) as { state: string; complete: boolean };
        if (state.state === 'deleted' && state.complete) break;
        await setTimeout(400, undefined, { signal });
      }
    }
    await rm(root, { recursive: true, force: true });
  }
});
