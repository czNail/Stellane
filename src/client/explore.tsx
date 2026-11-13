import { useState } from 'react';
import type { ContextResult } from '../shared/context-models.ts';
import type { Environment, QueryPreview, Run, Snapshot } from '../shared/models.ts';
import { knowledgeLabel, knowledgeStatus } from './catalog.tsx';
import { message, type Api } from './workspace-ui.tsx';

export const runStatus = { running: '执行中', succeeded: '完成', failed: '失败', interrupted: '已中断', unknown: '待核实' };
export type Conversation = (workspaceId: string, prompt: string) => void;
export type ExploreMode = 'ask' | 'sql';
type ResultView = 'result' | 'history' | 'deliveries';

function PreviewTable({ preview }: { preview: QueryPreview }) {
  if (!preview.columns.length) return null;
  return <div className="st-table-scroll"><table>
    <thead><tr>{preview.columns.map(column => <th key={column} scope="col">{column}</th>)}</tr></thead>
    <tbody>{preview.rows.map((row, index) => <tr key={index}>{preview.columns.map(column => {
      const value = row[column];
      return <td key={column}>{value === null ? <span className="st-muted">NULL</span> : typeof value === 'object' ? JSON.stringify(value) : String(value ?? '')}</td>;
    })}</tr>)}</tbody>
  </table></div>;
}

function QueryResult({ run, onReconcile, busy }: { run: Run; onReconcile: () => void; busy: boolean }) {
  const preview = run.preview;
  return <section className="st-result" aria-label="查询结果">
    <div className="st-row st-result-meta"><span className={`st-status st-${run.status}`}>{runStatus[run.status]}</span>
      <span className="st-muted">{preview && (run.kind === 'execute' ? `影响 ${preview.affectedRows ?? 0} 行` : `${preview.rowCount} 行${preview.truncated ? '预览' : ''}`)}
        {run.durationMs !== undefined && `${preview ? ' · ' : ''}${run.durationMs} ms`}</span>
      <code className="st-result-sql" title={run.sql}>{run.sql}</code>
    </div>
    {run.error && <p role="alert" className="st-error">{run.error}</p>}
    {run.status === 'unknown' && <button className="st-button" disabled={busy} onClick={onReconcile}>核对原写入回执</button>}
    {preview && (run.kind !== 'execute' && preview.rowCount === 0
      ? <p className="st-list-empty">没有符合条件的记录。</p>
      : <PreviewTable preview={preview} />)}
    <details className="st-details"><summary>执行详情</summary>
      <pre className="st-code">{run.sql}</pre>
      {run.target && <p className="st-path">{run.target.database} · {run.target.user} · {run.target.address ?? '本地'}:{run.target.port ?? '—'}</p>}
      {run.branch && <p className="st-path">{run.branch.resource} · 来源位置 {run.branch.forkLsn}</p>}
      <p className="st-path">{run.actor.kind === 'agent' ? `Agent ${run.actor.id}` : '用户操作'} · {run.id}</p>
    </details>
  </section>;
}

function ReferencePreview({ result }: { result: ContextResult }) {
  const hasMatches = result.definitions.length || result.relations.length || result.knowledge.length;
  return <section className="st-reference st-stack" aria-label="匹配资料">
    <h3>匹配资料</h3>
    {!hasMatches && <p className="st-muted">没有找到相关资料。可以试试表名或字段名。</p>}
    {result.definitions.map(item => <details className="st-details" key={item.id}>
      <summary>{item.title} <small>{item.source.name}</small></summary><p className="st-content">{item.content}</p>
    </details>)}
    {result.knowledge.map(item => <p className="st-path" key={item.id}>{knowledgeLabel(item)} · {knowledgeStatus[item.status]}</p>)}
    {result.relations.length > 0 && <p className="st-muted">相关表 {result.relations.map(item => `${item.schema}.${item.name}`).join('、')}</p>}
    {result.excluded.length > 0 && <details className="st-details"><summary>已排除的业务说明</summary>
      {result.excluded.map(item => <p className="st-path" key={item.key}>{item.key} · {item.reason}</p>)}
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
  const [question, setQuestion] = useState('');
  const [sql, setSql] = useState('');
  const [reference, setReference] = useState<ContextResult>();
  const [resultView, setResultView] = useState<ResultView>('result');
  const [selectedRun, setSelectedRun] = useState<Run>();
  const [busy, setBusy] = useState<'ask' | 'preview' | 'query' | 'execute' | 'reconcile'>();
  const [error, setError] = useState('');
  const environmentId = environment.id;
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
    const prompt = isSql
      ? `请在 Stellane 环境 ${environmentId} 执行以下只读 SQL。先用 stellane_context 核对表结构和业务说明，再用 stellane_query 执行并解释结果。\n\n${text}`
      : `请在 Stellane 环境 ${environmentId} 调查下面的问题。先用问题调用 stellane_context 获取业务说明、表结构、关联和血缘。根据需要执行只读 SQL。要沿用待核对的关系，先用 stellane_learn 复核。发现有业务意义的隐性键或关联时，也用 stellane_learn 验证和保存。引用所用业务来源与执行证据。\n\n${text}`;
    return act('ask', async () => {
      const { workspaceId } = await api('prepareConversation', { environmentId });
      openConversation(workspaceId, prompt);
    });
  }

  function execute(operation: 'query' | 'execute') {
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

  return <section className="st-stack" aria-label="探索">
    <div className="st-page-heading"><div><h2>探索数据</h2><p className="st-muted">结合业务说明、数据关系和血缘调查问题。</p></div>
      <div className="st-segment" aria-label="探索方式">
        <button aria-pressed={mode === 'ask'} disabled={!!busy} onClick={() => { onMode('ask'); setError(''); }}>向 Agent 提问</button>
        <button aria-pressed={mode === 'sql'} disabled={!!busy} onClick={() => { onMode('sql'); setError(''); }}>执行 SQL</button>
      </div></div>
    {latestUnknown && (mode !== 'sql' || resultView !== 'result' || currentRun?.id !== latestUnknown.id) && <div className="st-row st-attention"><span>有一笔写入待核实。</span>
      <button className="st-button" disabled={!!busy} onClick={() => { onMode('sql'); setSelectedRun(latestUnknown); setResultView('result'); }}>查看记录</button></div>}
    {mode === 'ask' ? <>
      <form className="st-composer" onSubmit={event => { event.preventDefault(); if (!busy && question.trim()) void ask(question.trim()); }}>
        <label className="st-field"><span>业务问题</span><textarea rows={4} maxLength={200} required disabled={!!busy}
          className="st-prose-input" placeholder="例如：这两张表应该用哪些字段关联？" value={question}
          onChange={event => { setQuestion(event.target.value); setReference(undefined); }} /></label>
        <div className="st-composer-footer"><button className="st-button st-quiet" type="button" disabled={!!busy} onClick={onCatalog}>查看数据目录</button>
          <div className="st-actions"><button className="st-button" type="button" disabled={!!busy || !question.trim()}
            onClick={() => void act('preview', async () => setReference(await api('context', { environmentId, query: question.trim() })))}>
            {busy === 'preview' ? '查找中…' : '预览参考资料'}</button>
            <button className="st-button st-primary" type="submit" disabled={!!busy || !question.trim()}>{busy === 'ask' ? '打开中…' : '去对话中提问'}</button></div>
        </div>
      </form>
      {reference && <ReferencePreview result={reference} />}
      <p className="st-muted">问题会带入 Harness 对话，发送后开始探索。</p>
    </> : <>
      <form className="st-composer" onSubmit={event => { event.preventDefault(); if (!busy && sql.trim()) void execute('query'); }}>
        <label className="st-field"><span>SQL 查询</span><textarea value={sql} onChange={event => setSql(event.target.value)} rows={6}
          maxLength={16384} spellCheck={false} disabled={!!busy} placeholder="SELECT …" required /></label>
        <div className="st-composer-footer"><span className="st-muted">{environment.access === 'read-write' ? '可写分支' : '只读查询'}</span>
          <div className="st-actions">
            {environment.access === 'read-write' && <button className="st-button st-quiet" type="button" disabled={!!busy || !sql.trim()} onClick={() => void execute('execute')}>{busy === 'execute' ? '提交中…' : '提交写入'}</button>}
            <button className="st-button" type="button" disabled={!!busy || !sql.trim()} onClick={() => void ask(sql.trim(), true)}>在对话中查询</button>
            <button className="st-button st-primary" type="submit" disabled={!!busy || !sql.trim()}>{busy === 'query' ? '查询中…' : '执行查询'}</button>
          </div></div>
      </form>
      <nav className="st-tabs" aria-label="SQL 结果视图">
        <button aria-pressed={resultView === 'result'} onClick={() => setResultView('result')}>查询结果</button>
        <button aria-pressed={resultView === 'history'} onClick={() => setResultView('history')}>执行历史</button>
        {deliveries.length > 0 && <button aria-pressed={resultView === 'deliveries'} onClick={() => setResultView('deliveries')}>交付结果</button>}
      </nav>
      {resultView === 'result' && (runningSql
        ? <section className="st-result" aria-label="查询结果" aria-busy="true"><p className="st-muted" role="status">{busy === 'query' ? '正在执行查询…' : '正在提交写入…'}</p></section>
        : currentRun ? <QueryResult run={currentRun} busy={!!busy} onReconcile={() => void reconcile(currentRun)} />
          : <p className="st-muted">执行查询后，结果会显示在这里。</p>)}
      {resultView === 'history' && (runs.length ? <div className="st-history">{runs.map(run => <button key={run.id} onClick={() => { setSelectedRun(run); setResultView('result'); }}>
        <span className={`st-status st-${run.status}`}>{runStatus[run.status]}</span><code>{run.sql}</code><time>{new Date(run.startedAt).toLocaleTimeString()}</time>
      </button>)}</div> : <p className="st-muted">当前环境暂无执行记录。</p>)}
      {resultView === 'deliveries' && <div className="st-list">{deliveries.map(delivery => <article key={delivery.id} className="st-list-row st-source-row">
        <div><h3>{delivery.summary}</h3><p className="st-muted">{new Date(delivery.createdAt).toLocaleString()}</p></div>
        <button className="st-button" onClick={() => {
          const run = data.runs.find(item => item.id === delivery.runId);
          if (delivery.snapshotEnvironmentId === environmentId && run) { setSelectedRun(run); setResultView('result'); }
          else onEnvironment(delivery.snapshotEnvironmentId, run);
        }}>打开固定结果</button>
      </article>)}</div>}
    </>}
    {error && <p className="st-error" role="alert">{error}</p>}
  </section>;
}
