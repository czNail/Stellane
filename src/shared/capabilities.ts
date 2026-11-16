import type { Environment } from './models.ts';

/** Product behavior follows the connected source's capabilities. */
export function describeEnvironment(environment: Environment) {
  const provider = environment.neon ? 'neon' : environment.stello ? 'stello' : 'postgres';
  const canDerive = provider !== 'postgres' && !environment.removedAt && !environment.resourceDeletedAt && !environment.disabledAt && !environment.resourceRemovalPendingAt;
  const checkpointGuarantee = provider === 'stello' ? 'immutable'
    : provider === 'neon' ? 'managed-read-only' : 'none';
  return {
    provider, providerLabel: provider === 'neon' ? environment.neon?.local ? 'Neon (Docker)' : 'Neon' : provider === 'stello' ? 'Stello' : 'PostgreSQL',
    canDerive, canExperiment: canDerive && !environment.experimentId && environment.mode !== 'branch',
    checkpointGuarantee,
    stateLabel: environment.resourceRemovalPendingAt ? '回收待核实 · 访问已暂停'
      : environment.removedAt ? environment.retainedReason ? '依赖保留 · 访问已结束' : '已清理'
      : environment.disabledAt ? '访问已停用'
      : environment.mode === 'branch' ? '独立可写分支'
      : environment.mode === 'fixed' ? provider === 'neon' ? '保留的只读分支' : '固定只读快照' : '实时只读',
  } as const;
}
