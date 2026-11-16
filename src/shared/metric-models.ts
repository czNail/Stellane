import { z } from 'zod';
import type { KnowledgeEndpoint } from './knowledge-models.ts';

const column = z.string().min(1).max(63).refine(value => !value.includes('\u0000'));
export const metricInput = z.strictObject({
  environmentId: z.string().uuid(),
  name: z.string().trim().min(1).max(100),
  relationshipIds: z.array(z.string().uuid()).min(1).max(4).refine(ids => new Set(ids).size === ids.length),
  groupColumn: column,
  amountColumn: column.optional(),
  filter: z.strictObject({ column, value: z.union([z.string().max(512), z.number().finite(), z.boolean()]) }).optional(),
});
export type MetricInput = z.infer<typeof metricInput>;
export interface MetricRelationship {
  id: string;
  sourceRunId: string;
  version: number;
  from: KnowledgeEndpoint;
  to: KnowledgeEndpoint;
}
export type MetricPlan = Omit<MetricInput, 'environmentId' | 'relationshipIds'> & { relationships: MetricRelationship[] };
export interface MetricCheck {
  eligible: string;
  missing: string;
  ambiguous: string;
  nullSourceKeys: string;
}
export interface MetricEvidence {
  plan: MetricPlan;
  version: string;
  status: 'complete' | 'partial' | 'unverified';
  snapshot?: string;
  counts?: {
    total: string; attributed: string; unattributed: string; nullAmounts: string;
    totalAmount: string; attributedAmount: string; unattributedAmount: string;
  };
  checks?: MetricCheck[];
  reason?: string;
}
