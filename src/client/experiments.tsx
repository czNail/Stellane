import { t, systemMessage, useLocale, labels as localizedLabels } from './i18n.tsx';
import { useEffect, useState } from 'react';
import type { Environment, Experiment, ExperimentDetail, Run } from '../shared/models.ts';
import { describeEnvironment } from '../shared/capabilities.ts';
import { QueryResult, runStatus, type Conversation } from './explore.tsx';
import { ActionDialog, environmentLabel, message, type Api } from './workspace-ui.tsx';
import { MetricComparison } from './metric.tsx';

const labels = localizedLabels({ preparing: '准备中', active: '进行中', closing: '清理中', closed: '已结束' });

export function StartExperiment({ source, api, onClose, onStarted }: {
  source: Environment; api: Api; onClose: () => void; onStarted: (detail: ExperimentDetail) => void;
}) {
  useLocale();
  const [id] = useState(() => crypto.randomUUID());
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [submitted, setSubmitted] = useState(false);
  return <ActionDialog title={t("开始实验")} busy={busy} onClose={onClose}>
    <form className="st-stack" onSubmit={async event => {
      event.preventDefault();
      if (busy || !name.trim()) return;
      setBusy(true);
      setSubmitted(true);
      setError('');
      try { onStarted(await api('startExperiment', { id, environmentId: source.id, name: name.trim() })); }
      catch (error) { setError(message(error)); }
      finally { setBusy(false); }
    }}>
      <div className="st-task-notice">
        <strong>{source.name}</strong><span className="st-muted">{environmentLabel(source)}</span>
        <p>{source.mode === 'fixed' ? t("从这个基线创建独立可写分支。") : t("保存当前数据作为基线，再创建独立可写分支。")}</p>
        {source.neon && <p className="st-muted">{t(source.neon.local ? "本地 Neon 的分支会占用本机磁盘和 compute 资源。保留结果时会保留必要父分支，结束后移除临时 compute。" : "Neon 试验会占用分支和存储额度。保留结果时，也会保留它依赖的父分支，父分支的 compute 在结束后移除。")}</p>}
      </div>
      <label className="st-field"><span>{t("要验证什么")}</span><input autoFocus required maxLength={80} value={name} disabled={busy || submitted}
        placeholder={t("例如：验证新的分类规则")} onChange={event => setName(event.target.value)} /></label>
      {error && <p className="st-error" role="alert">{systemMessage(error)}</p>}
      <div className="st-actions st-form-actions">
        <button type="button" className="st-button" disabled={busy} onClick={onClose}>{t("取消")}</button>
        <button className="st-button st-primary" disabled={busy || !name.trim()}>{busy ? t("正在准备工作分支…") : submitted ? t("核对原任务") : t("创建实验")}</button>
      </div>
    </form>
  </ActionDialog>;
}

export function ExperimentList({ experiments, environments, onOpen }: {
  experiments: Experiment[]; environments: Environment[]; onOpen: (id: string) => void;
}) {
  useLocale();
  const [project, setProject] = useState('');
  const projects = [...new Set(experiments.map(item => item.projectPath))];
  const visible = experiments.filter(item => !project || item.projectPath === project);
  return <section className="st-stack st-task-section" aria-label={t("实验任务")}>
    <h3>{t("实验任务")}</h3>
    {projects.length > 1 && <label className="st-field st-task-project"><span>{t("项目")}</span>
      <select value={project} onChange={event => setProject(event.target.value)}>
        <option value="">{t("全部项目")}</option>{projects.map(path => <option key={path}>{path}</option>)}
      </select>
    </label>}
    {!visible.length ? <p className="st-muted">{t("暂无实验任务。")}</p>
    : <div className="st-list">{visible.map(experiment => <article className="st-list-row st-source-row" key={experiment.id}>
      <div className="st-source-info"><div className="st-row"><h3>{experiment.name}</h3>
        <span className={`st-status${experiment.error ? ' st-unknown' : ''}`}>{experiment.error ? t("需处理") : labels[experiment.status]}</span>
        {experiment.deliveryId && <span className="st-muted">{t("结果已保存")}</span>}</div>
        <p className="st-muted">{environments.find(environment => environment.id === experiment.sourceId)?.name ?? t("数据源")} · {new Date(experiment.createdAt).toLocaleString()}</p>
      </div>
      <button className="st-button" aria-label={t("打开任务 {0}", experiment.name)} onClick={() => onOpen(experiment.id)}>{t("查看任务")}</button>
    </article>)}</div>}
  </section>;
}

export function ExperimentView({ id, initial, api, refresh, openConversation, openSession, openEvidence, onBack, onSql }: {
  id: string; initial?: ExperimentDetail; api: Api; refresh: () => Promise<unknown>; openConversation: Conversation;
  openSession: (sessionId: string) => void;
  openEvidence: (id: string) => void;
  onBack: () => void; onSql: (environment: Environment, run?: Run) => void;
}) {
  useLocale();
  const [detail, setDetail] = useState(initial);
  const [busy, setBusy] = useState<'load' | 'resume' | 'chat' | 'capture' | 'finish' | 'receipt'>();
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [dialog, setDialog] = useState<'capture' | 'finish'>();
  const [selectedRun, setSelectedRun] = useState<Run>();
  useEffect(() => {
    if (busy) return;
    let open = true;
    let loading = false;
    async function poll() {
      if (loading || document.visibilityState === 'hidden') return;
      loading = true;
      try {
        const value = await api('experimentDetail', { id });
        if (open) { setDetail(value); setLoadError(''); }
      } catch (error) {
        if (open) setLoadError(message(error));
      } finally {
        loading = false;
      }
    }
    void poll();
    const interval = window.setInterval(() => void poll(), 2000);
    return () => { open = false; window.clearInterval(interval); };
  }, [api, busy, id]);

  async function act(kind: NonNullable<typeof busy>, action: () => Promise<ExperimentDetail | void>) {
    setBusy(kind);
    setError('');
    try {
      const next = await action();
      if (next) {
        setDetail(next);
        setDialog(undefined);
        await refresh();
      }
    } catch (error) { setError(message(error)); }
    finally { setBusy(undefined); }
  }

  const back = <button className="st-button st-quiet st-back" onClick={onBack}>{t("← 任务与结果")}</button>;
  if (!detail) return <section className="st-stack">{back}{loadError ? <p role="alert" className="st-error">{systemMessage(loadError)}</p>
    : <p role="status" className="st-muted">{t("正在读取任务…")}</p>}</section>;
  const { experiment, source, baseline, work, result, delivered, unresolved, runs } = detail;
  const active = experiment.status === 'active';
  const closing = experiment.status === 'closing';
  const blocked = !!busy || !!detail.processing;
  const capturing = !!detail.processing && active && !delivered;
  const sessionId = experiment.sessionId;
  const evidenceRun = selectedRun && (runs.find(item => item.id === selectedRun.id) ?? selectedRun);
  const refreshDetail = () => api('experimentDetail', { id });
  const reconcile = (run: Run) => void act('receipt', async () => {
    const checked = await api('reconcileRun', { runId: run.id });
    setSelectedRun(checked);
    return refreshDetail();
  });

  return <section className="st-stack st-task" aria-label={t("任务详情")}>
    {back}
    <div className="st-page-heading">
      <div className="st-row st-task-title"><h2>{experiment.name}</h2><span className="st-status">{capturing ? t("保存结果中") : labels[experiment.status]}</span></div>
      <div className="st-actions">
        {active && work && <button className="st-button" disabled={blocked} onClick={() => onSql(work)}>{t("执行 SQL")}</button>}
        {sessionId ? <button className="st-button" onClick={() => openSession(sessionId)}>{t("查看原对话")}</button>
          : active && work && <button className="st-button" disabled={blocked} onClick={() => void act('chat', () => openConversation(work.id,
          t("请在已绑定的 Stellane 工作分支验证「{0}」。先用 stellane_environments 和 stellane_context 核对目标与业务定义。使用 stellane_query 查证，必要时在当前分支用 stellane_execute 执行单条事务。保留证据 SQL 供保存结果时核验。", experiment.name)))}>
          {busy === 'chat' ? t("正在打开…") : t("在对话中探索")}
        </button>}
      </div>
    </div>
    <dl className="st-task-scope">
      <div><dt>{t("来源")}</dt><dd>{source.name}</dd></div>
      <div><dt>{t("基线")}</dt><dd>{baseline?.name ?? t("准备中")}{baseline?.removedAt && <small>{baseline.retainedReason ? t("已停用，保留依赖") : t("已清理")}</small>}</dd></div>
      <div><dt>{t("工作分支")}</dt><dd>{work ? work.removedAt ? work.retainedReason ? t("已停用，保留依赖") : t("已清理") : t("独立可写") : t("准备中")}</dd></div>
    </dl>
    {baseline && <details className="st-details"><summary>{t("数据状态详情")}</summary>
      <p>{describeEnvironment(baseline).providerLabel} · {environmentLabel(baseline)}</p>
      <p>{t("基线")}{baseline.neon?.branchId ?? baseline.stello?.resource} · {baseline.neon?.parentLsn ?? baseline.stello?.forkLsn}</p>
      {work && <p>{t("工作分支")}{work.neon?.branchId ?? work.stello?.resource}</p>}
      {baseline.neon && <p>{t("此基线在 Stellane 中只读。Neon 项目中的外部修改仍可能改变分支，重新使用关系前会复核。")}</p>}
    </details>}
    {experiment.retentionNote && <p className="st-attention" role="status">{systemMessage(experiment.retentionNote)}</p>}
    {(error || loadError || experiment.error) && <p className="st-attention st-error" role="alert">{systemMessage(error || loadError || experiment.error || '')}</p>}
    {experiment.status === 'preparing' && <div className="st-attention st-row" role="status">
      <span>{detail.processing ? t("正在准备独立工作分支。") : t("工作分支尚未就绪。")}</span>
      {!detail.processing && <button className="st-button" disabled={blocked} onClick={() => void act('resume', () => api('startExperiment', {
        id, environmentId: source.id, name: experiment.name,
      }))}>{busy === 'resume' ? t("正在核对…") : t("核对并继续准备")}</button>}
    </div>}
    {!!unresolved.length && <section className="st-stack st-reference" aria-label={t("待核实操作")}>
      <h3>{t("待核实写入")}</h3>{unresolved.map(run => <QueryResult key={run.id} run={run} busy={!!busy} onReconcile={() => reconcile(run)} />)}
    </section>}
    {detail.baselineMetric && <MetricComparison before={detail.baselineMetric} after={delivered?.run} openEvidence={openEvidence} />}
    <section className="st-task-section st-stack" aria-label={t("已保存结果")}>
      <div className="st-row st-section-heading"><h3>{t("已保存结果")}</h3>
        {active && !delivered && !capturing && <button className="st-button" disabled={blocked || !!unresolved.length} onClick={() => setDialog('capture')}>
          {result ? t("补查证据") : experiment.evidence ? t("核对并交付") : t("保存结果与证据")}
        </button>}
      </div>
      {delivered ? <article className="st-stack st-task-result">
        <div className="st-source-row"><div><p className="st-content">{delivered.delivery.summary}</p>
          <p className="st-muted">{environmentLabel(delivered.environment)} {t("· 证据已保存")}</p></div>
          <button className="st-button" onClick={() => onSql(delivered.environment, delivered.run)}>{t("查看结果数据")}</button>
        </div>
        <QueryResult run={delivered.run} />
      </article> : <p className="st-muted">{capturing ? t("正在保存结果并执行证据查询。") : result ? t("结果分支已保存，可在原分支补查只读证据。")
        : t("方案验证完成后，这里会展示结论、结果数据和查询证据。")}</p>}
    </section>
    {work && <section className="st-task-section st-stack" aria-label={t("执行记录")}>
      <div className="st-row st-section-heading"><h3>{t("执行记录")}</h3><button className="st-button st-quiet" disabled={!!busy}
        onClick={() => void act('load', refreshDetail)}>{busy === 'load' ? t("正在刷新…") : t("刷新记录")}</button></div>
      {runs.length ? <div className="st-history">{runs.map(run => <button key={run.id} onClick={() => setSelectedRun(run)}>
        <span className={`st-status st-${run.status}`}>{runStatus[run.status]}</span><code>{run.sql}</code>
        <time>{new Date(run.startedAt).toLocaleTimeString()}</time>
      </button>)}</div> : <p className="st-muted">{t("暂无查询或写入。")}</p>}
      {evidenceRun && <QueryResult run={evidenceRun} busy={!!busy} onReconcile={() => reconcile(evidenceRun)} />}
    </section>}
    {experiment.status !== 'closed' && <footer className="st-task-footer st-row">
      <p className="st-muted">{delivered ? source.neon ? t("结束后移除临时 compute，保留结果及依赖分支的存储。") : t("清理工作分支会保留已交付的结果。") : active ? t("需要保留结果时，请先保存结果与证据。") : ''}</p>
      <button className="st-button" disabled={blocked || !!unresolved.length} onClick={() => setDialog('finish')}>
        {closing ? t("继续清理") : active ? t("结束任务") : t("放弃实验")}
      </button>
    </footer>}
    {dialog === 'capture' && <CaptureDialog detail={detail} busy={busy === 'capture'} error={systemMessage(error)}
      onClose={() => { setDialog(undefined); setError(''); }}
      onSubmit={(summary, sql, values) => void act('capture', () => api('captureExperiment', { id, summary, sql, values }))} />}
    {dialog === 'finish' && <ActionDialog title={closing ? t("继续清理") : t("结束任务")} busy={busy === 'finish'} onClose={() => setDialog(undefined)}>
      <div className="st-stack">
        <p>{source.neon && delivered ? t(source.neon.local ? "结束任务访问并移除临时 compute。结果及必要父分支保留在本机，仍占用磁盘；可在管理与清理中回收。" : "结束任务对话的分支访问，移除工作分支和基线的 compute。保留结果分支及它依赖的父分支存储，仍可能产生 Neon 存储费用。") : work ? t("结束任务对话的分支访问，清理工作分支{0}。", baseline?.experimentId === id ? t('和本任务创建的基线') : '') : t("结束准备过程，清理已确认由本任务创建的分支。")}</p>
        <p className="st-muted">{delivered ? t("结果和执行记录将保留。") : result ? t("未交付的结果分支也会清理。执行记录将保留。") : t("尚无已交付结果。清理后仍可查看执行记录。")}</p>
        {error && <p className="st-error" role="alert">{systemMessage(error)}</p>}
        <div className="st-actions st-form-actions">
          <button className="st-button" disabled={!!busy} onClick={() => setDialog(undefined)}>{t("取消")}</button>
          <button className="st-button st-primary" disabled={!!busy} onClick={() => void act('finish', () => api('finishExperiment', { id }))}>
            {busy === 'finish' ? t("正在清理…") : delivered ? t("保留结果并清理") : t("确认清理")}
          </button>
        </div>
      </div>
    </ActionDialog>}
  </section>;
}

function CaptureDialog({ detail, busy, error, onClose, onSubmit }: {
  detail: ExperimentDetail; busy: boolean; error: string; onClose: () => void;
  onSubmit: (summary: string, sql?: string, values?: Run['values']) => void;
}) {
  useLocale();
  const [original] = useState(() => detail.experiment.evidence ?? detail.runs.find(run => run.kind === 'query' && run.status === 'succeeded'));
  const [summary, setSummary] = useState(detail.experiment.evidence?.summary ?? '');
  const [sql, setSql] = useState(original?.sql ?? '');
  const values = sql.trim() === original?.sql.trim() ? original?.values : undefined;
  const sameMetric = !!detail.baselineMetric;
  return <ActionDialog title={detail.result ? t("补查证据") : t("保存结果与证据")} busy={busy} onClose={onClose}>
    <form className="st-stack" onSubmit={event => {
      event.preventDefault();
      if (!busy && summary.trim() && (sameMetric || sql.trim())) onSubmit(summary.trim(), sameMetric ? undefined : sql.trim(), values);
    }}>
      <p className="st-muted">{detail.result ? t("在原结果分支上执行只读证据 SQL。") : t("保存「{0}」的当前状态，并在结果分支上执行只读证据 SQL。", detail.work?.name)}</p>
      <label className="st-field"><span>{t("方案摘要")}</span><textarea className="st-prose-input" required rows={3} maxLength={4000}
        autoFocus value={summary} onChange={event => setSummary(event.target.value)} disabled={busy} /></label>
      {sameMetric ? <p className="st-muted">{t("按基线的指标口径计算结果，比较改动前后差异。")}</p> :
        <label className="st-field"><span>{t("只读证据 SQL")}</span><textarea required rows={4} maxLength={16384}
          placeholder="SELECT …" value={sql} onChange={event => setSql(event.target.value)} disabled={busy} /></label>}
      {!sameMetric && !!values?.length && <p className="st-muted">{t("沿用查询参数")}<code>{JSON.stringify(values)}</code></p>}
      {error && <p className="st-error" role="alert">{systemMessage(error)}</p>}
      <div className="st-actions st-form-actions">
        <button className="st-button" type="button" disabled={busy} onClick={onClose}>{t("取消")}</button>
        <button className="st-button st-primary" disabled={busy || !summary.trim() || (!sameMetric && !sql.trim())}>
          {busy ? t("正在保存证据…") : detail.result ? t("验证并交付") : t("保存结果与证据")}
        </button>
      </div>
    </form>
  </ActionDialog>;
}
