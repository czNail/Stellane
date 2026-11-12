import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-api-gateway/client';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type {} from '@deepseek-ai/dsh-client-ui-layout/client';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client';
import type {} from '@deepseek-ai/dsh-client-ui-settings/client';
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client';
import type { UiWorkspace } from '@deepseek-ai/dsh-client-ui-workspace/client';
import type { TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol';
import { remoteInfo, type Operation, type Reply, type Requests, type Responses } from '../shared/remote.ts';
import type { ConnectionInput, Environment, QueryPreview, Run, Snapshot, StelloInput } from '../shared/models.ts';
import styles from './styles.css';

type Api = <K extends Operation>(name: K, input: Requests[K]) => Promise<Responses[K]>;
const empty: Snapshot = { connections: [], environments: [], runs: [], providers: [], operations: [], deliveries: [] };
const statusText = { running: '执行中', succeeded: '已完成', failed: '失败', interrupted: '已中断', unknown: '待核实' };
const toolLabels: Record<string, string> = {
  stellane_query: '查询数据', stellane_environments: '可用环境', stellane_execute: '提交写入',
  stellane_checkpoint: '固定状态', stellane_fork: '派生环境', stellane_deliver: '交付方案',
  stellane_results: '收到的结果', stellane_reconcile_write: '核对写入', stellane_reconcile_branch: '核对派生',
};
export const inject = ['remote', 'slots'];

function useSnapshot(api: Api) {
  const [data, setData] = useState<Snapshot>(empty);
  const [error, setError] = useState('');
  const refresh = useCallback(async () => {
    const value = await api('snapshot', {});
    setData(value); setError('');
  }, [api]);
  useEffect(() => {
    let disposed = false;
    const load = async () => {
      try { const value = await api('snapshot', {}); if (!disposed) { setData(value); setError(''); } }
      catch (error) { if (!disposed) setError(message(error)); }
    };
    void load();
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 1500);
    return () => { disposed = true; clearInterval(timer); };
  }, [api]);
  return { data, error, refresh };
}
function message(error: unknown) { return error instanceof Error ? error.message : '操作失败，请重试。'; }
function cellText(value: unknown) { return value === null ? 'NULL' : typeof value === 'object' ? JSON.stringify(value) : String(value); }
function contentText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  return content.flatMap((item: unknown) => {
    if (typeof item === 'object' && item !== null && 'type' in item && item.type === 'text' && 'text' in item && typeof item.text === 'string') return [item.text];
    return [];
  }).join('\n');
}
function Icon() { return <span aria-hidden="true" className="st-icon">S</span>; }
function environmentLabel(environment: Environment) {
  return environment.mode === 'fixed' ? '固定切面 · 只读' : environment.access === 'read-write'
    ? '独立分支 · 可写' : environment.stello ? '来源库 · 只读' : '实时直连 · 只读';
}

function Connections({ api, data, refresh }: { api: Api; data: Snapshot; refresh: () => Promise<void> }) {
  const [form, setForm] = useState<ConnectionInput>({
    name: '本地 PostgreSQL', projectPath: '', host: '127.0.0.1', port: 5432,
    database: 'stellane', user: 'stellane_reader', passwordRef: '', tls: 'disable',
  });
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [error, setError] = useState('');
  const [stello, setStello] = useState<StelloInput>({ name: 'Stello 业务来源', projectPath: '', configPath: '', resource: 'stellane/main' });
  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setFeedback('');
    try { await api('saveConnection', form); await refresh(); setFeedback('连接配置已保存。'); }
    catch (error) { setError(message(error)); }
    finally { setBusy(false); }
  }
  async function probe(id: string) {
    setBusy(true); setError(''); setFeedback('');
    try {
      const target = await api('probe', { connectionId: id });
      setFeedback(`连接成功：${target.database} · ${target.user}`);
    } catch (error) { setError(message(error)); }
    finally { setBusy(false); }
  }
  function field(key: keyof ConnectionInput, label: string, placeholder = '') {
    return <label className={key === 'projectPath' || key === 'passwordRef' ? 'st-field st-wide' : 'st-field'}>
      <span>{label}</span><input required aria-label={label} value={form[key]} placeholder={placeholder}
        type={key === 'port' ? 'number' : 'text'} min={key === 'port' ? 1 : undefined} max={key === 'port' ? 65535 : undefined}
        onChange={event => setForm({ ...form, [key]: key === 'port' ? Number(event.target.value) : event.target.value })} />
    </label>;
  }
  return <section className="st-settings">
    <h2>数据库连接</h2><p className="st-muted">登记项目使用的数据资源，密码由宿主读取引用来源。</p>
    {error && <p role="alert" className="st-error">{error}</p>}
    {feedback && <p role="status">{feedback}</p>}
    {data.connections.length > 0 && <div className="st-connection-list">
      {data.connections.map(connection => <div key={connection.id} className="st-connection">
        <div><strong>{connection.name}</strong><p className="st-muted">{connection.user}@{connection.host}:{connection.port}/{connection.database}</p>
          <p className="st-path">{connection.projectPath}</p></div>
        <button className="st-button" disabled={busy} onClick={() => void probe(connection.id)}>测试连接</button>
      </div>)}
    </div>}
    <form className="st-form" onSubmit={event => void save(event)}>
      <h3 className="st-wide">添加连接</h3>
      {field('name', '连接名称')}{field('host', '数据库地址')}{field('port', '端口')}
      {field('database', '数据库')}{field('user', '数据库用户')}
      <label className="st-field"><span>TLS</span><select aria-label="TLS" value={form.tls}
        onChange={event => setForm({ ...form, tls: event.target.value as ConnectionInput['tls'] })}>
        <option value="disable">本地连接（不启用 TLS）</option><option value="verify-full">验证服务器证书</option>
      </select></label>
      {field('projectPath', '项目目录', '/absolute/path/to/project')}
      {field('passwordRef', '密码引用', 'file:/absolute/path/password 或 env:DB_PASSWORD')}
      <p className="st-muted st-wide">只保存引用，不将密码写入连接记录。文件须仅当前用户可读。Agent 只能使用其项目目录下登记的环境。</p>
      <div className="st-wide"><button className="st-button st-primary" disabled={busy} type="submit">{busy ? '处理中…' : '保存连接'}</button></div>
    </form>
    <div className="st-stello-settings">
      <h2>Stello 分支来源</h2><p className="st-muted">登记客户端配置引用与来源分支。来源保持只读，从固定状态派生独立的可写环境。</p>
      {data.providers.map(source => <div className="st-connection" key={source.id}><div><strong>{source.name}</strong>
        <p className="st-muted">{source.resource}</p><p className="st-path">{source.projectPath}</p></div></div>)}
      <form className="st-form" onSubmit={event => {
        event.preventDefault(); setBusy(true); setError(''); setFeedback('');
        void api('saveStello', stello).then(refresh).then(() => setFeedback('Stello 来源已核验并登记。'))
          .catch(error => setError(message(error))).finally(() => setBusy(false));
      }}>
        {([['name', '来源名称'], ['resource', '数据库 / 分支'], ['projectPath', 'Stello 项目目录'], ['configPath', 'Stello 客户端配置文件']] as const).map(([key, label]) =>
          <label className={`st-field ${key.endsWith('Path') ? 'st-wide' : ''}`} key={key}><span>{label}</span>
            <input required aria-label={label} value={stello[key]} onChange={event => setStello({ ...stello, [key]: event.target.value })} /></label>)}
        <p className="st-muted st-wide">配置文件中的 CA 和令牌引用仅由 Host 使用。Agent 只能操作当前项目登记的环境。</p>
        <div className="st-wide"><button className="st-button st-primary" disabled={busy}>登记 Stello 来源</button></div>
      </form>
    </div>
  </section>;
}

function Result({ run }: { run: Run }) {
  return <section className="st-result" aria-label="查询结果">
    <div className="st-section-heading"><h3>查询结果</h3><span className={`st-status st-${run.status}`}>{statusText[run.status]}</span></div>
    <p className="st-muted">{run.actor.kind === 'agent' ? `Agent · ${run.actor.id}` : '用户操作'}{run.durationMs !== undefined && ` · ${run.durationMs} ms`}</p>
    {run.kind === 'execute' && run.preview && <p className="st-target">事务已提交 · {run.preview.command} · 影响 {run.preview.affectedRows ?? 0} 行</p>}
    {run.target && <p className="st-target">实际数据库：{run.target.database} · 用户：{run.target.user} · {run.target.address ?? 'local'}:{run.target.port ?? '—'}</p>}
    {run.branch && <p className="st-target">实际分支：{run.branch.resource} · 来源位置 {run.branch.forkLsn}</p>}
    <details className="st-executed-sql"><summary>查看本次执行的 SQL</summary><pre>{run.sql}</pre></details>
    {run.error && <p role="alert" className="st-error">{run.error}</p>}
    {run.preview && <>
      <PreviewTable preview={run.preview} />
      <p className="st-muted">{run.preview.rowCount} 行{run.preview.truncated ? '预览，结果已截断' : ''} · 执行记录 {run.id}</p>
    </>}
  </section>;
}

function PreviewTable({ preview, maxRows = 200 }: { preview: QueryPreview; maxRows?: number }) {
  if (!preview.columns.length) return null;
  return <div className="st-table-scroll"><table><thead><tr>{preview.columns.map((column, index) => <th key={`${column}-${index}`}>{column}</th>)}</tr></thead>
    <tbody>{preview.rows.slice(0, maxRows).map((row, index) => <tr key={index}>{preview.columns.map((column, cell) => <td key={`${column}-${cell}`}>{cellText(row[column])}</td>)}</tr>)}</tbody>
  </table></div>;
}

function Panel({ api, openConversation }: { api: Api; openConversation: (workspaceId: string, prompt: string) => void }) {
  const { data, error, refresh } = useSnapshot(api);
  const [view, setView] = useState<'environments' | 'connections'>('environments');
  const [selected, setSelected] = useState('');
  const [selectedRun, setSelectedRun] = useState('');
  const [sql, setSql] = useState('SELECT current_database() AS database, current_user AS role;');
  const [connectionId, setConnectionId] = useState('');
  const [name, setName] = useState('工作环境');
  const [derivedName, setDerivedName] = useState('工作方案');
  const [summary, setSummary] = useState('');
  const [recipientId, setRecipientId] = useState('');
  const [evidenceSql, setEvidenceSql] = useState('SELECT * FROM demo_orders ORDER BY id;');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const environment = data.environments.find(item => item.id === selected) ?? data.environments[0];
  const connection = data.connections.find(item => item.id === environment?.connectionId);
  const runs = data.runs.filter(run => run.environmentId === environment?.id);
  const run = runs.find(item => item.id === selectedRun) ?? runs[0];
  const ancestors: Environment[] = [];
  let parentId = environment?.parentEnvironmentId;
  while (parentId && ancestors.length < 16) {
    const parent = data.environments.find(item => item.id === parentId);
    if (!parent) break;
    ancestors.push(parent); parentId = parent.parentEnvironmentId;
  }
  const ordered: { environment: Environment; depth: number }[] = [];
  const append = (item: Environment, depth: number) => {
    if (depth > 16) return;
    ordered.push({ environment: item, depth });
    data.environments.filter(child => child.parentEnvironmentId === item.id).forEach(child => append(child, depth + 1));
  };
  data.environments.filter(item => !item.parentEnvironmentId || !data.environments.some(parent => parent.id === item.parentEnvironmentId))
    .forEach(item => append(item, 0));
  const deliveries = data.deliveries.filter(item => item.recipientEnvironmentId === environment?.id || item.snapshotEnvironmentId === environment?.id);
  async function mutate(work: () => Promise<void>) {
    setBusy(true); setActionError('');
    try { await work(); await refresh(); } catch (error) { setActionError(message(error)); }
    finally { setBusy(false); }
  }
  function derive() {
    if (!environment) return;
    void mutate(async () => {
      const created = await api(environment.mode === 'fixed' ? 'fork' : 'checkpoint', { environmentId: environment.id, name: derivedName, requestId: crypto.randomUUID() });
      setSelected(created.id); setSelectedRun('');
    });
  }
  function deliver(event: FormEvent) {
    event.preventDefault(); if (!environment) return;
    void mutate(async () => {
      const recipientEnvironmentId = recipientId && ancestors.some(item => item.id === recipientId) ? recipientId
        : (ancestors.find(item => item.access === 'read-write') ?? ancestors[0])?.id;
      if (!recipientEnvironmentId) throw new Error('请先选择接收结果的祖先环境。');
      const result = await api('deliver', { environmentId: environment.id, recipientEnvironmentId, summary, sql: evidenceSql, requestId: crypto.randomUUID() });
      setSelected(result.environment.id); setSelectedRun(result.run.id); setSummary('');
    });
  }
  async function create(event: FormEvent) {
    event.preventDefault(); setBusy(true); setActionError('');
    try {
      const id = connectionId || data.connections[0]?.id;
      if (!id) throw new Error('请先添加数据库连接。');
      await api('probe', { connectionId: id });
      const created = await api('createEnvironment', { connectionId: id, name });
      await refresh(); setSelected(created.id); setSelectedRun('');
    } catch (error) { setActionError(message(error)); }
    finally { setBusy(false); }
  }
  async function execute(event: { preventDefault(): void }, operation: 'query' | 'execute' = 'query') {
    event.preventDefault(); if (!environment) return;
    setBusy(true); setActionError('');
    try {
      const result = await api(operation, { environmentId: environment.id, sql, values: [], requestId: crypto.randomUUID() });
      await refresh(); setSelectedRun(result.id);
    } catch (error) { setActionError(message(error)); }
    finally { setBusy(false); }
  }
  async function askAgent() {
    if (!environment) return;
    setActionError('');
    try {
      const { workspaceId } = await api('prepareConversation', { environmentId: environment.id });
      openConversation(workspaceId, `请使用 Stellane 工具查询数据库：先调用 stellane_environments 确认可用环境，再用 stellane_query 在环境 ${environment.id} 中执行以下只读 SQL。请根据实际结果回答，附必要来源，无需讲解工具调用方法。\n\n${sql}`);
    } catch (error) { setActionError(message(error)); }
  }
  return <main className="st-app">
    <header className="st-header"><div><p className="st-eyebrow">STELLANE</p><h1>任务与数据环境</h1>
      <p className="st-muted">固定父状态，独立尝试方案，交付可追溯的结果。</p></div>
      <button className="st-button" onClick={() => void refresh().catch(error => setActionError(message(error)))}>刷新</button>
    </header>
    <nav className="st-tabs" aria-label="Stellane 导航">
      <button aria-pressed={view === 'environments'} onClick={() => setView('environments')}>环境与查询 <span>{data.environments.length}</span></button>
      <button aria-pressed={view === 'connections'} onClick={() => setView('connections')}>连接配置 <span>{data.connections.length + data.providers.length}</span></button>
    </nav>
    {(error || actionError) && <p role="alert" className="st-error">{actionError || error}</p>}
    {view === 'connections' ? <Connections api={api} data={data} refresh={refresh} /> : <>
      {data.connections.length + data.providers.length === 0 ? <section className="st-empty"><h2>连接第一个数据资源</h2><p className="st-muted">登记 PostgreSQL 连接或 Stello 分支来源，开始使用数据环境。</p>
        <button className="st-button st-primary" onClick={() => setView('connections')}>添加连接</button></section> : <>
        {data.connections.length > 0 && <form className="st-create" onSubmit={event => void create(event)}>
          <label className="st-field"><span>数据库连接</span><select aria-label="数据库连接" value={connectionId || data.connections[0]?.id || ''} onChange={event => setConnectionId(event.target.value)}>
            {data.connections.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>
          <label className="st-field"><span>环境名称</span><input required aria-label="环境名称" maxLength={80} value={name} onChange={event => setName(event.target.value)} /></label>
          <button className="st-button" disabled={busy} type="submit">创建环境</button>
        </form>}
        {data.operations.some(item => item.status === 'pending' || item.status === 'unknown') && <section className="st-operation-list" aria-label="待完成派生">
          {data.operations.filter(item => item.status === 'pending' || item.status === 'unknown').map(item => <div key={item.id}>
            <span>{item.environment.name} · {item.status === 'pending' ? '派生中' : '待核实'}</span>
            {item.error && <p className="st-muted">{item.error}</p>}
            {item.status === 'unknown' && <button className="st-button" disabled={busy} onClick={() => void mutate(async () => {
              await api('reconcileOperation', { operationId: item.id });
            })}>核对原分支</button>}
          </div>)}
        </section>}
        {environment && <div className="st-workspace">
          <aside className="st-environments" aria-label="数据环境">
            {ordered.map(({ environment: item, depth }) => <button style={{ paddingLeft: 12 + Math.min(depth, 6) * 12 }} key={item.id} aria-pressed={environment.id === item.id} onClick={() => { setSelected(item.id); setSelectedRun(''); }}>
              <span className="st-env-name">{depth > 0 ? '↳ ' : ''}{item.name}</span><span className="st-muted">{environmentLabel(item)}</span>
            </button>)}
          </aside>
          <div className="st-detail">
            <div className="st-section-heading"><h2>{environment.name}</h2><span className="st-status">{environmentLabel(environment)}</span></div>
            {connection && <p className="st-muted">{connection.host}:{connection.port}/{connection.database} · {connection.user}</p>}
            {environment.stello && <>
              <p className="st-muted">{environment.stello.resource} · 来源位置 {environment.stello.forkLsn}</p>
              {ancestors[0] && <p className="st-muted">来自：{ancestors[0].name}</p>}
              <details className="st-provenance"><summary>来源与资源身份</summary><p className="st-path">环境 {environment.id}</p>
                <p className="st-path">{environment.stello.identity.service} / 槽位 {environment.stello.identity.slot} / 代次 {environment.stello.identity.incarnation}</p>
                <p className="st-path">{environment.stello.resourceId}</p></details>
              <div className="st-branch-actions"><label className="st-field"><span>{environment.mode === 'fixed' ? '新方案名称' : '固定切面名称'}</span>
                <input aria-label="派生环境名称" value={derivedName} onChange={event => setDerivedName(event.target.value)} maxLength={80} /></label>
                <button className="st-button" disabled={busy || !derivedName.trim()} onClick={derive}>{environment.mode === 'fixed' ? '派生可写环境' : '固定当前状态'}</button></div>
            </>}
            <p className="st-path">{environment.projectPath}</p>
            {deliveries.length > 0 && <section className="st-deliveries" aria-label="交付结果"><h3>交付结果</h3>
              {deliveries.map(delivery => <article key={delivery.id}><strong>{delivery.summary}</strong>
                <p className="st-muted">{data.environments.find(item => item.id === delivery.sourceEnvironmentId)?.name} → {data.environments.find(item => item.id === delivery.recipientEnvironmentId)?.name}</p>
                {data.runs.find(item => item.id === delivery.runId)?.preview && <PreviewTable preview={data.runs.find(item => item.id === delivery.runId)!.preview!} maxRows={3} />}
                <p className="st-path">交付 {delivery.id} · 证据 {delivery.runId}</p>
                <button className="st-button" onClick={() => { setSelected(delivery.snapshotEnvironmentId); setSelectedRun(delivery.runId); }}>查看固定结果</button>
              </article>)}
            </section>}
            <form className="st-query" onSubmit={event => void execute(event)}>
              <label className="st-field"><span>SQL 查询</span><textarea aria-label="SQL 查询" value={sql} onChange={event => setSql(event.target.value)} rows={5} spellCheck={false} required /></label>
              <div className="st-query-actions"><span className="st-muted">预览最多 200 行 · 查询 5 秒{environment.access === 'read-write' ? ' / 写入 30 秒' : ''}</span><div className="st-actions"><button className="st-button" type="button" disabled={busy} onClick={() => void askAgent()}>在对话中查询</button><button className="st-button st-primary" type="submit" disabled={busy}>{busy ? '执行中…' : '执行查询'}</button>
                {environment.access === 'read-write' && <button className="st-button" type="button" disabled={busy} onClick={event => void execute(event, 'execute')}>提交写入</button>}
              </div></div>
            </form>
            {run && <Result run={run} />}
            {run?.status === 'unknown' && <button className="st-button" disabled={busy} onClick={() => void mutate(async () => {
              await api('reconcileRun', { runId: run.id });
            })}>核对原写入回执</button>}
            {environment.access === 'read-write' && ancestors.length > 0 && <details className="st-delivery-form"><summary>交付方案</summary>
              <form onSubmit={deliver}><label className="st-field"><span>接收环境</span><select aria-label="接收环境" value={recipientId && ancestors.some(item => item.id === recipientId) ? recipientId : (ancestors.find(item => item.access === 'read-write') ?? ancestors[0])!.id}
                onChange={event => setRecipientId(event.target.value)}>{ancestors.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
                <label className="st-field"><span>方案摘要</span><textarea aria-label="方案摘要" required maxLength={4000} rows={2} value={summary} onChange={event => setSummary(event.target.value)} /></label>
                <label className="st-field"><span>固定结果上的证据查询</span><textarea aria-label="交付证据 SQL" required rows={3} value={evidenceSql} onChange={event => setEvidenceSql(event.target.value)} /></label>
                <p className="st-muted">固定当前已提交状态后执行证据查询；后续工作修改不会改变本次交付。</p>
                <button className="st-button" disabled={busy}>固定并交付</button>
              </form></details>}
            <section className="st-history"><div className="st-section-heading"><h3>执行记录</h3><span className="st-muted">最近 100 次操作</span></div>
              {runs.length === 0 ? <p className="st-muted">还没有执行记录。在这里查询，或让当前项目中的 Agent 调用 Stellane 工具。</p> : runs.map(item => <button key={item.id} onClick={() => setSelectedRun(item.id)} aria-pressed={run?.id === item.id}>
                <span className={`st-status st-${item.status}`}>{statusText[item.status]}</span><code>{item.sql.slice(0, 100)}</code><time>{new Date(item.startedAt).toLocaleTimeString()}</time>
              </button>)}
            </section>
          </div>
        </div>}
      </>}
    </>}
  </main>;
}

function SettingsPage({ api }: { api: Api }) {
  const { data, error, refresh } = useSnapshot(api);
  return <div className="st-settings-page">{error && <p role="alert" className="st-error">{error}</p>}<Connections api={api} data={data} refresh={refresh} /></div>;
}

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
      <span className="st-muted">{result ? statusText[result.status] : props.phase === 'result' ? '已返回' : '处理中'}</span>
    </button>
    {result?.branch && <p className="st-muted">{result.branch.resource} · {result.branch.forkLsn}</p>}
    {result?.target && <p className="st-muted">{result.target.database} · {result.target.user} · {result.target.address}:{result.target.port} · {result.durationMs} ms</p>}
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
