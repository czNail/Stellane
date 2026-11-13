import { z } from 'zod';

export const connectionInput = z.strictObject({
  name: z.string().trim().min(1).max(80),
  projectPath: z.string().trim().min(1).max(1024),
  host: z.string().trim().min(1).max(253),
  port: z.number().int().min(1).max(65535),
  database: z.string().trim().min(1).max(63),
  user: z.string().trim().min(1).max(63),
  passwordRef: z.string().regex(/^(env:[A-Z_][A-Z0-9_]*|file:\/[^\r\n]+)$/),
  tls: z.enum(['disable', 'verify-full']),
});
export type ConnectionInput = z.infer<typeof connectionInput>;
export interface Connection extends ConnectionInput { id: string; createdAt: string }
export const stelloInput = z.strictObject({
  name: z.string().trim().min(1).max(80), projectPath: z.string().trim().min(1).max(1024),
  configPath: z.string().startsWith('/').max(1024),
  resource: z.string().regex(/^[a-z0-9-]{1,24}\/[a-z0-9-]{1,24}$/),
});
export type StelloInput = z.infer<typeof stelloInput>;
export interface StelloSource extends StelloInput { id: string; createdAt: string }
export interface BranchIdentity { service: string; slot: number; incarnation: number }
export interface BranchBinding {
  providerId: string; resource: string; identity: BranchIdentity; resourceId: string;
  forkLsn: string; managed: boolean; creationId?: string;
}
export const environmentInput = z.strictObject({
  connectionId: z.string().uuid(), name: z.string().trim().min(1).max(80),
});
export type EnvironmentInput = z.infer<typeof environmentInput>;
export interface Environment {
  id: string; connectionId?: string; name: string; projectPath: string;
  mode: 'live' | 'fixed' | 'branch'; access: 'read-only' | 'read-write'; createdAt: string;
  parentEnvironmentId?: string; stello?: BranchBinding;
}
export const deriveInput = z.strictObject({
  environmentId: z.string().uuid(), name: z.string().trim().min(1).max(80),
  requestId: z.string().uuid().optional(),
});
export const deliverInput = z.strictObject({
  environmentId: z.string().uuid(), recipientEnvironmentId: z.string().uuid(),
  summary: z.string().trim().min(1).max(4000), sql: z.string().trim().min(1).max(16384),
  requestId: z.string().uuid().optional(),
});
export const queryInput = z.strictObject({
  environmentId: z.string().uuid(), sql: z.string().trim().min(1).max(16384),
  values: z.array(z.union([z.string().max(8192), z.number().finite(), z.boolean(), z.null()])).max(32).default([]),
  requestId: z.string().uuid().optional(),
});
export type QueryInput = z.infer<typeof queryInput>;
export interface Actor { kind: 'user' | 'agent'; id: string; projectPath?: string; callId?: string }
export type Cell = string | number | boolean | null | Cell[] | { [key: string]: Cell };
export interface DatabaseTarget { database: string; user: string; address: string | null; port: number | null }
export interface QueryPreview {
  columns: string[]; rows: Record<string, Cell>[]; rowCount: number; truncated: boolean; target: DatabaseTarget;
  command?: string; affectedRows?: number;
}
export interface Run {
  id: string; environmentId: string; connectionId?: string; projectPath: string;
  actor: Actor; sql: string; values: QueryInput['values'];
  kind?: 'query' | 'execute'; digest?: string;
  purpose?: 'context' | 'knowledge';
  status: 'running' | 'succeeded' | 'failed' | 'interrupted' | 'unknown';
  startedAt: string; finishedAt?: string; durationMs?: number;
  target?: DatabaseTarget; preview?: QueryPreview; error?: string;
  branch?: BranchBinding;
}
export interface BranchOperation {
  id: string; kind: 'checkpoint' | 'fork'; providerId: string; parentEnvironmentId: string;
  resource: string; actor: Actor; environment: Environment; request?: Record<string, unknown>; inputDigest?: string;
  status: 'pending' | 'succeeded' | 'failed' | 'unknown'; error?: string; createdAt: string;
}
export interface Delivery {
  id: string; sourceEnvironmentId: string; recipientEnvironmentId: string; snapshotEnvironmentId: string;
  runId: string; summary: string; actor: Actor; projectPath: string; createdAt: string;
}
export interface DeliveredResult { delivery: Delivery; environment: Environment; run: Run }
export interface Snapshot {
  connections: Connection[]; environments: Environment[]; runs: Run[];
  providers: StelloSource[]; operations: BranchOperation[]; deliveries: Delivery[];
}
