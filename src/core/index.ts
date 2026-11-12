import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { connectionInput, environmentInput, queryInput } from '../shared/models.ts';
import type { Actor, Connection, DatabaseTarget, Environment, QueryInput, Run, Snapshot } from '../shared/models.ts';
import { PostgresProvider, type QueryProvider } from '../providers/postgres.ts';
import { Store } from './store.ts';

export class StellaneCore {
  private readonly store: Store;
  private readonly shutdown = new AbortController();
  private readonly active = new Set<Promise<unknown>>();
  private readonly provider: QueryProvider;
  constructor(directory: string, provider: QueryProvider = new PostgresProvider()) {
    this.provider = provider;
    this.store = new Store(directory);
  }
  snapshot(): Snapshot {
    return { connections: this.store.list('connections'), environments: this.store.list('environments'), runs: this.store.list('runs').slice(0, 100) };
  }
  async saveConnection(value: unknown): Promise<Connection> {
    const input = connectionInput.parse(value);
    if (!isAbsolute(input.projectPath)) throw new Error('项目目录必须是绝对路径。');
    const projectPath = await realpath(input.projectPath);
    if (!(await stat(projectPath)).isDirectory()) throw new Error('项目路径必须是目录。');
    const connection: Connection = { ...input, projectPath, id: randomUUID(), createdAt: new Date().toISOString() };
    this.store.put('connections', connection);
    return connection;
  }
  probe(connectionId: string, signal: AbortSignal): Promise<DatabaseTarget> {
    return this.provider.probe(this.store.get('connections', connectionId), AbortSignal.any([signal, this.shutdown.signal]));
  }
  createEnvironment(value: unknown): Environment {
    const input = environmentInput.parse(value);
    const connection = this.store.get('connections', input.connectionId);
    const environment: Environment = {
      ...input, id: randomUUID(), projectPath: connection.projectPath,
      mode: 'live', access: 'read-only', createdAt: new Date().toISOString(),
    };
    this.store.put('environments', environment);
    return environment;
  }
  environment(id: string): Environment { return this.store.get('environments', id); }
  private async agentProject(actor: Actor): Promise<string> {
    if (!actor.projectPath) throw new Error('Agent 尚未绑定项目目录。');
    return realpath(actor.projectPath);
  }
  async environments(actor: Actor): Promise<Environment[]> {
    if (actor.kind === 'user') return this.store.list('environments');
    const projectPath = await this.agentProject(actor);
    return this.store.list('environments').filter(environment => environment.projectPath === projectPath);
  }
  query(value: unknown, actor: Actor, signal: AbortSignal = new AbortController().signal): Promise<Run> {
    if (this.active.size >= 4) return Promise.reject(new Error('已有 4 个查询正在执行，请稍后重试。'));
    const promise = this.execute(queryInput.parse(value), actor, AbortSignal.any([signal, this.shutdown.signal]));
    this.active.add(promise);
    void promise.finally(() => this.active.delete(promise)).catch(() => {});
    return promise;
  }
  private async execute(input: QueryInput, actor: Actor, signal: AbortSignal): Promise<Run> {
    signal.throwIfAborted();
    const environment = this.store.get('environments', input.environmentId);
    if (actor.kind === 'agent') {
      const projectPath = await this.agentProject(actor);
      if (environment.projectPath !== projectPath) throw new Error('当前 Agent 无权使用这个项目的数据环境。');
    }
    const connection = this.store.get('connections', environment.connectionId);
    const started = Date.now();
    const run: Run = {
      id: randomUUID(), environmentId: environment.id, connectionId: connection.id,
      projectPath: environment.projectPath, actor: { ...actor }, sql: input.sql, values: input.values,
      startedAt: new Date(started).toISOString(), status: 'running',
    };
    this.store.put('runs', run);
    let finished: Run;
    try {
      const preview = await this.provider.query(connection, input, signal);
      finished = { ...run, status: 'succeeded', preview, target: preview.target };
    } catch (error) {
      finished = { ...run, status: signal.aborted ? 'interrupted' : 'failed', error: error instanceof Error ? error.message : '查询失败。' };
    }
    finished.finishedAt = new Date().toISOString();
    finished.durationMs = Date.now() - started;
    this.store.put('runs', finished);
    return finished;
  }
  async close(): Promise<void> {
    this.shutdown.abort();
    await Promise.allSettled([...this.active]);
    this.store.close();
  }
}
