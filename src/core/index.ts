import { createHash, randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { connectionInput, deliverInput, deriveInput, environmentInput, experimentInput, experimentResultInput, experimentSourceInput, queryInput, stelloInput } from '../shared/models.ts';
import type { Actor, BranchBinding, BranchOperation, Connection, DatabaseTarget, DeliveredResult, Delivery, Environment, Experiment, ExperimentDetail, ExperimentInput, QueryInput, Run, Snapshot, StelloSource } from '../shared/models.ts';
import { PostgresProvider, WriteOutcomeError, type QueryProvider } from '../providers/postgres.ts';
import { StelloProvider } from '../providers/stello.ts';
import { NeonCreationRejectedError, NeonProvider } from '../providers/neon.ts';
import { neonInput, type NeonBinding, type NeonSource } from '../shared/neon-models.ts';
import { Store } from './store.ts';
import { SemanticCatalog } from './catalog.ts';
import type { CatalogView, ContextResult, SemanticDefinition } from '../shared/context-models.ts';
import type { LearnResult } from '../shared/knowledge-models.ts';
import { metricInput, type MetricPlan } from '../shared/metric-models.ts';
import { metricSql, withMetric } from './metric.ts';
import { prepareNeonConnection, preparePostgresConnection } from './onboarding.ts';
import { DataManagement, sourceKey } from './management.ts';
import type { ManagementView } from '../shared/management-models.ts';

const owner: Actor = { kind: 'user', id: 'owner' };

function invocationId(actor: Actor, operation: string): string {
  if (!actor.callId) return randomUUID();
  const digits = createHash('sha256').update(JSON.stringify([actor.kind, actor.id, actor.callId, operation])).digest('hex').slice(0, 32).split('');
  digits[12] = '8'; digits[16] = ((parseInt(digits[16]!, 16) & 3) | 8).toString(16);
  const hex = digits.join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export class StellaneCore {
  private readonly store: Store;
  private readonly shutdown = new AbortController();
  private readonly active = new Set<Promise<unknown>>();
  private readonly modifying = new Set<string>();
  private readonly activeRuns = new Map<string, Set<string>>();
  private readonly provider: QueryProvider;
  private readonly branches: StelloProvider;
  private readonly neon: NeonProvider;
  private readonly catalog: SemanticCatalog;
  private readonly directory: string;
  private readonly managingSources = new Set<string>();
  private readonly dataManagement: DataManagement;
  constructor(directory: string, provider: QueryProvider = new PostgresProvider(), branches: StelloProvider = new StelloProvider(), neon = new NeonProvider()) {
    this.directory = directory;
    this.provider = provider; this.branches = branches; this.neon = neon; this.store = new Store(directory);
    this.catalog = new SemanticCatalog(this.store,id=>this.environment(id),
      (environmentId, sql, actor, signal, purpose) => this.run(queryInput.parse({ environmentId, sql }), actor, signal, false, purpose));
    this.dataManagement = new DataManagement(this.store, directory, provider, branches, neon,
      environment => this.activeRuns.has(environment.id) || this.modifying.has(environment.id)
        || !!environment.experimentId && this.modifying.has(environment.experimentId),
      sourceId => {
        if (this.managingSources.has(sourceId)) throw new Error('此数据源正在管理操作，请稍后继续。');
        this.managingSources.add(sourceId);
        return () => this.managingSources.delete(sourceId);
      });
  }
  management(actor: Actor = owner): ManagementView { return this.dataManagement.view(actor); }
  manage(value: unknown, actor: Actor = owner, signal?: AbortSignal): Promise<ManagementView> {
    return this.track(signal => this.dataManagement.execute(value, actor, signal), signal);
  }
  private assertSourceEnabled(environment: Environment) {
    if (this.store.get('environments', environment.id).resourceRemovalPendingAt) throw new Error('此资源的回收结果尚未确认，请先核对原清理请求。');
    const key = sourceKey(environment);
    if (this.managingSources.has(key)) throw new Error('此数据源正在管理操作，请稍后继续。');
    if (this.store.listAll('environments').some(item => sourceKey(item) === key && !item.parentEnvironmentId && (item.disabledAt || item.removedAt))) {
      throw new Error('数据源已停用或移除；请在管理中重新启用后再执行新查询。');
    }
  }
  snapshot(): Snapshot {
    return { connections: this.store.list('connections'), environments: this.store.environments(),
      runs: this.store.list('runs', 100), providers: this.store.list('providers'), neonSources: this.store.list('neonSources'),
      operations: this.store.list('operations', 100), deliveries: this.store.list('deliveries', 100), experiments: this.store.list('experiments') };
  }
  private async project(path: string): Promise<string> {
    if (!isAbsolute(path)) throw new Error('项目目录必须是绝对路径。');
    const projectPath = await realpath(path);
    if (!(await stat(projectPath)).isDirectory()) throw new Error('项目路径必须是目录。');
    return projectPath;
  }
  private capacity(projectPath: string, additional = 1): void {
    if (this.store.environmentCount(projectPath) + additional > 16) throw new Error('项目最多保留 16 个环境或待核实派生，请清理资源后继续。');
  }
  async saveConnection(value: unknown): Promise<Connection> {
    const input = connectionInput.parse(value);
    const projectPath = await this.project(input.projectPath);
    const connection: Connection = { ...input, projectPath, id: randomUUID(), createdAt: new Date().toISOString() };
    this.store.put('connections', connection);
    return connection;
  }
  connectPostgres(value: unknown, signal?: AbortSignal): Promise<Environment> {
    return this.track(async signal => {
      const prepared = await preparePostgresConnection(this.directory, value);
      try {
        const projectPath = await this.project(prepared.connection.projectPath);
        this.capacity(projectPath);
        await this.provider.probe(prepared.connection, signal);
        signal.throwIfAborted();
        this.capacity(projectPath);
        const connection: Connection = { ...prepared.connection, projectPath, id: randomUUID(), createdAt: new Date().toISOString() };
        const environment: Environment = { id: randomUUID(), connectionId: connection.id, name: connection.name,
          projectPath, mode: 'live', access: 'read-only', createdAt: connection.createdAt,
          ...(prepared.managedCredentialRef ? { managedCredentialRefs: [prepared.managedCredentialRef] } : {}) };
        this.store.transaction(() => {
          this.store.put('connections', connection); this.store.put('environments', environment);
        });
        return environment;
      } catch (error) { await prepared.discard(); throw error; }
    }, signal);
  }
  async connectNeon(value: unknown, signal?: AbortSignal): Promise<Environment> {
    const prepared = await prepareNeonConnection(this.directory, value);
    try {
      const environment = await this.saveNeon(prepared.source, signal, prepared.expectedHost);
      const registered = { ...environment, managedCredentialRefs: [prepared.managedCredentialRef] };
      this.store.put('environments', registered);
      return registered;
    }
    catch (error) { await prepared.discard(); throw error; }
  }
  saveStello(value: unknown, signal?: AbortSignal): Promise<Environment> {
    const input = stelloInput.parse(value);
    return this.track(async signal => {
      const projectPath = await this.project(input.projectPath);
      this.capacity(projectPath);
      const source: StelloSource = { ...input, projectPath, id: randomUUID(), createdAt: new Date().toISOString() };
      const observed = await this.branches.inspect(source, source.resource, signal);
      if (!observed.complete) throw new Error('Stello 来源分支尚未就绪。');
      this.capacity(projectPath);
      const environment: Environment = { id: randomUUID(), name: source.name, projectPath,
        mode: observed.mode === 'fixed' ? 'fixed' : 'live', access: 'read-only', createdAt: source.createdAt,
        stello: this.branches.binding(source, source.resource, observed, false) };
      this.store.put('providers', source); this.store.put('environments', environment);
      return environment;
    }, signal);
  }
  saveNeon(value: unknown, signal?: AbortSignal, expectedHost?: string): Promise<Environment> {
    const input = neonInput.parse(value);
    return this.track(async signal => {
      const projectPath = await this.project(input.projectPath);
      this.capacity(projectPath);
      const source: NeonSource = { ...input, projectPath, id: randomUUID(), createdAt: new Date().toISOString() };
      const binding = await this.neon.sourceBinding(source, signal, expectedHost);
      const connection = await this.neon.connect(source, binding, signal);
      if (expectedHost && connection.host !== expectedHost) {
        throw new Error('连接地址与 Neon 项目或分支不一致，请从同一个分支复制连接信息。');
      }
      const environment: Environment = { id: randomUUID(), name: source.name, projectPath,
        mode: 'live', access: 'read-only', createdAt: source.createdAt, neon: binding };
      await this.neon.sql.query(connection, { environmentId: environment.id, sql: 'SELECT 1 AS connected', values: [] }, signal);
      this.capacity(projectPath);
      this.store.transaction(() => {
        this.store.put('neonSources', source); this.store.put('environments', environment);
      });
      return environment;
    }, signal);
  }
  probe(connectionId: string, signal: AbortSignal): Promise<DatabaseTarget> {
    const environment = this.store.listAll('environments').find(item => item.connectionId === connectionId);
    if (environment) this.assertSourceEnabled(environment);
    return this.provider.probe(this.store.get('connections', connectionId), AbortSignal.any([signal, this.shutdown.signal]));
  }
  createEnvironment(value: unknown): Environment {
    const input = environmentInput.parse(value);
    const connection = this.store.get('connections', input.connectionId);
    const source = this.store.listAll('environments').find(item => item.connectionId === connection.id);
    if (source) this.assertSourceEnabled(source);
    this.capacity(connection.projectPath);
    const environment: Environment = { ...input, id: randomUUID(), projectPath: connection.projectPath,
      mode: 'live', access: 'read-only', createdAt: new Date().toISOString() };
    this.store.put('environments', environment);
    return environment;
  }
  environment(id: string): Environment { return this.store.get('environments', id); }
  private async agentProject(actor: Actor): Promise<string> {
    if (!actor.projectPath) throw new Error('Agent 尚未绑定项目目录。');
    return realpath(actor.projectPath);
  }
  private async authorize(id: string, actor: Actor, allowDisabled = false): Promise<Environment> {
    const environment = this.environment(id);
    if (actor.kind === 'agent') {
      const projectPath = await this.agentProject(actor);
      if (environment.projectPath !== projectPath || !this.agentCanUse(environment, actor)) {
        throw new Error('当前 Agent 无权使用这个数据环境。');
      }
    }
    if (environment.removedAt) throw new Error(environment.retainedReason
      ? '该分支已清理计算资源并结束访问，请打开保留的结果。' : '该分支已清理，请打开保留的结果。');
    if (this.managingSources.has(sourceKey(environment))) throw new Error('此数据源正在管理操作，请稍后继续。');
    if (!allowDisabled || actor.kind !== 'user') this.assertSourceEnabled(environment);
    return environment;
  }
  private agentCanUse(environment: Environment, actor: Actor): boolean {
    const scope = this.store.find('scopes', actor.id);
    if (scope && scope.environmentId !== environment.id) return false;
    if (!environment.experimentId) return true;
    const experiment = this.store.get('experiments', environment.experimentId);
    return experiment.sessionId === actor.id && experiment.workId === environment.id && experiment.status === 'active';
  }
  async environments(actor: Actor): Promise<Environment[]> {
    if (actor.kind === 'user') return this.store.environments();
    const projectPath = await this.agentProject(actor);
    return this.store.environments().filter(environment => {
      if (environment.projectPath !== projectPath || !this.agentCanUse(environment, actor)) return false;
      try { this.assertSourceEnabled(environment); return true; } catch { return false; }
    });
  }
  conversationSession(environmentId: string): string | undefined {
    const environment = this.environment(environmentId);
    this.assertSourceEnabled(environment);
    if (environment.removedAt) throw new Error('该分支已清理。');
    if (!environment.experimentId) return undefined;
    const experiment = this.store.get('experiments', environment.experimentId);
    if (experiment.status !== 'active' || experiment.workId !== environmentId) throw new Error('这个环境无法开启任务对话。');
    return experiment.sessionId;
  }
  bindConversation(environmentId: string, sessionId: string): string {
    const saved = this.conversationSession(environmentId);
    const environment = this.environment(environmentId);
    const experiment = environment.experimentId ? this.store.get('experiments', environment.experimentId) : undefined;
    const previous = this.store.find('scopes', sessionId);
    if (previous && previous.environmentId !== environmentId) throw new Error('对话已绑定到另一个数据环境。');
    if (saved) return saved;
    if (experiment && this.modifying.has(experiment.id)) throw new Error('任务正在处理操作，请稍后打开对话。');
    this.store.transaction(() => {
      this.store.put('scopes', { id: sessionId, environmentId });
      if (experiment) this.store.put('experiments', { ...experiment, sessionId });
    });
    return sessionId;
  }
  private track<T>(work: (signal: AbortSignal) => Promise<T>, signal = new AbortController().signal): Promise<T> {
    if (this.shutdown.signal.aborted) return Promise.reject(new Error('Stellane Host 正在停止。'));
    if (this.active.size >= 4) return Promise.reject(new Error('已有 4 个操作正在执行，请稍后重试。'));
    const combined = AbortSignal.any([signal, this.shutdown.signal]);
    const promise = Promise.resolve().then(() => { combined.throwIfAborted(); return work(combined); });
    this.active.add(promise);
    void promise.finally(() => this.active.delete(promise)).catch(() => {});
    return promise;
  }
  query(value: unknown, actor: Actor, signal?: AbortSignal): Promise<Run> {
    return this.track(signal => this.run(queryInput.parse(value), actor, signal, false), signal);
  }
  evidence(id: string): Run { return this.store.get('runs', id); }
  metric(value: unknown, actor: Actor, signal?: AbortSignal): Promise<Run> {
    const { environmentId, relationshipIds, ...spec } = metricInput.parse(value);
    return this.track(async signal => {
      const environment = await this.authorize(environmentId, actor);
      const experiment = environment.experimentId && this.store.find('experiments', environment.experimentId);
      const baseline = experiment && experiment.workId === environment.id && experiment.baselineMetricRunId
        ? this.evidence(experiment.baselineMetricRunId).metric?.plan : undefined;
      const relationships = relationshipIds.map(id => {
        const record = this.store.find('knowledge', id);
        if (!record || record.archivedAt || record.environmentId !== environmentId || record.fact.kind !== 'join') {
          const dependency = baseline?.relationships.find(item => item.id === id);
          if (dependency) return dependency;
          throw new Error('请使用当前环境中已保存的多对一或一对一关系。');
        }
        return { id, version: record.version, sourceRunId: record.evidence.runId, from: record.fact.from, to: record.fact.to };
      });
      for (let i = 1; i < relationships.length; i++) {
        const previous = relationships[i - 1]!.to;
        const next = relationships[i]!.from;
        if (previous.schema !== next.schema || previous.table !== next.table) {
          throw new Error('关系须按从指标明细到最终归属表的顺序连续排列。');
        }
      }
      return this.evaluateMetric(environment, { ...spec, relationships }, actor, signal);
    }, signal);
  }
  private async evaluateMetric(environment: Environment, plan: MetricPlan, actor: Actor, signal: AbortSignal): Promise<Run> {
    const run = await this.runOn(environment, {
      environmentId: environment.id, sql: metricSql(plan), values: plan.filter ? [plan.filter.value] : [],
    }, actor, signal, false, undefined, plan);
    if (run.status === 'succeeded' && run.metric?.relationChecksValid && run.metric.snapshot) {
      for (const [index, relationship] of plan.relationships.entries()) {
        const check = run.metric.checks?.[index];
        if (!check || check.missing === '0' && check.ambiguous === '0' && check.nullSourceKeys === '0') continue;
        const record = this.store.find('knowledge', relationship.id);
        // A branch's counterexample never invalidates the original source's
        // observation, and an older query cannot overwrite a newer check.
        if (!record || record.environmentId !== environment.id || record.version !== relationship.version
          || record.fact.kind !== 'join' || record.evidence.observedAt > run.startedAt
          || (record.invalidation && record.invalidation.evidence.observedAt > run.startedAt)) continue;
        const scope = `指标「${plan.name}」的统计范围${plan.filter ? `（${plan.filter.column} = ${JSON.stringify(plan.filter.value)}）` : ''}`;
        const reason = `${scope}内有 ${check.missing} 条记录未匹配、${check.ambiguous} 条记录存在多个候选匹配，旧的完整关联已失效。`;
        this.store.put('knowledge', { ...record, invalidation: { reason, scope, unmatchedRows: check.missing,
          evidence: { contextId: record.evidence.contextId, runId: run.id, observedAt: run.finishedAt!,
            method: 'metric-coverage', snapshot: run.metric.snapshot } } });
      }
    }
    return run;
  }
  write(value: unknown, actor: Actor, signal?: AbortSignal): Promise<Run> {
    return this.track(signal => this.run(queryInput.parse(value), actor, signal, true), signal);
  }
  context(value: unknown, actor: Actor, signal?: AbortSignal): Promise<ContextResult> {
    return this.track(signal=>this.catalog.context(value,actor,signal),signal);
  }
  catalogView(environmentId: string, actor: Actor, signal?: AbortSignal): Promise<CatalogView> {
    return this.track(signal=>this.catalog.view(environmentId,actor,signal),signal);
  }
  importCatalog(value: unknown, actor: Actor, signal?: AbortSignal): Promise<SemanticDefinition[]> {
    return this.track(signal=>this.catalog.import(value,actor,signal),signal);
  }
  learn(value: unknown, actor: Actor, signal?: AbortSignal): Promise<LearnResult> {
    return this.track(signal => this.catalog.learn(value, actor, signal), signal);
  }
  private lock(id: string): () => void {
    if (this.modifying.has(id)) throw new Error('这个环境正在写入或固定状态，请待当前操作结束。');
    this.modifying.add(id);
    return () => this.modifying.delete(id);
  }
  private async run(input: QueryInput, actor: Actor, signal: AbortSignal, write: boolean, purpose?: Run['purpose']): Promise<Run> {
    const environment = await this.authorize(input.environmentId, actor);
    return this.runOn(environment, input, actor, signal, write, purpose);
  }
  private async runOn(environment: Environment, input: QueryInput, actor: Actor, signal: AbortSignal, write: boolean, purpose?: Run['purpose'],
    metricPlan?: MetricPlan): Promise<Run> {
    if (this.environment(environment.id).removedAt) throw new Error('该分支已清理。');
    this.assertSourceEnabled(environment);
    if (environment.experimentId) {
      const experiment = this.store.get('experiments', environment.experimentId);
      const preparingMetric = metricPlan && experiment.status === 'preparing' && experiment.baselineId === environment.id;
      if (experiment.status !== 'active' && !preparingMetric && !(experiment.deliveryId && experiment.resultId === environment.id)) {
        throw new Error('任务工作环境尚未就绪或正在清理。');
      }
      if (write && this.modifying.has(experiment.id)) throw new Error('任务正在固定结果或清理，请稍后写入。');
    }
    if (write && (environment.access !== 'read-write' || !(environment.stello?.managed || environment.neon?.managed))) {
      throw new Error('只能写入 Stellane 派生的可写分支。来源库和保留的只读结果无法写入。');
    }
    const digest = write ? createHash('sha256').update(JSON.stringify(input)).digest('hex') : undefined;
    const id = write ? invocationId(actor, 'execute') : randomUUID();
    const existing = write ? this.store.find('runs', id) : undefined;
    if (existing) {
      if (existing.digest !== digest || existing.environmentId !== environment.id) throw new Error('原调用标识已关联其他写入请求。');
      return existing;
    }
    const release = write ? this.lock(environment.id) : () => {};
    const started = Date.now();
    const run: Run = { id, environmentId: environment.id, connectionId: environment.connectionId,
      projectPath: environment.projectPath, actor: { ...actor }, sql: input.sql, values: input.values,
      kind: write ? 'execute' : 'query', startedAt: new Date(started).toISOString(), status: 'running' };
    if (purpose) run.purpose = purpose;
    if (write) run.digest = digest;
    this.store.put('runs', run);
    const active = this.activeRuns.get(environment.id) ?? new Set<string>();
    active.add(run.id);
    this.activeRuns.set(environment.id, active);
    let finished: Run;
    try {
      let preview;
      if (environment.stello) {
        const source = this.store.get('providers', environment.stello.providerId);
        const connection = await this.branches.connect(source, environment.stello, signal);
        run.branch = environment.stello;
        this.store.put('runs', run);
        preview = write
          ? await this.branches.sql.execute(connection, input, { runId: run.id, digest: run.digest! }, signal)
          : await this.branches.sql.query(connection, input, signal);
      } else if (environment.neon) {
        const source = this.store.get('neonSources', environment.neon.providerId);
        const connection = await this.neon.connect(source, environment.neon, signal);
        run.neon = environment.neon;
        this.store.put('runs', run);
        preview = write
          ? await this.neon.sql.execute(connection, input, { runId: run.id, digest: run.digest! }, signal)
          : await this.neon.sql.query(connection, input, signal);
      } else {
        preview = await this.provider.query(this.store.get('connections', environment.connectionId!), input, signal);
      }
      finished = { ...run, status: 'succeeded', preview, target: preview.target };
    } catch (error) {
      const status = write ? error instanceof WriteOutcomeError && error.unknown ? 'unknown' : 'failed'
        : signal.aborted ? 'interrupted' : 'failed';
      finished = { ...run, status, error: error instanceof Error ? error.message : '执行失败。' };
    } finally {
      release();
      active.delete(run.id);
      if (!active.size) this.activeRuns.delete(environment.id);
    }
    finished.finishedAt = new Date().toISOString(); finished.durationMs = Date.now() - started;
    if (metricPlan) finished = withMetric(finished, metricPlan);
    this.store.put('runs', finished);
    return finished;
  }
  derive(kind: 'checkpoint' | 'fork', value: unknown, actor: Actor, signal?: AbortSignal): Promise<Environment> {
    return this.track(signal => this.deriveWork(kind, deriveInput.parse(value), actor, signal), signal);
  }
  private async deriveWork(kind: 'checkpoint' | 'fork', input: { environmentId: string; name: string }, actor: Actor, signal: AbortSignal,
    intent?: string, experimentId?: string): Promise<Environment> {
    const parent = await this.authorize(input.environmentId, actor);
    if (!parent.stello && !parent.neon) throw new Error('当前连接没有分支能力，可用于查询、血缘和记忆。独立写入实验需要启用 Neon 或 Stello 分支连接。');
    if (parent.experimentId && parent.experimentId !== experimentId) throw new Error('请在任务详情操作这个分支。');
    if (actor.kind === 'agent' && this.store.find('scopes', actor.id)) throw new Error('请从工作台发起独立实验。');
    if (kind === 'fork' && parent.mode !== 'fixed') throw new Error('请先保存父环境的只读基线，再从同一基线派生方案。');
    if (kind === 'checkpoint' && parent.mode === 'fixed') throw new Error('这个环境已经是只读基线，可以直接派生。');
    const id = invocationId(actor, kind);
    const inputDigest = createHash('sha256').update(JSON.stringify([parent.id, input.name, kind, intent ?? null])).digest('hex');
    const existing = this.store.find('operations', id);
    if (existing) {
      if (existing.parentEnvironmentId !== parent.id || existing.environment.name !== input.name || existing.kind !== kind
        || (existing.inputDigest && existing.inputDigest !== inputDigest)) throw new Error('原调用标识已关联其他派生请求。');
      if (existing.status === 'succeeded') return this.environment(existing.environment.id);
      if (experimentId && existing.status === 'unknown' && existing.request) {
        const binding = existing.providerKind === 'neon'
          ? await this.neon.resumeCreation(this.store.get('neonSources', existing.providerId), existing, signal)
          : await this.branches.resumeCreation(this.store.get('providers', existing.providerId), existing, signal);
        return this.finishBranch(existing, binding);
      }
      if (!(experimentId && existing.status === 'failed' && (!existing.request || existing.rejectedAttempts?.length))) {
        throw new Error(`原派生操作 ${id} 尚未确认，请核对原分支。`);
      }
    }
    this.capacity(parent.projectPath);
    const release = kind === 'checkpoint' ? this.lock(parent.id) : () => {};
    const providerId = parent.neon?.providerId ?? parent.stello!.providerId;
    const environment: Environment = existing?.environment ?? { id: randomUUID(), name: input.name, projectPath: parent.projectPath,
      mode: kind === 'checkpoint' ? 'fixed' : 'branch', access: kind === 'checkpoint' ? 'read-only' : 'read-write',
      createdAt: new Date().toISOString(), parentEnvironmentId: parent.id, experimentId };
    const operation: BranchOperation = { id, kind, providerId, parentEnvironmentId: parent.id,
      ...(parent.neon ? { providerKind: 'neon' as const } : {}),
      resource: parent.neon ? `stellane-${id}` : `${parent.stello!.resource.split('/')[0]}/sl-${id.replaceAll('-', '').slice(0, 20)}`,
      actor: { ...actor }, environment, inputDigest, status: 'pending', createdAt: environment.createdAt };
    if (existing?.rejectedAttempts) operation.rejectedAttempts = existing.rejectedAttempts;
    this.store.put('operations', operation);
    try {
      const prepared = (request: Record<string, unknown>) => {
        operation.request = request; this.store.put('operations', operation);
      };
      const binding = parent.neon
        ? await this.neon.create(this.store.get('neonSources', providerId), parent.neon, operation, prepared, signal)
        : await this.branches.create(this.store.get('providers', providerId), parent.stello!, operation, prepared, signal);
      return this.finishBranch(operation, binding);
    } catch (error) {
      operation.status = error instanceof NeonCreationRejectedError ? 'failed' : operation.request ? 'unknown' : 'failed';
      if (error instanceof NeonCreationRejectedError && operation.request) {
        operation.rejectedAttempts = [...(operation.rejectedAttempts ?? []),
          { status: error.status, at: new Date().toISOString(), request: structuredClone(operation.request) }];
      }
      operation.error = error instanceof Error ? error.message : '派生未确认。';
      this.store.put('operations', operation);
      throw new Error(`${operation.error} 操作记录：${operation.id}`, { cause: error });
    } finally { release(); }
  }
  private finishBranch(operation: BranchOperation, binding: BranchBinding | NeonBinding): Environment {
    const environment: Environment = { ...operation.environment,
      ...('branchId' in binding ? { neon: binding } : { stello: binding }) };
    this.store.transaction(() => {
      this.store.put('environments', environment);
      this.store.put('operations', { ...operation, environment, status: 'succeeded', error: undefined });
    });
    return environment;
  }
  reconcileOperation(id: string, actor: Actor, signal?: AbortSignal): Promise<BranchOperation> {
    return this.track(async signal => {
      const operation = this.store.get('operations', id);
      await this.authorize(operation.parentEnvironmentId, actor, true);
      if (operation.environment.experimentId) throw new Error('请在任务详情核对这次派生。');
      if (operation.status === 'succeeded' || operation.status === 'failed') return operation;
      const binding = operation.providerKind === 'neon'
        ? await this.neon.reconcile(this.store.get('neonSources', operation.providerId), operation, signal)
        : await this.branches.reconcile(this.store.get('providers', operation.providerId), operation, signal);
      if (binding) this.finishBranch(operation, binding);
      return this.store.get('operations', id);
    }, signal);
  }
  reconcileRun(id: string, actor: Actor, signal?: AbortSignal): Promise<Run> {
    return this.track(async signal => {
      const run = this.store.get('runs', id);
      const environment = await this.authorize(run.environmentId, actor, true);
      if (run.kind !== 'execute' || run.status !== 'unknown' || !run.digest || (!environment.stello && !environment.neon)) return run;
      const connection = environment.neon
        ? await this.neon.connect(this.store.get('neonSources', environment.neon.providerId), environment.neon, signal)
        : await this.branches.connect(this.store.get('providers', environment.stello!.providerId), environment.stello!, signal);
      const sql = environment.neon ? this.neon.sql : this.branches.sql;
      const preview = await sql.receipt(connection, environment.id, run.id, run.digest, signal);
      const checked: Run = preview ? { ...run, status: 'succeeded', preview, target: preview.target, error: undefined }
        : { ...run, error: '尚未找到匹配的提交回执，结果继续标为未知；SQL 未重放。' };
      this.store.put('runs', checked);
      return checked;
    }, signal);
  }
  deliver(value: unknown, actor: Actor, signal?: AbortSignal): Promise<DeliveredResult> {
    const input = deliverInput.parse(value);
    return this.track(async signal => {
      const source = await this.authorize(input.environmentId, actor);
      const recipient = await this.authorize(input.recipientEnvironmentId, actor);
      let ancestor = source.parentEnvironmentId;
      let found = false;
      for (let depth = 0; ancestor && depth < 16; depth++) {
        if (ancestor === recipient.id) { found = true; break; }
        ancestor = this.environment(ancestor).parentEnvironmentId;
      }
      if (!found || source.projectPath !== recipient.projectPath) throw new Error('结果只能交付给当前项目中的祖先环境。');
      if (source.access !== 'read-write') throw new Error('请从可写工作环境交付结果。');
      const id = invocationId(actor, 'delivery');
      const existing = this.store.find('deliveries', id);
      if (existing) {
        if (existing.sourceEnvironmentId !== source.id || existing.recipientEnvironmentId !== recipient.id || existing.summary !== input.summary
          || this.store.get('runs', existing.runId).sql !== input.sql) throw new Error('原调用标识已关联其他交付请求。');
        return { delivery: existing, environment: this.environment(existing.snapshotEnvironmentId), run: this.store.get('runs', existing.runId) };
      }
      const environment = await this.deriveWork('checkpoint', { environmentId: source.id, name: `${source.name.slice(0, 70)} · 交付` }, actor, signal, JSON.stringify(input));
      const run = await this.run(queryInput.parse({ environmentId: environment.id, sql: input.sql }), actor, signal, false);
      if (run.status !== 'succeeded') throw new Error(`交付结果已保留，但证据查询未成功：${run.error ?? run.status}`);
      const delivery: Delivery = { id, sourceEnvironmentId: source.id, recipientEnvironmentId: recipient.id,
        snapshotEnvironmentId: environment.id, runId: run.id, summary: input.summary, actor: { ...actor },
        projectPath: source.projectPath, createdAt: new Date().toISOString() };
      this.store.put('deliveries', delivery);
      return { delivery, environment, run };
    }, signal);
  }
  async results(environmentId: string, actor: Actor): Promise<DeliveredResult[]> {
    await this.authorize(environmentId, actor);
    return this.store.list('deliveries').filter(delivery => delivery.recipientEnvironmentId === environmentId
      && (actor.kind === 'user' || !this.environment(delivery.snapshotEnvironmentId).experimentId)).slice(0, 3)
      .map(delivery => ({ delivery, environment: this.environment(delivery.snapshotEnvironmentId), run: this.store.get('runs', delivery.runId) }));
  }
  experimentDetail(id: string): ExperimentDetail {
    const experiment = this.store.get('experiments', id);
    const { sourceId, baselineId, workId, resultId, deliveryId } = experiment;
    const delivery = deliveryId ? this.store.get('deliveries', deliveryId) : undefined;
    const result = resultId ? this.environment(resultId) : undefined;
    return { experiment, source: this.environment(sourceId), baseline: baselineId ? this.environment(baselineId) : undefined,
      work: workId ? this.environment(workId) : undefined, result,
      runs: workId ? this.store.experimentRuns(workId) : [], unresolved: workId ? this.store.experimentRuns(workId, true) : [],
      delivered: delivery && result ? { delivery, environment: result, run: this.store.get('runs', delivery.runId) } : undefined,
      baselineMetric: experiment.baselineMetricRunId ? this.evidence(experiment.baselineMetricRunId) : undefined,
      processing: this.modifying.has(id) };
  }
  private async authorizeExperiment(id: string, actor: Actor): Promise<void> {
    if (actor.kind === 'user') return;
    const project = await this.agentProject(actor);
    const experiment = this.store.find('experiments', id);
    if (experiment?.projectPath !== project || experiment.sessionId !== actor.id) {
      throw new Error('当前对话无权访问此实验。');
    }
  }
  async conversationExperiments(actor: Actor, id?: string): Promise<Experiment[] | ExperimentDetail> {
    if (id) {
      await this.authorizeExperiment(id, actor);
      return this.experimentDetail(id);
    }
    return this.store.conversationExperiments(await this.agentProject(actor), actor.id);
  }
  startConversationExperiment(value: unknown, actor: Actor, signal?: AbortSignal): Promise<ExperimentDetail> {
    const input = experimentSourceInput.parse(value);
    return this.track(async signal => {
      const source = await this.authorize(input.environmentId, actor);
      const sessionId = actor.id;
      if (source.mode === 'branch' || this.store.find('scopes', sessionId)) {
        throw new Error('请在普通项目对话中选择 Neon、Stello 来源或已保留的基线创建实验。');
      }
      const id = invocationId(actor, 'start-experiment');
      const saved = this.store.find('experiments', id)
        ?? this.store.openConversationExperiment(source.projectPath, sessionId, source.id, input.name);
      return this.prepareExperiment({ ...input, id: saved?.id ?? id }, signal, sessionId);
    }, signal);
  }
  startExperiment(value: unknown, signal?: AbortSignal): Promise<ExperimentDetail> {
    const input = experimentInput.parse(value);
    return this.track(signal => this.prepareExperiment(input, signal), signal);
  }
  private async prepareExperiment(input: ExperimentInput, signal: AbortSignal, sessionId?: string): Promise<ExperimentDetail> {
    const source = this.environment(input.environmentId);
    this.assertSourceEnabled(source);
    if ((!source.stello && !source.neon) || source.experimentId || source.removedAt) throw new Error('请选择已启用分支的 Neon 或 Stello 来源。PostgreSQL 连接可直接用于查询、血缘和记忆。');
    const saved = this.store.find('experiments', input.id);
    const metricRunId = input.metricRunId ?? saved?.metricRunId;
    const metricRun = metricRunId ? this.store.find('runs', metricRunId) : undefined;
    if (metricRunId && (!metricRun?.metric?.counts || metricRun.environmentId !== source.id || metricRun.metric.status === 'complete')) {
      throw new Error('请选择同一数据环境中的异常指标记录。');
    }
    if (saved && (saved.sourceId !== source.id || saved.name !== input.name || saved.metricRunId !== metricRunId
      || (sessionId && saved.sessionId !== sessionId))) {
      throw new Error('原任务已关联其他实验。');
    }
    if (!saved) this.capacity(source.projectPath, (source.mode === 'fixed' ? 1 : 2) + (sessionId ? 1 : 0));
    const experiment: Experiment = saved ?? { id: input.id, sourceId: source.id, name: input.name,
      projectPath: source.projectPath, createdAt: new Date().toISOString(), status: 'preparing', sessionId, metricRunId };
    if (experiment.status !== 'preparing') return this.experimentDetail(experiment.id);
    return this.updateExperiment(experiment, async () => {
      const actor: Actor = { ...owner, callId: experiment.id };
      const baseline = experiment.baselineId ? this.environment(experiment.baselineId) : source.mode === 'fixed' ? source
        : await this.deriveWork('checkpoint', { environmentId: source.id, name: '实验基线' }, actor, signal, undefined, experiment.id);
      experiment.baselineId = baseline.id;
      this.store.put('experiments', experiment);
      if (metricRun?.metric && !experiment.baselineMetricRunId) {
        const baselineMetric = await this.evaluateMetric(baseline, metricRun.metric.plan, actor, signal);
        if (baselineMetric.status !== 'succeeded' || !baselineMetric.metric?.counts) throw new Error('未能核对基线上的指标，请核对后重试。');
        experiment.baselineMetricRunId = baselineMetric.id;
        this.store.put('experiments', experiment);
      }
      const work = await this.deriveWork('fork', { environmentId: baseline.id, name: experiment.name }, actor, signal, undefined, experiment.id);
      experiment.workId = work.id;
      experiment.status = 'active';
    });
  }
  captureExperiment(value: unknown, signal?: AbortSignal, actor: Actor = owner): Promise<ExperimentDetail> {
    const { id, summary, sql, values } = experimentResultInput.parse(value);
    return this.track(async signal => {
      await this.authorizeExperiment(id, actor);
      const experiment = this.store.get('experiments', id);
      if (experiment.deliveryId) return this.experimentDetail(id);
      if (experiment.status !== 'active' || !experiment.workId) throw new Error('任务的工作分支尚不可用。');
      const workId = experiment.workId;
      const plan = experiment.baselineMetricRunId ? this.evidence(experiment.baselineMetricRunId).metric?.plan : undefined;
      if (!plan && !sql) throw new Error('请提供只读证据 SQL。');
      if (this.modifying.has(workId)) throw new Error('请等待当前写入结束再固定结果。');
      if (this.store.experimentRuns(workId, true).length) throw new Error('请先核对待确认的写入。');
      return this.updateExperiment(experiment, async () => {
        const lifecycleActor: Actor = { ...owner, callId: `${id}:result` };
        experiment.evidence = { summary, sql: plan ? metricSql(plan) : sql!, values: plan ? (plan.filter ? [plan.filter.value] : []) : values };
        this.store.put('experiments', experiment);
        const result = experiment.resultId ? this.environment(experiment.resultId)
          : await this.deriveWork('checkpoint', { environmentId: workId,
            name: this.environment(workId).neon ? '保留的只读结果' : '固定结果' }, lifecycleActor, signal, undefined, id);
        experiment.resultId = result.id;
        this.store.put('experiments', experiment);
        const run = plan ? await this.evaluateMetric(result, plan, actor, signal)
          : await this.runOn(result, queryInput.parse({ environmentId: result.id, sql, values }), actor, signal, false);
        if (run.status !== 'succeeded') throw new Error(result.neon
          ? `结果分支已保留。请在原分支补查证据。${run.error ?? ''}` : `切面已保存。请在原切面补查证据。${run.error ?? ''}`);
        if (plan && !run.metric?.counts) throw new Error('结果已保留，尚未取得指标覆盖证据。');
        const delivery: Delivery = { id, sourceEnvironmentId: workId, recipientEnvironmentId: experiment.sourceId,
          snapshotEnvironmentId: result.id, runId: run.id, summary, actor, projectPath: experiment.projectPath, createdAt: new Date().toISOString() };
        experiment.deliveryId = delivery.id;
        this.store.transaction(() => {
          this.store.put('deliveries', delivery);
          this.store.put('experiments', experiment);
        });
      });
    }, signal);
  }
  finishExperiment(id: string, signal?: AbortSignal, actor: Actor = owner): Promise<ExperimentDetail> {
    return this.track(async signal => {
      await this.authorizeExperiment(id, actor);
      const experiment = this.store.get('experiments', id);
      if (experiment.status === 'closed') return this.experimentDetail(id);
      if (this.managingSources.has(sourceKey(this.environment(experiment.sourceId)))) throw new Error('此数据源正在管理操作，请稍后结束实验。');
      if (actor.kind === 'agent' && !experiment.deliveryId) throw new Error(this.environment(experiment.sourceId).neon
        ? '请先保存并交付证据，再结束实验。' : '请先固定并交付证据，再清理实验。');
      const lifecycleActor: Actor = { ...owner, callId: id };
      const baselineOp = this.store.find('operations', invocationId(lifecycleActor, 'checkpoint'));
      const workOp = this.store.find('operations', invocationId(lifecycleActor, 'fork'));
      if ([baselineOp, workOp].some(op => op?.status === 'unknown' || op?.status === 'pending')) {
        throw new Error('请先核对未完成的分支派生。');
      }
      const resultOp = this.store.find('operations', invocationId({ ...lifecycleActor, callId: `${id}:result` }, 'checkpoint'));
      if (resultOp?.status === 'unknown' || resultOp?.status === 'pending') throw new Error('请先在交付入口核对未完成的只读结果。');
      const resourceId = (saved: string | undefined, operation: BranchOperation | undefined) =>
        saved ?? (operation?.status === 'succeeded' ? operation.environment.id : undefined);
      const workId = resourceId(experiment.workId, workOp);
      const baselineId = resourceId(experiment.baselineId, baselineOp);
      const resultId = resourceId(experiment.resultId, resultOp);
      const owned = [experiment.deliveryId ? undefined : resultId, workId, baselineId].flatMap(environmentId => {
        if (!environmentId) return [];
        const environment = this.environment(environmentId);
        return environment.experimentId === id && !environment.removedAt ? [environment] : [];
      });
      if (owned.some(environment => this.activeRuns.has(environment.id))) throw new Error('请等待当前查询或写入结束。');
      if (workId && this.store.experimentRuns(workId, true).length) throw new Error('请先核对待确认的写入。');
      return this.updateExperiment(experiment, async () => {
        Object.assign(experiment, { workId, baselineId, resultId });
        experiment.status = 'closing';
        this.store.put('experiments', experiment);
        for (const environment of owned) {
          const environmentId = environment.id;
          if (environment.neon?.managed) {
            const source = this.store.get('neonSources', environment.neon.providerId);
            // Neon cannot delete parents of a retained result. Remove their computes
            // and revoke local access while keeping the dependency chain explicit.
            const retain = !!experiment.deliveryId;
            await this.neon.remove(source, environment.neon, environmentId, this.store.find('neonRemovals', environmentId),
              removal => this.store.put('neonRemovals', removal), signal, retain ? 'compute' : 'branch');
            const retainedReason = retain ? environment.neon.local
              ? '本地 Neon 结果依赖此父时间线。compute 已移除，访问已结束；时间线仍占用本地磁盘。'
              : 'Neon 结果依赖此父分支。compute 已移除，访问已结束；存储仍保留，可能继续产生费用。' : undefined;
            this.store.put('environments', { ...environment, removedAt: new Date().toISOString(), retainedReason });
            if (retainedReason) experiment.retentionNote = retainedReason;
          } else if (environment.stello?.managed) {
            const source = this.store.get('providers', environment.stello.providerId);
            await this.branches.remove(source, environment.stello, environmentId, this.store.find('removals', environmentId),
              removal => this.store.put('removals', removal), signal);
            this.store.put('environments', { ...environment, removedAt: new Date().toISOString() });
          } else throw new Error('没有可核对的任务分支身份。');
        }
        experiment.status = 'closed';
      });
    }, signal);
  }
  private async updateExperiment(experiment: Experiment, work: () => Promise<void>): Promise<ExperimentDetail> {
    const release = this.lock(experiment.id);
    try {
      delete experiment.error;
      this.store.put('experiments', experiment);
      await work();
    } catch (error) {
      experiment.error = error instanceof Error ? error.message : '任务操作中断，请核对原操作。';
    } finally {
      this.store.put('experiments', experiment);
      release();
    }
    return this.experimentDetail(experiment.id);
  }
  async close(): Promise<void> {
    this.shutdown.abort(); await Promise.allSettled([...this.active]); this.store.close();
  }
}
