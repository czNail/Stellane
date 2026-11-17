import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-agent';
import Schema from '@deepseek-ai/schemastery';
import type {} from '@deepseek-ai/dsh-skill';
import type {} from '@deepseek-ai/dsh-system-prompt';
import { defineTool } from '@deepseek-ai/dsh-tools';
import '@deepseek-ai/dsh-typert-registry';
import type {} from '@deepseek-ai/dsh-workspace';
import type { SessionId } from '@deepseek-ai/dsh-session';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { z } from 'zod';
import { StellaneCore } from '../core/index.ts';
import { PACKAGE, remoteInfo, type Reply, type Requests, type Responses } from '../shared/remote.ts';
import type { Actor, BranchOperation, Connection, DatabaseTarget, DeliveredResult, Environment, Run, Snapshot } from '../shared/models.ts';
import { dataSkill } from './data-skill.ts';
import { describeEnvironment } from '../shared/capabilities.ts';
import { readLocalNeonConfig } from '../core/neon-local-onboarding.ts';

export interface Config { stateDirectory?: string }
export const Config = Schema.object({
  stateDirectory: Schema.string().description('Stellane state directory (absolute path). Defaults to this DSH profile; existing legacy data is preserved.'),
});
export const inject = ['tools', 'typert', 'workspaceRegistry', 'sessions', 'skills', 'systemPrompt'];

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
  management(_input: Requests['management'], _signal: AbortSignal): Promise<Reply<Responses['management']>> {
    return this.owner(() => this.core.management());
  }
  manage(input: Requests['manage'], signal: AbortSignal): Promise<Reply<Responses['manage']>> {
    return this.owner(() => this.core.manage(input, { kind: 'user', id: 'owner' }, signal));
  }
  saveConnection(input: Requests['saveConnection'], _signal: AbortSignal): Promise<Reply<Connection>> {
    return this.owner(() => this.core.saveConnection(input));
  }
  connectPostgres(input: Requests['connectPostgres'], signal: AbortSignal): Promise<Reply<Environment>> {
    return this.owner(() => this.core.connectPostgres(input, signal));
  }
  connectNeon(input: Requests['connectNeon'], signal: AbortSignal): Promise<Reply<Environment>> {
    return this.owner(() => this.core.connectNeon(input, signal));
  }
  connectLocalNeon(input: Requests['connectLocalNeon'], signal: AbortSignal): Promise<Reply<Environment>> {
    return this.owner(async () => {
      const source = await readLocalNeonConfig(input.configPath);
      return this.core.saveNeon({ ...source, ...(input.projectPath ? { projectPath: input.projectPath } : {}),
        ...(input.name ? { name: input.name } : {}) }, signal);
    });
  }
  saveNeon(input: Requests['saveNeon'], signal: AbortSignal): Promise<Reply<Environment>> {
    return this.owner(() => this.core.saveNeon(input, signal));
  }
  probe(input: Requests['probe'], signal: AbortSignal): Promise<Reply<DatabaseTarget>> {
    return this.owner(() => this.core.probe(input.connectionId, signal));
  }
  createEnvironment(input: Requests['createEnvironment'], _signal: AbortSignal): Promise<Reply<Environment>> {
    return this.owner(() => this.core.createEnvironment(input));
  }
  prepareConversation(input: Requests['prepareConversation'], _signal: AbortSignal): Promise<Reply<Responses['prepareConversation']>> {
    return this.owner(async () => {
      const environment = this.core.environment(input.environmentId);
      const sessionId = this.core.conversationSession(environment.id);
      const workspace = await this.ctx.workspaceRegistry.create(environment.projectPath);
      return { workspaceId: workspace.id, ...(sessionId ? { sessionId } : {}) };
    });
  }
  bindConversation(input: Requests['bindConversation'], _signal: AbortSignal): Promise<Reply<Responses['bindConversation']>> {
    return this.owner(() => {
      const session = this.ctx.sessions.get(input.sessionId as SessionId);
      const environment = this.core.environment(input.environmentId);
      if (!session || session.header.cwd !== environment.projectPath || session.header.origin === 'subagent') {
        throw new Error('对话不属于目标项目，无法绑定数据环境。');
      }
      return { sessionId: this.core.bindConversation(input.environmentId, session.id) };
    });
  }
  query(input: Requests['query'], signal: AbortSignal): Promise<Reply<Run>> {
    return this.owner(() => this.core.query(input, { kind: 'user', id: 'owner' }, signal));
  }
  metric(input: Requests['metric'], signal: AbortSignal): Promise<Reply<Run>> {
    return this.owner(() => this.core.metric(input, { kind: 'user', id: 'owner' }, signal));
  }
  runEvidence(input: Requests['runEvidence'], _signal: AbortSignal): Promise<Reply<Run>> {
    return this.owner(() => this.core.evidence(input.id));
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
  startExperiment(input: Requests['startExperiment'], signal: AbortSignal) {
    return this.owner(() => this.core.startExperiment(input, signal));
  }
  experimentDetail(input: Requests['experimentDetail'], _signal: AbortSignal) {
    return this.owner(() => this.core.experimentDetail(input.id));
  }
  captureExperiment(input: Requests['captureExperiment'], signal: AbortSignal) {
    return this.owner(() => this.core.captureExperiment(input, signal));
  }
  finishExperiment(input: Requests['finishExperiment'], signal: AbortSignal) {
    return this.owner(() => this.core.finishExperiment(input.id, signal));
  }
}

export function apply(ctx: Context, config: Config): void {
  const legacy = join(homedir(), '.local/share/stellane');
  const profile = ctx.get('profileContext') as { dir?: string } | undefined;
  const directory = config.stateDirectory ?? (existsSync(join(legacy, 'state.sqlite')) ? legacy
    : profile?.dir && isAbsolute(profile.dir) ? join(profile.dir, 'stellane-state') : legacy);
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
  ctx.skills.register(dataSkill);
  ctx.on('system-prompt/assemble', async (_assembly, { agent, scope, toolSet }, next) => {
    const prompt = await next();
    if (!agent?.session.header.cwd || !toolSet
      || !['stellane_environments', 'stellane_context', 'stellane_query'].every(name => ctx.tools.get(name, scope, toolSet))) {
      return prompt;
    }
    const environments = await core.environments(actor(agent)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR' || error.code === 'EACCES') return [];
      throw error;
    });
    if (!environments.length) return prompt;
    const workflow = ctx.tools.get('skill', scope, toolSet)
      ? `先用 skill 加载 ${dataSkill.name}，再按说明调查。`
      : '先调用 stellane_environments 选择适用环境，再用 stellane_context 核对业务口径和表结构，需要时用 stellane_query 只读查询。';
    const experiment = environments.some(item => describeEnvironment(item).canExperiment)
      && ctx.tools.get('stellane_start_experiment', scope, toolSet)
      ? '如果用户明确要模拟改动或在独立分支验证方案，使用 stellane_start_experiment 开始，并保存结果与证据。'
      : '';
    return { ...prompt, sections: [...prompt.sections, {
      name: 'stellane-data', text: `当前对话可使用 Stellane。用户要调查项目数据、业务口径或数据血缘时，${workflow}${experiment}`,
    }] };
  });
  ctx.tools.register(defineTool({
    name: 'stellane_environments',
    description: '列出当前项目可用的数据库、读写权限和能力。PostgreSQL、Neon、Stello 均可查询和积累记忆；capabilities.canExperiment 表示可以开启独立试验。每次访问均检查项目与来源身份。',
    parameters: {}, output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(_args, exec) {
      return JSON.parse(JSON.stringify((await core.environments(actor(exec.agent, exec.callId)))
        .map(environment => ({ ...environment, capabilities: describeEnvironment(environment) }))));
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
  const experimentId = { type: 'string' as const, required: true as const, description: '本对话的实验 ID' };
  ctx.tools.register(defineTool({
    name: 'stellane_metric',
    description: '沿已保存的多对一或一对一关系链分组计数或求和。在同一数据库快照复核匹配与缺失、计算分组和总量。返回结构化覆盖状态与证据。可使用待核对或曾失效的已知关系，服务会按本次统计范围重新验证。',
    parameters: {
      environmentId,
      name: { type: 'string', required: true, description: '用户可读的指标名称' },
      relationshipIds: { type: 'array', required: true, items: { type: 'string' }, description: '从统计明细表指向最终归属表，按顺序列出已保存的关系 ID，1 至 4 条' },
      groupColumn: { type: 'string', required: true, description: '末端归属表的分组字段' },
      amountColumn: { type: 'string', description: '可选，起始明细表的数值求和字段，省略时仅计数' },
      filter: { type: 'object', additionalProperties: false, properties: {
        column: { type: 'string', required: true, description: '明细表的筛选字段' },
        value: { type: 'json', required: true, description: '需要等于的字符串、数字或布尔值' },
      }, description: '可选，限定本次统计范围' },
    }, output,
    async execute(args, exec) {
      return JSON.parse(JSON.stringify(await core.metric(args, actor(exec.agent, exec.callId), exec.signal)));
    },
  }));
  ctx.tools.register(defineTool({
    name: 'stellane_start_experiment',
    description: '在普通项目对话为用户明确要求的验证创建实验。选择具备 canExperiment 能力的 Neon 或 Stello 来源。返回任务 ID 和私有 work.id，后续 SQL 只使用 work.id。用同样的环境和名称可恢复未结束的原实验。',
    parameters: { environmentId, name: { type: 'string', required: true, description: '概括用户要验证的假设，长度不超过 80 字' },
      metricRunId: { type: 'string', description: '从异常正式指标发起修复试算时传入原执行记录 ID，固定基线与结果按原口径重算' } },
    output,
    async execute(args, exec) {
      return JSON.parse(JSON.stringify(await core.startConversationExperiment(args, actor(exec.agent, exec.callId), exec.signal)));
    },
  }));
  ctx.tools.register(defineTool({
    name: 'stellane_experiments',
    description: '查看当前对话创建或绑定的实验。用实验 ID 查看阶段、工作分支、SQL 记录及保留结果；省略 ID 列出近期实验。恢复中断时先查看原任务。',
    parameters: { id: { type: 'string', description: '可选，本对话的实验 ID' } },
    output,
    async execute(args, exec) {
      return JSON.parse(JSON.stringify(await core.conversationExperiments(actor(exec.agent, exec.callId), args.id)));
    },
  }));
  ctx.tools.register(defineTool({
    name: 'stellane_capture_experiment',
    description: '保存本对话的实验结果，在保留的只读分支执行证据 SQL 并交付。Stello 提供不可变快照，Neon 为受只读保护的分支。证据失败可补查原结果。检查 delivered 和 experiment.error 判断是否已交付。',
    parameters: {
      id: experimentId,
      summary: { type: 'string', required: true, description: '验证方案、实测结论和适用范围' },
      sql: { type: 'string', description: '普通实验提供固定切面的只读证据 SQL。指标修复实验由系统以原口径生成证据，可省略' },
      values: { type: 'array', items: { type: 'json' }, description: '可选的 $1 等参数值，仅字符串、数字、布尔或 null' },
    },
    output,
    async execute(args, exec) {
      return JSON.parse(JSON.stringify(await core.captureExperiment(args, exec.signal, actor(exec.agent, exec.callId))));
    },
  }));
  ctx.tools.register(defineTool({
    name: 'stellane_finish_experiment',
    description: '结束本对话已交付的实验，保留结果与 SQL 证据。Stello 清理临时分支；Neon 删除临时 compute 并撤销访问，结果依赖的父分支继续保留，参见 retentionNote。结果待核对时可用同一实验 ID 继续清理。',
    parameters: { id: experimentId },
    output,
    async execute(args, exec) {
      return JSON.parse(JSON.stringify(await core.finishExperiment(args.id, exec.signal, actor(exec.agent, exec.callId))));
    },
  }));
  const endpointValue = { type: 'object', additionalProperties: false, properties: {
    schema: { type: 'string', required: true }, table: { type: 'string', required: true },
    columns: { type: 'array', required: true, items: { type: 'string' } },
  } } as const;
  const endpoint = { ...endpointValue, required: true } as const;
  ctx.tools.register(defineTool({
    name:'stellane_context',
    description:'获取可读表、业务定义、视图血缘、行粒度和关联。declared 表示数据库目录依赖，observed 表示固定切面的数据观察，needs-check 是可变数据上的历史观察。invalidatedRelationships 是历史失效记录，可将其 ID 交给 stellane_metric 重新核对本次范围。',
    parameters:{environmentId,query:{type:'string',description:'可选：业务问题或关键词。留空返回目录摘要；无匹配时可改用表名或字段名。'},
      limit:{type:'number',description:'最多返回多少个对象和定义，1 到 16，默认 8。'},
      previousContextId:{type:'string',description:'可选：同环境之前的上下文 ID，比较结构和业务定义版本是否变化。'}},output,
    async execute(args,exec) { return JSON.parse(JSON.stringify(await core.context(args,actor(exec.agent,exec.callId),exec.signal))); },
  }));
  ctx.tools.register(defineTool({
    name: 'stellane_draft_definition',
    description: '在用户明确要求记住或更正业务词、字段含义或计算口径时，准备一份可在对话中确认的说明。核对数据源、表和字段，不会直接保存。目标应来自实际调查。',
    parameters: {
      environmentId,
      title: { type: 'string', required: true, description: '下次提问时会使用的业务词' },
      content: { type: 'string', required: true, description: '用户已说明或可查证的含义、适用条件和计算口径' },
      targets: { type: 'array', required: true, items: endpointValue },
    }, output,
    async execute(args, exec) {
      return JSON.parse(JSON.stringify(await core.draftDefinition(args, actor(exec.agent, exec.callId), exec.signal)));
    },
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
      description: kind === 'checkpoint' ? '从具备分支能力的来源保存只读基线。Stello 为固定快照，Neon 为受只读保护的分支。临时表和未提交事务不继承。'
        : '从已保存的只读基线派生独立可写分支。返回新环境 ID，后续 SQL 显式传此 ID。Neon 和 Stello 均支持，普通 PostgreSQL 连接不具备此能力。',
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
    name: 'stellane_deliver', description: '向祖先环境交付方案：固定当前可写环境，针对固定切面执行只读证据查询，并保存不可编辑的摘要、来源、结果与交付对象。交付后工作分支的修改不会传入结果分支。Neon 结果仍可能被外部管理员修改，不能视为不可变快照。',
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
