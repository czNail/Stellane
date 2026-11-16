import { useState } from 'react';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-api-gateway/client';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client';
import type { ChatSnapshot, ToolChatData, TurnTailOwnerProps } from '@deepseek-ai/dsh-client-ui-chat/client';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client';
import type {} from '@deepseek-ai/dsh-client-ui-settings/client';
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client';
import type { UiWorkspace } from '@deepseek-ai/dsh-client-ui-workspace/client';
import type {} from '@deepseek-ai/dsh-api-session-controller/client';
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client';
import type { ToolCallBlock } from '@deepseek-ai/dsh-client-ui-conversation/client';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import type { TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol';
import { remoteInfo, type Reply, type Responses } from '../shared/remote.ts';
import type { Run } from '../shared/models.ts';
import styles from './styles.css';
import { Panel, SettingsPage } from './panel.tsx';
import { runStatus } from './explore.tsx';
import type { Api } from './workspace-ui.tsx';
import { MetricSummary } from './metric.tsx';

const toolLabels: Record<string, string> = {
  stellane_context: '语义上下文', stellane_query: '查询数据', stellane_environments: '可用环境', stellane_execute: '提交写入',
  stellane_learn: '核对数据关系',
  stellane_metric: '指标结果',
  stellane_start_experiment: '创建实验', stellane_experiments: '查看实验',
  stellane_capture_experiment: '固定并交付', stellane_finish_experiment: '清理实验',
  stellane_checkpoint: '固定状态', stellane_fork: '派生环境', stellane_deliver: '交付方案',
  stellane_results: '收到的结果', stellane_reconcile_write: '核对写入', stellane_reconcile_branch: '核对派生',
};
export const inject = ['remote', 'slots'];

function contentText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  return content.flatMap((item: unknown) => {
    if (typeof item === 'object' && item !== null && 'type' in item && item.type === 'text' && 'text' in item && typeof item.text === 'string') return [item.text];
    return [];
  }).join('\n');
}
function latestMetric(calls: readonly ToolCallBlock[]): Run | undefined {
  for (const call of [...calls].reverse()) {
    if ('kind' in call && call.kind === 'tool-result' && call.name === 'stellane_metric') {
      try {
        const run = JSON.parse(contentText(call.content) ?? '') as Run;
        if (run.metric && typeof run.id === 'string') return run;
      } catch { /* A tool failure has no metric evidence. */ }
    }
    const nested = latestMetric(call.subCalls);
    if (nested) return nested;
  }
}

function MetricTurnTail({ turn, readMetric, openEvidence }: TurnTailOwnerProps & {
  readMetric: (turn: number) => Run | undefined; openEvidence: (id: string) => void;
}) {
  if (turn.status !== 'closed') return null;
  const run = readMetric(turn.turn);
  if (!run?.metric) return null;
  return <section className="st-tool st-metric-tail" aria-label="指标覆盖与证据">
    <MetricSummary metric={run.metric} />
    <button type="button" onClick={() => openEvidence(run.id)}>查看指标证据</button>
  </section>;
}
function Icon() { return <span aria-hidden="true" className="st-icon">S</span>; }
function ToolCard(props: ToolCallViewProps & { openEvidence: (id: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const text = contentText(props.phase === 'result' ? props.block.content : undefined);
  let result: Run | undefined;
  let evidenceId: string | undefined;
  try { if (text) { const value = JSON.parse(text); const run = value?.run ?? value;
    if (run && typeof run.id === 'string' && typeof run.status === 'string') result = run;
    const proof = value?.evidence?.runId ?? value?.knowledge?.evidence?.runId ?? value?.context?.runId;
    evidenceId = result?.id ?? (typeof proof === 'string' ? proof : undefined);
  } } catch { /* Generic failure content stays inspectable. */ }
  return <div className="st-tool">
    <button onClick={() => setExpanded(value => !value)} aria-expanded={expanded}>
      <Icon /><span>Stellane · {toolLabels[props.toolName] ?? props.toolName}</span>
      <span className="st-muted">{result ? runStatus[result.status] : props.phase === 'result' ? '已返回' : '处理中'}</span>
    </button>
    {result?.metric && <MetricSummary metric={result.metric} />}
    {evidenceId && <button type="button" onClick={() => props.openEvidence(evidenceId!)}>查看证据</button>}
    {expanded && <pre>{text ?? '等待执行结果…'}</pre>}
  </div>;
}

export async function apply(ctx: Context): Promise<void> {
  const unmount = await ctx.remote.$mount(remoteInfo);
  ctx.effect(() => unmount);
  ctx.inject(['remote.stellane', 'uiWorkspace', 'sessions', 'conversation', 'uiConversation', 'layout'], mounted => mountUI(mounted));
}

function mountUI(ctx: Context): void {
  const api: Api = async (name, input) => {
    const result = await remoteInfo.methods[`stellane/${name}`]!.invoke(ctx.remote as TypertClientRemote, { input });
    if (!('ok' in result)) throw new Error('宿主返回了不支持的响应类型。');
    if (!result.ok) throw new Error(result.error.message);
    const reply = result.value as Reply<Responses[typeof name]>;
    if (!reply.success) throw new Error(reply.error);
    return reply.value;
  };
  ctx.effect(() => {
    const style = document.createElement('style'); style.dataset.stellane = ''; style.textContent = styles;
    document.head.appendChild(style); return () => style.remove();
  });
  const openConversation = async (environmentId: string, prompt?: string, options?: { unbound?: boolean }) => {
    const target = await api('prepareConversation', { environmentId });
    if (target.sessionId) {
      ctx.uiWorkspace.openSession(target.sessionId as SessionId);
      return;
    }
    // A fresh Session keeps an existing conversation draft scoped to its original environment.
    const created = await ctx.sessions.create({ workspaceId: target.workspaceId as Parameters<UiWorkspace['connectWorkspace']>[0] });
    const { sessionId } = options?.unbound ? { sessionId: created } : await api('bindConversation', { environmentId, sessionId: created });
    if (prompt && sessionId === created) {
      await ctx.sessions.using(created, { source: 'controllerOperation' }, async reference => {
        const binding = await reference.ready;
        const result = ctx.conversation.input.requestDraftInitialization(binding, { prompt, whenDraftExists: 'keep' });
        if (result === 'blocked') throw new Error('暂时无法打开对话草稿。');
        ctx.uiWorkspace.openSession(created);
      });
    } else {
      ctx.uiWorkspace.openSession(sessionId as SessionId);
    }
  };
  const openSession = (id: string) => { ctx.uiWorkspace.openSession(id as SessionId); };
  const navigation = new EventTarget();
  let evidence: { id: string } | undefined;
  const openEvidence = (id: string) => {
    evidence = { id };
    navigation.dispatchEvent(new Event('navigate'));
    ctx.layout.selectPanel('stellane' as MainPanelId);
  };
  const evidenceNavigation = {
    read: () => evidence,
    subscribe(notify: () => void) {
      navigation.addEventListener('navigate', notify);
      return () => navigation.removeEventListener('navigate', notify);
    },
    clear() { evidence = undefined; navigation.dispatchEvent(new Event('navigate')); },
  };
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main', key: 'stellane', inject: () => ({ api, openConversation, openSession, openEvidence, evidenceNavigation }),
  }, Panel));
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 'stellane', order: 30, label: 'Stellane' }, Icon));
  ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'stellane', order: 50, label: 'Stellane', inject: () => ({ api }) }, SettingsPage));
  for (const key of Object.keys(toolLabels)) {
    ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key, inject: () => ({ openEvidence }) }, ToolCard));
  }
  ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
    name: 'conversation.chat.turnTail', id: 'stellane-metric', inject: sessionId => ({
      openEvidence,
      readMetric(turn: number) {
        const binding = ctx.sessions.binding(sessionId as SessionId);
        const snapshot: ChatSnapshot | undefined = binding && ctx.uiConversation.binding(binding).target('chat').getSnapshot();
        const calls: readonly ToolChatData[] | undefined = snapshot?.nodes.turnDataSource(turn, 'tool-call').getSnapshot();
        return calls ? latestMetric(calls.map(item => item.root)) : undefined;
      },
    }),
  }, MetricTurnTail));
}
