import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { StellaneCore } from '../src/core/index.ts';
import { NeonProvider } from '../src/providers/neon.ts';
import { neonInput, type NeonBinding, type NeonRemoval } from '../src/shared/neon-models.ts';
import type { Actor, Environment } from '../src/shared/models.ts';

const configPath = process.env.STELLANE_NEON_CONFIG;

test('live Neon isolates writes, retains evidence and removes only its test branches', {
  skip: configPath ? false : 'Set STELLANE_NEON_CONFIG to a dedicated Neon test source JSON to run cloud validation.',
  timeout: 600000,
}, async t => {
  const config = neonInput.parse(JSON.parse(await readFile(configPath!, 'utf8')));
  const directory = await mkdtemp(join(tmpdir(), 'stellane-neon-live-'));
  const reportPath = join(directory, 'report.json');
  const removals: Record<string, NeonRemoval> = {};
  const checks: string[] = [];
  const report: Record<string, unknown> = {
    startedAt: new Date().toISOString(), provider: 'neon-cloud', status: 'running',
    stateDirectory: directory, checks, removals,
  };
  const save = () => writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  const core = new StellaneCore(directory);
  const actor: Actor = { kind: 'agent', id: `neon-live-${randomUUID()}`, projectPath: config.projectPath };
  const sibling: Actor = { ...actor, id: `neon-sibling-${randomUUID()}` };
  const owner: Actor = { kind: 'user', id: 'owner' };
  const table = `stellane_live_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const qualified = `public.${table}`;
  report.table = qualified;
  save();
  try {
    const source = await core.saveNeon(config, t.signal);
    report.sourceEnvironmentId = source.id;
    const sourceTable = async () => {
      const run = await core.query({ environmentId: source.id, sql: 'SELECT to_regclass($1)::text AS relation', values: [qualified] }, actor, t.signal);
      assert.equal(run.status, 'succeeded', run.error);
      assert.equal(run.preview?.rows[0]?.relation, null, 'The random test table must not exist on the source branch.');
      return run.id;
    };
    report.sourceBeforeRunId = await sourceTable();
    const detail = await core.startConversationExperiment({ environmentId: source.id, name: `Neon live test ${table}` },
      { ...actor, callId: `start-${table}` }, t.signal);
    report.experimentId = detail.experiment.id;
    report.resources = { baseline: detail.baseline?.neon, work: detail.work?.neon };
    save();
    assert.equal(detail.experiment.status, 'active', detail.experiment.error);
    assert(detail.work?.neon?.managed && detail.baseline?.neon?.managed);
    const work = detail.work;
    await assert.rejects(core.query({ environmentId: work.id, sql: 'SELECT 1' }, sibling, t.signal), /无权/);
    await assert.rejects(core.conversationExperiments(sibling, detail.experiment.id), /无权/);
    checks.push('Sibling conversation cannot query the private work branch');

    const create = await core.write({ environmentId: work.id,
      sql: `CREATE TABLE ${qualified} (id integer PRIMARY KEY, value integer NOT NULL)` },
      { ...actor, callId: `create-${table}` }, t.signal);
    assert.equal(create.status, 'succeeded', create.error);
    const insert = await core.write({ environmentId: work.id,
      sql: `INSERT INTO ${qualified} (id, value) VALUES (1, 10), (2, 20), (3, 30)` },
      { ...actor, callId: `insert-${table}` }, t.signal);
    assert.equal(insert.status, 'succeeded', insert.error);
    const delivered = await core.captureExperiment({ id: detail.experiment.id, summary: 'Three synthetic rows total 60 in an isolated branch.',
      sql: `SELECT count(*) AS rows, sum(value) AS total FROM ${qualified}`, values: [] }, t.signal, actor);
    report.resources = { baseline: delivered.baseline?.neon, work: delivered.work?.neon, result: delivered.result?.neon };
    save();
    assert(delivered.delivered && delivered.result?.neon?.managed, delivered.experiment.error);
    assert.equal(delivered.delivered.run.status, 'succeeded', delivered.delivered.run.error);
    assert.equal(String(delivered.delivered.run.preview?.rows[0]?.rows), '3');
    assert.equal(String(delivered.delivered.run.preview?.rows[0]?.total), '60');
    report.evidenceRunId = delivered.delivered.run.id;
    report.sourceAfterRunId = await sourceTable();
    checks.push('Only the work branch contains the synthetic table; retained result reports 3 rows and total 60');

    const learned = await core.learn({ environmentId: delivered.result.id,
      claim: { kind: 'row-key', target: { schema: 'public', table, columns: ['id'] } } }, owner, t.signal);
    assert(learned.accepted);
    const context = await core.context({ environmentId: delivered.result.id, query: table }, owner, t.signal);
    assert.equal(context.knowledge.find(item => item.id === learned.knowledge.id)?.status, 'needs-check');
    checks.push('A retained Neon read-only result still requires memory revalidation');

    const finished = await core.finishExperiment(detail.experiment.id, t.signal, actor);
    assert.equal(finished.experiment.status, 'closed', finished.experiment.error);
    assert.match(finished.experiment.retentionNote ?? '', /保留/);
    assert(finished.work?.removedAt && finished.baseline?.removedAt);
    assert.equal(core.evidence(delivered.delivered.run.id).status, 'succeeded');
    report.retentionNote = finished.experiment.retentionNote;
    checks.push('Finish closes temporary access and reports the retained parent dependency');
    save();

    // The product retains result storage. This opt-in test subsequently deletes
    // only its exact recorded resources, leaf first, to avoid leaving cloud costs.
    // Any failed or unknown operation exits above and preserves its state instead.
    const provider = new NeonProvider();
    const registered = core.snapshot().neonSources?.find(item => item.id === source.neon?.providerId);
    assert(registered && source.neon);
    const ownBinding = (environment: Environment | undefined): NeonBinding => {
      assert(environment?.neon?.managed && environment.experimentId === detail.experiment.id);
      assert.equal(environment.neon.providerId, registered.id);
      assert.notEqual(environment.neon.branchId, source.neon!.branchId);
      assert(environment.neon.operationId);
      return environment.neon;
    };
    for (const environment of [finished.result, finished.work, finished.baseline]) {
      const binding = ownBinding(environment);
      const cleanupId = `live-test-${environment!.id}`;
      await provider.remove(registered, binding, cleanupId, removals[cleanupId], removal => {
        removals[cleanupId] = removal;
        save();
      }, t.signal, 'branch');
      checks.push(`Deleted own test branch ${binding.branchId}`);
      save();
    }
    await provider.connect(registered, source.neon, t.signal);
    report.sourceFinalRunId = await sourceTable();
    checks.push('The configured source branch remains connectable and unchanged by the test');
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed-needs-review';
    report.failure = error instanceof Error ? error.message : 'Cloud validation did not complete.';
    report.nextStep = 'Inspect the original Core state and removal intents. Reconcile unknown operations before cleanup; do not repeat the failed SQL or create another experiment blindly.';
    t.diagnostic(`Neon validation failed. Original state and cleanup intents are preserved at ${directory}`);
    throw error;
  } finally {
    await core.close();
    report.finishedAt = new Date().toISOString();
    save();
    t.diagnostic(`Neon live validation report: ${reportPath}`);
  }
});
