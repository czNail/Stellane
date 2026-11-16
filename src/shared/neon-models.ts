import { z } from 'zod';

const neonId = z.string().regex(/^[a-z0-9-]{1,60}$/);
export const neonInput = z.strictObject({
  name: z.string().trim().min(1).max(80),
  projectPath: z.string().trim().min(1).max(1024),
  projectId: neonId, branchId: neonId,
  database: z.string().trim().min(1).max(63), user: z.string().trim().min(1).max(63),
  apiKeyRef: z.string().regex(/^(env:[A-Z_][A-Z0-9_]*|file:\/[^\r\n]+)$/),
});
export type NeonInput = z.infer<typeof neonInput>;
export interface NeonSource extends NeonInput { id: string; createdAt: string }

// Neon branches can be reset by the account owner. A read-only compute is not
// an immutable snapshot; recorded observations must still be revalidated.
export interface NeonBinding {
  providerId: string; projectId: string; branchId: string; endpointId: string;
  createdAt: string; parentId?: string; parentLsn?: string; lastResetAt?: string;
  managed: boolean; checkpoint: boolean; operationId?: string;
}
export interface NeonRemoval {
  id: string; kind: 'branch' | 'compute'; projectId: string; branchId: string; endpointId: string;
  operationIds?: string[];
}
