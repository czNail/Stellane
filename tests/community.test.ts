import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { StellaneCore } from '../src/core/index.ts';
import type { Actor } from '../src/shared/models.ts';

const connection = JSON.parse(await readFile(new URL('../.stellane-dev/connection.json', import.meta.url), 'utf8'));
function sql(statement: string) {
  const container = 'stellane-phase1-postgres';
  assert.equal(execFileSync('docker', ['inspect', '--format', '{{ index .Config.Labels "com.stellane.owner" }}', container], { encoding: 'utf8' }).trim(), 'stellane-phase1');
  execFileSync('docker', ['exec', '-i', container, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'stellane'],
    { input: statement, stdio: ['pipe', 'pipe', 'pipe'] });
}

test('plain PostgreSQL supports URL onboarding, lineage, cross-chat memory, changed data and metric evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stellane-community-'));
  const schema = `community_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  let core = new StellaneCore(directory);
  const actor: Actor = { kind: 'agent', id: 'first-chat', projectPath: connection.projectPath };
  const next: Actor = { ...actor, id: 'next-chat' };
  try {
    sql(`CREATE SCHEMA ${schema};
      CREATE TABLE ${schema}.locations (station_key text, area text);
      CREATE TABLE ${schema}.readings (reading_no integer, station_ref text, units integer);
      INSERT INTO ${schema}.locations VALUES ('station-a','North'),('station-b','South');
      INSERT INTO ${schema}.readings VALUES (1,'station-a',10),(2,'station-a',20),(3,'station-b',30),(4,'station-b',40);
      CREATE VIEW ${schema}.area_totals AS SELECT area, SUM(units) AS units
        FROM ${schema}.readings r JOIN ${schema}.locations l ON r.station_ref=l.station_key GROUP BY area;
      GRANT USAGE ON SCHEMA ${schema} TO stellane_reader;
      GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO stellane_reader;`);
    const password = (await readFile(connection.passwordRef.slice(5), 'utf8')).replace(/\r?\n$/, '');
    const connectionString = `postgresql://${encodeURIComponent(connection.user)}:${encodeURIComponent(password)}@${connection.host}:${connection.port}/${connection.database}?sslmode=disable`;
    const environment = await core.connectPostgres({ name: 'Ordinary PostgreSQL', projectPath: connection.projectPath, connectionString });
    assert.equal((await core.environments(next))[0]!.id, environment.id);
    const context = await core.context({ environmentId: environment.id, query: 'area_totals' }, actor);
    assert(context.knowledge.some(item => item.fact.kind === 'view-lineage' && item.fact.upstream.table === 'readings'));
    const claim = { kind: 'join', from: { schema, table: 'readings', columns: ['station_ref'] },
      to: { schema, table: 'locations', columns: ['station_key'] } };
    const learned = await core.learn({ environmentId: environment.id, claim }, actor);
    assert(learned.accepted);
    const plan = { environmentId: environment.id, name: 'Units per area', relationshipIds: [learned.knowledge.id], groupColumn: 'area', amountColumn: 'units' };
    const first = await core.metric(plan, actor);
    assert.equal(first.metric?.status, 'complete');
    assert.equal(first.metric?.counts?.total, '4');
    assert.equal(first.metric?.counts?.totalAmount, '100');
    await core.close();
    core = new StellaneCore(directory);
    const reused = await core.context({ environmentId: environment.id, query: 'readings' }, next);
    assert.equal(reused.knowledge.find(item => item.id === learned.knowledge.id)?.status, 'needs-check');
    sql(`UPDATE ${schema}.readings SET station_ref='missing-station' WHERE reading_no=2`);
    const after = await core.metric(plan, next);
    assert.equal(after.metric?.status, 'partial');
    assert.equal(after.metric?.counts?.total, '4');
    assert.equal(after.metric?.counts?.unattributed, '1');
    assert.equal(after.metric?.counts?.unattributedAmount, '20');
    assert.equal(after.metric?.counts?.totalAmount, '100');
    const catalog = await core.catalogView(environment.id, { kind: 'user', id: 'owner' });
    const old = catalog.knowledge.find(item => item.id === learned.knowledge.id);
    assert.equal(old?.status, 'stale');
    assert(old && 'invalidation' in old && old.invalidation?.unmatchedRows === '1');
    assert.equal(old.invalidation.evidence.method, 'metric-coverage');
    assert.equal(old.invalidation.evidence.runId, after.id);
    assert.match(old.invalidation.scope!, /Units per area/);
    assert(!(await core.context({ environmentId: environment.id, query: 'readings' }, next)).knowledge.some(item => item.id === learned.knowledge.id));
    assert.equal(core.evidence(after.id).metric?.version, first.metric?.version);
    assert(!JSON.stringify(core.snapshot()).includes(password));
    await assert.rejects(core.startConversationExperiment({ environmentId: environment.id, name: 'Attempt unsupported write experiment' }, next), /Neon|Stello|分支/);
    assert.equal(core.snapshot().experiments.length, 0);
  } finally {
    await core.close();
    sql(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await rm(directory, { recursive: true, force: true });
  }
});
