import { useEffect, useState } from 'react';
import type { Environment, Run } from '../shared/models.ts';
import { QueryResult, type Conversation } from './explore.tsx';
import { message, type Api } from './workspace-ui.tsx';

function displayProof(run: Run): Run {
  const row = run.preview?.rows[0];
  if (run.purpose !== 'knowledge' || !run.preview || !row) return run;
  const rows = [['来源', row.source], ['目标', row.target]].flatMap(([label, profile]) => {
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return [];
    return [{ 范围: String(label), 行数: profile.rows ?? null, 空键: profile.nullRows ?? null,
      重复键: profile.duplicateKeys ?? null, 未匹配: label === '来源' ? row.unmatched ?? null : null }];
  });
  return rows.length ? { ...run, preview: { ...run.preview,
    columns: ['范围', '行数', '空键', '重复键', '未匹配'], rows, rowCount: rows.length,
  } } : run;
}

export function RunEvidence({ id, api, environments, openEvidence, openConversation, onBack }: {
  id: string; api: Api; environments: Environment[]; openEvidence: (id: string) => void;
  openConversation: Conversation; onBack: () => void;
}) {
  const [run, setRun] = useState<Run>();
  const [failure, setFailure] = useState('');
  const [opening, setOpening] = useState(false);
  useEffect(() => {
    let usable = true;
    void api('runEvidence', { id }).then(next => { if (usable) setRun(next); }, error => { if (usable) setFailure(message(error)); });
    return () => { usable = false; };
  }, [api, id]);
  const environment = environments.find(item => item.id === run?.environmentId);
  const metric = run?.metric;
  async function tryRepair(from: Environment, source: Run) {
    setOpening(true);
    setFailure('');
    try {
      await openConversation(from.id, `为「${source.metric!.plan.name}」试算修复。指标执行记录 ${source.id}，环境 ${from.id}。请先让我说明要验证的修复规则，然后用这条指标记录发起独立分支实验，并比较归因覆盖率、分组及总量。`, { unbound: true });
    } catch (error) { setFailure(message(error)); }
    finally { setOpening(false); }
  }
  return <section className="st-stack" aria-label="执行证据">
    <button className="st-button st-quiet st-back" onClick={onBack}>← 任务与结果</button>
    <div className="st-page-heading"><div><h2>执行证据</h2>
      {run && <p className="st-muted">{environment?.name ?? run.branch?.resource ?? run.target?.database} · {new Date(run.startedAt).toLocaleString()}</p>}</div>
      {run && metric?.counts && metric.status !== 'complete' && environment?.stello && !environment.experimentId && environment.mode !== 'branch'
        && <button className="st-button st-primary" disabled={opening} onClick={() => void tryRepair(environment, run)}>试算修复</button>}</div>
    {failure && <p role="alert" className="st-error">{failure}</p>}
    {!run && !failure && <p role="status">正在读取执行记录…</p>}
    {run && <><p className="st-path">执行记录 {run.id}</p><QueryResult run={displayProof(run)} /></>}
    {metric && <section className="st-stack st-task-section" aria-label="指标口径与复核">
      <h3>口径与关系</h3>
      <p className="st-muted">口径版本 {metric.version.slice(0,12)}{metric.snapshot && <> · 数据快照 {metric.snapshot}</>}</p>
      <p>按 {metric.plan.groupColumn} 分组、计数
        {metric.plan.amountColumn && <>、对 {metric.plan.amountColumn} 求和</>}
        {metric.plan.filter && <> · {metric.plan.filter.column} = {String(metric.plan.filter.value)}</>}</p>
      {metric.plan.relationships.map((item,i)=> {
        const check = metric.checks?.[i];
        return <article key={item.id} className="st-list-row st-stack">
          <p className="st-path">{item.from.schema}.{item.from.table}（{item.from.columns.join('、')}） → {item.to.schema}.{item.to.table}（{item.to.columns.join('、')}）</p>
          {check && <p>{check.eligible} 条待匹配 · 缺少对应记录 {check.missing} 条 · 对应多条 {check.ambiguous} 条</p>}
          <div><button className="st-button" onClick={() => openEvidence(item.sourceRunId)}>查看关系原验证</button></div>
        </article>;
      })}
    </section>}
  </section>;
}
