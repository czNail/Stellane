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
const owner: Actor = { kind: 'user', id: 'owner' };
const agent: Actor = { kind: 'agent', id: 'knowledge-author', projectPath: connection.projectPath };
const reader: Actor = { ...agent, id: 'knowledge-reader' };
const container = 'stellane-phase1-postgres';

function sql(statement: string): void {
  assert.equal(execFileSync('docker', ['inspect', '--format', '{{ index .Config.Labels "com.stellane.owner" }}', container], { encoding: 'utf8' }).trim(), 'stellane-phase1');
  execFileSync('docker', ['exec', '-i', container, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'stellane'],
    { input: statement, stdio: ['pipe', 'pipe', 'pipe'] });
}

test('knowledge records implicit keys and joins with evidence and reads current view lineage', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stellane-knowledge-'));
  const schema = `know_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  let core = new StellaneCore(directory);
  try {
    sql(`CREATE SCHEMA ${schema};
      CREATE TABLE ${schema}.groups (group_code text, region integer, label text);
      CREATE TABLE ${schema}.measurements (event_no integer, group_code text, region integer, amount integer);
      INSERT INTO ${schema}.groups VALUES ('A',1,'Alpha'),('A',2,'Alpha East'),('B',1,'Beta');
      INSERT INTO ${schema}.measurements VALUES (1,'A',1,120),(2,'A',1,80),(3,'A',2,160);
      CREATE VIEW ${schema}.group_totals AS SELECT g.label,SUM(m.amount) AS total
        FROM ${schema}.measurements m JOIN ${schema}.groups g USING (group_code,region) GROUP BY g.label;
      CREATE VIEW ${schema}.positive_totals AS SELECT label,total FROM ${schema}.group_totals WHERE total>0;
      GRANT USAGE ON SCHEMA ${schema} TO stellane_reader;
      GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO stellane_reader;`);
    const saved = await core.saveConnection(connection);
    const env = core.createEnvironment({ connectionId: saved.id, name: 'knowledge integration' });
    const peer = core.createEnvironment({ connectionId: saved.id, name: 'separate environment' });
    const environmentId = env.id;
    const before = await core.context({ environmentId, query: 'positive_totals' }, agent);
    const upstream = before.knowledge.find(item => item.fact.kind === 'view-lineage'
      && item.fact.downstream.table === 'positive_totals');
    assert(upstream && upstream.fact.kind === 'view-lineage');
    assert.equal(upstream.fact.upstream.table, 'group_totals');
    assert.deepEqual(upstream.fact.upstream.columns, ['label', 'total']);
    assert.equal(upstream.status, 'declared');
    assert.equal(upstream.evidence.runId, before.context.runId);
    const claim = { kind: 'join', from: { schema, table: 'measurements', columns: ['region', 'group_code'] },
      to: { schema, table: 'groups', columns: ['region', 'group_code'] } } as const;
    await assert.rejects(core.learn({ environmentId, claim }, { ...reader, projectPath: directory }), /无权/);
    const rowKey = await core.learn({ environmentId, claim: { kind: 'row-key', target: { schema, table: 'measurements', columns: ['event_no'] } } }, agent);
    assert(rowKey.accepted && rowKey.knowledge.fact.kind === 'row-key');
    assert.equal(rowKey.knowledge.fact.profile.rows, '3');
    const join = await core.learn({ environmentId, claim }, agent);
    assert(join.accepted && join.knowledge.fact.kind === 'join');
    assert.equal(join.knowledge.fact.cardinality, 'many-to-one');
    assert.equal(join.knowledge.fact.unmatchedRows, '0');
    const context = await core.context({ environmentId, query: 'measurements' }, reader);
    assert.equal(context.knowledge.find(item => item.id === join.knowledge.id)?.status, 'needs-check');
    assert(context.relations.some(relation => relation.name === 'groups'));
    assert(context.context.selection?.knowledgeIds?.includes(join.knowledge.id));
    assert(!(await core.context({ environmentId: peer.id, query: 'measurements' }, reader)).knowledge.some(item => item.fact.kind === 'join'));

    sql(`UPDATE ${schema}.measurements SET amount=amount+10 WHERE event_no=1`);
    const duplicate = await core.learn({ environmentId, claim }, reader);
    assert(duplicate.accepted && 'version' in duplicate.knowledge);
    assert.equal(duplicate.knowledge.id, join.knowledge.id);
    assert.equal(duplicate.knowledge.version, 1);
    sql(`INSERT INTO ${schema}.groups VALUES ('A',1,'Conflicting label')`);
    const rejected = await core.learn({ environmentId, claim }, reader);
    assert(!rejected.accepted);
    assert.match(rejected.reason, /不唯一/);
    assert(!(await core.context({ environmentId, query: 'measurements' }, reader)).knowledge.some(item => item.fact.kind === 'join'));
    const afterReject = await core.catalogView(environmentId, owner);
    assert.equal(afterReject.knowledge.find(item => item.id === join.knowledge.id)?.status, 'stale');
    sql(`DELETE FROM ${schema}.groups WHERE label='Conflicting label'`);
    const recovered = await core.learn({ environmentId, claim }, reader);
    assert(recovered.accepted && 'version' in recovered.knowledge);
    assert.equal(recovered.knowledge.version, 2);
    await core.close();
    core = new StellaneCore(directory);
    assert((await core.context({ environmentId, query: 'measurements' }, reader)).knowledge.some(item => item.id === recovered.knowledge.id));
    sql(`REVOKE SELECT ON ${schema}.groups FROM stellane_reader`);
    const limited = await core.context({ environmentId, query: 'group_totals measurements' }, reader);
    assert(!limited.knowledge.some(item => item.fact.kind === 'join' || item.fact.kind === 'view-lineage' && item.fact.upstream.table === 'groups'));
  } finally {
    await core.close();
    sql(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await rm(directory, { recursive: true, force: true });
  }
});
