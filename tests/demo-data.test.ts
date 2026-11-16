import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { StellaneCore } from '../src/core/index.ts';
import type { Actor, Run } from '../src/shared/models.ts';
import type { KnowledgeClaim } from '../src/shared/knowledge-models.ts';
import type { MetricInput } from '../src/shared/metric-models.ts';

interface Row { group_name: string | null; records: string; total: string }
interface Manifest {
  name: string; schema: string; metricSql: string; fingerprintSql: string;
  claims: KnowledgeClaim[];
  metric: Omit<MetricInput, 'environmentId' | 'relationshipIds'>;
  expected: Record<'baseline' | 'drift' | 'variantA' | 'variantB', Row[]>;
  capacitySql?: string;
  expectedCapacity?: Record<'variantA' | 'variantB', Record<string, string>[]>;
}

const connection = JSON.parse(await readFile(new URL('../.stellane-dev/connection.json', import.meta.url), 'utf8'));
const container = 'stellane-phase1-postgres';
function sql(statement: string): string {
  assert.equal(execFileSync('docker', ['inspect', '--format', '{{ index .Config.Labels "com.stellane.owner" }}', container],
    { encoding: 'utf8' }).trim(), 'stellane-phase1');
  return execFileSync('docker', ['exec', '-i', container, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'stellane'],
    { input: statement, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}
const jsonRows = (statement: string) => `SELECT coalesce(jsonb_agg(result), '[]'::jsonb) FROM (${statement}) AS result;`;
const readRows = (statement: string): unknown[] => JSON.parse(sql(jsonRows(statement)));
function metricRows(run: Run): Row[] {
  assert.equal(run.status, 'succeeded', run.error);
  return (run.preview?.rows ?? []).map(row => ({ group_name: row.归属 as string | null,
    records: String(row.记录数), total: String(row.合计) }));
}

for (const name of ['telemetry', 'support']) {
  test(`synthetic ${name}: published data, memory and each proposed change match independent expectations`, async () => {
    const folder = new URL(`../examples/datasets/${name}/`, import.meta.url);
    const manifest = JSON.parse(await readFile(new URL('manifest.json', folder), 'utf8')) as Manifest;
    assert.equal(manifest.schema, `stellane_demo_${name}`);
    const setup = await readFile(new URL('setup.sql', folder), 'utf8');
    const drift = await readFile(new URL('drift.sql', folder), 'utf8');
    const directory = await mkdtemp(join(tmpdir(), `stellane-demo-${name}-`));
    let core = new StellaneCore(directory);
    let created = false;
    const actor: Actor = { kind: 'agent', id: 'demo-first-chat', projectPath: connection.projectPath };
    const next: Actor = { ...actor, id: 'demo-next-chat' };
    try {
      // CREATE SCHEMA intentionally refuses an existing demo. A failed transaction
      // never makes this test the owner of an existing person's data.
      sql(`BEGIN; ${setup}
        GRANT USAGE ON SCHEMA ${manifest.schema} TO stellane_reader;
        GRANT SELECT ON ALL TABLES IN SCHEMA ${manifest.schema} TO stellane_reader;
        COMMIT;`);
      created = true;
      assert.deepEqual(readRows(manifest.metricSql), manifest.expected.baseline);
      const environment = await core.connectPostgres({ ...connection, name: `${name} fixture test` });
      const context = await core.context({ environmentId: environment.id, query: manifest.schema }, actor);
      assert(context.knowledge.some(item => item.fact.kind === 'view-lineage' && item.fact.upstream.schema === manifest.schema));
      const relationshipIds: string[] = [];
      for (const claim of manifest.claims) {
        const learned = await core.learn({ environmentId: environment.id, claim }, actor);
        assert(learned.accepted);
        relationshipIds.push(learned.knowledge.id);
      }
      const plan = { ...manifest.metric, environmentId: environment.id, relationshipIds };
      const baseline = await core.metric(plan, actor);
      assert.equal(baseline.metric?.status, 'complete');
      assert.deepEqual(metricRows(baseline), manifest.expected.baseline);
      await core.close();
      core = new StellaneCore(directory);
      const reused = await core.context({ environmentId: environment.id, query: manifest.schema }, next);
      for (const id of relationshipIds) assert.equal(reused.knowledge.find(item => item.id === id)?.status, 'needs-check');

      sql(drift);
      assert.deepEqual(readRows(manifest.metricSql), manifest.expected.drift);
      const changed = await core.metric(plan, next);
      assert.equal(changed.metric?.status, 'partial');
      assert.equal(changed.metric?.version, baseline.metric?.version);
      assert.deepEqual(metricRows(changed), manifest.expected.drift);
      const catalog = await core.catalogView(environment.id, { kind: 'user', id: 'owner' });
      assert(catalog.knowledge.some(item => 'invalidation' in item && item.invalidation?.evidence.runId === changed.id));

      const originalFingerprint = readRows(manifest.fingerprintSql);
      sql(drift);
      assert.deepEqual(readRows(manifest.fingerprintSql), originalFingerprint, 'Drift must be repeatable without accumulating changes.');
      // These transactions verify the published example SQL and expected numbers.
      // They are not a substitute for provider branch isolation tests.
      for (const [variant, filename] of [['variantA', 'variant-a.sql'], ['variantB', 'variant-b.sql']] as const) {
        const change = await readFile(new URL(filename, folder), 'utf8');
        const observed = JSON.parse(sql(`BEGIN; ${change}\n${jsonRows(manifest.metricSql)} ROLLBACK;`));
        assert.deepEqual(observed, manifest.expected[variant]);
        if (manifest.capacitySql && manifest.expectedCapacity) {
          const capacity = JSON.parse(sql(`BEGIN; ${change}\n${jsonRows(manifest.capacitySql)} ROLLBACK;`));
          assert.deepEqual(capacity, manifest.expectedCapacity[variant]);
        }
        assert.deepEqual(readRows(manifest.fingerprintSql), originalFingerprint, 'The next alternative starts from the same drifted data.');
      }
    } finally {
      await core.close();
      if (created) sql(`DROP SCHEMA ${manifest.schema} CASCADE`);
      await rm(directory, { recursive: true, force: true });
    }
  });
}
