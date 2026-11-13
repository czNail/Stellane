import { useEffect, useRef, useState } from 'react';
import type { CatalogView, DefinitionStatus, RelationMetadata, SemanticDefinition, SemanticDocument } from '../shared/context-models.ts';
import type { KnowledgeEndpoint, KnowledgeItem } from '../shared/knowledge-models.ts';
import type { Environment } from '../shared/models.ts';
import { DefinitionEditor, definitionKinds } from './catalog-editor.tsx';
import { ActionDialog, message, type Api } from './workspace-ui.tsx';

const tabs = { tables: '表与字段', definitions: '业务说明', relationships: '关系与血缘' };
type CatalogTab = keyof typeof tabs;
type Editor = { kind: 'form'; definition?: SemanticDefinition } | { kind: 'import' };
const endpointName = (endpoint: KnowledgeEndpoint) => `${endpoint.schema}.${endpoint.table}（${endpoint.columns.join('、')}）`;
export const knowledgeStatus = { declared: '数据库目录', observed: '数据观察', 'needs-check': '使用前核对', stale: '已失效', superseded: '历史版本' };

export function knowledgeLabel({ fact }: KnowledgeItem): string {
  if (fact.kind === 'view-lineage') return `${fact.downstream.schema}.${fact.downstream.table} ← ${fact.upstream.schema}.${fact.upstream.table}`;
  if (fact.kind === 'row-key') return `${endpointName(fact.target)} · 行键`;
  return `${endpointName(fact.from)} → ${endpointName(fact.to)}`;
}

function KnowledgeList({ items, search }: { items: KnowledgeItem[]; search: string }) {
  const matches = items.filter(item => knowledgeLabel(item).toLocaleLowerCase().includes(search));
  const current = matches.filter(item => item.status !== 'superseded' && item.status !== 'stale');
  const history = matches.filter(item => item.status === 'superseded' || item.status === 'stale');
  const render = (item: KnowledgeItem) => <details className="st-list-row st-catalog-item" key={item.id}>
    <summary><span>{knowledgeLabel(item)}</span><small>{item.fact.kind === 'join' && `${item.fact.cardinality === 'many-to-one' ? '多对一' : '一对一'} · `}{knowledgeStatus[item.status]}</small></summary>
    <div className="st-item-body">
      {item.fact.kind === 'view-lineage' ? <p>引用字段 {item.fact.upstream.columns.join('、') || '整表依赖'}</p>
        : item.fact.kind === 'row-key' ? <p>观测 {item.fact.profile.rows} 行 · 空键 {item.fact.profile.nullRows} 行 · 重复键 {item.fact.profile.duplicateKeys} 组</p>
          : <p>来源 {item.fact.source.rows} 行 · 目标 {item.fact.target.rows} 行 · 未匹配 {item.fact.unmatchedRows} 行</p>}
      {'reason' in item && item.reason && <p className="st-muted">{item.reason}</p>}
      <details className="st-details"><summary>验证证据</summary>
        <p className="st-path">{new Date(item.evidence.observedAt).toLocaleString()} · 执行 {item.evidence.runId}{'version' in item && ` · 版本 ${item.version}`}</p>
        {'invalidation' in item && item.invalidation && <p className="st-path">复核记录 {item.invalidation.evidence.runId}</p>}
      </details>
    </div>
  </details>;
  return <div className="st-stack">
    {current.length ? <div className="st-list">{current.map(render)}</div>
      : <p className="st-list-empty">{search ? '没有匹配的关系或血缘。' : '暂无已发现的关系。可以让 Agent 调查两张表的关联键或某个视图的来源。'}</p>}
    {history.length > 0 && <details className="st-details"><summary>历史与失效记录</summary><div className="st-list">{history.map(render)}</div></details>}
  </div>;
}

function TableList({ relations, search }: { relations: RelationMetadata[]; search: string }) {
  const matches = relations.filter(relation => [`${relation.schema}.${relation.name}`, relation.comment,
    ...relation.columns.flatMap(column => [column.name, column.comment])].some(value => value?.toLocaleLowerCase().includes(search)));
  if (!matches.length) return <p className="st-list-empty">{search ? '没有匹配的表或字段。' : '当前环境没有可读取的表。请检查连接权限。'}</p>;
  return <div className="st-list">{matches.map(relation => <details className="st-list-row st-catalog-item" key={relation.oid}>
    <summary><span className="st-object-name">{relation.schema}.{relation.name}</span><small>{relation.view ? '视图' : '表'} · {relation.columns.length} 个字段</small></summary>
    {relation.comment && <p className="st-item-body">{relation.comment}</p>}
    <div className="st-table-scroll"><table>
      <thead><tr><th scope="col">字段</th><th scope="col">类型</th><th scope="col">说明</th><th scope="col">可空</th></tr></thead>
      <tbody>{relation.columns.map(column => <tr key={column.ordinal}>
        <td>{column.name}</td><td>{column.type}</td><td>{column.comment ?? '—'}</td><td>{column.nullable ? '是' : '否'}</td>
      </tr>)}</tbody>
    </table></div>
    {(relation.constraints.length > 0 || relation.view || relation.columns.some(column => column.default)) && <details className="st-details st-item-body"><summary>结构详情</summary>
      {relation.constraints.map(constraint => <p className="st-path" key={constraint.name}>{constraint.definition}</p>)}
      {relation.columns.filter(column => column.default).map(column => <p className="st-path" key={column.ordinal}>{column.name} · 默认值 {column.default}</p>)}
      {relation.view && <pre className="st-code">{relation.view}</pre>}
    </details>}
  </details>)}</div>;
}

function DefinitionList({ versions, search, onEdit }: { versions: DefinitionStatus[]; search: string; onEdit: (definition: SemanticDefinition) => void }) {
  const matches = versions.filter(({ definition }) => [definition.title, definition.content, definition.source.name,
    ...definition.targets.map(target => `${target.schema}.${target.table}`)].some(value => value.toLocaleLowerCase().includes(search)));
  const current = matches.filter(item => item.status !== 'superseded');
  const history = matches.filter(item => item.status === 'superseded');
  const render = ({ definition, status, reason }: DefinitionStatus) => <details className="st-list-row st-catalog-item" key={definition.id}>
    <summary><span>{definition.title}</span><small>{definitionKinds[definition.kind]}{status === 'stale' && ' · 需更新'}{status === 'superseded' && ` · 版本 ${definition.version}`}</small></summary>
    <div className="st-item-body st-stack">
      <p className="st-content">{definition.content}</p>
      <p className="st-muted">适用 {definition.targets.map(target => target.columns.length ? endpointName(target) : `${target.schema}.${target.table}`).join('、')}</p>
      <p className="st-muted">来源 {definition.source.name}{definition.source.uri && ` · ${definition.source.uri}`}</p>
      {status === 'stale' && <p className="st-error">{reason}</p>}
      <details className="st-details"><summary>版本与证据</summary>
        {definition.sql && <pre className="st-code">{definition.sql}</pre>}
        <p className="st-path">版本 {definition.version} · {new Date(definition.createdAt).toLocaleString()}</p>
        <p className="st-path">{definition.key} · 执行 {definition.runId}</p>
      </details>
      {status !== 'superseded' && <div><button className="st-button" onClick={() => onEdit(definition)}>编辑说明</button></div>}
    </div>
  </details>;
  return <div className="st-stack">
    {current.length ? <div className="st-list">{current.map(render)}</div>
      : <p className="st-list-empty">{search ? '没有匹配的业务说明。' : '暂无业务说明。可以补充字段含义、指标口径或常用关联。'}</p>}
    {history.length > 0 && <details className="st-details"><summary>历史版本</summary><div className="st-list">{history.map(render)}</div></details>}
  </div>;
}

function ImportForm({ relation, busy, onSave, onClose }: {
  relation?: RelationMetadata; busy: boolean; onSave: (document: SemanticDocument) => Promise<void>; onClose: () => void;
}) {
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const file = useRef<HTMLInputElement>(null);
  function example() {
    setText(JSON.stringify({ source: { name: '业务词典' }, entries: [{ key: 'example.definition', title: '业务说明', kind: 'description',
      content: '填写含义与适用条件。', targets: [{ schema: relation?.schema ?? 'public', table: relation?.name ?? 'table_name' }], expectedVersion: 0 }] }, null, 2));
    setError('');
  }
  return <form className="st-stack" onSubmit={event => {
    event.preventDefault();
    let document: SemanticDocument;
    try { document = JSON.parse(text) as SemanticDocument; }
    catch { setError('JSON 格式不正确，请检查文档。'); return; }
    setError('');
    void onSave(document);
  }}>
    <div className="st-actions"><button className="st-button" type="button" disabled={busy} onClick={() => file.current?.click()}>选择 JSON 文件</button>
      <button className="st-button st-quiet" type="button" disabled={busy} onClick={example}>填入格式示例</button></div>
    <input ref={file} type="file" accept="application/json,.json" hidden onChange={event => {
      const selected = event.target.files?.[0];
      event.target.value = '';
      if (!selected) return;
      if (selected.size > 65536) { setError('文档超过 64 KiB。'); return; }
      setError('');
      void selected.text().then(setText).catch(error => setError(message(error)));
    }} />
    <label className="st-field"><span>语义文档 JSON</span><textarea rows={10} required disabled={busy} value={text} onChange={event => setText(event.target.value)} /></label>
    <p className="st-muted">新说明的 expectedVersion 填 0，更新已有说明时填写当前版本号。</p>
    {error && <p className="st-error" role="alert">{error}</p>}
    <div className="st-actions st-form-actions"><button className="st-button" type="button" disabled={busy} onClick={onClose}>取消</button>
      <button className="st-button st-primary" disabled={busy || !text.trim()}>{busy ? '导入中…' : '导入说明'}</button></div>
  </form>;
}

export function CatalogPanel({ api, environment, onExplore }: { api: Api; environment: Environment; onExplore: () => void }) {
  const [view, setView] = useState<CatalogView>();
  const [tab, setTab] = useState<CatalogTab>('tables');
  const [search, setSearch] = useState('');
  const [editor, setEditor] = useState<Editor>();
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');
  const environmentId = environment.id;

  useEffect(() => {
    let alive = true;
    void api('catalogView', { environmentId }).then(value => { if (alive) setView(value); })
      .catch(error => { if (alive) setError(message(error)); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [api, environmentId]);

  async function refresh() {
    setLoading(true);
    setError('');
    setFeedback('');
    try { setView(await api('catalogView', { environmentId })); }
    catch (error) { setError(message(error)); }
    finally { setLoading(false); }
  }

  async function save(document: SemanticDocument) {
    if (!view) return;
    setBusy(true);
    setError('');
    try {
      const result = await api('importCatalog', { environmentId, baseContextId: view.context.id, requestId: crypto.randomUUID(), document });
      setEditor(undefined);
      setSearch('');
      await refresh();
      setFeedback(`已保存 ${result.length} 条业务说明。`);
    } catch (error) { setError(message(error)); }
    finally { setBusy(false); }
  }

  const term = search.trim().toLocaleLowerCase();
  const closeEditor = () => { setEditor(undefined); setError(''); };
  return <section className="st-stack" aria-label="数据目录">
    <div className="st-page-heading"><div><h2>数据目录</h2><p className="st-muted">查表结构、业务口径、数据关系和视图来源。</p></div>
      <button className="st-button st-quiet" onClick={onExplore}>去探索</button></div>
    <nav className="st-tabs" aria-label="目录分类">{Object.entries(tabs).map(([key, label]) => <button key={key}
      aria-pressed={tab === key} onClick={() => { setTab(key as CatalogTab); setSearch(''); setFeedback(''); }}>{label}</button>)}</nav>
    <div className="st-catalog-toolbar">
      <input className="st-search" aria-label={`搜索${tabs[tab]}`} placeholder={tab === 'tables' ? '搜索表名、字段或注释' : `搜索${tabs[tab]}`}
        type="search" value={search} onChange={event => setSearch(event.target.value)} disabled={!view} />
      <div className="st-actions"><button className="st-button st-quiet" disabled={loading || busy} onClick={() => void refresh()}>{loading ? '读取中…' : '刷新目录'}</button>
        {tab === 'definitions' && view && <>
          <button className="st-button" onClick={() => { setError(''); setEditor({ kind: 'import' }); }}>导入 JSON</button>
          <button className="st-button st-primary" disabled={!view.relations.length} onClick={() => { setError(''); setEditor({ kind: 'form' }); }}>添加说明</button>
        </>}
      </div>
    </div>
    {error && !editor && <p className="st-error" role="alert">{error}</p>}
    {feedback && <p className="st-notice" role="status">{feedback}</p>}
    {loading && !view && <p className="st-loading" role="status">正在读取目录…</p>}
    {view && <>
      {tab === 'tables' && <TableList relations={view.relations} search={term} />}
      {tab === 'definitions' && <DefinitionList versions={view.versions} search={term} onEdit={definition => { setError(''); setEditor({ kind: 'form', definition }); }} />}
      {tab === 'relationships' && <KnowledgeList items={view.knowledge} search={term} />}
      <details className="st-details st-catalog-audit"><summary>目录来源</summary>
        <p className="st-path">{view.context.state.target.database} · {new Date(view.context.state.observedAt).toLocaleString()}</p>
        <p className="st-path">环境 {view.context.environmentId} · 执行 {view.context.runId}</p>
        {view.context.state.branch && <p className="st-path">{view.context.state.branch.resource} · 来源位置 {view.context.state.branch.forkLsn}</p>}
        {view.context.state.dataVersion.position && <p className="st-path">固定位置 {view.context.state.dataVersion.position}</p>}
        <p className="st-path">结构指纹 {view.context.schemaFingerprint} · 目录指纹 {view.context.catalogFingerprint}</p>
      </details>
    </>}
    {editor && view && <ActionDialog title={editor.kind === 'import' ? '导入业务说明' : editor.definition ? '编辑业务说明' : '添加业务说明'} busy={busy} onClose={closeEditor}>
      {error && <p className="st-error" role="alert">{error}</p>}
      {editor.kind === 'import' ? <ImportForm relation={view.relations[0]} busy={busy} onSave={save} onClose={closeEditor} />
        : <DefinitionEditor definition={editor.definition} relations={view.relations} busy={busy} onSave={save} onCancel={closeEditor} />}
    </ActionDialog>}
  </section>;
}
