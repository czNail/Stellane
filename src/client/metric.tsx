import type { MetricEvidence } from '../shared/metric-models.ts';
import type { Run } from '../shared/models.ts';

export const metricStatus = { complete: '完整覆盖', partial: '部分覆盖', unverified: '待核实' };

export function MetricSummary({ metric }: { metric: MetricEvidence }) {
  const { status, counts, reason, plan } = metric;
  return <div className="st-stack st-metric-summary">
    <div className="st-row"><strong>{plan.name}</strong><span className={`st-status ${status === 'unverified' ? 'st-unknown' : ''}`}>{metricStatus[status]}</span></div>
    {counts && <p>{counts.total} 条记录中，{counts.attributed} 条已归因，<strong>{counts.unattributed} 条未归因</strong>
      {plan.amountColumn && <> · 未归因合计 <strong>{counts.unattributedAmount}</strong></>}</p>}
    {reason && <p className="st-error">{reason}</p>}
  </div>;
}

export function MetricComparison({ before, after, openEvidence }: { before: Run; after?: Run; openEvidence: (id: string) => void }) {
  const beforeCounts = before.metric?.counts;
  const afterCounts = after?.metric?.counts;
  if (!before.metric || !beforeCounts) return null;
  const measurable = !!before.metric.plan.amountColumn;
  const groups = new Map<string | null, { before?: string; after?: string; beforeAmount?: string; afterAmount?: string }>();
  for (const [side, run] of [['before', before], ['after', after]] as const) {
    for (const row of run?.preview?.rows ?? []) {
      const name = row.归属;
      if (name !== null && typeof name !== 'string') continue;
      const entry = groups.get(name) ?? {};
      entry[side] = String(row.记录数);
      entry[side === 'before' ? 'beforeAmount' : 'afterAmount'] = String(row.合计 ?? '0');
      groups.set(name, entry);
    }
  }
  return <section className="st-stack st-task-section" aria-label="修复前后指标">
    <h3>修复前后指标</h3>
    <div className="st-row"><span>固定基线 {beforeCounts.attributed} / {beforeCounts.total} 条已归因</span>
      <button className="st-button" onClick={() => openEvidence(before.id)}>查看基线证据</button></div>
    {after && after.metric && afterCounts && <>
      <div className="st-row"><span>固定结果 {afterCounts.attributed} / {afterCounts.total} 条已归因 · {metricStatus[after.metric.status]}</span>
        <button className="st-button" onClick={() => openEvidence(after.id)}>查看结果证据</button></div>
      <p>全量记录 {beforeCounts.total} → {afterCounts.total}
        {measurable && <> · 总合计 {beforeCounts.totalAmount} → {afterCounts.totalAmount}</>}
        {before.metric.status !== 'unverified' && after.metric.status !== 'unverified' && beforeCounts.total === afterCounts.total
          && (!measurable || beforeCounts.totalAmount === afterCounts.totalAmount) && <> · 总量一致</>}</p>
      <div className="st-table-scroll"><table><thead><tr><th scope="col">归属</th><th scope="col">基线记录数</th><th scope="col">结果记录数</th>
        {measurable && <><th scope="col">基线合计</th><th scope="col">结果合计</th></>}</tr></thead><tbody>
        {[...groups].map(([name, row])=><tr key={JSON.stringify(name)}><th scope="row">{name ?? '未归因'}</th>
          <td>{row.before ?? (before.preview?.truncated ? '—' : '0')}</td><td>{row.after ?? (after.preview?.truncated ? '—' : '0')}</td>
          {measurable && <><td>{row.beforeAmount ?? (before.preview?.truncated ? '—' : '0')}</td>
            <td>{row.afterAmount ?? (after.preview?.truncated ? '—' : '0')}</td></>}</tr>)}
      </tbody></table></div>
    </>}
  </section>;
}
