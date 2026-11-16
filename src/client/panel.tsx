import { t, systemMessage, LanguageSwitch, useLocale, labels as localizedLabels } from './i18n.tsx';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Environment, ExperimentDetail, Run, Snapshot } from '../shared/models.ts';
import { describeEnvironment } from '../shared/capabilities.ts';
import { CatalogPanel } from './catalog.tsx';
import { Connections } from './connections.tsx';
import { EnvironmentDialog, type EnvironmentAction } from './environment.tsx';
import { Explore, runStatus, type Conversation, type ExploreMode } from './explore.tsx';
import { ExperimentList, ExperimentView, StartExperiment } from './experiments.tsx';
import { ActionDialog, environmentLabel, environmentTree, message, type Api, type ProjectAccess } from './workspace-ui.tsx';
import { RunEvidence } from './evidence.tsx';
import { ManagementPanel } from './management.tsx';

const empty: Snapshot = { connections: [], environments: [], runs: [], providers: [], operations: [], deliveries: [], experiments: [] };
const pages = localizedLabels({ experiments: '任务与结果', catalog: '数据目录', explore: '探索', management: '管理与清理' });
type Page = keyof typeof pages | 'connections' | 'evidence';

function useSnapshot(api: Api) {
  const [data, setData] = useState(empty);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const request = useRef(0);
  const refresh = useCallback(async () => {
    const id = ++request.current;
    try {
      const value = await api('snapshot', {});
      if (id === request.current) { setData(value); setError(''); }
      return value;
    } catch (error) {
      if (id === request.current) setError(message(error));
    } finally { if (id === request.current) setLoading(false); }
  }, [api]);
  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 3000);
    return () => { window.clearInterval(interval); request.current++; };
  }, [refresh]);
  return { data, loading, error, refresh };
}

export function Panel({ api, openConversation, openSession, openEvidence, evidenceNavigation, projectAccess }: {
  api: Api; projectAccess?: ProjectAccess; openConversation: Conversation; openSession: (sessionId: string) => void;
  openEvidence: (id: string) => void;
  evidenceNavigation: { read: () => { id: string } | undefined; subscribe: (fn: () => void) => () => void; clear: () => void };
}) {
  useLocale();
  const { data, loading, error, refresh } = useSnapshot(api);
  const evidence = useSyncExternalStore(evidenceNavigation.subscribe, evidenceNavigation.read);
  const [page, setPage] = useState<Page>('experiments');
  const [mode, setMode] = useState<ExploreMode>('sql');
  const [selected, setSelected] = useState('');
  const [focusRun, setFocusRun] = useState<Run>();
  const [experimentId, setExperimentId] = useState('');
  const [initialExperiment, setInitialExperiment] = useState<ExperimentDetail>();
  const [starting, setStarting] = useState<Environment>();
  const [dialog, setDialog] = useState<{ action: EnvironmentAction; connectionId?: string }>();
  const [operationsOpen, setOperationsOpen] = useState(false);
  const [reconciling, setReconciling] = useState('');
  const [operationError, setOperationError] = useState('');
  const menu = useRef<HTMLDetailsElement>(null);
  const surface = useRef<HTMLElement>(null);
  const environment = selected ? data.environments.find(item => item.id === selected) : data.environments.find(item => !item.experimentId);
  const available = data.environments.filter(item => !item.experimentId || item.id === selected);
  const pending = data.operations.filter(item => !item.environment.experimentId && (item.status === 'pending' || item.status === 'unknown'));
  const connection = data.connections.find(item => item.id === environment?.connectionId);
  const capability = environment ? describeEnvironment(environment) : undefined;
  const canStart = capability?.canExperiment;
  const showingEnvironment = page === 'explore' || page === 'catalog';
  const recentRuns = page === 'experiments' && !experimentId
    ? data.runs.filter(run => !run.purpose && available.some(item => item.id === run.environmentId && !item.experimentId)).slice(0, 8)
    : [];

  useEffect(() => {
    if (!evidence) return;
    setPage('evidence');
    surface.current?.scrollTo({ top: 0 });
  }, [evidence]);

  useEffect(() => {
    function dismissOnOutsidePress(event: PointerEvent) {
      const details = menu.current;
      if (details?.open && event.target instanceof Node && !details.contains(event.target)) details.open = false;
    }
    function dismissOnEscape(event: KeyboardEvent) {
      const details = menu.current;
      if (event.key !== 'Escape' || !details?.open) return;
      details.open = false;
      details.querySelector('summary')?.focus();
    }
    document.addEventListener('pointerdown', dismissOnOutsidePress);
    document.addEventListener('keydown', dismissOnEscape);
    return () => {
      document.removeEventListener('pointerdown', dismissOnOutsidePress);
      document.removeEventListener('keydown', dismissOnEscape);
    };
  }, []);

  function navigate(target: Page) {
    if (menu.current) menu.current.open = false;
    if (target !== 'explore') setFocusRun(undefined);
    if (target !== 'evidence') evidenceNavigation.clear();
    setPage(target);
    surface.current?.scrollTo({ top: 0 });
  }

  function selectEnvironment(id: string) {
    setSelected(id);
    setFocusRun(undefined);
  }

  function openEnvironment(id: string, run?: Run) {
    selectEnvironment(id);
    if (run) { setFocusRun(run); setMode('sql'); }
    navigate('explore');
  }
  function openExperiment(id: string, detail?: ExperimentDetail) {
    setExperimentId(id);
    setInitialExperiment(detail);
    navigate('experiments');
  }

  function showAction(action: EnvironmentAction, connectionId?: string) {
    if (menu.current) menu.current.open = false;
    setDialog({ action, connectionId });
  }

  async function reconcile(id: string) {
    setReconciling(id);
    setOperationError('');
    try {
      const result = await api('reconcileOperation', { operationId: id });
      await refresh();
      if (result.status === 'succeeded') {
        openEnvironment(result.environment.id);
        setOperationsOpen(false);
      } else setOperationError(result.error ?? t("原操作仍待核实。"));
    } catch (error) { setOperationError(message(error)); }
    finally { setReconciling(''); }
  }

  return <main className="st-app" ref={surface}>
    <div className="st-shell">
      <header className="st-topbar"><h1>Stellane</h1><LanguageSwitch />
        <nav className="st-main-nav" aria-label={t("Stellane 导航")}>{Object.entries(pages).map(([id, label]) =>
          <button key={id} aria-current={page === id ? 'page' : undefined} onClick={() => navigate(id as Page)}>{label}</button>)}</nav>
        <button className="st-button st-quiet st-sources-button" aria-current={page === 'connections' ? 'page' : undefined} onClick={() => navigate('connections')}>{t("数据源")}</button>
      </header>
      {error && <div className="st-row st-attention" role="alert"><span>{systemMessage(error)}</span><button className="st-button" onClick={() => void refresh()}>{t("重试")}</button></div>}
      {loading ? <p className="st-loading" role="status">{t("正在加载 Stellane…")}</p> : <>
        {showingEnvironment && available.length > 0 && <div className="st-environment-bar">
          <label className="st-environment-select"><span>{t("环境")}</span><select aria-label={t("环境")} value={environment?.id ?? ''} onChange={event => selectEnvironment(event.target.value)}>
            {!environment && <option value="">{t("选择数据环境")}</option>}
            {environmentTree(available).map(({ environment: item, depth }) => <option key={item.id} value={item.id}>
              {'　'.repeat(Math.min(depth, 4))}{depth ? '↳ ' : ''}{item.name} · {environmentLabel(item)}</option>)}
          </select></label>
          <span className="st-environment-source">{environment?.neon?.branchId ?? environment?.stello?.resource ?? connection?.database}</span>
          <div className="st-actions st-environment-actions">
            {environment?.experimentId && <button className="st-button" onClick={() => openExperiment(environment.experimentId!)}>{t("返回任务")}</button>}
            {page === 'explore' && canStart && <button className="st-button" onClick={() => setStarting(environment)}>{t("开始实验")}</button>}
            {pending.length > 0 && <button className="st-button st-quiet" onClick={() => setOperationsOpen(true)}>{t("分支操作")}{pending.length}</button>}
            {environment && !environment.experimentId && <details className="st-menu" ref={menu}><summary className="st-button">{t("环境操作")}</summary><div className="st-menu-body">
              {capability?.canDerive && <button onClick={() => showAction(environment.mode === 'fixed' ? 'fork' : 'checkpoint')}>
                {environment.mode === 'fixed' ? t("创建可写分支") : environment.neon ? t("保存只读基线") : t("固定当前状态")}</button>}
              {environment.access === 'read-write' && environment.parentEnvironmentId && <button onClick={() => showAction('deliver')}>{t("交付方案")}</button>}
              <button onClick={() => navigate('connections')}>{t("管理连接")}</button>
            </div></details>}
          </div>
        </div>}
        <div className="st-page">
          {page === 'management' && <ManagementPanel api={api} refresh={refresh} onActivity={() => navigate('experiments')} />}
          {page === 'connections' && <Connections api={api} data={data} refresh={refresh} projectAccess={projectAccess}
            onManage={() => navigate('management')} onOpen={environment => { selectEnvironment(environment.id); navigate('catalog'); }}
            onChat={environment => openConversation(environment.id, undefined, { unbound: true })} onCreate={id => showAction('create', id)} />}
          {showingEnvironment && selected && !environment && <section className="st-empty"><h2>{t("原环境已不可用")}</h2>
            <p>{t("请重新选择数据环境，或从任务详情查看保留的结果与证据。")}</p>
            <button className="st-button" onClick={() => navigate('experiments')}>{t("任务与结果")}</button></section>}
          {showingEnvironment && !selected && !environment && <section className="st-empty"><h2>{data.connections.length ? t("启用已保存的连接") : t("连接数据库，直接聊数据")}</h2>
              <p>{data.connections.length ? t("选择已有连接，验证后即可在项目对话中查询。") : t("接入 PostgreSQL、Neon 或 Stello 后，在普通 DSH 对话中提问。")}</p>
              <button className="st-button st-primary" onClick={() => data.connections.length ? showAction('create') : navigate('connections')}>
                {data.connections.length ? t("启用查询") : t("连接数据")}</button>
              {pending.length > 0 && <button className="st-button" onClick={() => setOperationsOpen(true)}>{t("查看分支操作")}</button>}
            </section>}
          {page === 'experiments' && (experimentId ? <ExperimentView key={experimentId} id={experimentId} initial={initialExperiment}
            api={api} refresh={refresh} openConversation={openConversation} openSession={openSession} openEvidence={openEvidence} onBack={() => setExperimentId('')}
            onSql={(target, run) => { setMode('sql'); openEnvironment(target.id, run); }} />
            : <div className="st-stack">
              <div className="st-page-heading"><div><h2>{t("任务与结果")}</h2><p className="st-muted">{t("日常分析继续在 DSH 对话中进行。这里查看进度、查询依据和试验结果。")}</p></div>
                {pending.length > 0 && <button className="st-button" onClick={() => setOperationsOpen(true)}>{t("分支操作")}{pending.length}</button>}
              </div>
              {available.length === 0 ? <section className="st-empty"><h3>{t("为项目接入数据")}</h3>
                <p>{t("连接 PostgreSQL、Neon 或 Stello 后，可在该项目的普通 DSH 对话里直接提问。")}</p>
                <button className="st-button st-primary" onClick={() => navigate('connections')}>{t("管理数据源")}</button>
              </section> : <section className="st-stack st-task-section" aria-label={t("近期执行")}>
                <h3>{t("近期执行")}</h3>
                {recentRuns.length === 0
                  ? <p className="st-muted">{t("在项目对话中提问，Stellane 执行的查询会显示在这里。")}</p>
                  : <div className="st-history">{recentRuns.map(run => {
                    const source = available.find(item => item.id === run.environmentId);
                    return <button key={run.id} onClick={() => openEvidence(run.id)}>
                      <span className={`st-status st-${run.status}`}>{runStatus[run.status]}</span>
                      <code title={run.metric?.plan.name ?? run.sql}>{run.metric?.plan.name ?? run.sql}</code>
                      <span className="st-muted st-run-source" title={source?.name}>{source?.name}</span>
                      <time dateTime={run.startedAt}>{new Date(run.startedAt).toLocaleString()}</time>
                    </button>;
                  })}</div>}
              </section>}
              <ExperimentList experiments={data.experiments} environments={available} onOpen={openExperiment} />
            </div>)}
          {page === 'evidence' && evidence && <RunEvidence key={evidence.id} id={evidence.id} api={api} environments={data.environments}
            openEvidence={openEvidence} openConversation={openConversation} onBack={() => navigate('experiments')} />}
          {page === 'catalog' && environment && <CatalogPanel key={environment.id} api={api} environment={environment}
            onExplore={() => navigate('explore')} openEvidence={openEvidence} />}
          {environment && <div hidden={page !== 'explore'}>
            <Explore key={`${environment.id}:${focusRun?.id ?? ''}`} api={api} environment={environment} data={data} mode={mode} onMode={setMode}
              refresh={refresh} openConversation={openConversation} onCatalog={() => navigate('catalog')} onEnvironment={openEnvironment} focusRun={focusRun} />
          </div>}
        </div>
      </>}
      {starting && <StartExperiment source={starting} api={api} onClose={() => setStarting(undefined)} onStarted={detail => {
        setStarting(undefined);
        openExperiment(detail.experiment.id, detail);
        void refresh();
      }} />}
      {dialog && <EnvironmentDialog action={dialog.action} api={api} data={data} environment={environment} initialConnection={dialog.connectionId}
        onDone={async (created, run) => { await refresh(); setDialog(undefined); openEnvironment(created.id, run); }}
        onPending={async requestId => {
          const snapshot = await refresh();
          const unresolved = snapshot?.operations.some(item => item.actor.callId === requestId
            && (item.status === 'pending' || item.status === 'unknown'));
          if (!unresolved) return false;
          setDialog(undefined);
          setOperationError('');
          setOperationsOpen(true);
          return true;
        }} onClose={() => setDialog(undefined)} />}
      {operationsOpen && <ActionDialog title={t("分支操作")} busy={!!reconciling} onClose={() => { setOperationsOpen(false); setOperationError(''); }}>
        <div className="st-stack">
          {!pending.length && <p className="st-muted">{t("当前没有待处理的分支操作。")}</p>}
          {pending.map(item => <div className="st-list-row st-source-row" key={item.id}>
            <div><h3>{item.environment.name}</h3><p className="st-muted">{item.status === 'pending' ? t("正在派生") : t("待核实")}</p>
              {item.error && <p className="st-path">{systemMessage(item.error)}</p>}</div>
            {item.status === 'unknown' && <button className="st-button" disabled={!!reconciling} onClick={() => void reconcile(item.id)}>
              {reconciling === item.id ? t("核对中…") : t("核对原分支")}</button>}
          </div>)}
          {operationError && <p role="alert" className="st-error">{systemMessage(operationError)}</p>}
        </div>
      </ActionDialog>}
    </div>
  </main>;
}

export function SettingsPage({ api, projectAccess }: { api: Api; projectAccess?: ProjectAccess }) {
  useLocale();
  const { data, loading, error, refresh } = useSnapshot(api);
  return <div className="st-settings-page"><div className="st-settings-language"><LanguageSwitch /></div>
    {error && <p role="alert" className="st-error">{systemMessage(error)}</p>}
    {loading ? <p className="st-muted">{t("正在读取连接…")}</p> : <Connections api={api} data={data} refresh={refresh} projectAccess={projectAccess} />}
  </div>;
}
