import { useCallback, useEffect, useRef, useState } from 'react';
import type { Run, Snapshot } from '../shared/models.ts';
import { CatalogPanel } from './catalog.tsx';
import { Connections } from './connections.tsx';
import { EnvironmentDialog, type EnvironmentAction } from './environment.tsx';
import { Explore, type Conversation, type ExploreMode } from './explore.tsx';
import { ActionDialog, environmentLabel, environmentTree, message, type Api } from './workspace-ui.tsx';

const empty: Snapshot = { connections: [], environments: [], runs: [], providers: [], operations: [], deliveries: [] };
const pages = { explore: '探索', catalog: '数据目录', connections: '连接' };
type Page = keyof typeof pages;

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

export function Panel({ api, openConversation }: { api: Api; openConversation: Conversation }) {
  const { data, loading, error, refresh } = useSnapshot(api);
  const [page, setPage] = useState<Page>('explore');
  const [mode, setMode] = useState<ExploreMode>('ask');
  const [selected, setSelected] = useState('');
  const [focusRun, setFocusRun] = useState<Run>();
  const [dialog, setDialog] = useState<{ action: EnvironmentAction; connectionId?: string }>();
  const [operationsOpen, setOperationsOpen] = useState(false);
  const [reconciling, setReconciling] = useState('');
  const [operationError, setOperationError] = useState('');
  const menu = useRef<HTMLDetailsElement>(null);
  const surface = useRef<HTMLElement>(null);
  const environment = data.environments.find(item => item.id === selected) ?? data.environments[0];
  const pending = data.operations.filter(item => item.status === 'pending' || item.status === 'unknown');
  const connection = data.connections.find(item => item.id === environment?.connectionId);

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
      } else setOperationError(result.error ?? '原操作仍待核实。');
    } catch (error) { setOperationError(message(error)); }
    finally { setReconciling(''); }
  }

  return <main className="st-app" ref={surface}>
    <div className="st-shell">
      <header className="st-topbar"><h1>Stellane</h1>
        <nav className="st-main-nav" aria-label="Stellane 导航">{Object.entries(pages).map(([id, label]) =>
          <button key={id} aria-current={page === id ? 'page' : undefined} onClick={() => navigate(id as Page)}>{label}</button>)}</nav>
      </header>
      {error && <div className="st-row st-attention" role="alert"><span>{error}</span><button className="st-button" onClick={() => void refresh()}>重试</button></div>}
      {loading ? <p className="st-loading" role="status">正在加载 Stellane…</p> : <>
        {page !== 'connections' && environment && <div className="st-environment-bar">
          <label className="st-environment-select"><span>环境</span><select value={environment.id} onChange={event => selectEnvironment(event.target.value)}>
            {environmentTree(data.environments).map(({ environment: item, depth }) => <option key={item.id} value={item.id}>
              {'　'.repeat(Math.min(depth, 4))}{depth ? '↳ ' : ''}{item.name} · {environmentLabel(item)}</option>)}
          </select></label>
          <span className="st-environment-source">{environment.stello?.resource ?? connection?.database}</span>
          <div className="st-actions st-environment-actions">
            {pending.length > 0 && <button className="st-button st-quiet" onClick={() => setOperationsOpen(true)}>分支操作 {pending.length}</button>}
            <details className="st-menu" ref={menu}><summary className="st-button">环境操作</summary><div className="st-menu-body">
              {data.connections.length > 0 && <button onClick={() => showAction('create')}>创建环境</button>}
              {environment.stello && <button onClick={() => showAction(environment.mode === 'fixed' ? 'fork' : 'checkpoint')}>
                {environment.mode === 'fixed' ? '派生可写分支' : '固定当前状态'}</button>}
              {environment.access === 'read-write' && environment.parentEnvironmentId && <button onClick={() => showAction('deliver')}>交付方案</button>}
              <button onClick={() => navigate('connections')}>管理连接</button>
            </div></details>
          </div>
        </div>}
        <div className="st-page">
          {page === 'connections' && <Connections api={api} data={data} refresh={refresh}
            onOpen={environment => openEnvironment(environment.id)} onCreate={id => showAction('create', id)} />}
          {page !== 'connections' && !environment && <section className="st-empty"><h2>{data.connections.length ? '创建查询环境' : '连接数据，开始探索'}</h2>
              <p>{data.connections.length ? '选择一个 PostgreSQL 连接，为 Agent 和 SQL 查询创建环境。' : '接入 PostgreSQL 或 Stello 后，可以提问、查询和查看数据目录。'}</p>
              <button className="st-button st-primary" onClick={() => data.connections.length ? showAction('create') : navigate('connections')}>
                {data.connections.length ? '创建环境' : '连接数据'}</button>
              {pending.length > 0 && <button className="st-button" onClick={() => setOperationsOpen(true)}>查看分支操作</button>}
            </section>}
          {page === 'catalog' && environment && <CatalogPanel key={environment.id} api={api} environment={environment} onExplore={() => navigate('explore')} />}
          {environment && <div hidden={page !== 'explore'}>
            <Explore key={`${environment.id}:${focusRun?.id ?? ''}`} api={api} environment={environment} data={data} mode={mode} onMode={setMode}
              refresh={refresh} openConversation={openConversation} onCatalog={() => navigate('catalog')} onEnvironment={openEnvironment} focusRun={focusRun} />
          </div>}
        </div>
      </>}
      {dialog && <EnvironmentDialog action={dialog.action} api={api} data={data} environment={environment} initialConnection={dialog.connectionId}
        onDone={async (created, run) => { setDialog(undefined); openEnvironment(created.id, run); await refresh(); }}
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
      {operationsOpen && <ActionDialog title="分支操作" busy={!!reconciling} onClose={() => { setOperationsOpen(false); setOperationError(''); }}>
        <div className="st-stack">
          {!pending.length && <p className="st-muted">当前没有待处理的分支操作。</p>}
          {pending.map(item => <div className="st-list-row st-source-row" key={item.id}>
            <div><h3>{item.environment.name}</h3><p className="st-muted">{item.status === 'pending' ? '正在派生' : '待核实'}</p>
              {item.error && <p className="st-path">{item.error}</p>}</div>
            {item.status === 'unknown' && <button className="st-button" disabled={!!reconciling} onClick={() => void reconcile(item.id)}>
              {reconciling === item.id ? '核对中…' : '核对原分支'}</button>}
          </div>)}
          {operationError && <p role="alert" className="st-error">{operationError}</p>}
        </div>
      </ActionDialog>}
    </div>
  </main>;
}

export function SettingsPage({ api }: { api: Api }) {
  const { data, loading, error, refresh } = useSnapshot(api);
  return <div className="st-settings-page">
    {error && <p role="alert" className="st-error">{error}</p>}
    {loading ? <p className="st-muted">正在读取连接…</p> : <Connections api={api} data={data} refresh={refresh} />}
  </div>;
}
