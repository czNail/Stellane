import { z } from 'zod';

const identifier = z.string().min(1).max(63).refine(value => !value.includes('\u0000'));
const columns = z.array(identifier).min(1).max(8).refine(value => new Set(value).size === value.length, '字段不能重复');
const endpoint = z.strictObject({ schema: identifier, table: identifier, columns });
export type KnowledgeEndpoint = z.infer<typeof endpoint>;

export const learnInput = z.strictObject({
  environmentId: z.string().uuid(),
  claim: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('row-key'), target: endpoint }),
    z.strictObject({ kind: z.literal('join'), from: endpoint, to: endpoint }),
  ]),
});
export type KnowledgeClaim = z.infer<typeof learnInput>['claim'];

export interface KnowledgeEvidence {
  runId: string;
  contextId: string;
  observedAt: string;
  method: 'postgres-catalog' | 'key-profile' | 'join-profile';
  snapshot: string;
}

export interface KeyProfile {
  rows: string;
  nullRows: string;
  duplicateKeys: string;
}

export type ProfiledFact =
  | { kind: 'row-key'; target: KnowledgeEndpoint; profile: KeyProfile }
  | { kind: 'join'; from: KnowledgeEndpoint; to: KnowledgeEndpoint; cardinality: 'one-to-one' | 'many-to-one'; source: KeyProfile; target: KeyProfile; unmatchedRows: string };

export interface ViewLineage {
  kind: 'view-lineage';
  upstream: KnowledgeEndpoint;
  downstream: Omit<KnowledgeEndpoint, 'columns'>;
}

export interface ProfiledKnowledge {
  id: string;
  environmentId: string;
  key: string;
  version: number;
  fact: ProfiledFact;
  evidence: KnowledgeEvidence;
  dependencyFingerprint: string;
  invalidation?: { reason: string; evidence: KnowledgeEvidence };
}

export type KnowledgeItem = { id: string; fact: ViewLineage; evidence: KnowledgeEvidence; status: 'declared' }
  | { id: string; version: number; fact: ProfiledFact; evidence: KnowledgeEvidence; status: 'observed' | 'stale' | 'superseded' | 'needs-check'; reason?: string;
    invalidation?: ProfiledKnowledge['invalidation'] };
export type LearnResult = { accepted: true; knowledge: KnowledgeItem }
  | { accepted: false; reason: string; evidence: KnowledgeEvidence };
