import { z } from 'zod';
import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info';
import type { TypertRemoteSpec } from '@deepseek-ai/dsh-typert-protocol';
import { connectionInput, deliverInput, deriveInput, environmentInput, experimentInput, experimentResultInput, queryInput, stelloInput } from './models.ts';
import type { BranchOperation, Connection, DatabaseTarget, DeliveredResult, Environment, ExperimentDetail, Run, Snapshot } from './models.ts';
import { contextInput, importCatalogInput } from './context-models.ts';
import type { CatalogView, ContextResult, SemanticDefinition } from './context-models.ts';
import { metricInput } from './metric-models.ts';
import { connectPostgresInput, connectNeonInput } from './onboarding-models.ts';
import { neonInput } from './neon-models.ts';

export const PACKAGE = '@stellane/harness-plugin';
export const requestSchemas = {
  snapshot: z.strictObject({}),
  saveConnection: connectionInput,
  connectPostgres: connectPostgresInput,
  connectNeon: connectNeonInput,
  saveNeon: neonInput,
  probe: z.strictObject({ connectionId: z.string().uuid() }),
  createEnvironment: environmentInput,
  prepareConversation: z.strictObject({ environmentId: z.string().uuid() }),
  bindConversation: z.strictObject({ environmentId: z.string().uuid(), sessionId: z.string().min(1).max(128) }),
  query: queryInput,
  metric: metricInput,
  runEvidence: z.strictObject({ id: z.string().uuid() }),
  saveStello: stelloInput,
  checkpoint: deriveInput, fork: deriveInput, execute: queryInput, deliver: deliverInput,
  results: z.strictObject({ environmentId: z.string().uuid() }),
  reconcileRun: z.strictObject({ runId: z.string().uuid() }),
  reconcileOperation: z.strictObject({ operationId: z.string().uuid() }),
  context: contextInput,
  catalogView: z.strictObject({ environmentId: z.string().uuid() }),
  importCatalog: importCatalogInput,
  startExperiment: experimentInput, captureExperiment: experimentResultInput,
  experimentDetail: z.strictObject({ id: z.string().uuid() }), finishExperiment: z.strictObject({ id: z.string().uuid() }),
};
export type Operation = keyof typeof requestSchemas;
export type Requests = { [K in Operation]: z.input<(typeof requestSchemas)[K]> };
export interface Responses {
  snapshot: Snapshot; saveConnection: Connection; probe: DatabaseTarget;
  connectPostgres: Environment; connectNeon: Environment; saveNeon: Environment;
  createEnvironment: Environment; query: Run;
  metric: Run; runEvidence: Run;
  prepareConversation: { workspaceId: string; sessionId?: string };
  bindConversation: { sessionId: string };
  saveStello: Environment; checkpoint: Environment; fork: Environment; execute: Run;
  deliver: DeliveredResult; results: DeliveredResult[]; reconcileRun: Run; reconcileOperation: BranchOperation;
  context: ContextResult; catalogView: CatalogView; importCatalog: SemanticDefinition[];
  startExperiment: ExperimentDetail; experimentDetail: ExperimentDetail; captureExperiment: ExperimentDetail; finishExperiment: ExperimentDetail;
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
