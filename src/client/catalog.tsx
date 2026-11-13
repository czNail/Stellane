import { useCallback, useEffect, useRef, useState } from 'react';
import type { Api } from './index.tsx';
import type { Environment } from '../shared/models.ts';
import type { CatalogView, ContextResult, SemanticDefinition, SemanticDocument } from '../shared/context-models.ts';
import { DefinitionEditor, definitionKinds } from './catalog-editor.tsx';

const message = (error: unknown) => error instanceof Error ? error.message : '操作失败。';
type Editor = { id: string; mode: 'form' | 'json'; definition?: SemanticDefinition };

export function CatalogPanel({ api, environments, environmentId, onSelect, openConversation, onSetup }: {
  api: Api; environments: Environment[]; environmentId?: string; onSelect: (id: string) => void;
  openConversation: (workspaceId: string, prompt: string) => void; onSetup: () => void;
}) {
  const [view, setView] = useState<CatalogView>();
  const [result, setResult] = useState<ContextResult>();
  const [query, setQuery] = useState('');
  const [document, setDocument] = useState('');
  const [editor, setEditor] = useState<Editor>();
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const editorRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const load = useCallback(async () => {
    if (!environmentId) return;
    const next = await api('catalogView', { environmentId });
    setView(next); return next;
  }, [api, environmentId]);

  useEffect(() => {
    let alive = true;
    setView(undefined); setResult(undefined); setEditor(undefined); setQuery(''); setDocument(''); setError(''); setFeedback('');
    setLoading(!!environmentId);
    if (environmentId) void api('catalogView', { environmentId }).then(value => { if (alive) setView(value); })
      .catch(error => { if (alive) setError(message(error)); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [api, environmentId]);
  useEffect(() => { if (editor) editorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, [editor?.id]);

  async function action(work: () => Promise<void>) {
    setBusy(true); setError(''); setFeedback('');
    try { await work(); } catch (error) { setError(message(error)); } finally { setBusy(false); }
  }
  const current = view?.versions.filter(item => item.status !== 'superseded') ?? [];
  const history = view?.versions.filter(item => item.status === 'superseded') ?? [];
  const usable = current.filter(item => item.status === 'applicable').length;
  const stale = current.length - usable;
  const stateLabel = view?.context.state.dataVersion.kind === 'fixed-position' ? '固定切面' : view?.context.state.mode === 'branch' ? '可写分支' : '实时库';

  function edit(mode: Editor['mode'], definition?: SemanticDefinition) {
    setError(''); setFeedback(''); setEditor({ id: crypto.randomUUID(), mode, definition });
  }
  async function save(document: SemanticDocument) {
    await action(async () => {
      const imported = await api('importCatalog', { environmentId: environmentId!, baseContextId: view!.context.id, requestId: crypto.randomUUID(), document });
      setEditor(undefined); setResult(undefined);
      try { await load(); setFeedback(`已保存 ${imported.length} 条业务说明，Agent 查询时可按需读取。`); }
      catch { setFeedback('业务说明已保存。目录刷新失败，请点击「重新检查」查看最新状态。'); }
    });
  }
  function template() {
    const relation = view?.relations[0];
    setDocument(JSON.stringify({ source: { name: '业务词典', uri: 'docs/data-dictionary' }, entries: [{ key: 'example.definition', title: '业务定义名称', kind: 'description',
      content: '填写含义、单位和适用条件。', targets: [{ schema: relation?.schema ?? 'public', table: relation?.name ?? 'table_name', columns: [] }], expectedVersion: 0 }] }, null, 2));
  }
  function definitionCard(item: CatalogView['versions'][number]) {
    const definition = item.definition;
    const isHistory = item.status === 'superseded';
    return <article className="st-definition" key={definition.id}>
      <div className="st-section-heading"><h3>{definition.title}</h3>
        <span className={`st-status ${item.status === 'stale' ? 'st-failed' : ''}`}>{item.status === 'applicable' ? '核对通过' : item.status === 'stale' ? '需要更新' : '历史版本'}</span></div>
      <p className="st-muted">{definitionKinds[definition.kind]} · 版本 {definition.version}</p>
      <p className="st-definition-content">{definition.content}</p>
      <p className="st-path">适用表：{definition.targets.map(target => `${target.schema}.${target.table}${target.columns.length ? `（${target.columns.join('、')}）` : ''}`).join('；')}</p>
      <p className="st-muted">来源：{definition.source.name}</p>
      {item.status === 'stale' && <p className="st-error">{item.reason} Agent 获取资料时会排除这条说明，请核对内容后重新保存。</p>}
      <div className="st-definition-footer">
        <details><summary>查看{definition.sql ? ' SQL、' : ''}来源与版本</summary>
          {definition.sql && <><p className="st-muted">供 Agent 参考的 SQL，保存时未执行。</p><pre className="st-code">{definition.sql}</pre></>}
          <p className="st-path">{definition.source.uri && <>文档位置 {definition.source.uri}<br /></>}
            保存于 {new Date(definition.createdAt).toLocaleString()} · {definition.author.id}<br />
            定义标识 {definition.key}<br />上下文 {definition.contextId}<br />元数据执行 {definition.runId}</p>
        </details>
        {!isHistory && <button className="st-button" disabled={busy} onClick={() => edit('form', definition)}>编辑说明</button>}
      </div>
    </article>;
  }
  return <section className="st-catalog" aria-label="语义目录">
    <div className="st-catalog-intro">
      <h2>给 Agent 一份业务说明书</h2>
      <p>补充字段的业务含义、指标怎么算、表之间怎样关联。Agent 查询时会按需读取这些说明，再编写 SQL 验证。</p>
      <ol className="st-catalog-steps">
        <li><span>1</span><div><strong>选择数据</strong><p>自动读取表结构与字段注释</p></div></li>
        <li><span>2</span><div><strong>补充业务说明</strong><p>写清含义、计算口径和来源</p></div></li>
        <li><span>3</span><div><strong>向 Agent 提问</strong><p>按业务口径查询，得到有依据的答案</p></div></li>
      </ol>
    </div>
    <div className="st-catalog-source">
      <label className="st-field"><span>使用哪个数据环境</span><select value={environmentId ?? ''} disabled={busy || loading || !environments.length} onChange={event => onSelect(event.target.value)}>
        {!environments.length && <option value="">尚未配置数据环境</option>}
        {environments.map(environment => <option key={environment.id} value={environment.id}>{environment.name}</option>)}
      </select></label>
      {view && <p className="st-catalog-counts"><strong>{view.relations.length}</strong> 张表 / 视图<span>·</span><strong>{usable}</strong> 条说明核对通过{stale > 0 && <><span>·</span><strong className="st-error">{stale} 条需要更新</strong></>}</p>}
      <button className="st-button" disabled={busy || loading || !environmentId} onClick={() => void action(async () => {
        await load(); setResult(undefined); setFeedback('已重新读取表结构，并检查业务说明是否仍然适用。');
      })}>重新检查</button>
    </div>
    {loading && <p role="status" className="st-muted">正在读取表结构和已有说明…</p>}
    {!environmentId && <div className="st-catalog-empty"><h3>先选择要查询的数据</h3><p>连接 PostgreSQL 或 Stello 并创建环境后，表和字段会自动出现在这里。</p><button className="st-button st-primary" onClick={onSetup}>设置数据环境</button></div>}
    {!editor && error && <p className="st-error" role="alert">{error}</p>}
    {feedback && <p className="st-feedback" role="status">{feedback}</p>}
    {view && <>
      <div className="st-catalog-columns">
        <div className="st-catalog-library">
          <section className="st-catalog-definitions" aria-label="业务说明">
            <div className="st-section-heading"><div><h2>业务说明 <small>{current.length}</small></h2><p className="st-muted">补充数据库结构中没有写清的业务知识。</p></div>
              <button className="st-button" disabled={busy || !view.relations.length} onClick={() => edit('form')}>添加业务说明</button></div>
            {current.map(definitionCard)}
            {!current.length && <div className="st-catalog-empty"><h3>表结构已读取，还可以补充业务口径</h3><p>例如：某字段是什么单位、指标是否包含退款、两张表应该如何关联。补充后，Agent 可以据此选择正确的查询方法。</p></div>}
            <div className="st-library-actions">
              {history.length > 0 && <details className="st-catalog-history"><summary>历史版本 · {history.length}</summary>{history.map(definitionCard)}</details>}
              <button className="st-button st-quiet-button" disabled={busy} onClick={() => edit('json')}>批量导入 JSON</button>
            </div>
          </section>
          {editor && <div className="st-catalog-editor" ref={editorRef}>
            <h2>{editor.mode === 'json' ? '批量导入业务说明' : editor.definition ? '编辑业务说明' : '添加业务说明'}</h2>
            {editor.mode === 'form' ? <DefinitionEditor key={editor.id} definition={editor.definition} relations={view.relations} busy={busy} onSave={save} onCancel={() => { setEditor(undefined); setError(''); }} /> : <>
              <p className="st-muted">一次导入多条说明。新定义的 expectedVersion 填 0，更新填当前版本号；也可以取消后使用表单逐条添加。</p>
              <div className="st-actions"><button className="st-button" disabled={busy} onClick={template}>填入 JSON 格式示例</button>
                <button className="st-button" disabled={busy} onClick={() => fileRef.current?.click()}>选择 JSON 文件</button>
                <input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={event => {
                  const file = event.target.files?.[0]; if (!file) return;
                  if (file.size > 65536) { setError('文档超过 64 KiB。'); return; }
                  void file.text().then(setDocument).catch(error => setError(message(error)));
                  event.target.value = '';
                }} /></div>
              <form onSubmit={event => {
                event.preventDefault();
                let parsed: SemanticDocument;
                try { parsed = JSON.parse(document) as SemanticDocument; } catch { setError('JSON 格式不正确，请检查后重试。'); return; }
                void save(parsed);
              }}>
                <label className="st-field"><span>语义文档 JSON</span><textarea rows={12} required disabled={busy} value={document} onChange={event => setDocument(event.target.value)} /></label>
                <div className="st-actions"><button className="st-button st-primary" disabled={busy || !document.trim()}>{busy ? '导入中…' : '导入业务说明'}</button>
                  <button className="st-button" type="button" disabled={busy} onClick={() => { setEditor(undefined); setError(''); }}>取消</button></div>
              </form>
            </>}
            {error && <p className="st-error" role="alert">{error}</p>}
          </div>}
          <section className="st-catalog-objects">
            <h2>数据库里有哪些表 <small>{view.relations.length}</small></h2><p className="st-muted">从数据库自动读取，展开可查看字段、注释和关联约束。</p>
            {view.relations.map(relation => <details key={relation.oid}><summary>{relation.schema}.{relation.name} <small>· {relation.columns.length} 个字段</small>{relation.comment && ` · ${relation.comment}`}</summary>
              <div className="st-table-scroll"><table><thead><tr><th>字段</th><th>类型</th><th>数据库注释</th><th>可空 / 默认值</th></tr></thead>
                <tbody>{relation.columns.map(column => <tr key={column.ordinal}><td>{column.name}</td><td>{column.type}</td><td>{column.comment ?? '未填写'}</td><td>{column.nullable ? '可空' : '不可空'} / {column.default ?? '无'}</td></tr>)}</tbody></table></div>
              {relation.constraints.map(constraint => <p className="st-path" key={constraint.name}>{constraint.name}：{constraint.definition}</p>)}
              {relation.view && <pre className="st-code">{relation.view}</pre>}
            </details>)}
            {!view.relations.length && <p className="st-muted">当前数据库用户没有可读取的表，请检查连接权限。</p>}
          </section>
        </div>
        <section className="st-context-search" aria-label="向 Agent 提问">
          <h2>用这些说明问 Agent</h2><p className="st-catalog-help">描述你想查什么，Agent 会先找相关说明，再用只读 SQL 查询数据。</p>
          <form onSubmit={event => {
            event.preventDefault(); void action(async () => {
              const workspace = await api('prepareConversation', { environmentId: environmentId! });
              openConversation(workspace.workspaceId, `请在 Stellane 环境 ${environmentId} 调查以下业务问题。先调用 stellane_context 获取当前适用的表结构与业务定义，再自行编写只读 SQL 并使用 stellane_query 验证。根据实际结果回答，引用定义版本、文档来源和执行证据。\n\n${query}`);
            });
          }}>
            <label className="st-field"><span>你的业务问题</span><textarea className="st-prose-input" required maxLength={200} rows={3} value={query} onChange={event => { setQuery(event.target.value); setResult(undefined); }} placeholder="例如：按业务口径汇总各组的指标值，并解释计算方法。" /></label>
            <div className="st-actions"><button className="st-button st-primary" disabled={busy || !query.trim()}>去对话中提问 →</button>
              <button className="st-button" type="button" disabled={busy} onClick={() => void action(async () => {
                setResult(await api('context', { environmentId: environmentId!, query, previousContextId: view.context.id }));
              })}>预览参考资料</button></div>
            <p className="st-muted">打开新对话后，发送问题即可开始查询。</p>
          </form>
          {result && <div className="st-context-preview" role="status">
            <h3>这次找到的参考资料</h3><p className="st-muted">这里只预览资料；查询结果将在对话中给出。</p>
            <p>{result.definitions.length} 条业务说明 · {result.relations.length} 张表 / 视图</p>
            {result.changes?.structureChanged && <p className="st-error">数据库结构或目标已变化，请重新检查目录。</p>}
            {result.changes?.definitionsChanged && <p>业务说明已有更新，本次使用最新适用版本。</p>}
            {result.definitions.map(item => <div className="st-preview-definition" key={item.id}><strong>{item.title}</strong><p>{item.content}</p><small>来源：{item.source.name} · 版本 {item.version}</small></div>)}
            {!result.definitions.length && <p>未找到匹配的业务说明。可补充说明，或用表名、字段名再试一次。</p>}
            <p className="st-path">相关表：{result.relations.map(item => `${item.schema}.${item.name}`).join('、') || '无匹配'}</p>
            {result.excluded.map(item => <p className="st-error" key={item.key}>{item.key} 的旧说明已排除：{item.reason}</p>)}
            <details><summary>检索记录</summary><p className="st-path">上下文 {result.context.id}<br />元数据执行 {result.context.runId}</p></details>
          </div>}
        </section>
      </div>
      <details className="st-catalog-audit"><summary>数据来源与校验详情 · {stateLabel} · {new Date(view.context.state.observedAt).toLocaleTimeString()}</summary>
        <p className="st-muted">“核对通过”表示关联表结构与导入时匹配，说明内容来自所标注的来源。实时库与可写分支的数据仍可能变化。</p>
        <p className="st-path">实际数据库 {view.context.state.target.database}<br />数据源 {view.context.dataSourceId}<br />环境 {view.context.environmentId}<br />结构 {view.context.schemaFingerprint}<br />语义目录 {view.context.catalogFingerprint}<br />元数据执行 {view.context.runId}</p>
        {view.context.state.dataVersion.position && <p className="st-path">固定位置 {view.context.state.dataVersion.position}</p>}
        {view.context.state.branch && <p className="st-path">分支 {view.context.state.branch.resource} · {view.context.state.branch.resourceId}<br />来源位置 {view.context.state.branch.forkLsn}</p>}
      </details>
    </>}
  </section>;
}
