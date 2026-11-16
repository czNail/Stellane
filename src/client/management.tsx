import { useEffect, useState, type FormEvent } from 'react';
import type { ManagementInput, ManagementView, ManagedSource, ManagedResource } from '../shared/management-models.ts';
import { ActionDialog, environmentLabel, message, type Api } from './workspace-ui.tsx';
import { t, systemMessage, useLocale } from './i18n.tsx';

const empty: ManagementView = { sources: [], resources: [], knowledge: [], definitions: [], notes: [] };
type Tab = 'sources' | 'resources' | 'memory';
type Confirmation = { source: ManagedSource; action: 'remove-source' | 'purge-source' | 'credentials' }
  | { resource: ManagedResource; action: 'remove-resource' };

export function ManagementPanel({ api, refresh, onActivity }: {
  api: Api; refresh: () => Promise<unknown>; onActivity: () => void;
}) {
  useLocale();
  const [view, setView] = useState(empty);
  const [tab, setTab] = useState<Tab>('sources');
  const [sourceFilter, setSourceFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirmation, setConfirmation] = useState<Confirmation>();
  useEffect(() => {
    let alive = true;
    void api('management', {}).then(result => { if (alive) setView(result); }, failure => { if (alive) setError(message(failure)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [api]);
  async function reload() {
    setError(''); setLoading(true);
    try { setView(await api('management', {})); }
    catch (failure) { setError(message(failure)); }
    finally { setLoading(false); }
  }
  async function manage(input: ManagementInput) {
    if (busy) return;
    setBusy('environmentId' in input ? input.environmentId : input.id);
    setError(''); setNotice('');
    try {
      setView(await api('manage', input));
      setConfirmation(undefined);
      setNotice('管理操作已完成。');
      await refresh();
    } catch (failure) {
      setError(message(failure));
      // Removal may have been admitted before its acknowledgement was lost.
      // Refresh that original request's state before offering the next action.
      try {
        const latest = await api('management', {}); setView(latest);
        if (confirmation?.action === 'remove-resource') {
          const resource = latest.resources.find(item => item.environment.id === confirmation.resource.environment.id);
          if (resource) setConfirmation({ action: 'remove-resource', resource });
        }
      } catch { /* Preserve the original error and request if state cannot be read. */ }
    }
    finally { setBusy(''); }
  }
  const sources = view.sources.filter(source => !sourceFilter || source.environmentId === sourceFilter);
  const resources = view.resources.filter(resource => !sourceFilter || resource.sourceEnvironmentId === sourceFilter);
  const knowledge = view.knowledge.filter(item => !sourceFilter || item.sourceEnvironmentId === sourceFilter);
  const definitions = view.definitions.filter(item => !sourceFilter || item.sourceEnvironmentId === sourceFilter);
  const sourceName = (id: string) => view.sources.find(source => source.environmentId === id)?.name ?? id;
  return <section className="st-stack" aria-label={t('管理与清理')}>
    <div className="st-page-heading"><div><h2>{t('管理与清理')}</h2>
      <p className="st-muted">{t('管理访问、保留资源和记忆。停止访问、删除本地资料、回收远端资源是不同操作。')}</p></div>
      <button className="st-button" disabled={loading || !!busy} onClick={() => void reload()}>{t('刷新')}</button></div>
    <nav className="st-tabs" aria-label={t('管理分类')}>
      <button aria-pressed={tab === 'sources'} onClick={() => setTab('sources')}>{t('访问与凭据')}</button>
      <button aria-pressed={tab === 'resources'} onClick={() => setTab('resources')}>{t('保留的分支')}</button>
      <button aria-pressed={tab === 'memory'} onClick={() => setTab('memory')}>{t('记忆与资料')}</button>
    </nav>
    <label className="st-field st-management-filter"><span>{t('数据源')}</span><select value={sourceFilter} onChange={event => setSourceFilter(event.target.value)}>
      <option value="">{t('全部数据源')}</option>{view.sources.map(source => <option key={source.environmentId} value={source.environmentId}>{source.name}</option>)}
    </select></label>
    {error && !confirmation && <p className="st-error" role="alert">{systemMessage(error)}</p>}
    {notice && <p className="st-notice" role="status">{t(notice)}</p>}
    {loading && <p role="status" className="st-muted">{t('正在读取管理信息…')}</p>}
    {tab === 'sources' && <div className="st-list">
      {!loading && !sources.length && <p className="st-list-empty">{t('暂无数据源。先在数据源页面连接数据库。')}</p>}
      {sources.map(source => <article className="st-list-row st-stack" key={source.environmentId}>
        <div className="st-row"><h3>{source.name}</h3><span className="st-status">{source.removed ? t('已移除连接') : source.enabled ? t('访问已启用') : t('访问已停用')}</span>
          <span className="st-muted">{source.provider === 'postgres' ? 'PostgreSQL' : source.provider === 'neon' ? source.local ? 'Neon (Docker)' : t('Neon 云端（实验性）') : 'Stello'}</span></div>
        <details className="st-details"><summary>{t('管理范围')}</summary><p className="st-path">{source.projectPath}</p>
          <p>{t('保留分支 {0} 个；插件管理的凭据 {1} 份。', source.retainedResources, source.managedCredentialCount)}</p></details>
        {!source.removed && <div className="st-actions">
          <button className="st-button" disabled={!!busy} onClick={() => void manage({ action: 'set-source-enabled', environmentId: source.environmentId, enabled: !source.enabled })}>
            {source.enabled ? t('停用访问') : t('启用访问')}</button>
          <button className="st-button" disabled={!!busy} onClick={() => { setError(''); setConfirmation({ source, action: 'credentials' }); }}>{t('更新凭据')}</button>
          <button className="st-button" disabled={!!busy || !source.canRemove} onClick={() => { setError(''); setConfirmation({ source, action: 'remove-source' }); }}>{t('移除本地连接')}</button>
        </div>}
        {!!source.blockedReasons.length && <ul className="st-reasons">{source.blockedReasons.map((reason, i) => <li key={i}>{systemMessage(reason)}</li>)}</ul>}
        <details className="st-details"><summary>{t('删除本地资料与历史')}</summary>
          <p>{t('这会删除此来源在 Stellane 中的记忆、定义和执行证据。先停用访问并处理保留资源；来源数据库不会被删除。')}</p>
          {!!source.purgeBlockedReasons.length && <ul className="st-reasons">{source.purgeBlockedReasons.map((reason, i) => <li key={i}>{systemMessage(reason)}</li>)}</ul>}
          <button className="st-button st-danger" disabled={!!busy || !source.canPurge} onClick={() => { setError(''); setConfirmation({ source, action: 'purge-source' }); }}>{t('删除本地资料与历史')}</button>
        </details>
      </article>)}
    </div>}
    {tab === 'resources' && <>
      <p className="st-muted">{t('结束实验通常会保留结果和共同基线。这里只回收 Stellane 创建的派生资源，来源数据库不能在这里删除。')}</p>
      {!loading && !resources.length && <p className="st-list-empty">{t('没有保留的派生资源。')}</p>}
      <div className="st-list">{resources.map(resource => <article className="st-list-row st-stack" key={resource.environment.id}>
        <div className="st-row"><h3>{resource.environment.name}</h3><span className="st-status">{environmentLabel(resource.environment)}</span></div>
        <p className="st-muted">{sourceName(resource.sourceEnvironmentId)} · {systemMessage(resource.retentionReason)}</p>
        {!!resource.dependentEnvironmentIds.length && <p className="st-muted">{t('依赖此资源的分支：')}{resource.dependentEnvironmentIds.map(id => view.resources.find(item => item.environment.id === id)?.environment.name ?? id).join(', ')}</p>}
        {!!resource.blockedReasons.length && <ul className="st-reasons">{resource.blockedReasons.map((reason, i) => <li key={i}>{systemMessage(reason)}</li>)}</ul>}
        <div className="st-actions"><button className="st-button st-danger" disabled={!!busy || !resource.canRemove} onClick={() => { setError(''); setConfirmation({ resource, action: 'remove-resource' }); }}>{resource.environment.resourceRemovalPendingAt ? t('核对回收') : t('回收此分支')}</button>
          {!resource.canRemove && <button className="st-button st-quiet" onClick={onActivity}>{t('查看任务与未决操作')}</button>}</div>
      </article>)}</div>
    </>}
    {tab === 'memory' && <>
      <p className="st-muted">{t('归档后不再用于新查询，历史证据仍保留，并释放可用记忆额度。需要彻底删除时，在访问与凭据中删除该来源的本地资料。')}</p>
      <h3>{t('关系记忆')}</h3>
      {!knowledge.length && !loading && <p className="st-list-empty">{t('暂无关系记忆。')}</p>}
      <div className="st-list">{knowledge.map(item => <article className="st-list-row st-source-row" key={item.id}>
        <div><h3 className="st-path">{item.label}</h3><p className="st-muted">{sourceName(item.sourceEnvironmentId)} · {t('版本')}{item.version}{item.archivedAt && <> · {t('已归档')}</>}</p></div>
        <button className="st-button" disabled={!!busy || !!item.archivedAt} onClick={() => void manage({ action: 'archive-knowledge', id: item.id })}>{t('归档，停止复用')}</button>
      </article>)}</div>
      <h3>{t('业务说明')}</h3>
      {!definitions.length && !loading && <p className="st-list-empty">{t('暂无业务说明。')}</p>}
      <div className="st-list">{definitions.map(item => <article className="st-list-row st-source-row" key={item.id}>
        <div><h3>{item.title}</h3><p className="st-muted">{sourceName(item.sourceEnvironmentId)} · {t('版本')}{item.version}{item.archivedAt && <> · {t('已归档')}</>}</p></div>
        <button className="st-button" disabled={!!busy || !!item.archivedAt} onClick={() => void manage({ action: 'archive-definition', id: item.id })}>{t('归档，停止复用')}</button>
      </article>)}</div>
    </>}
    <details className="st-details st-data-notice"><summary>{t('数据会保存在哪里？')}</summary>
      <p>{t('数据库凭据只由 DSH Host 使用。表结构、注释和查询结果可能作为工具结果进入当前对话，并发送给你在 DSH 配置的模型服务。')}</p>
      <p>{t('Stellane 在 Host 本地保存连接引用、SQL、结果预览、记忆及实验记录。卸载插件不会自动删除这些资料或远端分支。')}</p>
      <p>{t('在此停用访问、归档或删除本地资料；保留的分支须单独回收。DSH 对话、模型服务端记录和备份需要分别管理。')}</p>
    </details>
    {confirmation && <ManagementDialog action={confirmation} busy={!!busy} error={error} onClose={() => { setConfirmation(undefined); setError(''); }} onSubmit={manage} />}
  </section>;
}

function ManagementDialog({ action, busy, error, onClose, onSubmit }: {
  action: Confirmation; busy: boolean; error: string; onClose: () => void; onSubmit: (input: ManagementInput) => Promise<void>;
}) {
  useLocale();
  const [value, setValue] = useState('');
  const credentials = action.action === 'credentials';
  const checkingRemoval = action.action === 'remove-resource' && !!action.resource.environment.resourceRemovalPendingAt;
  const purge = action.action === 'purge-source';
  const name = 'source' in action ? action.source.name : action.resource.environment.name;
  const title = credentials ? t('更新凭据') : purge ? t('删除本地资料与历史') : action.action === 'remove-resource' ? checkingRemoval ? t('核对回收') : t('回收此分支') : t('移除本地连接');
  async function submit(event: FormEvent) {
    event.preventDefault(); if (busy) return;
    let input: ManagementInput;
    if (action.action === 'credentials') {
      const environmentId = action.source.environmentId;
      input = action.source.provider === 'postgres' ? { action: 'rotate-postgres', environmentId, connectionString: value }
        : action.source.provider === 'neon' ? { action: 'rotate-neon', environmentId, apiKey: value }
          : { action: 'replace-stello-config', environmentId, configPath: value };
    } else if (action.action === 'remove-resource') input = { action: 'remove-resource', environmentId: action.resource.environment.id };
    else if (action.action === 'purge-source') input = { action: 'purge-source', environmentId: action.source.environmentId, confirmation: value };
    else input = { action: 'remove-source', environmentId: action.source.environmentId };
    await onSubmit(input);
  }
  return <ActionDialog title={title} busy={busy} onClose={onClose}>
    <form className="st-stack" onSubmit={event => void submit(event)}>
      <strong>{name}</strong>
      {credentials && 'source' in action ? <>
        <p className="st-muted">{t('先验证新凭据，再替换本地引用。验证失败会保留原配置。数据库密码本身不会被修改。')}</p>
        {action.source.provider === 'postgres' && <p className="st-muted">{t('连接必须保留同一个主机、端口、数据库、用户、TLS 和通道绑定设置。更换来源请另行添加数据源。')}</p>}
        <label className="st-field"><span>{action.source.provider === 'postgres' ? t('新的连接 URL') : action.source.provider === 'neon' ? action.source.local ? t('本地 Neon 访问令牌') : 'Neon API key' : t('Stello 客户端配置')}</span>
          <input autoFocus required type={action.source.provider === 'stello' ? 'text' : 'password'} autoComplete="off" spellCheck={false} maxLength={16384} value={value} disabled={busy} onChange={event => setValue(event.target.value)} /></label>
      </> : purge ? <>
        <p>{t('永久删除此来源的本地记忆、定义、查询结果预览及历史证据，不能撤销。来源数据库和 DSH 对话历史不会被删除。')}</p>
        <label className="st-field"><span>{t('输入数据源名称以确认')}</span><input autoFocus required autoComplete="off" value={value} disabled={busy} onChange={event => setValue(event.target.value)} /></label>
      </> : action.action === 'remove-resource' ? <>
        <p>{checkingRemoval ? t('核对上次回收请求的结果。沿用同一资源身份和原请求，不会选择新的删除目标。') : t('删除这个派生分支的数据。来源数据库不受影响，已保存的本地执行证据仍保留。')}</p>
        <p className="st-muted">{t('删除时会再次核对资源身份和依赖；结果未知时保留原请求供核对。')}</p>
      </> : <p>{t('移除此来源的本地连接和插件管理的凭据，停止后续访问。历史证据会保留，来源数据库不会被修改。')}</p>}
      {error && <p className="st-error" role="alert">{systemMessage(error)}</p>}
      <div className="st-actions st-form-actions"><button className="st-button" type="button" disabled={busy} onClick={onClose}>{t('取消')}</button>
        <button className={`st-button ${credentials ? 'st-primary' : 'st-danger'}`} disabled={busy || (credentials && !value.trim()) || (purge && value !== name)}>
          {busy ? t('处理中…') : credentials ? t('验证并更新') : checkingRemoval ? t('核对回收') : t('确认操作')}</button></div>
    </form>
  </ActionDialog>;
}
