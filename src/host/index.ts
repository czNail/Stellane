import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import '@deepseek-ai/dsh-typert-registry';
import type {} from '@deepseek-ai/dsh-workspace';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { z } from 'zod';
import { StellaneCore } from '../core/index.ts';
import { PACKAGE, remoteInfo, type Reply, type Requests } from '../shared/remote.ts';
import type { Actor, Connection, DatabaseTarget, Environment, Run, Snapshot } from '../shared/models.ts';

export interface Config { stateDirectory?: string }
export const Config = Schema.object({
  stateDirectory: Schema.string().description('Stellane 本地状态目录（绝对路径）。').default(join(homedir(), '.local/share/stellane')),
});
export const inject = ['tools', 'typert', 'workspaceRegistry'];

export class StellaneService extends TypertRemoteService {
  constructor(ctx: Context, readonly core: StellaneCore) { super(ctx, 'stellane'); }
  private async owner<T>(work: () => T | Promise<T>): Promise<Reply<T>> {
    if (this.ctx.invocation?.peer.principal.kind !== 'owner') throw new Error('仅 Host 所有者可访问 Stellane 管理界面。');
    try { return { success: true, value: await work() }; }
    catch (error) {
      const message = error instanceof z.ZodError ? '输入格式不正确，请检查字段。'
        : error instanceof Error ? error.message : '操作失败。';
      return { success: false, error: message };
    }
  }
  snapshot(_input: Requests['snapshot'], _signal: AbortSignal): Promise<Reply<Snapshot>> {
    return this.owner(() => this.core.snapshot());
  }
  saveConnection(input: Requests['saveConnection'], _signal: AbortSignal): Promise<Reply<Connection>> {
    return this.owner(() => this.core.saveConnection(input));
  }
  probe(input: Requests['probe'], signal: AbortSignal): Promise<Reply<DatabaseTarget>> {
    return this.owner(() => this.core.probe(input.connectionId, signal));
  }
  createEnvironment(input: Requests['createEnvironment'], _signal: AbortSignal): Promise<Reply<Environment>> {
    return this.owner(() => this.core.createEnvironment(input));
  }
  prepareConversation(input: Requests['prepareConversation'], _signal: AbortSignal): Promise<Reply<{ workspaceId: string }>> {
    return this.owner(async () => {
      const environment = this.core.environment(input.environmentId);
      const workspace = await this.ctx.workspaceRegistry.create(environment.projectPath);
      return { workspaceId: workspace.id };
    });
  }
  query(input: Requests['query'], signal: AbortSignal): Promise<Reply<Run>> {
    return this.owner(() => this.core.query(input, { kind: 'user', id: 'owner' }, signal));
  }
}

export function apply(ctx: Context, config: Config): void {
  const directory = config.stateDirectory ?? join(homedir(), '.local/share/stellane');
  if (!isAbsolute(directory)) throw new Error('Stellane 状态目录必须是绝对路径。');
  const core = new StellaneCore(directory);
  new StellaneService(ctx, core);
  ctx.effect(() => ctx.typert.register({
    package: PACKAGE, face: 'host', schemas: [],
    model: { services: [], events: [], objects: [] }, invocations: remoteInfo.descriptors,
  }));
  ctx.effect(() => () => core.close());
  const actor = (agent: { id: string; session: { header: { cwd?: string } } } | undefined): Actor => {
    if (!agent) throw new Error('工具调用必须关联真实 Agent。');
    return { kind: 'agent', id: agent.id, projectPath: agent.session.header.cwd };
  };
  ctx.tools.register(defineTool({
    name: 'stellane_environments',
    description: '列出当前 Agent 项目中可用的 Stellane PostgreSQL 数据环境。查询前先取得环境 ID；第一阶段环境为直连、实时、只读。',
    parameters: {}, output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(_args, exec) {
      return JSON.parse(JSON.stringify(await core.environments(actor(exec.agent))));
    },
  }));
  ctx.tools.register(defineTool({
    name: 'stellane_query',
    description: '在当前项目获准的 Stellane 环境执行单条只读 PostgreSQL 查询。传入 stellane_environments 返回的环境 ID。返回实际目标、运行记录与最多 200 行预览；使用 SELECT / WITH 和 $1 参数，写入、事务控制和多条语句不受支持。',
    parameters: {
      environmentId: { type: 'string', required: true, description: '获准使用的环境 ID' },
      sql: { type: 'string', required: true, description: '单条只读 SELECT / WITH 查询' },
      values: { type: 'array', items: { type: 'json' }, description: '可选的 $1 等参数值，仅字符串、数字、布尔或 null' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      return JSON.parse(JSON.stringify(await core.query(args, actor(exec.agent), exec.signal)));
    },
  }));
}

declare module '@deepseek-ai/cordis' { interface Context { stellane: StellaneService } }
