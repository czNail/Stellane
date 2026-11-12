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
import type { ConnectionInput, Run, Snapshot } from '../shared/models.ts';
import styles from './styles.css';

type Api = <K extends Operation>(name: K, input: Requests[K]) => Promise<Responses[K]>;
const empty: Snapshot = { connections: [], environments: [], runs: [] };
const statusText = { running: '执行中', succeeded: '已完成', failed: '失败', interrupted: '已中断' };
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

function Connections({ api, data, refresh }: { api: Api; data: Snapshot; refresh: () => Promise<void> }) {
  const [form, setForm] = useState<ConnectionInput>({
    name: '本地 PostgreSQL', projectPath: '', host: '127.0.0.1', port: 5432,
    database: 'stellane', user: 'stellane_reader', passwordRef: '', tls: 'disable',
  });
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [error, setError] = useState('');
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
  </section>;
}

function Result({ run }: { run: Run }) {
  return <section className="st-result" aria-label="查询结果">
    <div className="st-section-heading"><h3>查询结果</h3><span className={`st-status st-${run.status}`}>{statusText[run.status]}</span></div>
    <p className="st-muted">{run.actor.kind === 'agent' ? `Agent · ${run.actor.id}` : '用户操作'}{run.durationMs !== undefined && ` · ${run.durationMs} ms`}</p>
    {run.target && <p className="st-target">实际数据库：{run.target.database} · 用户：{run.target.user} · {run.target.address ?? 'local'}:{run.target.port ?? '—'}</p>}
    <details className="st-executed-sql"><summary>查看本次执行的 SQL</summary><pre>{run.sql}</pre></details>
    {run.error && <p role="alert" className="st-error">{run.error}</p>}
    {run.preview && <>
      <div className="st-table-scroll"><table><thead><tr>{run.preview.columns.map((column, index) => <th key={`${column}-${index}`}>{column}</th>)}</tr></thead>
        <tbody>{run.preview.rows.map((row, index) => <tr key={index}>{run.preview!.columns.map((column, cell) => <td key={`${column}-${cell}`}>{cellText(row[column])}</td>)}</tr>)}</tbody>
      </table></div>
      <p className="st-muted">{run.preview.rowCount} 行{run.preview.truncated ? '预览，结果已截断' : ''} · 执行记录 {run.id}</p>
    </>}
  </section>;
}

function Panel({ api, openConversation }: { api: Api; openConversation: (workspaceId: string, prompt: string) => void }) {
  const { data, error, refresh } = useSnapshot(api);
  const [view, setView] = useState<'environments' | 'connections'>('environments');
  const [selected, setSelected] = useState('');
  const [selectedRun, setSelectedRun] = useState('');
  const [sql, setSql] = useState('SELECT current_database() AS database, current_user AS role;');
  const [connectionId, setConnectionId] = useState('');
  const [name, setName] = useState('工作环境');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const environment = data.environments.find(item => item.id === selected) ?? data.environments[0];
  const connection = data.connections.find(item => item.id === environment?.connectionId);
  const runs = data.runs.filter(run => run.environmentId === environment?.id);
  const run = runs.find(item => item.id === selectedRun) ?? runs[0];
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
  async function execute(event: FormEvent) {
    event.preventDefault(); if (!environment) return;
    setBusy(true); setActionError('');
    try {
      const result = await api('query', { environmentId: environment.id, sql, values: [] });
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
      <p className="st-muted">配置数据资源，执行查询，追踪每一次操作。</p></div>
      <button className="st-button" onClick={() => void refresh().catch(error => setActionError(message(error)))}>刷新</button>
    </header>
    <nav className="st-tabs" aria-label="Stellane 导航">
      <button aria-pressed={view === 'environments'} onClick={() => setView('environments')}>环境与查询 <span>{data.environments.length}</span></button>
      <button aria-pressed={view === 'connections'} onClick={() => setView('connections')}>连接配置 <span>{data.connections.length}</span></button>
    </nav>
    {(error || actionError) && <p role="alert" className="st-error">{actionError || error}</p>}
    {view === 'connections' ? <Connections api={api} data={data} refresh={refresh} /> : <>
      {data.connections.length === 0 ? <section className="st-empty"><h2>连接第一个数据资源</h2><p className="st-muted">添加 PostgreSQL 连接后，就可以创建项目环境并开始查询。</p>
        <button className="st-button st-primary" onClick={() => setView('connections')}>添加连接</button></section> : <>
        <form className="st-create" onSubmit={event => void create(event)}>
          <label className="st-field"><span>数据库连接</span><select aria-label="数据库连接" value={connectionId || data.connections[0]?.id || ''} onChange={event => setConnectionId(event.target.value)}>
            {data.connections.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>
          <label className="st-field"><span>环境名称</span><input required aria-label="环境名称" maxLength={80} value={name} onChange={event => setName(event.target.value)} /></label>
          <button className="st-button" disabled={busy} type="submit">创建环境</button>
        </form>
        {environment && <div className="st-workspace">
          <aside className="st-environments" aria-label="数据环境">
            {data.environments.map(item => <button key={item.id} aria-pressed={environment.id === item.id} onClick={() => { setSelected(item.id); setSelectedRun(''); }}>
              <span className="st-env-name">{item.name}</span><span className="st-muted">实时直连 · 只读</span>
            </button>)}
          </aside>
          <div className="st-detail">
            <div className="st-section-heading"><h2>{environment.name}</h2><span className="st-status">实时数据库 · 只读</span></div>
            <p className="st-muted">{connection?.host}:{connection?.port}/{connection?.database} · {connection?.user}</p>
            <p className="st-path">{environment.projectPath}</p>
            <form className="st-query" onSubmit={event => void execute(event)}>
              <label className="st-field"><span>SQL 查询</span><textarea aria-label="SQL 查询" value={sql} onChange={event => setSql(event.target.value)} rows={5} spellCheck={false} required /></label>
              <div className="st-query-actions"><span className="st-muted">预览最多 200 行 · 查询限时 5 秒</span><div className="st-actions"><button className="st-button" type="button" disabled={busy} onClick={() => void askAgent()}>在对话中查询</button><button className="st-button st-primary" type="submit" disabled={busy}>{busy ? '执行中…' : '执行查询'}</button></div></div>
            </form>
            {run && <Result run={run} />}
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
  try { if (text) { const value = JSON.parse(text); if (value && typeof value.id === 'string' && typeof value.status === 'string') result = value; } } catch { /* Generic failure content stays inspectable. */ }
  return <div className="st-tool">
    <button onClick={() => setExpanded(value => !value)} aria-expanded={expanded}>
      <Icon /><span>{props.toolName === 'stellane_query' ? 'Stellane · 查询数据' : 'Stellane · 可用环境'}</span>
      <span className="st-muted">{result ? statusText[result.status] : props.phase === 'result' ? '已返回' : '处理中'}</span>
    </button>
    {result?.target && <p className="st-muted">{result.target.database} · {result.target.user} · {result.durationMs} ms</p>}
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
  for (const key of ['stellane_environments', 'stellane_query']) {
    ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key }, ToolCard));
  }
}
