import { useState, type FormEvent } from 'react';
import type { ConnectionInput, Environment, Snapshot, StelloInput } from '../shared/models.ts';
import { ActionDialog, message, type Api } from './workspace-ui.tsx';

const initialPg: ConnectionInput = {
  name: '', host: '127.0.0.1', port: 5432, database: '', user: '', projectPath: '', passwordRef: '', tls: 'disable',
};
const initialStello: StelloInput = { name: '', projectPath: '', configPath: '', resource: '' };

function SourceForm({ api, onSaved, onClose }: {
  api: Api;
  onSaved: (environment?: Environment) => void;
  onClose: () => void;
}) {
  const [kind, setKind] = useState<'postgres' | 'stello'>('postgres');
  const [pg, setPg] = useState(initialPg);
  const [stello, setStello] = useState(initialStello);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (kind === 'stello') onSaved(await api('saveStello', stello));
      else { await api('saveConnection', pg); onSaved(); }
    } catch (error) { setError(message(error)); }
    finally { setBusy(false); }
  }

  function pgField<K extends keyof ConnectionInput>(key: K, label: string, placeholder?: string) {
    const numeric = key === 'port';
    return <label className="st-field"><span>{label}</span>
      <input required value={pg[key]} placeholder={placeholder} type={numeric ? 'number' : 'text'}
        min={numeric ? 1 : undefined} max={numeric ? 65535 : undefined}
        onChange={event => setPg(current => ({ ...current, [key]: numeric ? Number(event.target.value) : event.target.value }))} />
    </label>;
  }

  return <ActionDialog title="添加数据源" busy={busy} onClose={onClose}>
    <form className="st-stack" onSubmit={event => void save(event)}>
      <fieldset className="st-stack" disabled={busy}>
        <label className="st-field"><span>连接类型</span><select value={kind} onChange={event => {
          setKind(event.target.value as typeof kind);
          setError('');
        }}><option value="postgres">PostgreSQL</option><option value="stello">Stello</option></select></label>
        {kind === 'postgres' ? <>
          {pgField('name', '名称', '例如：分析数据库')}
          <div className="st-form-grid">{pgField('host', '主机')}{pgField('port', '端口')}{pgField('database', '数据库')}{pgField('user', '数据库用户')}</div>
          {pgField('projectPath', '项目目录', '/path/to/project')}
          {pgField('passwordRef', '密码引用', 'file:/path/to/password 或 env:DB_PASSWORD')}
          <label className="st-field"><span>TLS</span><select value={pg.tls} onChange={event => setPg({ ...pg, tls: event.target.value as ConnectionInput['tls'] })}>
            <option value="disable">不启用</option><option value="verify-full">验证服务器证书</option>
          </select></label>
          <p className="st-muted">密码由宿主从引用读取。保存连接后，可从该连接创建只读环境。</p>
        </> : <>
          {([['name', '名称', '例如：分析分支'], ['resource', '数据库 / 分支', 'database/main'],
            ['projectPath', '项目目录', '/path/to/project'], ['configPath', 'Stello 客户端配置', '/path/to/client.json']] as const).map(([key, label, placeholder]) =>
            <label className="st-field" key={key}><span>{label}</span><input required value={stello[key]} placeholder={placeholder}
              onChange={event => setStello({ ...stello, [key]: event.target.value })} /></label>)}
          <p className="st-muted">验证来源分支后，会自动创建环境。</p>
        </>}
        {error && <p role="alert" className="st-error">{error}</p>}
        <div className="st-actions st-form-actions"><button className="st-button" type="button" onClick={onClose}>取消</button>
          <button className="st-button st-primary" type="submit">{busy ? '保存中…' : '保存数据源'}</button></div>
      </fieldset>
    </form>
  </ActionDialog>;
}

export function Connections({ api, data, refresh, onOpen, onCreate }: {
  api: Api;
  data: Snapshot;
  refresh: () => Promise<Snapshot | undefined>;
  onOpen?: (environment: Environment) => void;
  onCreate?: (connectionId: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [probing, setProbing] = useState('');
  const [notice, setNotice] = useState<{ text: string; error?: boolean }>();
  const empty = !data.connections.length && !data.providers.length;

  async function probe(id: string, name: string) {
    setProbing(id);
    setNotice(undefined);
    try {
      const target = await api('probe', { connectionId: id });
      setNotice({ text: `${name}连接成功。已访问 ${target.database}。` });
    } catch (error) { setNotice({ text: message(error), error: true }); }
    finally { setProbing(''); }
  }

  function saved(environment?: Environment) {
    setAdding(false);
    setNotice({ text: environment ? 'Stello 来源已连接，环境已创建。' : '连接已保存。' });
    if (environment) onOpen?.(environment);
    void refresh().catch(error => setNotice({ text: message(error), error: true }));
  }

  return <section aria-label="数据连接" className="st-stack">
    <div className="st-page-heading"><div><h2>数据连接</h2><p className="st-muted">管理 PostgreSQL 数据库和 Stello 来源。</p></div>
      {!empty && <button className="st-button st-primary" onClick={() => setAdding(true)}>添加数据源</button>}</div>
    {notice && <p role={notice.error ? 'alert' : 'status'} className={notice.error ? 'st-error' : 'st-notice'}>{notice.text}</p>}
    {empty ? <div className="st-empty"><h3>连接第一个数据源</h3><p>添加连接后，就可以向 Agent 提问或执行 SQL。</p>
      <button className="st-button st-primary" onClick={() => setAdding(true)}>添加数据源</button></div> : <div className="st-list">
      {data.connections.map(connection => {
        const environments = data.environments.filter(environment => environment.connectionId === connection.id);
        return <article className="st-list-row st-source-row" key={connection.id}>
          <div className="st-source-info"><h3>{connection.name}</h3>
            <p className="st-muted">PostgreSQL · {connection.database} · {environments.length} 个环境</p>
            <details className="st-details"><summary>连接详情</summary>
              <p className="st-path">{connection.user}@{connection.host}:{connection.port}/{connection.database}</p>
              <p className="st-path">项目 {connection.projectPath}</p>
            </details>
          </div>
          <div className="st-actions"><button className="st-button" disabled={!!probing} onClick={() => void probe(connection.id, connection.name)}>
            {probing === connection.id ? '测试中…' : '测试连接'}</button>
            {onCreate && <button className="st-button" onClick={() => onCreate(connection.id)}>创建环境</button>}
          </div>
        </article>;
      })}
      {data.providers.map(source => {
        const environment = data.environments.find(item => item.stello?.providerId === source.id && !item.parentEnvironmentId);
        return <article className="st-list-row st-source-row" key={source.id}>
          <div className="st-source-info"><h3>{source.name}</h3><p className="st-muted">Stello · {source.resource}</p>
            <details className="st-details"><summary>连接详情</summary><p className="st-path">项目 {source.projectPath}</p></details>
          </div>
          {environment && onOpen && <button className="st-button" onClick={() => onOpen(environment)}>打开环境</button>}
        </article>;
      })}
    </div>}
    {adding && <SourceForm api={api} onSaved={saved} onClose={() => setAdding(false)} />}
  </section>;
}
