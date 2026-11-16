import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import pg from 'pg';
import { StellaneCore } from '../src/core/index.ts';
import { readLocalNeonConfig } from '../src/core/neon-local-onboarding.ts';
import { NeonProvider } from '../src/providers/neon.ts';
import type { Actor, Environment, Run } from '../src/shared/models.ts';

const configPath = resolve(process.env.STELLANE_NEON_LOCAL_CONFIG ?? '.stellane-dev/neon-local/provider.json');

test('real local Neon timelines preserve a shared baseline, isolate A/B and clean up exact resources', { timeout: 600000 }, async t => {
  const config = await readLocalNeonConfig(configPath);
  const directory = await mkdtemp(join(tmpdir(), 'stellane-local-neon-test-'));
  const core = new StellaneCore(directory);
  const owner: Actor = { kind: 'user', id: 'owner' };
  const actors: Actor[] = ['A', 'B'].map(name => ({ kind: 'agent', id: `local-${name}-${randomUUID()}`, projectPath: config.projectPath }));
  const table = `stellane_local_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const report: Record<string, unknown> = { provider: 'real-local-neon', stateDirectory: directory, startedAt: new Date().toISOString(), status: 'running', checks: [] };
  const checks = report.checks as string[];
  const save = () => writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  let admin: pg.Client | undefined;
  await save();
  const query = async (environment: Environment, actor = owner): Promise<Run> => {
    const result = await core.query({ environmentId: environment.id, sql: `SELECT count(*)::text AS records, sum(value)::text AS total FROM public.${table}` }, actor, t.signal);
    assert.equal(result.status, 'succeeded', result.error); return result;
  };
  try {
    const source = await core.saveNeon(config, t.signal);
    assert.equal(source.neon?.local, true);
    const registered = core.snapshot().neonSources!.find(item => item.id === source.neon!.providerId)!;
    admin = new pg.Client(await new NeonProvider().connect(registered, source.neon!, t.signal));
    await admin.connect();
    await admin.query(`CREATE TABLE public.${table} (id integer PRIMARY KEY, value integer NOT NULL)`);
    await admin.query(`INSERT INTO public.${table} VALUES (1,10),(2,20),(3,30)`);
    assert.deepEqual((await query(source)).preview?.rows, [{ records: '3', total: '60' }]);
    const baseline = await core.derive('checkpoint', { environmentId: source.id, name: 'Shared local test baseline' },
      { ...owner, callId: randomUUID() }, t.signal);
    assert.deepEqual((await query(baseline)).preview?.rows, [{ records: '3', total: '60' }]);
    const readOnly = new pg.Client(await new NeonProvider().connect(registered, baseline.neon!, t.signal));
    try {
      await readOnly.connect();
      await assert.rejects(readOnly.query(`INSERT INTO public.${table} VALUES (4,40)`), /read-only|recovery/i);
    } finally { await readOnly.end(); }
    checks.push('Baseline uses a real read-only Neon compute, including outside the plugin query wrapper');
    const experiments = [];
    for (const [index, actor] of actors.entries()) {
      const detail = await core.startConversationExperiment({ environmentId: baseline.id, name: `Local path ${index}` }, { ...actor, callId: randomUUID() }, t.signal);
      assert.equal(detail.experiment.status, 'active', detail.experiment.error);
      assert.equal(detail.baseline?.id, baseline.id);
      assert(detail.work); experiments.push(detail);
    }
    await assert.rejects(core.query({ environmentId: experiments[1]!.work!.id, sql: 'SELECT 1' }, actors[0]!, t.signal), /无权/);
    const results: Environment[] = [];
    for (let index = 0; index < experiments.length; index++) {
      const detail = experiments[index]!, actor = actors[index]!;
      const change = await core.write({ environmentId: detail.work!.id, sql: `UPDATE public.${table} SET value=${index === 0 ? 99 : 40} WHERE id=2` },
        { ...actor, callId: randomUUID() }, t.signal);
      assert.equal(change.status, 'succeeded', change.error);
      if (index === 0) assert.deepEqual((await query(experiments[1]!.work!, actors[1]!)).preview?.rows, [{ records: '3', total: '60' }]);
      const captured = await core.captureExperiment({ id: detail.experiment.id, summary: `Local path ${index}`,
        sql: `SELECT count(*)::text AS records, sum(value)::text AS total FROM public.${table}` }, t.signal, actor);
      assert(captured.result && captured.delivered, captured.experiment.error);
      assert.deepEqual(captured.delivered.run.preview?.rows, [{ records: '3', total: index === 0 ? '139' : '80' }]);
      results.push(captured.result);
      const finished = await core.finishExperiment(detail.experiment.id, t.signal, actor);
      assert.equal(finished.experiment.status, 'closed', finished.experiment.error);
    }
    assert.deepEqual((await query(results[0]!)).preview?.rows, [{ records: '3', total: '139' }]);
    assert.deepEqual((await query(source)).preview?.rows, [{ records: '3', total: '60' }]);
    checks.push('A and B share one baseline, isolate writes and access, retain distinct results and leave the source unchanged');
    const learned = await core.learn({ environmentId: results[0]!.id,
      claim: { kind: 'row-key', target: { schema: 'public', table, columns: ['id'] } } }, owner, t.signal);
    assert(learned.accepted);
    const context = await core.context({ environmentId: results[0]!.id, query: table }, owner, t.signal);
    assert.equal(context.knowledge.find(item => item.id === learned.knowledge.id)?.status, 'needs-check');
    checks.push('Local Neon retained results keep the conservative memory revalidation contract');
    while (true) {
      const remaining = core.management().resources;
      if (!remaining.length) break;
      const leaf = remaining.find(resource => resource.canRemove);
      assert(leaf, 'Every retained local resource must have an exact removable leaf.');
      await core.manage({ action: 'remove-resource', environmentId: leaf.environment.id }, owner, t.signal);
    }
    checks.push('Product resource management removed only this test’s retained leaves and ancestors');
    await admin.query(`DROP TABLE public.${table}`);
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed-needs-review'; report.error = error instanceof Error ? error.message : String(error);
    report.operations = core.snapshot().operations.map(item => ({ id: item.id, status: item.status, environmentId: item.environment.id }));
    throw error;
  } finally {
    await admin?.end().catch(() => {}); await core.close(); report.finishedAt = new Date().toISOString(); await save();
    console.log(`Local Neon evidence: ${join(directory, 'report.json')}`);
  }
});
