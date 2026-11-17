import { t, useLocale, systemMessage, labels as localizedLabels } from './i18n.tsx';
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
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client';
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client';
import type { ToolCallBlock } from '@deepseek-ai/dsh-client-ui-conversation/client';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import type { TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol';
import { remoteInfo, type Reply, type Responses } from '../shared/remote.ts';
import type { ExperimentDetail, Run } from '../shared/models.ts';
import { importCatalogInput, type DefinitionDraft } from '../shared/context-models.ts';
import styles from './styles.css';
import { Panel, SettingsPage, type PanelTarget } from './panel.tsx';
import { runStatus } from './explore.tsx';
import { message, type Api, type ProjectAccess } from './workspace-ui.tsx';

const toolLabels: Record<string, string> = localizedLabels({
  stellane_context: '查阅表与口径', stellane_query: '查询数据', stellane_environments: '可用环境', stellane_execute: '提交写入',
  stellane_learn: '核对数据关系',
  stellane_draft_definition: '准备业务说明',
  stellane_metric: '指标结果',
  stellane_start_experiment: '创建实验', stellane_experiments: '查看实验',
  stellane_capture_experiment: '保存结果与证据', stellane_finish_experiment: '清理实验',
  stellane_checkpoint: '保存基线', stellane_fork: '创建独立分支', stellane_deliver: '交付方案',
  stellane_results: '收到的结果', stellane_reconcile_write: '核对写入', stellane_reconcile_branch: '核对派生',
});
export const inject = ['remote', 'slots'];

function contentText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  return content.flatMap((item: unknown) => {
    if (typeof item === 'object' && item !== null && 'type' in item && item.type === 'text' && 'text' in item && typeof item.text === 'string') return [item.text];
    return [];
  }).join('\n');
}
interface TurnLinks { metric?: Run; query?: Run; experiment?: ExperimentDetail['experiment']; drafts: DefinitionDraft[] }

function readLinks(calls: readonly ToolCallBlock[], links: TurnLinks = { drafts: [] }): TurnLinks {
  for (const call of [...calls].reverse()) {
    if ('kind' in call && call.kind === 'tool-result' && call.name.startsWith('stellane_')) {
      try {
        const value = JSON.parse(contentText(call.content) ?? '');
        if (call.name === 'stellane_metric' && value?.metric && typeof value.id === 'string') links.metric ??= value;
        if (call.name === 'stellane_query' && typeof value?.id === 'string') links.query ??= value;
        if (['stellane_start_experiment', 'stellane_capture_experiment', 'stellane_finish_experiment', 'stellane_experiments'].includes(call.name)
          && typeof value?.experiment?.id === 'string') links.experiment ??= value.experiment;
        if (call.name === 'stellane_draft_definition') {
          const request = importCatalogInput.safeParse(value?.request);
          if (request.success && request.data.document.entries.length === 1
            && !links.drafts.some(draft => draft.request.requestId === request.data.requestId)) {
            links.drafts.unshift({ ...value, request: request.data });
          }
        }
      } catch { /* A tool failure has no structured link. */ }
    }
    readLinks(call.subCalls, links);
  }
  return links;
}

function DefinitionConfirmation({ draft, save, saved }: {
  draft: DefinitionDraft; save: (draft: DefinitionDraft) => Promise<void>; saved: boolean;
}) {
  useLocale();
  const [done, setDone] = useState(saved);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const entry = draft.request.document.entries[0]!;
  async function confirm() {
    setBusy(true);
    setError('');
    try { await save(draft); setDone(true); }
    catch (error) { setError(message(error)); }
    finally { setBusy(false); }
  }
  return <section className="st-definition-confirm" aria-label={t('业务说明')}>
    <div className="st-row"><strong>{entry.title}</strong><span className="st-muted" title={draft.projectPath}>{draft.environmentName}</span></div>
    <p className="st-content">{entry.content}</p>
    <p className="st-muted">{entry.targets.map(target => `${target.schema}.${target.table}${target.columns?.length ? ` (${target.columns.join(', ')})` : ''}`).join(' · ')}</p>
    {draft.previousContent && <details className="st-details"><summary>{t('原业务说明')}</summary><p className="st-content">{draft.previousContent}</p></details>}
    {error && <p className="st-error" role="alert">{systemMessage(error)}</p>}
    {done ? <p className="st-muted" role="status">{t('已保存，下次提问可复用。')}</p>
      : <button type="button" className="st-proof-link" disabled={busy} onClick={() => void confirm()}>{busy ? t('保存中…')
        : entry.expectedVersion ? t('更新业务说明') : t('保存业务说明')}</button>}
  </section>;
}

function StellaneTurnTail({ turn, linksForTurn, openPanel, save, saved }: TurnTailOwnerProps & {
  linksForTurn: (turn: number) => TurnLinks; openPanel: (target: PanelTarget) => void;
  save: (draft: DefinitionDraft) => Promise<void>; saved: Set<string>;
}) {
  useLocale();
  if (turn.status !== 'closed') return null;
  const { metric, query, experiment, drafts } = linksForTurn(turn.turn);
  const run = metric ?? query;
  if (!run && !experiment && !drafts.length) return null;
  return <section className="st-tool st-turn-tail" aria-label="Stellane">
    {drafts.map(draft => <DefinitionConfirmation key={draft.request.requestId} draft={draft} save={save} saved={saved.has(draft.request.requestId)} />)}
    {(run || experiment) && <div className="st-row">
      {run && <button type="button" className="st-proof-link" onClick={() => openPanel({ kind: 'evidence', id: run.id })}>{metric ? t('查看指标证据') : t('查看查询证据')}</button>}
      {experiment && <button type="button" className="st-proof-link" onClick={() => openPanel({ kind: 'experiment', id: experiment.id })}>{t('查看分支试验')}</button>}
    </div>}
  </section>;
}
function Icon() {
  useLocale(); return <span aria-hidden="true" className="st-icon">S</span>; }
function ToolCard(props: ToolCallViewProps & { openEvidence: (id: string) => void }) {
  useLocale();
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
      <span className="st-muted">{result ? runStatus[result.status] : props.phase === 'result' ? t("已返回") : t("处理中")}</span>
    </button>
    {expanded && <>
      {evidenceId && <button type="button" onClick={() => props.openEvidence(evidenceId!)}>{t('查看证据')}</button>}
      <pre>{text ?? t('等待执行结果…')}</pre>
    </>}
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
    if (!('ok' in result)) throw new Error(t("宿主返回了不支持的响应类型。"));
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
        if (result === 'blocked') throw new Error(t("暂时无法打开对话草稿。"));
        ctx.uiWorkspace.openSession(created);
      });
    } else {
      ctx.uiWorkspace.openSession(sessionId as SessionId);
    }
  };
  const openSession = (id: string) => { ctx.uiWorkspace.openSession(id as SessionId); };
  const projectAccess: ProjectAccess = {
    currentPath() {
      const sessions = ctx.sessions.list.getSnapshot() as SessionListState;
      return Object.values(sessions.byId).find(session => {
        const owners: Readonly<Record<string, number | undefined>> = session.retainedBy;
        return (owners.mainView ?? 0) > 0;
      })?.cwd;
    },
    pickDirectory: () => ctx.uiWorkspace.pickDirectory(),
  };
  const navigation = new EventTarget();
  let target: PanelTarget | undefined;
  const openPanel = (next: PanelTarget) => {
    target = next;
    navigation.dispatchEvent(new Event('navigate'));
    ctx.layout.selectPanel('stellane' as MainPanelId);
  };
  const openEvidence = (id: string) => openPanel({ kind: 'evidence', id });
  const panelNavigation = {
    read: () => target,
    subscribe(notify: () => void) {
      navigation.addEventListener('navigate', notify);
      return () => navigation.removeEventListener('navigate', notify);
    },
    clear() { target = undefined; navigation.dispatchEvent(new Event('navigate')); },
  };
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main', key: 'stellane', inject: () => ({ api, openConversation, openSession, panelNavigation, projectAccess }),
  }, Panel));
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 'stellane', order: 30, label: 'Stellane' }, Icon));
  ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'stellane', order: 50, label: 'Stellane', inject: () => ({ api, projectAccess }) }, SettingsPage));
  for (const key of Object.keys(toolLabels)) {
    ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key, inject: () => ({ openEvidence }) }, ToolCard));
  }
  const saved = new Set<string>();
  ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
    name: 'conversation.chat.turnTail', id: 'stellane-evidence', inject: sessionId => ({
      openPanel: (next: PanelTarget) => openPanel({ ...next, fromSessionId: sessionId }), saved,
      async save(draft: DefinitionDraft) {
        await api('importCatalog', draft.request);
        saved.add(draft.request.requestId);
      },
      linksForTurn(turn: number) {
        const binding = ctx.sessions.binding(sessionId as SessionId);
        const snapshot: ChatSnapshot | undefined = binding && ctx.uiConversation.binding(binding).target('chat').getSnapshot();
        const calls: readonly ToolChatData[] | undefined = snapshot?.nodes.turnDataSource(turn, 'tool-call').getSnapshot();
        return readLinks(calls?.map(item => item.root) ?? []);
      },
    }),
  }, StellaneTurnTail));
}
