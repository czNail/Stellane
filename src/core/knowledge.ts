import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { metadataSchema } from '../shared/context-models.ts';
import type { ContextRecord, DatabaseMetadata, RelationMetadata } from '../shared/context-models.ts';
import type { KnowledgeClaim, KnowledgeEndpoint, KnowledgeEvidence, KnowledgeItem, LearnResult, ProfiledFact, ProfiledKnowledge } from '../shared/knowledge-models.ts';
import type { Run } from '../shared/models.ts';
import { fingerprint } from './context-utils.ts';
import { knowledgeSql } from './knowledge-sql.ts';
import type { Store } from './store.ts';

const count = z.string().regex(/^\d{1,20}$/);
const profile = z.object({ rows: count, nullRows: count, duplicateKeys: count });
const proof = z.object({ metadata: metadataSchema, source: profile, target: profile.optional(), unmatched: count.optional() });
// Built-in scalar types with ordinary equality and grouping semantics.
const keyTypes = new Set(['16', '20', '21', '23', '25', '1043', '1082', '1114', '1184', '1700', '2950']);
type ReadProof = (sql: string, signal: AbortSignal) => Promise<Run>;

type Table = Pick<KnowledgeEndpoint, 'schema' | 'table'>;
export const tableKey = (target: Table) => JSON.stringify([target.schema, target.table]);

export function knowledgeTables(fact: KnowledgeItem['fact']): Table[] {
  switch (fact.kind) {
    case 'row-key': return [fact.target];
    case 'join': return [fact.from, fact.to];
    case 'view-lineage': return [fact.upstream, fact.downstream];
  }
}

function relationFor(target: Table, relations: RelationMetadata[]): RelationMetadata | undefined {
  return relations.find(relation => relation.schema === target.schema && relation.name === target.table);
}

function dependencies(context: ContextRecord, relations: RelationMetadata[], tables: Table[]): string {
  return fingerprint([context.sourceFingerprint, context.state.target, context.state.branch ?? null,
    context.state.databaseOid, tables.map(table => relationFor(table, relations) ?? null)]);
}

function keyColumns(endpoint: KnowledgeEndpoint, metadata: DatabaseMetadata) {
  const relation = relationFor(endpoint, metadata.relations);
  if (!relation || !metadata.profileTables.includes(relation.oid)) {
    throw new Error('首版核对支持可读取、未启用行级安全且没有子表的普通表。');
  }
  return endpoint.columns.map(name => {
    const column = relation.columns.find(item => item.name === name);
    if (!column || !keyTypes.has(column.typeOid)) throw new Error('键字段不存在，或其类型不在首版支持的范围内。');
    return column;
  });
}

function normalizedClaim(claim: KnowledgeClaim): KnowledgeClaim {
  if (claim.kind === 'row-key') return { ...claim, target: { ...claim.target, columns: [...claim.target.columns].sort() } };
  if (claim.from.columns.length !== claim.to.columns.length) throw new Error('关联两侧的字段数量必须一致。');
  const pairs = claim.from.columns.map((from, index) => [from, claim.to.columns[index]!] as const)
    .sort(([a], [b]) => a.localeCompare(b));
  const from = { ...claim.from, columns: pairs.map(pair => pair[0]) };
  const to = { ...claim.to, columns: pairs.map(pair => pair[1]) };
  if (fingerprint(from) === fingerprint(to)) throw new Error('请提供有业务意义的两个关联键。');
  return { kind: 'join', from, to };
}

function evidence(context: ContextRecord, method: KnowledgeEvidence['method'], run?: Run, snapshot?: string): KnowledgeEvidence {
  return { contextId: context.id, runId: run?.id ?? context.runId, method,
    observedAt: run?.finishedAt ?? context.state.observedAt, snapshot: snapshot ?? context.state.dataVersion.snapshot };
}

export class KnowledgeMemory {
  private readonly store: Store;
  private readonly checking = new Set<string>();

  constructor(store: Store) { this.store = store; }

  view(context: ContextRecord, metadata: DatabaseMetadata): KnowledgeItem[] {
    const declared = metadata.lineage.map(({ upstream, downstream }): KnowledgeItem => {
      const fact = { kind: 'view-lineage', upstream, downstream } as const;
      const id = fingerprint([context.environmentId, dependencies(context, metadata.relations, knowledgeTables(fact)), fact]);
      return { id, fact, evidence: evidence(context, 'postgres-catalog'), status: 'declared' };
    });
    const seen = new Set<string>();
    const learned = this.store.knowledge(context.environmentId).map((record): KnowledgeItem => {
      const { id, version, fact, evidence, invalidation } = record;
      const item = { id, version, fact, evidence, ...(invalidation ? { invalidation } : {}) };
      const superseded = seen.has(record.key);
      seen.add(record.key);
      const tables = knowledgeTables(fact);
      if (tables.some(table => !relationFor(table, metadata.relations))) {
        return { ...item, status: 'stale', reason: '关联对象当前不可读取。' };
      }
      if (superseded) return { ...item, status: 'superseded' };
      if (record.dependencyFingerprint !== dependencies(context, metadata.relations, tables)) {
        return { ...item, status: 'stale', reason: '数据来源或相关对象的结构已变化。' };
      }
      if (tables.some(table => !metadata.profileTables.includes(relationFor(table, metadata.relations)!.oid))) {
        return { ...item, status: 'stale', reason: '相关表的权限或继承范围已变化。' };
      }
      if (record.invalidation) return { ...item, status: 'stale', reason: record.invalidation.reason };
      return context.state.mode === 'fixed' ? { ...item, status: 'observed' }
        : { ...item, status: 'needs-check', reason: '这是历史数据观察。数据可变，使用前请重新核对。' };
    });
    return [...declared, ...learned];
  }

  async learn(input: KnowledgeClaim, context: ContextRecord, initial: DatabaseMetadata, read: ReadProof, signal: AbortSignal): Promise<LearnResult> {
    const claim = normalizedClaim(input);
    const tables = claim.kind === 'row-key' ? [claim.target] : [claim.from, claim.to];
    const left = keyColumns(tables[0]!, initial);
    if (claim.kind === 'join') {
      const right = keyColumns(claim.to, initial);
      if (left.some((column, i) => column.typeOid !== right[i]!.typeOid || column.collationOid !== right[i]!.collationOid)) {
        throw new Error('关联字段类型和排序规则必须一致。');
      }
    }
    const key = fingerprint(claim);
    const lock = `${context.environmentId}:${key}`;
    if (this.checking.has(lock)) throw new Error('这条关系正在核对，请稍后重试。');
    this.checking.add(lock);
    try {
      const run = await read(knowledgeSql(claim), signal);
      signal.throwIfAborted();
      const parsed = proof.safeParse(run.preview?.rows[0]);
      if (run.status !== 'succeeded' || !parsed.success || !run.target || run.preview?.truncated) {
        throw new Error(`知识核对未完成。${run.error ?? '未取得完整证据。'} 执行记录 ${run.id}`);
      }
      const { metadata, source, target, unmatched } = parsed.data;
      for (const table of tables) keyColumns(table, metadata);
      const dependencyFingerprint = dependencies(context, initial.relations, tables);
      if (fingerprint(run.target) !== fingerprint(context.state.target)
        || fingerprint(run.branch ?? null) !== fingerprint(context.state.branch ?? null)
        || metadata.databaseOid !== context.state.databaseOid
        || dependencyFingerprint !== dependencies(context, metadata.relations, tables)) {
        throw new Error('核对期间数据来源或相关结构发生变化，请重新获取上下文。');
      }
      const observed = evidence(context, claim.kind === 'row-key' ? 'key-profile' : 'join-profile', run, metadata.snapshot);
      const versions = this.store.knowledge(context.environmentId);
      const previous = versions.find(record => record.key === key);
      const reject = (reason: string): LearnResult => {
        if (previous && previous.dependencyFingerprint === dependencyFingerprint) {
          this.store.put('knowledge', { ...previous, invalidation: { reason, evidence: observed } });
        }
        return { accepted: false, reason, evidence: observed };
      };
      if (source.rows === '0') return reject('没有数据，无法验证行粒度或关联。');
      if (source.nullRows !== '0') return reject('来源键存在空值。');
      let fact: ProfiledFact;
      if (claim.kind === 'row-key') {
        if (source.duplicateKeys !== '0') return reject('存在重复键，不能据此确定行粒度。');
        fact = { ...claim, profile: source };
      } else {
        if (!target || unmatched === undefined) throw new Error('缺少关联核对证据。');
        if (target.rows === '0' || target.nullRows !== '0' || target.duplicateKeys !== '0') return reject('目标键为空或不唯一，不能保证关联不放大行数。');
        if (unmatched !== '0') return reject('存在未匹配记录，当前数据不支持完整关联。');
        fact = { ...claim, cardinality: source.duplicateKeys === '0' ? 'one-to-one' : 'many-to-one', source, target, unmatchedRows: unmatched };
      }
      const sameConclusion = previous && !previous.invalidation && previous.dependencyFingerprint === dependencyFingerprint
        && (fact.kind === 'row-key' || (previous.fact.kind === 'join' && previous.fact.cardinality === fact.cardinality));
      if (!sameConclusion && versions.length >= 128) throw new Error('此环境已保存 128 个知识版本。');
      const record: ProfiledKnowledge = { id: sameConclusion ? previous.id : randomUUID(), environmentId: context.environmentId,
        key, version: sameConclusion ? previous.version : (previous?.version ?? 0) + 1, fact, evidence: observed, dependencyFingerprint };
      this.store.put('knowledge', record);
      return { accepted: true, knowledge: { id: record.id, version: record.version, fact, evidence: observed, status: 'observed' } };
    } finally { this.checking.delete(lock); }
  }
}
