import { useState } from 'react';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-api-gateway/client';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type {} from '@deepseek-ai/dsh-client-ui-layout/client';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client';
import type {} from '@deepseek-ai/dsh-client-ui-settings/client';
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client';
import type { UiWorkspace } from '@deepseek-ai/dsh-client-ui-workspace/client';
import type { TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol';
import { remoteInfo, type Reply, type Responses } from '../shared/remote.ts';
import type { Run } from '../shared/models.ts';
import styles from './styles.css';
import { Panel, SettingsPage } from './panel.tsx';
import { runStatus } from './explore.tsx';
import type { Api } from './workspace-ui.tsx';

const toolLabels: Record<string, string> = {
  stellane_context: '语义上下文', stellane_query: '查询数据', stellane_environments: '可用环境', stellane_execute: '提交写入',
  stellane_learn: '核对数据关系',
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
function Icon() { return <span aria-hidden="true" className="st-icon">S</span>; }
function ToolCard(props: ToolCallViewProps) {
  const [expanded, setExpanded] = useState(false);
  const text = contentText(props.phase === 'result' ? props.block.content : undefined);
  let result: Run | undefined;
  try { if (text) { const value = JSON.parse(text); const run = value?.run ?? value;
    if (run && typeof run.id === 'string' && typeof run.status === 'string') result = run;
  } } catch { /* Generic failure content stays inspectable. */ }
  return <div className="st-tool">
    <button onClick={() => setExpanded(value => !value)} aria-expanded={expanded}>
      <Icon /><span>Stellane · {toolLabels[props.toolName] ?? props.toolName}</span>
      <span className="st-muted">{result ? runStatus[result.status] : props.phase === 'result' ? '已返回' : '处理中'}</span>
    </button>
    {expanded && <pre>{text ?? '等待执行结果…'}</pre>}
  </div>;
}

export async function apply(ctx: Context): Promise<void> {
  const unmount = await ctx.remote.$mount(remoteInfo);
  ctx.effect(() => unmount);
  ctx.inject(['remote.stellane', 'uiWorkspace'], mounted => mountUI(mounted));
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
  const openConversation = (workspaceId: string, prompt: string) => ctx.uiWorkspace.startSession(
    workspaceId as Parameters<UiWorkspace['startSession']>[0], { prompt, whenDraftExists: 'append' });
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'stellane', inject: () => ({ api, openConversation }) }, Panel));
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 'stellane', order: 30, label: 'Stellane' }, Icon));
  ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'stellane', order: 50, label: 'Stellane', inject: () => ({ api }) }, SettingsPage));
  for (const key of Object.keys(toolLabels)) {
    ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key }, ToolCard));
  }
}
