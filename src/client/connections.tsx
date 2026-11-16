import { t, systemMessage, useLocale } from './i18n.tsx';
import { useState, type FormEvent } from 'react';
import type { ConnectionInput, Environment, Snapshot, StelloInput } from '../shared/models.ts';
import { ActionDialog, message, type Api, type ProjectAccess } from './workspace-ui.tsx';

const initialPg: ConnectionInput = {
  name: '', host: '127.0.0.1', port: 5432, database: '', user: '', projectPath: '', passwordRef: '', tls: 'disable',
};
const initialStello: StelloInput = { name: '', projectPath: '', configPath: '', resource: '' };

function SourceForm({ api, projectAccess, onSaved, onClose }: {
  api: Api; projectAccess?: ProjectAccess;
  onSaved: (environment: Environment) => void;
  onClose: () => void;
}) {
  useLocale();
  const [kind, setKind] = useState<'postgres' | 'neon' | 'neon-local' | 'stello'>('postgres');
  const [name, setName] = useState('');
  const [localConfigPath, setLocalConfigPath] = useState('');
  const [projectPath, setProjectPath] = useState(() => projectAccess?.currentPath() ?? '');
  const [connectionString, setConnectionString] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [branching, setBranching] = useState(false);
  const [neon, setNeon] = useState({ projectId: '', branchId: '', apiKey: '' });
  const [pg, setPg] = useState(initialPg);
  const [stello, setStello] = useState(initialStello);
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState('');

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      let defaultName = kind === 'neon-local' ? 'Neon (Docker)' : kind === 'stello' ? stello.resource : advanced && kind === 'postgres' ? pg.database : '';
      if (!defaultName && connectionString) {
        try { defaultName = decodeURIComponent(new URL(connectionString).pathname.slice(1)); } catch { /* The Host validates the connection URL. */ }
      }
      const common = { name: name.trim() || defaultName.slice(0, 80) || t("数据库"), projectPath: projectPath.trim() };
      let environment: Environment;
      if (kind === 'neon-local') environment = await api('connectLocalNeon', { ...common, configPath: localConfigPath.trim() });
      else if (kind === 'stello') environment = await api('saveStello', { ...stello, ...common });
      else if (kind === 'neon' && branching) environment = await api('connectNeon', { ...common, connectionString, ...neon });
      else environment = await api('connectPostgres', advanced && kind === 'postgres' ? { ...pg, ...common } : { ...common, connectionString });
      setConnectionString('');
      setNeon(current => ({ ...current, apiKey: '' }));
      onSaved(environment);
    } catch (error) { setError(message(error)); }
    finally { setBusy(false); }
  }

  async function pickProject() {
    if (!projectAccess) return;
    setPicking(true);
    setError('');
    try { const path = await projectAccess.pickDirectory(); if (path) setProjectPath(path); }
    catch (error) { setError(message(error)); }
    finally { setPicking(false); }
  }

  function pgField<K extends keyof ConnectionInput>(key: K, label: string, placeholder?: string) {
    const numeric = key === 'port';
    return <label className="st-field"><span>{label}</span>
      <input required value={pg[key]} placeholder={placeholder} type={numeric ? 'number' : 'text'}
        min={numeric ? 1 : undefined} max={numeric ? 65535 : undefined}
        onChange={event => setPg(current => ({ ...current, [key]: numeric ? Number(event.target.value) : event.target.value }))} />
    </label>;
  }

  return <ActionDialog title={t("添加数据源")} busy={busy || picking} onClose={onClose}>
    <form className="st-stack" onSubmit={event => void save(event)}>
      <fieldset className="st-stack" disabled={busy || picking}>
        <label className="st-field"><span>{t("数据库")}</span><select value={kind} onChange={event => {
          setKind(event.target.value as typeof kind);
          setError('');
        }}><option value="postgres">PostgreSQL</option><option value="neon-local">Neon (Docker)</option><option value="neon">{t("Neon 云端（实验性）")}</option><option value="stello">Stello</option></select></label>
        <label className="st-field"><span>{t("名称（可选）")}</span><input maxLength={80} value={name}
          placeholder={t("默认使用数据库名")} onChange={event => setName(event.target.value)} /></label>
        <div className="st-field"><label htmlFor="stellane-project-path">{t("用于哪个项目")}</label>
          <div className="st-path-input"><input id="stellane-project-path" required maxLength={1024} value={projectPath}
            placeholder="/path/to/project" onChange={event => setProjectPath(event.target.value)} />
            {projectAccess && <button className="st-button" type="button" onClick={() => void pickProject()}>{t("选择目录")}</button>}
          </div><small className="st-muted">{t("这个项目中的普通 DSH 对话可以使用此数据源。")}</small>
        </div>
        {kind === 'neon-local' ? <>
          <label className="st-field"><span>{t('Neon 本地配置文件')}</span><input required value={localConfigPath} placeholder="/path/to/provider.json" onChange={event => setLocalConfigPath(event.target.value)} /></label>
          <p className="st-muted">{t('运行 dsh plugin --profile web exec stellane-neon start 后粘贴输出的 provider.json 路径。连接本机 Docker 中的 Neon，可以直接进行独立分支试验，不需要云端项目或云 API key。')}</p>
        </> : kind === 'stello' ? <>
          {([['resource', t("数据库 / 分支"), 'database/main'], ['configPath', t("Stello 客户端配置"), '/path/to/client.json']] as const).map(([key, label, placeholder]) =>
            <label className="st-field" key={key}><span>{label}</span><input required value={stello[key]} placeholder={placeholder}
              onChange={event => setStello({ ...stello, [key]: event.target.value })} /></label>)}
          <p className="st-muted">{t("可查询数据、保存血缘与记忆，也可在独立分支做试验。")}</p>
        </> : <>
          {advanced && kind === 'postgres' ? <>
            <div className="st-form-grid">{pgField('host', t("主机"))}{pgField('port', t("端口"))}{pgField('database', t("数据库名"))}{pgField('user', t("数据库用户"))}</div>
            {pgField('passwordRef', t("密码引用"), t("file:/path/to/password 或 env:DB_PASSWORD"))}
            <label className="st-field"><span>{t("连接加密")}</span><select value={pg.tls} onChange={event => setPg({ ...pg, tls: event.target.value as ConnectionInput['tls'] })}>
              <option value="disable">{t("本地连接，不启用 TLS")}</option><option value="verify-full">{t("TLS，验证服务器证书")}</option>
            </select></label>
          </> : <div className="st-field"><label htmlFor="stellane-connection-url">{t("连接 URL")}</label><input id="stellane-connection-url" aria-describedby="stellane-url-help" type="password" autoComplete="off" spellCheck={false} required maxLength={8192}
            value={connectionString} placeholder={kind === 'neon' ? 'postgresql://user:password@ep-….neon.tech/database?sslmode=require' : 'postgresql://user:password@localhost:5432/database'}
            onChange={event => setConnectionString(event.target.value)} />
            <small id="stellane-url-help" className="st-muted">{kind === 'neon' ? t("从 Neon 控制台的 Connect 复制。") : t("粘贴数据库的 PostgreSQL 连接字符串。")} {t("凭据由 DSH 宿主安全保存。")}</small>
          </div>}
          {kind === 'postgres' && <button className="st-button st-quiet st-back" type="button" onClick={() => setAdvanced(value => !value)}>
            {advanced ? t("改用连接 URL") : t("按字段连接（高级）")}</button>}
          <p className="st-muted">{t("连接后即可只读查询、发现表关系、保存记忆和查看证据。")}</p>
          {kind === 'neon' && <>
            <label className="st-check"><input type="checkbox" checked={branching} onChange={event => setBranching(event.target.checked)} />
              <span>{t("启用独立试验（可选）")}</span></label>
            {branching ? <div className="st-stack st-reference">
              <p>{t("Stellane 会在这个 Neon 项目内创建试验分支。原数据库保持只读。")}</p>
              <div className="st-form-grid">{([['projectId', 'Project ID', 'project-name-123456'], ['branchId', 'Branch ID', 'br-…']] as const).map(([key, label, placeholder]) =>
                <label className="st-field" key={key}><span>{label}</span><input required value={neon[key]} placeholder={placeholder}
                  onChange={event => setNeon({ ...neon, [key]: event.target.value })} /></label>)}</div>
              <label className="st-field"><span>Neon API key</span><input type="password" required autoComplete="off" value={neon.apiKey}
                onChange={event => setNeon({ ...neon, apiKey: event.target.value })} /></label>
              <p className="st-muted">{t("在 Neon 控制台获取项目与分支 ID，并创建可管理该项目的 API key。试验会占用 Neon 分支与存储额度。")}</p>
            </div> : <p className="st-muted">{t("需要模拟改动时再启用。查询、血缘和记忆只需连接 URL。")}</p>}
          </>}
        </>}
        {error && <p role="alert" className="st-error">{systemMessage(error)}</p>}
        <div className="st-actions st-form-actions"><button className="st-button" type="button" onClick={onClose}>{t("取消")}</button>
          <button className="st-button st-primary" type="submit">{busy ? t("正在验证连接…") : t("连接并开始使用")}</button></div>
      </fieldset>
    </form>
  </ActionDialog>;
}

export function Connections({ api, data, refresh, projectAccess, onOpen, onChat, onCreate, onManage }: {
  api: Api; data: Snapshot; projectAccess?: ProjectAccess;
  refresh: () => Promise<Snapshot | undefined>;
  onOpen?: (environment: Environment) => void;
  onChat?: (environment: Environment) => Promise<void>;
  onCreate?: (connectionId: string) => void;
  onManage?: () => void;
}) {
  useLocale();
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState<{ text: string; values?: unknown[]; error?: boolean }>();
  const empty = !data.connections.length && !data.providers.length && !data.neonSources?.length;

  async function probe(id: string, name: string) {
    setBusy(id);
    setNotice(undefined);
    try {
      const target = await api('probe', { connectionId: id });
      setNotice({ text: "{0}连接成功。已访问 {1}。", values: [name, target.database] });
    } catch (error) { setNotice({ text: message(error), error: true }); }
    finally { setBusy(''); }
  }

  function saved(environment: Environment) {
    setAdding(false);
    setNotice({ text: "「{0}」已连接。回到这个项目的普通 DSH 对话，直接提问即可。", values: [environment.name] });
    void refresh().catch(error => setNotice({ text: message(error), error: true }));
  }

  function actions(environment?: Environment) {
    if (!environment) return null;
    if (environment.disabledAt) return <span className="st-status">{t("访问已停用")}</span>;
    return <>
      {onOpen && <button className="st-button" onClick={() => onOpen(environment)}>{t("查看数据目录")}</button>}
      {onChat && <button className="st-button" disabled={!!busy} onClick={async () => {
        setBusy(environment.id);
        try { await onChat(environment); }
        catch (error) { setNotice({ text: message(error), error: true }); }
        finally { setBusy(''); }
      }}>{t("在项目中提问")}</button>}
    </>;
  }

  return <section aria-label={t("数据连接")} className="st-stack">
    <div className="st-page-heading"><div><h2>{t("数据源")}</h2><p className="st-muted">{t("接入一次，在普通对话中查询。表关系、记忆和证据会留在这里。")}</p></div>
      {!empty && <div className="st-actions">{onManage && <button className="st-button" onClick={onManage}>{t("管理访问与资料")}</button>}<button className="st-button st-primary" onClick={() => setAdding(true)}>{t("添加数据源")}</button></div>}</div>
    {notice && <p role={notice.error ? 'alert' : 'status'} className={notice.error ? 'st-error' : 'st-notice'}>{notice.error ? systemMessage(notice.text) : t(notice.text, ...notice.values ?? [])}</p>}
    {empty ? <div className="st-empty"><h3>{t("连接第一个数据库")}</h3><p>{t("PostgreSQL 只需粘贴连接 URL。要在独立分支模拟改动，选择本机 Neon (Docker) 或 Stello。")}</p>
      <button className="st-button st-primary" onClick={() => setAdding(true)}>{t("添加数据源")}</button></div> : <div className="st-list">
      {data.connections.map(connection => {
        const environment = data.environments.find(environment => environment.connectionId === connection.id && !environment.parentEnvironmentId);
        const neon = connection.host.endsWith('.neon.tech');
        return <article className="st-list-row st-source-row" key={connection.id}>
          <div className="st-source-info"><h3>{connection.name}</h3>
            <p className="st-muted">{neon ? 'Neon' : 'PostgreSQL'} · {connection.database}</p>
            <p className="st-capability-line">{t("只读查询 · 血缘与记忆 · 查询证据")}</p>
            <details className="st-details"><summary>{t("连接详情")}</summary>
              <p className="st-path">{connection.user}@{connection.host}:{connection.port}/{connection.database}</p>
              <p className="st-path">{t("项目")}{connection.projectPath}</p>
            </details>
          </div>
          <div className="st-actions">{actions(environment)}<button className="st-button st-quiet" disabled={!!busy} onClick={() => void probe(connection.id, connection.name)}>
            {busy === connection.id ? t("测试中…") : t("测试连接")}</button>
            {!environment && onCreate && <button className="st-button" onClick={() => onCreate(connection.id)}>{t("启用查询")}</button>}
          </div>
        </article>;
      })}
      {(data.neonSources ?? []).map(source => {
        const environment = data.environments.find(item => item.neon?.providerId === source.id && !item.parentEnvironmentId);
        return <article className="st-list-row st-source-row" key={source.id}>
          <div className="st-source-info"><h3>{source.name}</h3><p className="st-muted">{environment?.neon?.local ? 'Neon (Docker)' : t("Neon 云端（实验性）")} · {source.database}</p>
            <p className="st-capability-line">{t("只读查询 · 血缘与记忆 · 独立试验")}</p>
            <details className="st-details"><summary>{t("连接详情")}</summary><p className="st-path">{t("项目")}{source.projectPath}</p>
              <p className="st-path">Neon {source.projectId} / {source.branchId}</p></details>
          </div><div className="st-actions">{actions(environment)}</div>
        </article>;
      })}
      {data.providers.map(source => {
        const environment = data.environments.find(item => item.stello?.providerId === source.id && !item.parentEnvironmentId);
        return <article className="st-list-row st-source-row" key={source.id}>
          <div className="st-source-info"><h3>{source.name}</h3><p className="st-muted">Stello · {source.resource}</p>
            <p className="st-capability-line">{t("只读查询 · 血缘与记忆 · 独立试验")}</p>
            <details className="st-details"><summary>{t("连接详情")}</summary><p className="st-path">{t("项目")}{source.projectPath}</p></details>
          </div><div className="st-actions">{actions(environment)}</div>
        </article>;
      })}
    </div>}
    {adding && <SourceForm api={api} projectAccess={projectAccess} onSaved={saved} onClose={() => setAdding(false)} />}
  </section>;
}
