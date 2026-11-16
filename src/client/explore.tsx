import { t, systemMessage, useLocale, labels as localizedLabels } from './i18n.tsx';
import { useState } from 'react';
import type { ContextResult } from '../shared/context-models.ts';
import type { Environment, QueryPreview, Run, Snapshot } from '../shared/models.ts';
import { knowledgeLabel, knowledgeStatus } from './catalog.tsx';
import { message, type Api } from './workspace-ui.tsx';
import { MetricSummary } from './metric.tsx';

export const runStatus = localizedLabels({ running: '执行中', succeeded: '完成', failed: '失败', interrupted: '已中断', unknown: '待核实' });
export type Conversation = (environmentId: string, prompt?: string, options?: { unbound?: boolean }) => Promise<void>;
export type ExploreMode = 'ask' | 'sql';
type ResultView = 'result' | 'history' | 'deliveries';

function PreviewTable({ preview, metric, generated }: { preview: QueryPreview; metric?: boolean; generated?: boolean }) {
  useLocale();
  if (!preview.columns.length) return null;
  return <div className="st-table-scroll"><table>
    <thead><tr>{preview.columns.map(column => <th key={column} scope="col">{generated ? t(column) : column}</th>)}</tr></thead>
    <tbody>{preview.rows.map((row, index) => <tr key={index}>{preview.columns.map(column => {
      const value = row[column];
      return <td key={column}>{value === null ? <span className="st-muted">{metric && column === '归属' ? t("未归因") : 'NULL'}</span>
        : typeof value === 'object' ? JSON.stringify(value) : String(value ?? '')}</td>;
    })}</tr>)}</tbody>
  </table></div>;
}

export function QueryResult({ run, onReconcile, busy }: { run: Run; onReconcile?: () => void; busy?: boolean }) {
  useLocale();
  const preview = run.preview;
  return <section className="st-result" aria-label={t("查询结果")}>
    {run.metric && <MetricSummary metric={run.metric} />}
    <div className="st-row st-result-meta"><span className={`st-status st-${run.status}`}>{runStatus[run.status]}</span>
      <span className="st-muted">{preview && (run.kind === 'execute' ? t("影响 {0} 行", preview.affectedRows ?? 0) : t("{0} 行{1}", preview.rowCount, preview.truncated ? t('预览') : ''))}
        {run.durationMs !== undefined && `${preview ? ' · ' : ''}${run.durationMs} ms`}</span>
      {!run.metric && <code className="st-result-sql" title={run.sql}>{run.sql}</code>}
    </div>
    {run.error && <p role="alert" className="st-error">{systemMessage(run.error)}</p>}
    {run.status === 'unknown' && onReconcile && <button className="st-button" disabled={busy} onClick={onReconcile}>{t("核对原写入回执")}</button>}
    {preview && (run.kind !== 'execute' && preview.rowCount === 0
      ? <p className="st-list-empty">{t("没有符合条件的记录。")}</p>
      : <PreviewTable preview={preview} metric={!!run.metric} generated={!!run.metric || run.purpose === 'knowledge'} />)}
    <details className="st-details"><summary>{t("执行详情")}</summary>
      <pre className="st-code">{run.sql}</pre>
      {!!run.values?.length && <p className="st-path">{t("查询参数")}<code>{JSON.stringify(run.values)}</code></p>}
      {run.target && <p className="st-path">{run.target.database} · {run.target.user} · {run.target.address ?? t("本地")}:{run.target.port ?? '—'}</p>}
      {run.branch && <p className="st-path">{run.branch.resource} {t("· 来源位置")}{run.branch.forkLsn}</p>}
      <p className="st-path">{run.actor.kind === 'agent' ? `Agent ${run.actor.id}` : t("用户操作")} · {run.id}</p>
    </details>
  </section>;
}

function ReferencePreview({ result }: { result: ContextResult }) {
  useLocale();
  const hasMatches = result.definitions.length || result.relations.length || result.knowledge.length;
  return <section className="st-reference st-stack" aria-label={t("匹配资料")}>
    <h3>{t("匹配资料")}</h3>
    {!hasMatches && <p className="st-muted">{t("没有找到相关资料。可以试试表名或字段名。")}</p>}
    {result.definitions.map(item => <details className="st-details" key={item.id}>
      <summary>{item.title} <small>{item.source.name}</small></summary><p className="st-content">{item.content}</p>
    </details>)}
    {result.knowledge.map(item => <p className="st-path" key={item.id}>{knowledgeLabel(item)} · {knowledgeStatus[item.status]}</p>)}
    {result.relations.length > 0 && <p className="st-muted">{t("相关表")}{result.relations.map(item => `${item.schema}.${item.name}`).join('、')}</p>}
    {result.excluded.length > 0 && <details className="st-details"><summary>{t("已排除的业务说明")}</summary>
      {result.excluded.map(item => <p className="st-path" key={item.key}>{item.key} · {systemMessage(item.reason)}</p>)}
    </details>}
  </section>;
}

export function Explore({ api, environment, data, mode, onMode, refresh, openConversation, onCatalog, onEnvironment, focusRun }: {
  api: Api;
  environment: Environment;
  data: Snapshot;
  mode: ExploreMode;
  onMode: (mode: ExploreMode) => void;
  refresh: () => Promise<Snapshot | undefined>;
  openConversation: Conversation;
  onCatalog: () => void;
  onEnvironment: (id: string, run?: Run) => void;
  focusRun?: Run;
}) {
  useLocale();
  const [question, setQuestion] = useState('');
  const [sql, setSql] = useState('');
  const [showComposer, setShowComposer] = useState(!focusRun);
  const [reference, setReference] = useState<ContextResult>();
  const [resultView, setResultView] = useState<ResultView>('result');
  const [selectedRun, setSelectedRun] = useState<Run>();
  const [busy, setBusy] = useState<'ask' | 'preview' | 'query' | 'execute' | 'reconcile'>();
  const [error, setError] = useState('');
  const environmentId = environment.id;
  const accessPaused = !!(environment.disabledAt || environment.removedAt || environment.resourceDeletedAt || environment.resourceRemovalPendingAt);
  const runs = data.runs.filter(run => run.environmentId === environmentId && !run.purpose);
  const selected = selectedRun ?? focusRun ?? runs[0];
  const currentRun = selected ? runs.find(run => run.id === selected.id) ?? selected : undefined;
  const deliveries = data.deliveries.filter(delivery => delivery.recipientEnvironmentId === environmentId || delivery.snapshotEnvironmentId === environmentId);
  const latestUnknown = runs.find(run => run.status === 'unknown');

  async function act(operation: NonNullable<typeof busy>, work: () => Promise<void>) {
    setBusy(operation);
    setError('');
    try { await work(); } catch (error) { setError(message(error)); }
    finally { setBusy(undefined); }
  }

  function ask(text: string, isSql = false) {
    if (accessPaused) return;
    const prompt = isSql
      ? t("请在 Stellane 环境 {0} 执行以下只读 SQL。先用 stellane_context 核对表结构和业务说明，再用 stellane_query 执行并解释结果。\n\n{1}", environmentId, text)
      : t("请在 Stellane 环境 {0} 调查下面的问题。先用问题调用 stellane_context 获取业务说明、表结构、关联和血缘。根据需要执行只读 SQL。要沿用待核对的关系，先用 stellane_learn 复核。发现有业务意义的隐性键或关联时，也用 stellane_learn 验证和保存。引用所用业务来源与执行证据。\n\n{1}", environmentId, text);
    return act('ask', () => openConversation(environmentId, prompt));
  }

  function execute(operation: 'query' | 'execute') {
    if (accessPaused) return;
    setResultView('result');
    return act(operation, async () => {
      const run = await api(operation, { environmentId, sql: sql.trim(), values: [], requestId: crypto.randomUUID() });
      setSelectedRun(run);
      setResultView('result');
      await refresh();
    });
  }

  function reconcile(run: Run) {
    return act('reconcile', async () => {
      setSelectedRun(await api('reconcileRun', { runId: run.id }));
      setResultView('result');
      await refresh();
    });
  }

  const runningSql = busy === 'query' || busy === 'execute';

  return <section className="st-stack" aria-label={t("探索")}>
    <div className="st-page-heading"><h2>{showComposer ? t("探索数据") : t("执行证据")}</h2>
      {showComposer ? <div className="st-segment" aria-label={t("探索方式")}>
        <button aria-pressed={mode === 'sql'} disabled={!!busy} onClick={() => { onMode('sql'); setError(''); }}>{t("执行 SQL")}</button>
        <button aria-pressed={mode === 'ask'} disabled={!!busy} onClick={() => { onMode('ask'); setError(''); }}>{t("按环境提问")}</button>
      </div> : <button className="st-button" onClick={() => setShowComposer(true)}>{t("打开 SQL 编辑器")}</button>}</div>
    {accessPaused && <p className="st-attention" role="status">{environment.resourceRemovalPendingAt
      ? t('回收结果尚未确认，请继续核对原清理请求；此资源暂停新访问。')
      : environment.disabledAt ? t('此来源已停用。历史证据仍可查看；请在管理与清理中启用访问后再运行新查询。')
        : t('此环境已结束访问。历史证据仍可查看。')}</p>}
    {latestUnknown && (mode !== 'sql' || resultView !== 'result' || currentRun?.id !== latestUnknown.id) && <div className="st-row st-attention"><span>{t("有一笔写入待核实。")}</span>
      <button className="st-button" disabled={!!busy} onClick={() => { onMode('sql'); setSelectedRun(latestUnknown); setResultView('result'); }}>{t("查看记录")}</button></div>}
    {mode === 'ask' ? <>
      <form className="st-composer" onSubmit={event => { event.preventDefault(); if (!busy && question.trim()) void ask(question.trim()); }}>
        <label className="st-field"><span>{t("业务问题")}</span><textarea rows={4} maxLength={200} required disabled={accessPaused || !!busy}
          className="st-prose-input" placeholder={t("例如：这两张表应该用哪些字段关联？")} value={question}
          onChange={event => { setQuestion(event.target.value); setReference(undefined); }} /></label>
        <div className="st-composer-footer"><button className="st-button st-quiet" type="button" disabled={accessPaused || !!busy} onClick={onCatalog}>{t("查看数据目录")}</button>
          <div className="st-actions"><button className="st-button" type="button" disabled={accessPaused || !!busy || !question.trim()}
            onClick={() => void act('preview', async () => setReference(await api('context', { environmentId, query: question.trim() })))}>
            {busy === 'preview' ? t("查找中…") : t("预览参考资料")}</button>
            <button className="st-button st-primary" type="submit" disabled={accessPaused || !!busy || !question.trim()}>{busy === 'ask' ? t("打开中…") : t("去对话中提问")}</button></div>
        </div>
      </form>
      {reference && <ReferencePreview result={reference} />}
      <p className="st-muted">{t("从这里打开的 Harness 对话会绑定当前环境。")}</p>
    </> : <>
      {showComposer && <form className="st-composer" onSubmit={event => { event.preventDefault(); if (!busy && sql.trim()) void execute('query'); }}>
        <label className="st-field"><span>{t("SQL 查询")}</span><textarea value={sql} onChange={event => setSql(event.target.value)} rows={6}
          maxLength={16384} spellCheck={false} disabled={accessPaused || !!busy} placeholder="SELECT …" required /></label>
        <div className="st-composer-footer"><span className="st-muted">{environment.access === 'read-write' ? t("可写分支") : t("只读查询")}</span>
          <div className="st-actions">
            {environment.access === 'read-write' && <button className="st-button st-quiet" type="button" disabled={accessPaused || !!busy || !sql.trim()} onClick={() => void execute('execute')}>{busy === 'execute' ? t("提交中…") : t("提交写入")}</button>}
            <button className="st-button" type="button" disabled={accessPaused || !!busy || !sql.trim()} onClick={() => void ask(sql.trim(), true)}>{t("在对话中查询")}</button>
            <button className="st-button st-primary" type="submit" disabled={accessPaused || !!busy || !sql.trim()}>{busy === 'query' ? t("查询中…") : t("执行查询")}</button>
          </div></div>
      </form>}
      <nav className="st-tabs" aria-label={t("SQL 结果视图")}>
        <button aria-pressed={resultView === 'result'} onClick={() => setResultView('result')}>{t("查询结果")}</button>
        <button aria-pressed={resultView === 'history'} onClick={() => setResultView('history')}>{t("执行历史")}</button>
        {deliveries.length > 0 && <button aria-pressed={resultView === 'deliveries'} onClick={() => setResultView('deliveries')}>{t("交付结果")}</button>}
      </nav>
      {resultView === 'result' && (runningSql
        ? <section className="st-result" aria-label={t("查询结果")} aria-busy="true"><p className="st-muted" role="status">{busy === 'query' ? t("正在执行查询…") : t("正在提交写入…")}</p></section>
        : currentRun ? <QueryResult run={currentRun} busy={!!busy} onReconcile={() => void reconcile(currentRun)} />
          : <p className="st-muted">{t("执行查询后，结果会显示在这里。")}</p>)}
      {resultView === 'history' && (runs.length ? <div className="st-history">{runs.map(run => <button key={run.id} onClick={() => { setSelectedRun(run); setResultView('result'); }}>
        <span className={`st-status st-${run.status}`}>{runStatus[run.status]}</span><code>{run.sql}</code><time>{new Date(run.startedAt).toLocaleTimeString()}</time>
      </button>)}</div> : <p className="st-muted">{t("当前环境暂无执行记录。")}</p>)}
      {resultView === 'deliveries' && <div className="st-list">{deliveries.map(delivery => <article key={delivery.id} className="st-list-row st-source-row">
        <div><h3>{delivery.summary}</h3><p className="st-muted">{new Date(delivery.createdAt).toLocaleString()}</p></div>
        <button className="st-button" onClick={() => {
          const run = data.runs.find(item => item.id === delivery.runId);
          if (delivery.snapshotEnvironmentId === environmentId && run) { setSelectedRun(run); setResultView('result'); }
          else onEnvironment(delivery.snapshotEnvironmentId, run);
        }}>{t("打开已保存结果")}</button>
      </article>)}</div>}
    </>}
    {error && <p className="st-error" role="alert">{systemMessage(error)}</p>}
  </section>;
}
