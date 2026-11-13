import { createHash, randomUUID } from 'node:crypto';
import { Store } from './store.ts';
import { catalogSql } from './catalog-sql.ts';
import { contextInput, importCatalogInput, metadataSchema } from '../shared/context-models.ts';
import type { CatalogView, ContextRecord, ContextResult, DefinitionStatus, SemanticDefinition } from '../shared/context-models.ts';
import type { Actor, Environment, Run } from '../shared/models.ts';

// Canonicalize JSONB key order before hashing; array order comes from catalog SQL.
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([key,item]) => [key,canonical(item)]));
  return value;
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const objectKey = (schema: string, table: string) => JSON.stringify([schema,table]);
type ReadMetadata = (environmentId: string, sql: string, actor: Actor, signal: AbortSignal) => Promise<Run>;
const notes = ['元数据只覆盖当前 SQL 角色拥有整表 SELECT 权限的用户对象。',
  '结构指纹不代表数据内容版本。实时库与可写分支仅记录本次观测，分支 forkLsn 是来源位置。',
  '业务说明来自导入文档；适用表示对象结构匹配。SQL 示例作为资料返回，未自动执行。'];

export class SemanticCatalog {
  private readonly store: Store;
  private readonly environment: (id: string) => Environment;
  private readonly read: ReadMetadata;
  constructor(store: Store, environment: (id: string) => Environment, read: ReadMetadata) { this.store=store; this.environment=environment; this.read=read; }
  private async observe(environmentId: string, actor: Actor, signal: AbortSignal): Promise<CatalogView> {
    // Authorization and verified branch connection happen in Core before any saved definitions are read.
    const run = await this.read(environmentId,catalogSql,actor,signal);
    if (run.status !== 'succeeded') throw new Error(`元数据读取失败：${run.error ?? run.status} 执行记录：${run.id}`);
    const parsed = metadataSchema.safeParse(run.preview?.rows[0]?.metadata);
    if (!parsed.success || run.preview?.truncated || !run.target) throw new Error('元数据不完整或超过上限（64 个对象、每对象 256 个字段、128 KiB），未生成上下文。');
    const metadata = parsed.data; const environment = this.environment(environmentId);
    const dataSourceId = environment.stello?.providerId ?? environment.connectionId!;
    let root = environment;
    for (let depth=0; root.parentEnvironmentId && depth<16; depth++) root=this.environment(root.parentEnvironmentId);
    const sourceFingerprint = hash(environment.stello
      ? [dataSourceId,root.stello?.identity,root.stello?.resourceId]
      : [dataSourceId,run.target,metadata.databaseOid]);
    const definitions = this.store.definitions(environment.projectPath,dataSourceId);
    const latest = new Map<string,SemanticDefinition>();
    for (const definition of definitions) if (!latest.has(definition.key) || latest.get(definition.key)!.version<definition.version) latest.set(definition.key,definition);
    const versions: DefinitionStatus[] = definitions.map(definition => {
      if (latest.get(definition.key)!.id!==definition.id) return { definition,status:'superseded',reason:'同一 key 已有更新版本。' };
      if (definition.sourceFingerprint!==sourceFingerprint) return { definition,status:'stale',reason:'数据源身份或实际目标已变化。' };
      for (const dependency of definition.dependencies) {
        const relation=metadata.relations.find(item=>item.schema===dependency.schema && item.name===dependency.table);
        if (!relation || hash(relation)!==dependency.fingerprint) return { definition,status:'stale',reason:`对象 ${dependency.schema}.${dependency.table} 不可见或结构、注释已变化，需要重新导入。` };
      }
      return { definition,status:'applicable',reason:'当前数据源与依赖对象元信息匹配。' };
    });
    const context: ContextRecord = { id:randomUUID(),environmentId,projectPath:environment.projectPath,dataSourceId,sourceFingerprint,
      schemaFingerprint:hash(metadata.relations),catalogFingerprint:hash([...latest.values()].sort((a,b)=>a.key.localeCompare(b.key)).map(item=>[item.id,item.version])),runId:run.id,
      state:{ environmentId,dataSourceId,mode:environment.mode,target:run.target,databaseOid:metadata.databaseOid,
        observedAt:run.finishedAt!,branch:run.branch,identityBasis:environment.stello?'stello-resource':'registration-and-target',
        dataVersion:environment.mode==='fixed' && run.branch ? {kind:'fixed-position',snapshot:metadata.snapshot,position:run.branch.forkLsn} : {kind:'observation',snapshot:metadata.snapshot} } };
    this.store.put('contexts',context); return { context,relations:metadata.relations,versions,notes };
  }
  view(environmentId: string,actor: Actor,signal: AbortSignal): Promise<CatalogView> {
    if (actor.kind!=='user') return Promise.reject(new Error('完整目录与历史仅供用户查看。'));
    return this.observe(environmentId,actor,signal);
  }
  async context(value: unknown,actor: Actor,signal: AbortSignal): Promise<ContextResult> {
    const input=contextInput.parse(value); const view=await this.observe(input.environmentId,actor,signal);
    const previous=input.previousContextId?this.store.get('contexts',input.previousContextId):undefined;
    if (previous && previous.environmentId!==input.environmentId) throw new Error('比较上下文必须属于同一个环境。');
    const applicable=view.versions.filter(item=>item.status==='applicable').map(item=>item.definition);
    const terms=[...new Set((input.query.normalize('NFKC').toLocaleLowerCase().match(/[a-z0-9_]+|[\p{Script=Han}]+/gu) ?? []).flatMap(term=>
      /[\p{Script=Han}]/u.test(term) && term.length>2 ? [term,...Array.from({length:term.length-1},(_,index)=>term.slice(index,index+2))] : [term]))].slice(0,32);
    const score=(text: string)=>terms.reduce((total,term)=>total+(text.toLocaleLowerCase().includes(term)?1:0),0);
    const selected=applicable.map(definition=>({definition,score:score(JSON.stringify([definition.key,definition.title,definition.content,definition.targets,definition.sql]))}))
      .filter(item=>!terms.length || item.score>0).sort((a,b)=>b.score-a.score || a.definition.key.localeCompare(b.definition.key)).slice(0,input.limit).map(item=>item.definition);
    const targetKeys=new Set(selected.flatMap(item=>item.targets.map(target=>objectKey(target.schema,target.table))));
    const candidates=view.relations.map(relation=>({relation,score:score(JSON.stringify(relation))+(targetKeys.has(objectKey(relation.schema,relation.name))?100:0)}));
    const neighbors=new Set(candidates.filter(item=>item.score>0).flatMap(item=>item.relation.constraints.flatMap(constraint=>
      constraint.references?[objectKey(constraint.references.schema,constraint.references.table)]:[])));
    const relations=candidates.map(item=>({...item,score:item.score+(neighbors.has(objectKey(item.relation.schema,item.relation.name))?10:0)}))
      .filter(item=>!terms.length || item.score>0).sort((a,b)=>b.score-a.score || objectKey(a.relation.schema,a.relation.name).localeCompare(objectKey(b.relation.schema,b.relation.name)))
      .slice(0,input.limit).map(item=>item.relation);
    const context:ContextRecord={...view.context,selection:{query:input.query,limit:input.limit,definitionIds:selected.map(item=>item.id),relationOids:relations.map(item=>item.oid)}};
    this.store.put('contexts',context);
    return { context,relations,definitions:selected,excluded:view.versions.filter(item=>item.status==='stale').map(item=>({key:item.definition.key,version:item.definition.version,reason:item.reason})),
      coverage:{totalRelations:view.relations.length,returnedRelations:relations.length,applicableDefinitions:applicable.length,returnedDefinitions:selected.length},
      changes:previous?{previousContextId:previous.id,structureChanged:previous.sourceFingerprint!==view.context.sourceFingerprint || previous.schemaFingerprint!==view.context.schemaFingerprint,
        definitionsChanged:previous.catalogFingerprint!==view.context.catalogFingerprint}:undefined,notes:view.notes };
  }
  async import(value: unknown,actor: Actor,signal: AbortSignal): Promise<SemanticDefinition[]> {
    if (actor.kind!=='user') throw new Error('业务定义由用户导入，Agent 通过上下文工具读取。');
    const input=importCatalogInput.parse(value); if (Buffer.byteLength(JSON.stringify(input.document))>65536) throw new Error('导入文档超过 64 KiB。');
    const view=await this.observe(input.environmentId,actor,signal); const base=this.store.get('contexts',input.baseContextId);
    if (base.environmentId!==input.environmentId || base.sourceFingerprint!==view.context.sourceFingerprint || base.schemaFingerprint!==view.context.schemaFingerprint) throw new Error('目标结构或身份已变化，请刷新目录后重新导入。');
    const digest=hash([input.environmentId,input.document]);
    signal.throwIfAborted();
    return this.store.transaction(()=>{
      const existing=this.store.find('catalogImports',input.requestId);
      if (existing) {
        if (existing.digest!==digest || existing.environmentId!==input.environmentId) throw new Error('原导入请求已关联其他内容。');
        return existing.definitionIds.map(id=>this.store.get('definitions',id));
      }
      const versions=this.store.definitions(view.context.projectPath,view.context.dataSourceId);
      if (versions.length+input.document.entries.length>128) throw new Error('首版每数据源最多保存 128 个语义版本（含历史）。');
      const definitions=input.document.entries.map(entry=>{
        const previous=versions.filter(item=>item.key===entry.key).sort((a,b)=>b.version-a.version)[0];
        if ((previous?.version ?? 0)!==entry.expectedVersion) throw new Error(`定义 ${entry.key} 已变化，请读取最新版本再更新。`);
        const dependencies=entry.targets.map(target=>{
          const relation=view.relations.find(item=>item.schema===target.schema && item.name===target.table);
          if (!relation || target.columns.some(column=>!relation.columns.some(item=>item.name===column))) throw new Error(`依赖对象或字段不存在、不可访问：${target.schema}.${target.table}`);
          return {schema:target.schema,table:target.table,fingerprint:hash(relation)};
        });
        const {expectedVersion:_expectedVersion,...content}=entry;
        const definition:SemanticDefinition={...content,id:randomUUID(),version:(previous?.version ?? 0)+1,projectPath:view.context.projectPath,dataSourceId:view.context.dataSourceId,
          sourceFingerprint:view.context.sourceFingerprint,source:input.document.source,author:{...actor},createdAt:new Date().toISOString(),contextId:view.context.id,runId:view.context.runId,dependencies};
        return definition;
      });
      for (const definition of definitions) this.store.put('definitions',definition);
      this.store.put('catalogImports',{id:input.requestId,projectPath:view.context.projectPath,dataSourceId:view.context.dataSourceId,environmentId:input.environmentId,digest,
        definitionIds:definitions.map(item=>item.id),createdAt:new Date().toISOString()});
      return definitions;
    });
  }
}
