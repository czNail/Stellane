import { useState } from 'react';
import type { RelationMetadata, SemanticDefinition, SemanticDocument } from '../shared/context-models.ts';

export const definitionKinds = { description: '业务说明', metric: '指标口径', relationship: '数据关系', 'sql-example': 'SQL 示例' };
type Target = SemanticDefinition['targets'][number];
const relationKey = (target: { schema: string; table: string }) => JSON.stringify([target.schema, target.table]);

export function DefinitionEditor({ definition, relations, busy, onSave, onCancel }: {
  definition?: SemanticDefinition; relations: RelationMetadata[]; busy: boolean;
  onSave: (document: SemanticDocument) => Promise<void>; onCancel: () => void;
}) {
  const [title, setTitle] = useState(definition?.title ?? '');
  const [kind, setKind] = useState<SemanticDefinition['kind']>(definition?.kind ?? 'description');
  const [content, setContent] = useState(definition?.content ?? '');
  const [source, setSource] = useState(definition?.source.name ?? '手动录入');
  const [uri, setUri] = useState(definition?.source.uri ?? '');
  const [sql, setSql] = useState(definition?.sql ?? '');
  const [key] = useState(definition?.key ?? `definition.${crypto.randomUUID()}`);
  const [targets, setTargets] = useState<Target[]>(definition?.targets ?? [{ schema: '', table: '', columns: [] }]);
  const invalidTargets = targets.some(target => {
    const relation = relations.find(item => item.schema === target.schema && item.name === target.table);
    return !relation || target.columns.some(name => !relation.columns.some(column => column.name === name));
  });
  function updateTarget(index: number, target: Target) {
    setTargets(current => current.map((item, position) => position === index ? target : item));
  }
  return <form className="st-definition-form" onSubmit={event => {
    event.preventDefault();
    void onSave({ source: { name: source.trim(), ...(uri.trim() ? { uri: uri.trim() } : {}) }, entries: [{
      key, title: title.trim(), kind, content: content.trim(), targets,
      ...(sql.trim() ? { sql: sql.trim() } : {}), expectedVersion: definition?.version ?? 0,
    }] });
  }}>
    <fieldset disabled={busy}>
      <div className="st-editor-grid">
        <label className="st-field"><span>说明名称</span><input required maxLength={120} value={title} onChange={event => setTitle(event.target.value)} placeholder="例如：净收入的计算口径" /></label>
        <label className="st-field"><span>说明类型</span><select value={kind} onChange={event => setKind(event.target.value as typeof kind)}>
          {Object.entries(definitionKinds).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
        </select></label>
      </div>
      <label className="st-field"><span>含义与计算口径</span><textarea className="st-prose-input" required rows={4} maxLength={4000} value={content} onChange={event => setContent(event.target.value)} placeholder="写清字段代表什么、包含哪些记录、如何计算、单位是什么，以及需要注意的条件。" /></label>
      <div className="st-editor-targets">
        <p className="st-field-label">适用的数据表</p>
        {targets.map((target, index) => {
          const relation = relations.find(item => item.schema === target.schema && item.name === target.table);
          const missing = !!target.table && !relation;
          return <div className="st-editor-target" key={index}>
            <div className="st-target-picker">
              <label className="st-field"><span>{targets.length > 1 ? `数据表 ${index + 1}` : '选择数据表'}</span>
                <select required value={target.table ? relationKey(target) : ''} onChange={event => {
                  const [schema, table] = JSON.parse(event.target.value) as [string, string];
                  updateTarget(index, { schema, table, columns: [] });
                }}>
                  <option value="" disabled>选择这条说明适用的表</option>
                  {missing && <option value={relationKey(target)} disabled>{target.schema}.{target.table}（已不可访问，请重新选择）</option>}
                  {relations.map(item => <option key={item.oid} value={relationKey({ schema: item.schema, table: item.name })}>{item.schema}.{item.name}</option>)}
                </select>
              </label>
              {targets.length > 1 && <button className="st-button" type="button" onClick={() => setTargets(current => current.filter((_, position) => position !== index))}>移除关联</button>}
            </div>
            {relation && <details><summary>指定字段（可选）{target.columns.length ? ` · 已选 ${target.columns.length} 个` : ' · 默认关联整张表'}</summary>
              <p className="st-muted">最多选择 64 个字段。不选则关联整张表。</p>
              <div className="st-column-choices">
                {[...relation.columns.map(column => column.name), ...target.columns.filter(name => !relation.columns.some(column => column.name === name))].map(name => {
                  const available = relation.columns.some(column => column.name === name);
                  return <label key={name}><input type="checkbox" checked={target.columns.includes(name)} disabled={!target.columns.includes(name) && target.columns.length >= 64}
                    onChange={event => updateTarget(index, { ...target, columns: event.target.checked ? [...target.columns, name] : target.columns.filter(column => column !== name) })} />
                    {name}{!available && <span className="st-error">（字段已不存在，请取消）</span>}</label>;
                })}
              </div>
            </details>}
          </div>;
        })}
        {targets.length < 8 && <button className="st-button" type="button" onClick={() => setTargets(current => [...current, { schema: '', table: '', columns: [] }])}>再关联一张表</button>}
      </div>
      <label className="st-field"><span>说明来源</span><input required maxLength={200} value={source} onChange={event => setSource(event.target.value)} placeholder="例如：团队指标词典、财务口径文档" /></label>
      <details className="st-editor-options"><summary>补充 SQL 示例或文档位置（可选）</summary>
        <label className="st-field"><span>SQL 示例</span><textarea rows={3} maxLength={16384} value={sql} onChange={event => setSql(event.target.value)} placeholder="供 Agent 参考的 SQL；保存时不会执行。" /></label>
        <label className="st-field"><span>文档位置</span><input maxLength={1024} value={uri} onChange={event => setUri(event.target.value)} placeholder="文档路径或链接，仅作来源引用" /></label>
      </details>
      <p className="st-muted">保存后，Agent 可按问题检索这条说明。{definition ? '修改会保留历史版本。' : '系统会自动记录版本和来源。'}</p>
      <div className="st-actions"><button className="st-button st-primary" disabled={busy || !title.trim() || !content.trim() || !source.trim() || invalidTargets}>
        {busy ? '保存中…' : definition ? '保存更新' : '保存业务说明'}</button><button className="st-button" type="button" onClick={onCancel}>取消</button></div>
    </fieldset>
  </form>;
}
