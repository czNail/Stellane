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
export const environmentInput = z.strictObject({
  connectionId: z.string().uuid(), name: z.string().trim().min(1).max(80),
});
export type EnvironmentInput = z.infer<typeof environmentInput>;
export interface Environment {
  id: string; connectionId: string; name: string; projectPath: string;
  mode: 'live'; access: 'read-only'; createdAt: string;
}
export const queryInput = z.strictObject({
  environmentId: z.string().uuid(), sql: z.string().trim().min(1).max(16384),
  values: z.array(z.union([z.string().max(8192), z.number().finite(), z.boolean(), z.null()])).max(32).default([]),
});
export type QueryInput = z.infer<typeof queryInput>;
export interface Actor { kind: 'user' | 'agent'; id: string; projectPath?: string }
export type Cell = string | number | boolean | null | Cell[] | { [key: string]: Cell };
export interface DatabaseTarget { database: string; user: string; address: string | null; port: number | null }
export interface QueryPreview {
  columns: string[]; rows: Record<string, Cell>[]; rowCount: number; truncated: boolean; target: DatabaseTarget;
}
export interface Run {
  id: string; environmentId: string; connectionId: string; projectPath: string;
  actor: Actor; sql: string; values: QueryInput['values'];
  status: 'running' | 'succeeded' | 'failed' | 'interrupted';
  startedAt: string; finishedAt?: string; durationMs?: number;
  target?: DatabaseTarget; preview?: QueryPreview; error?: string;
}
export interface Snapshot { connections: Connection[]; environments: Environment[]; runs: Run[] }
