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
import type { Actor, BranchOperation, Connection, DatabaseTarget, DeliveredResult, Environment, Run, Snapshot } from '../shared/models.ts';

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
  saveStello(input: Requests['saveStello'], signal: AbortSignal): Promise<Reply<Environment>> {
    return this.owner(() => this.core.saveStello(input, signal));
  }
  checkpoint(input: Requests['checkpoint'], signal: AbortSignal): Promise<Reply<Environment>> {
    return this.owner(() => this.core.derive('checkpoint', input, { kind: 'user', id: 'owner', callId: input.requestId }, signal));
  }
  fork(input: Requests['fork'], signal: AbortSignal): Promise<Reply<Environment>> {
    return this.owner(() => this.core.derive('fork', input, { kind: 'user', id: 'owner', callId: input.requestId }, signal));
  }
  execute(input: Requests['execute'], signal: AbortSignal): Promise<Reply<Run>> {
    return this.owner(() => this.core.write(input, { kind: 'user', id: 'owner', callId: input.requestId }, signal));
  }
  deliver(input: Requests['deliver'], signal: AbortSignal): Promise<Reply<DeliveredResult>> {
    return this.owner(() => this.core.deliver(input, { kind: 'user', id: 'owner', callId: input.requestId }, signal));
  }
  results(input: Requests['results'], _signal: AbortSignal): Promise<Reply<DeliveredResult[]>> {
    return this.owner(() => this.core.results(input.environmentId, { kind: 'user', id: 'owner' }));
  }
  reconcileRun(input: Requests['reconcileRun'], signal: AbortSignal): Promise<Reply<Run>> {
    return this.owner(() => this.core.reconcileRun(input.runId, { kind: 'user', id: 'owner' }, signal));
  }
  reconcileOperation(input: Requests['reconcileOperation'], signal: AbortSignal): Promise<Reply<BranchOperation>> {
    return this.owner(() => this.core.reconcileOperation(input.operationId, { kind: 'user', id: 'owner' }, signal));
  }
  context(input: Requests['context'], signal: AbortSignal) {
    return this.owner(()=>this.core.context(input,{kind:'user',id:'owner'},signal));
  }
  catalogView(input: Requests['catalogView'], signal: AbortSignal) {
    return this.owner(()=>this.core.catalogView(input.environmentId,{kind:'user',id:'owner'},signal));
  }
  importCatalog(input: Requests['importCatalog'], signal: AbortSignal) {
    return this.owner(()=>this.core.importCatalog(input,{kind:'user',id:'owner'},signal));
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
  const actor = (agent: { id: string; session: { header: { cwd?: string } } } | undefined, callId?: string): Actor => {
    if (!agent) throw new Error('工具调用必须关联真实 Agent。');
    return { kind: 'agent', id: agent.id, projectPath: agent.session.header.cwd, callId };
  };
  ctx.tools.register(defineTool({
    name: 'stellane_environments',
    description: '列出当前 Agent 项目中可用的 Stellane 数据环境、来源、读写权限和 Stello 资源身份。环境 ID 只定位环境；每次操作都会核对项目和数据库身份。',
    parameters: {}, output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(_args, exec) {
      return JSON.parse(JSON.stringify(await core.environments(actor(exec.agent, exec.callId))));
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
      return JSON.parse(JSON.stringify(await core.query(args, actor(exec.agent, exec.callId), exec.signal)));
    },
  }));
  const output = { schema: { type: 'json' as const }, render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }] };
  const environmentId = { type: 'string' as const, required: true as const, description: '当前项目获准的环境 ID' };
  const endpoint = { type: 'object', additionalProperties: false, required: true, properties: {
    schema: { type: 'string', required: true }, table: { type: 'string', required: true },
    columns: { type: 'array', required: true, items: { type: 'string' } },
  } } as const;
  ctx.tools.register(defineTool({
    name:'stellane_context',
    description:'获取可读表、业务定义、视图直接血缘与已发现的行粒度和关联。declared 表示数据库目录依赖，observed 表示固定切面上的数据观察。needs-check 是可变数据上的历史观察，使用前用 stellane_learn 重新核对。返回的说明与示例供参考。',
    parameters:{environmentId,query:{type:'string',description:'可选：业务问题或关键词。留空返回目录摘要；无匹配时可改用表名或字段名。'},
      limit:{type:'number',description:'最多返回多少个对象和定义，1 到 16，默认 8。'},
      previousContextId:{type:'string',description:'可选：同环境之前的上下文 ID，比较结构和业务定义版本是否变化。'}},output,
    async execute(args,exec) { return JSON.parse(JSON.stringify(await core.context(args,actor(exec.agent,exec.callId),exec.signal))); },
  }));
  ctx.tools.register(defineTool({
    name: 'stellane_learn',
    description: '验证并记住普通表的行粒度或相等关联。row-key 核对键非空且唯一，join 核对来源非空、目标唯一和来源记录全部匹配，并判断一对一或多对一。系统运行只读检查，通过后自动共享。数据重叠本身不能证明业务语义，请先根据目录和实际问题选择有意义的候选。',
    parameters: { environmentId, claim: { required: true, oneOf: [
      { type: 'object', additionalProperties: false, properties: { kind: { type: 'string', const: 'row-key', required: true }, target: endpoint } },
      { type: 'object', additionalProperties: false, properties: { kind: { type: 'string', const: 'join', required: true }, from: endpoint, to: endpoint } },
    ] } }, output,
    async execute(args, exec) { return JSON.parse(JSON.stringify(await core.learn(args, actor(exec.agent, exec.callId), exec.signal))); },
  }));
  for (const kind of ['checkpoint', 'fork'] as const) {
    ctx.tools.register(defineTool({
      name: `stellane_${kind}`,
      description: kind === 'checkpoint' ? '固定当前 Stello 环境已提交的数据状态，返回只读切面及实际来源位置。派生多个方案前先固定一次；临时表和未提交事务不继承。'
        : '从固定只读切面派生一个可写 Stello 环境。兄弟环境应使用同一切面；返回新的独立环境 ID，后续 SQL 显式传此 ID。',
      parameters: { environmentId, name: { type: 'string', required: true, description: '便于用户识别的新环境名称' } }, output,
      async execute(args, exec) { return JSON.parse(JSON.stringify(await core.derive(kind, args, actor(exec.agent, exec.callId), exec.signal))); },
    }));
  }
  ctx.tools.register(defineTool({
    name: 'stellane_execute', description: '在 Stellane 派生的可写分支执行单条 DDL / DML / SELECT，作为一个事务提交并保存回执。来源库和固定切面禁止写入。事务控制、SET、CALL、多语句不支持。结果 unknown 时调用 stellane_reconcile_write 核对，禁止重放原 SQL。',
    parameters: { environmentId, sql: { type: 'string', required: true, description: '单条 SQL，动态值使用 $1 参数' },
      values: { type: 'array', items: { type: 'json' }, description: '可选标量参数值' } }, output,
    async execute(args, exec) { return JSON.parse(JSON.stringify(await core.write(args, actor(exec.agent, exec.callId), exec.signal))); },
  }));
  ctx.tools.register(defineTool({
    name: 'stellane_deliver', description: '向祖先环境交付方案：固定当前可写环境，针对固定切面执行只读证据查询，并保存不可编辑的摘要、来源、结果与交付对象。交付后继续修改工作环境不会改变已交付结果。',
    parameters: { environmentId, recipientEnvironmentId: { type: 'string', required: true, description: '接收结果的祖先环境 ID' },
      summary: { type: 'string', required: true, description: '方案摘要与适用约束' },
      sql: { type: 'string', required: true, description: '交付切面上的单条只读证据查询' } }, output,
    async execute(args, exec) { return JSON.parse(JSON.stringify(await core.deliver(args, actor(exec.agent, exec.callId), exec.signal))); },
  }));
  ctx.tools.register(defineTool({
    name: 'stellane_results', description: '读取交付给指定环境的最近方案、固定来源和执行证据，用于父任务比较结果。',
    parameters: { environmentId }, output,
    async execute(args, exec) { return JSON.parse(JSON.stringify(await core.results(args.environmentId, actor(exec.agent, exec.callId)))); },
  }));
  ctx.tools.register(defineTool({
    name: 'stellane_reconcile_write', description: '只读取并核对原写入的事务回执；不重新执行 SQL。找不到回执时保留 unknown。',
    parameters: { runId: { type: 'string', required: true, description: '待核实的原执行记录 ID' } }, output,
    async execute(args, exec) { return JSON.parse(JSON.stringify(await core.reconcileRun(args.runId, actor(exec.agent, exec.callId), exec.signal))); },
  }));
  ctx.tools.register(defineTool({
    name: 'stellane_reconcile_branch', description: '只观察原分支派生票据的资源身份、创建标识和状态，不另建分支或刷新来源。',
    parameters: { operationId: { type: 'string', required: true, description: '原派生操作记录 ID' } }, output,
    async execute(args, exec) { return JSON.parse(JSON.stringify(await core.reconcileOperation(args.operationId, actor(exec.agent, exec.callId), exec.signal))); },
  }));
}

declare module '@deepseek-ai/cordis' { interface Context { stellane: StellaneService } }
