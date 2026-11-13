import { createHash, randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { connectionInput, deliverInput, deriveInput, environmentInput, queryInput, stelloInput } from '../shared/models.ts';
import type { Actor, BranchBinding, BranchOperation, Connection, DatabaseTarget, DeliveredResult, Delivery, Environment, QueryInput, Run, Snapshot, StelloSource } from '../shared/models.ts';
import { PostgresProvider, WriteOutcomeError, type QueryProvider } from '../providers/postgres.ts';
import { StelloProvider } from '../providers/stello.ts';
import { Store } from './store.ts';
import { SemanticCatalog } from './catalog.ts';
import type { CatalogView, ContextResult, SemanticDefinition } from '../shared/context-models.ts';
import type { LearnResult } from '../shared/knowledge-models.ts';

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
  private readonly provider: QueryProvider;
  private readonly branches: StelloProvider;
  private readonly catalog: SemanticCatalog;
  constructor(directory: string, provider: QueryProvider = new PostgresProvider(), branches: StelloProvider = new StelloProvider()) {
    this.provider = provider; this.branches = branches; this.store = new Store(directory);
    this.catalog = new SemanticCatalog(this.store,id=>this.environment(id),
      (environmentId, sql, actor, signal, purpose) => this.run(queryInput.parse({ environmentId, sql }), actor, signal, false, purpose));
  }
  snapshot(): Snapshot {
    return { connections: this.store.list('connections'), environments: this.store.list('environments'),
      runs: this.store.list('runs', 100), providers: this.store.list('providers'),
      operations: this.store.list('operations', 100), deliveries: this.store.list('deliveries', 100) };
  }
  private async project(path: string): Promise<string> {
    if (!isAbsolute(path)) throw new Error('项目目录必须是绝对路径。');
    const projectPath = await realpath(path);
    if (!(await stat(projectPath)).isDirectory()) throw new Error('项目路径必须是目录。');
    return projectPath;
  }
  private capacity(projectPath: string): void {
    if (this.store.environmentCount(projectPath) >= 16) throw new Error('项目已登记 16 个环境或待核实派生，请核对资源后继续。');
  }
  async saveConnection(value: unknown): Promise<Connection> {
    const input = connectionInput.parse(value);
    const projectPath = await this.project(input.projectPath);
    const connection: Connection = { ...input, projectPath, id: randomUUID(), createdAt: new Date().toISOString() };
    this.store.put('connections', connection);
    return connection;
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
  probe(connectionId: string, signal: AbortSignal): Promise<DatabaseTarget> {
    return this.provider.probe(this.store.get('connections', connectionId), AbortSignal.any([signal, this.shutdown.signal]));
  }
  createEnvironment(value: unknown): Environment {
    const input = environmentInput.parse(value);
    const connection = this.store.get('connections', input.connectionId);
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
  private async authorize(id: string, actor: Actor): Promise<Environment> {
    const environment = this.environment(id);
    if (actor.kind === 'agent' && environment.projectPath !== await this.agentProject(actor)) {
      throw new Error('当前 Agent 无权使用这个项目的数据环境。');
    }
    return environment;
  }
  async environments(actor: Actor): Promise<Environment[]> {
    if (actor.kind === 'user') return this.store.list('environments');
    const projectPath = await this.agentProject(actor);
    return this.store.list('environments').filter(environment => environment.projectPath === projectPath);
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
    if (write && (environment.access !== 'read-write' || !environment.stello?.managed)) {
      throw new Error('只能写入 Stellane 派生的可写分支；来源库、固定切面和普通 PG 环境保持只读。');
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
      } else {
        preview = await this.provider.query(this.store.get('connections', environment.connectionId!), input, signal);
      }
      finished = { ...run, status: 'succeeded', preview, target: preview.target };
    } catch (error) {
      const status = write ? error instanceof WriteOutcomeError && error.unknown ? 'unknown' : 'failed'
        : signal.aborted ? 'interrupted' : 'failed';
      finished = { ...run, status, error: error instanceof Error ? error.message : '执行失败。' };
    } finally { release(); }
    finished.finishedAt = new Date().toISOString(); finished.durationMs = Date.now() - started;
    this.store.put('runs', finished);
    return finished;
  }
  derive(kind: 'checkpoint' | 'fork', value: unknown, actor: Actor, signal?: AbortSignal): Promise<Environment> {
    return this.track(signal => this.deriveWork(kind, deriveInput.parse(value), actor, signal), signal);
  }
  private async deriveWork(kind: 'checkpoint' | 'fork', input: { environmentId: string; name: string }, actor: Actor, signal: AbortSignal, intent?: string): Promise<Environment> {
    const parent = await this.authorize(input.environmentId, actor);
    if (!parent.stello) throw new Error('当前数据库没有分支能力，请先登记 Stello 来源。');
    if (kind === 'fork' && parent.mode !== 'fixed') throw new Error('请先固定父环境状态，再从同一切面派生方案。');
    if (kind === 'checkpoint' && parent.mode === 'fixed') throw new Error('这个环境已经是固定切面，可以直接派生。');
    const id = invocationId(actor, kind);
    const inputDigest = createHash('sha256').update(JSON.stringify([parent.id, input.name, kind, intent ?? null])).digest('hex');
    const existing = this.store.find('operations', id);
    if (existing) {
      if (existing.parentEnvironmentId !== parent.id || existing.environment.name !== input.name || existing.kind !== kind
        || (existing.inputDigest && existing.inputDigest !== inputDigest)) throw new Error('原调用标识已关联其他派生请求。');
      if (existing.status === 'succeeded') return this.environment(existing.environment.id);
      throw new Error(`原派生操作 ${id} 尚未确认，请核对原分支；未另建资源。`);
    }
    this.capacity(parent.projectPath);
    const release = kind === 'checkpoint' ? this.lock(parent.id) : () => {};
    const source = this.store.get('providers', parent.stello.providerId);
    const environment: Environment = { id: randomUUID(), name: input.name, projectPath: parent.projectPath,
      mode: kind === 'checkpoint' ? 'fixed' : 'branch', access: kind === 'checkpoint' ? 'read-only' : 'read-write',
      createdAt: new Date().toISOString(), parentEnvironmentId: parent.id };
    const operation: BranchOperation = { id, kind, providerId: source.id, parentEnvironmentId: parent.id,
      resource: `${parent.stello.resource.split('/')[0]}/sl-${id.replaceAll('-', '').slice(0, 20)}`,
      actor: { ...actor }, environment, inputDigest, status: 'pending', createdAt: environment.createdAt };
    this.store.put('operations', operation);
    try {
      const binding = await this.branches.create(source, parent.stello, operation, request => {
        operation.request = request; this.store.put('operations', operation);
      }, signal);
      return this.finishBranch(operation, binding);
    } catch (error) {
      operation.status = operation.request ? 'unknown' : 'failed';
      operation.error = error instanceof Error ? error.message : '派生未确认。';
      this.store.put('operations', operation);
      throw new Error(`${operation.error} 操作记录：${operation.id}`, { cause: error });
    } finally { release(); }
  }
  private finishBranch(operation: BranchOperation, binding: BranchBinding): Environment {
    const environment = { ...operation.environment, stello: binding };
    this.store.put('environments', environment);
    this.store.put('operations', { ...operation, environment, status: 'succeeded', error: undefined });
    return environment;
  }
  reconcileOperation(id: string, actor: Actor, signal?: AbortSignal): Promise<BranchOperation> {
    return this.track(async signal => {
      const operation = this.store.get('operations', id);
      await this.authorize(operation.parentEnvironmentId, actor);
      if (operation.status === 'succeeded' || operation.status === 'failed') return operation;
      const binding = await this.branches.reconcile(this.store.get('providers', operation.providerId), operation, signal);
      if (binding) this.finishBranch(operation, binding);
      return this.store.get('operations', id);
    }, signal);
  }
  reconcileRun(id: string, actor: Actor, signal?: AbortSignal): Promise<Run> {
    return this.track(async signal => {
      const run = this.store.get('runs', id);
      const environment = await this.authorize(run.environmentId, actor);
      if (run.kind !== 'execute' || run.status !== 'unknown' || !run.digest || !environment.stello) return run;
      const connection = await this.branches.connect(this.store.get('providers', environment.stello.providerId), environment.stello, signal);
      const preview = await this.branches.sql.receipt(connection, environment.id, run.id, run.digest, signal);
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
      if (run.status !== 'succeeded') throw new Error(`交付切面已保留，但证据查询未成功：${run.error ?? run.status}`);
      const delivery: Delivery = { id, sourceEnvironmentId: source.id, recipientEnvironmentId: recipient.id,
        snapshotEnvironmentId: environment.id, runId: run.id, summary: input.summary, actor: { ...actor },
        projectPath: source.projectPath, createdAt: new Date().toISOString() };
      this.store.put('deliveries', delivery);
      return { delivery, environment, run };
    }, signal);
  }
  async results(environmentId: string, actor: Actor): Promise<DeliveredResult[]> {
    await this.authorize(environmentId, actor);
    return this.store.list('deliveries').filter(delivery => delivery.recipientEnvironmentId === environmentId).slice(0, 3)
      .map(delivery => ({ delivery, environment: this.environment(delivery.snapshotEnvironmentId), run: this.store.get('runs', delivery.runId) }));
  }
  async close(): Promise<void> {
    this.shutdown.abort(); await Promise.allSettled([...this.active]); this.store.close();
  }
}
