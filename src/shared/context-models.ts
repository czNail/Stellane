import { z } from 'zod';
import type { Actor, BranchBinding, DatabaseTarget } from './models.ts';
import type { KnowledgeItem } from './knowledge-models.ts';

const id = z.string().uuid();
export const contextInput = z.strictObject({
  environmentId: id, query: z.string().trim().max(200).default(''), limit: z.number().int().min(1).max(16).default(8),
  previousContextId: id.optional(),
});
const objectTarget = z.strictObject({ schema: z.string().min(1).max(63), table: z.string().min(1).max(63), columns: z.array(z.string().min(1).max(63)).max(64).default([]) });
export const definitionInput = z.strictObject({
  key: z.string().trim().regex(/^[a-zA-Z0-9_.-]{1,80}$/), title: z.string().trim().min(1).max(120),
  kind: z.enum(['description', 'metric', 'relationship', 'sql-example']), content: z.string().trim().min(1).max(4000),
  targets: z.array(objectTarget).min(1).max(8), sql: z.string().trim().max(16384).optional(), expectedVersion: z.number().int().min(0).default(0),
});
export const documentInput = z.strictObject({ source: z.strictObject({ name: z.string().trim().min(1).max(200), uri: z.string().trim().max(1024).optional() }),
  entries: z.array(definitionInput).min(1).max(16) }).refine(value => new Set(value.entries.map(entry => entry.key)).size === value.entries.length, '文档内 key 不能重复');
export const importCatalogInput = z.strictObject({ environmentId: id, baseContextId: id, requestId: id, document: documentInput });
export type SemanticDocument = z.input<typeof documentInput>;
export type DefinitionContent = z.output<typeof definitionInput>;

export const columnSchema = z.object({ ordinal: z.number().int(), name: z.string(), type: z.string(), typeOid: z.string(), nullable: z.boolean(), default: z.string().nullable(), comment: z.string().nullable(), identity: z.string(), generated: z.string(), collationOid: z.string() });
export const constraintSchema = z.object({ name: z.string(), kind: z.string(), definition: z.string(), validated: z.boolean(), columns: z.array(z.string()),
  references: z.object({ oid: z.string(), schema: z.string(), table: z.string(), columns: z.array(z.string()) }).nullable() });
export const relationSchema = z.object({ oid: z.string(), schema: z.string(), name: z.string(), kind: z.string(), comment: z.string().nullable(),
  view: z.string().nullable(), columns: z.array(columnSchema).max(256), constraints: z.array(constraintSchema).max(128) });
export const metadataSchema = z.object({ databaseOid: z.string(), snapshot: z.string(), relations: z.array(relationSchema).max(64),
  profileTables: z.array(z.string()).max(64).default([]),
  lineage: z.array(z.object({ upstream: z.object({ schema: z.string(), table: z.string(), columns: z.array(z.string()).max(256) }),
    downstream: z.object({ schema: z.string(), table: z.string() }) })).max(256).default([]),
});
export type RelationMetadata = z.infer<typeof relationSchema>;
export type DatabaseMetadata = z.infer<typeof metadataSchema>;
export interface DataState {
  environmentId: string; dataSourceId: string; mode: 'live' | 'fixed' | 'branch'; observedAt: string;
  target: DatabaseTarget; databaseOid: string; branch?: BranchBinding;
  dataVersion: { kind: 'observation' | 'fixed-position'; snapshot: string; position?: string };
  identityBasis: 'registration-and-target' | 'stello-resource';
}
export interface ContextRecord {
  id: string; environmentId: string; projectPath: string; dataSourceId: string; sourceFingerprint: string;
  schemaFingerprint: string; catalogFingerprint: string; state: DataState; runId: string;
  selection?: { query: string; limit: number; definitionIds: string[]; relationOids: string[]; knowledgeIds?: string[] };
}
export interface SemanticDefinition extends Omit<DefinitionContent, 'expectedVersion'> {
  id: string; projectPath: string; dataSourceId: string; sourceFingerprint: string; version: number;
  source: { name: string; uri?: string }; author: Actor; createdAt: string; contextId: string; runId: string;
  dependencies: { schema: string; table: string; fingerprint: string }[];
}
export interface CatalogImport { id: string; projectPath: string; dataSourceId: string; environmentId: string; digest: string; definitionIds: string[]; createdAt: string }
export interface DefinitionStatus { definition: SemanticDefinition; status: 'applicable' | 'stale' | 'superseded'; reason: string }
export interface ContextResult {
  context: ContextRecord; relations: RelationMetadata[]; definitions: SemanticDefinition[];
  knowledge: KnowledgeItem[];
  excluded: { key: string; version: number; reason: string }[];
  coverage: { totalRelations: number; returnedRelations: number; applicableDefinitions: number; returnedDefinitions: number };
  changes?: { previousContextId: string; structureChanged: boolean; definitionsChanged: boolean };
  notes: string[];
}
export interface CatalogView { context: ContextRecord; relations: RelationMetadata[]; versions: DefinitionStatus[]; notes: string[]; knowledge: KnowledgeItem[] }
