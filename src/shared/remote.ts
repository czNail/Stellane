import { z } from 'zod';
import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info';
import type { TypertRemoteSpec } from '@deepseek-ai/dsh-typert-protocol';
import { connectionInput, deliverInput, deriveInput, environmentInput, queryInput, stelloInput } from './models.ts';
import type { BranchOperation, Connection, DatabaseTarget, DeliveredResult, Environment, Run, Snapshot } from './models.ts';
import { contextInput, importCatalogInput } from './context-models.ts';
import type { CatalogView, ContextResult, SemanticDefinition } from './context-models.ts';

export const PACKAGE = '@stellane/harness-plugin';
export const requestSchemas = {
  snapshot: z.strictObject({}),
  saveConnection: connectionInput,
  probe: z.strictObject({ connectionId: z.string().uuid() }),
  createEnvironment: environmentInput,
  prepareConversation: z.strictObject({ environmentId: z.string().uuid() }),
  query: queryInput,
  saveStello: stelloInput,
  checkpoint: deriveInput, fork: deriveInput, execute: queryInput, deliver: deliverInput,
  results: z.strictObject({ environmentId: z.string().uuid() }),
  reconcileRun: z.strictObject({ runId: z.string().uuid() }),
  reconcileOperation: z.strictObject({ operationId: z.string().uuid() }),
  context: contextInput,
  catalogView: z.strictObject({ environmentId: z.string().uuid() }),
  importCatalog: importCatalogInput,
};
export type Operation = keyof typeof requestSchemas;
export type Requests = { [K in Operation]: z.input<(typeof requestSchemas)[K]> };
export interface Responses {
  snapshot: Snapshot; saveConnection: Connection; probe: DatabaseTarget;
  createEnvironment: Environment; query: Run;
  prepareConversation: { workspaceId: string };
  saveStello: Environment; checkpoint: Environment; fork: Environment; execute: Run;
  deliver: DeliveredResult; results: DeliveredResult[]; reconcileRun: Run; reconcileOperation: BranchOperation;
  context: ContextResult; catalogView: CatalogView; importCatalog: SemanticDefinition[];
}
export type Reply<T> = { success: true; value: T } | { success: false; error: string };

// One explicit contract is shared by the Host registry and browser mount.
// No custom HTTP route or alternate authentication carrier is introduced.
const methods = Object.fromEntries(Object.entries(requestSchemas).map(([name, schema]) => {
  const codec = { mode: 'strict' as const, typeSymbol: `${name}Input`, create: () => schema };
  return [`stellane/${name}`, {
    service: 'stellane', invocation: { kind: 'direct' as const },
    parameters: [{ name: 'input', source: 'json' as const, codec, strictCodec: codec }],
    cancellation: { parameter: 'signal' as const },
    result: { mode: 'strict' as const, typeSymbol: `${name}Reply`, create: () => z.unknown() },
  }];
})) as TypertRemoteSpec['methods'];
export const remoteInfo = createTypertRemoteInfo({ package: PACKAGE, methods }, z);
