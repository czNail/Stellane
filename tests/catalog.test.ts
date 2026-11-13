import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { StellaneCore } from '../src/core/index.ts';
import type { Actor } from '../src/shared/models.ts';

const connection=JSON.parse(await readFile(new URL('../.stellane-dev/connection.json',import.meta.url),'utf8'));
const owner:Actor={kind:'user',id:'owner'};
const container='stellane-phase1-postgres';
function sql(statement:string):void {
  assert.equal(execFileSync('docker',['inspect','--format','{{ index .Config.Labels "com.stellane.owner" }}',container],{encoding:'utf8'}).trim(),'stellane-phase1');
  execFileSync('docker',['exec','-i',container,'psql','-X','-v','ON_ERROR_STOP=1','-U','postgres','-d','stellane'],{input:statement,encoding:'utf8',stdio:['pipe','pipe','pipe']});
}

test('real semantic context: metadata, evidence, version CAS, scope and stale definitions',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'stellane-catalog-'));const schema=`ctx_${randomUUID().replaceAll('-','').slice(0,12)}`;
  let core=new StellaneCore(directory);
  try {
    sql(`CREATE SCHEMA ${schema};
      CREATE TABLE ${schema}.groups(id integer PRIMARY KEY,label text NOT NULL);
      CREATE TABLE ${schema}.measurements(id integer PRIMARY KEY,group_id integer NOT NULL REFERENCES ${schema}.groups(id),amount numeric(12,2) NOT NULL CHECK(amount>=0));
      CREATE TABLE ${schema}.hidden_notes(secret text);
      COMMENT ON TABLE ${schema}.measurements IS '可汇总的观测记录';
      COMMENT ON COLUMN ${schema}.measurements.amount IS '金额，单位元';
      INSERT INTO ${schema}.groups VALUES(1,'alpha'),(2,'beta');
      INSERT INTO ${schema}.measurements VALUES(1,1,120),(2,1,80),(3,2,160);
      GRANT USAGE ON SCHEMA ${schema} TO stellane_reader;
      GRANT SELECT ON ${schema}.groups,${schema}.measurements TO stellane_reader;`);
    const saved=await core.saveConnection(connection);const environment=core.createEnvironment({connectionId:saved.id,name:'context integration'});
    const actor:Actor={kind:'agent',id:'context-agent',projectPath:connection.projectPath};
    const initial=await core.context({environmentId:environment.id,query:'amount'},actor);
    const relation=initial.relations.find(item=>item.schema===schema && item.name==='measurements');assert(relation);
    assert.equal(relation.columns.find(item=>item.name==='amount')?.comment,'金额，单位元');
    assert(relation.constraints.some(item=>item.references?.table==='groups'));
    assert.equal(initial.context.state.dataVersion.kind,'observation');assert.equal(initial.context.state.dataVersion.position,undefined);
    const view=await core.catalogView(environment.id,owner);assert(!view.relations.some(item=>item.name==='hidden_notes'));
    await assert.rejects(core.catalogView(environment.id,actor),/仅供用户/);
    const count=core.snapshot().runs.length;
    await assert.rejects(core.context({environmentId:environment.id},{...actor,projectPath:directory}),/无权/);
    assert.equal(core.snapshot().runs.length,count);
    const document={source:{name:'指标词典',uri:'docs/metrics.json'},entries:[{key:'measurements.total',title:'总金额',kind:'metric' as const,
      content:'总金额为可见观测记录的金额之和，单位元。',targets:[{schema,table:'measurements',columns:['amount']}],
      sql:`SELECT SUM(amount) AS total FROM ${schema}.measurements`,expectedVersion:0}]};
    const input={environmentId:environment.id,baseContextId:view.context.id,requestId:randomUUID(),document};
    await assert.rejects(core.importCatalog(input,actor),/用户导入/);
    const imported=await core.importCatalog(input,owner);assert.equal(imported[0]?.version,1);
    assert.equal((await core.importCatalog(input,owner))[0]?.id,imported[0]?.id);
    await assert.rejects(core.importCatalog({...input,document:{...document,source:{name:'different'}}},owner),/原导入/);
    const relevant=await core.context({environmentId:environment.id,query:'总金额应该怎么计算',previousContextId:initial.context.id},actor);
    assert.equal(relevant.definitions[0]?.title,'总金额');assert.equal(relevant.definitions[0]?.source.name,'指标词典');
    assert.deepEqual(relevant.context.selection?.definitionIds,[imported[0]!.id]);
    assert(relevant.relations.some(item=>item.schema===schema && item.name==='measurements'));
    assert(relevant.relations.some(item=>item.schema===schema && item.name==='groups'));
    assert.equal(relevant.changes?.definitionsChanged,true);assert.equal(relevant.changes?.structureChanged,false);
    const calculated=await core.query({environmentId:environment.id,sql:relevant.definitions[0]!.sql},actor);
    assert.equal(calculated.preview?.rows[0]?.total,'360.00');
    sql(`UPDATE ${schema}.measurements SET amount=amount+10 WHERE id=1`);
    const changedData=await core.context({environmentId:environment.id,query:'总金额',previousContextId:relevant.context.id},actor);
    assert.equal(changedData.changes?.structureChanged,false);assert.equal(changedData.definitions.length,1);
    sql(`ALTER TABLE ${schema}.measurements ADD COLUMN unit text`);
    const changedSchema=await core.context({environmentId:environment.id,query:'总金额',previousContextId:relevant.context.id},actor);
    assert.equal(changedSchema.changes?.structureChanged,true);assert.equal(changedSchema.definitions.length,0);
    assert.equal(changedSchema.excluded[0]?.version,1);
    await assert.rejects(core.importCatalog({...input,requestId:randomUUID()},owner),/结构或身份已变化/);
    const updated={...document,entries:document.entries.map(entry=>({...entry,content:'总金额按最新对象结构加总 amount，单位元。',expectedVersion:1}))};
    const second=await core.importCatalog({environmentId:environment.id,baseContextId:changedSchema.context.id,requestId:randomUUID(),document:updated},owner);
    assert.equal(second[0]?.version,2);
    const races=await Promise.allSettled(['A','B'].map(suffix=>core.importCatalog({environmentId:environment.id,baseContextId:changedSchema.context.id,requestId:randomUUID(),
      document:{...updated,entries:updated.entries.map(entry=>({...entry,title:`总金额 ${suffix}`,expectedVersion:2}))}},owner)));
    assert.equal(races.filter(result=>result.status==='fulfilled').length,1);
    assert.equal(races.filter(result=>result.status==='rejected').length,1);
    const newView=await core.catalogView(environment.id,owner);assert.equal(newView.versions.length,3);
    assert.equal(newView.versions.filter(item=>item.status==='superseded').length,2);
    const peer=core.createEnvironment({connectionId:saved.id,name:'same source'});
    assert.equal((await core.context({environmentId:peer.id,query:'总金额'},actor)).definitions[0]?.version,3);
    await assert.rejects(core.context({environmentId:peer.id,previousContextId:initial.context.id},actor),/同一个环境/);
    const newConnection=await core.saveConnection(connection);const unrelated=core.createEnvironment({connectionId:newConnection.id,name:'new registration'});
    assert.equal((await core.context({environmentId:unrelated.id,query:'总金额'},actor)).definitions.length,0);
    await core.close();core=new StellaneCore(directory);
    assert.equal((await core.context({environmentId:environment.id,query:'总金额'},actor)).definitions[0]?.version,3);
    sql(`REVOKE SELECT ON ${schema}.measurements FROM stellane_reader`);
    const revoked=await core.context({environmentId:environment.id,query:'总金额'},actor);
    assert.equal(revoked.definitions.length,0);assert.equal(revoked.excluded.length,1);
  } finally {await core.close();sql(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await rm(directory,{recursive:true,force:true});}
});
