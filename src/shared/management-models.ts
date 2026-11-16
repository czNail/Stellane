import { z } from 'zod';
import type { Environment } from './models.ts';

const environmentId = z.string().uuid();
export const managementInput = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('set-source-enabled'), environmentId, enabled: z.boolean() }),
  z.strictObject({ action: z.literal('rotate-postgres'), environmentId, connectionString: z.string().min(1).max(16384) }),
  z.strictObject({ action: z.literal('rotate-neon'), environmentId, apiKey: z.string().min(1).max(8192) }),
  z.strictObject({ action: z.literal('replace-stello-config'), environmentId, configPath: z.string().startsWith('/').max(1024) }),
  z.strictObject({ action: z.literal('remove-source'), environmentId }),
  z.strictObject({ action: z.literal('purge-source'), environmentId, confirmation: z.string().min(1).max(80) }),
  z.strictObject({ action: z.literal('archive-knowledge'), id: z.string().uuid() }),
  z.strictObject({ action: z.literal('archive-definition'), id: z.string().uuid() }),
  z.strictObject({ action: z.literal('remove-resource'), environmentId }),
]);
export type ManagementInput = z.input<typeof managementInput>;
export interface ManagedSource {
  environmentId: string; name: string; projectPath: string; provider: 'postgres' | 'neon' | 'stello';
  local?: boolean;
  enabled: boolean; removed: boolean; canRemove: boolean; canPurge: boolean;
  blockedReasons: string[]; purgeBlockedReasons: string[];
  managedCredentialCount: number; retainedResources: number;
}
export interface ManagedResource {
  environment: Environment; sourceEnvironmentId: string; parentEnvironmentId?: string;
  dependentEnvironmentIds: string[]; retentionReason: string;
  canRemove: boolean; blockedReasons: string[];
}
export interface ManagedKnowledge {
  id: string; environmentId: string; sourceEnvironmentId: string; label: string; version: number;
  archivedAt?: string;
}
export interface ManagedDefinition {
  id: string; sourceEnvironmentId: string; key: string; title: string; version: number; archivedAt?: string;
}
export interface ManagementView {
  sources: ManagedSource[]; resources: ManagedResource[]; knowledge: ManagedKnowledge[]; definitions: ManagedDefinition[];
  notes: string[];
}
