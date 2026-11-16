import { t, systemMessage, useLocale, labels as localizedLabels } from './i18n.tsx';
import type { MetricEvidence } from '../shared/metric-models.ts';
import type { Run } from '../shared/models.ts';

export const metricStatus = localizedLabels({ complete: '完整覆盖', partial: '部分覆盖', unverified: '待核实' });

export function MetricSummary({ metric }: { metric: MetricEvidence }) {
  useLocale();
  const { status, counts, reason, plan } = metric;
  return <div className="st-stack st-metric-summary">
    <div className="st-row"><strong>{plan.name}</strong><span className={`st-status ${status === 'unverified' ? 'st-unknown' : ''}`}>{metricStatus[status]}</span></div>
    {counts && <p>{counts.total} {t("条记录中，")}{counts.attributed} {t("条已归因，")}<strong>{counts.unattributed} {t("条未归因")}</strong>
      {plan.amountColumn && <> {t("· 未归因合计")}<strong>{counts.unattributedAmount}</strong></>}</p>}
    {reason && <p className="st-error">{systemMessage(reason)}</p>}
  </div>;
}

export function MetricComparison({ before, after, openEvidence }: { before: Run; after?: Run; openEvidence: (id: string) => void }) {
  useLocale();
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
  return <section className="st-stack st-task-section" aria-label={t("修复前后指标")}>
    <h3>{t("修复前后指标")}</h3>
    <div className="st-row"><span>{t("基线")}{beforeCounts.attributed} / {beforeCounts.total} {t("条已归因")}</span>
      <button className="st-button" onClick={() => openEvidence(before.id)}>{t("查看基线证据")}</button></div>
    {after && after.metric && afterCounts && <>
      <div className="st-row"><span>{t("结果")}{afterCounts.attributed} / {afterCounts.total} {t("条已归因 ·")}{metricStatus[after.metric.status]}</span>
        <button className="st-button" onClick={() => openEvidence(after.id)}>{t("查看结果证据")}</button></div>
      <p>{t("全量记录")}{beforeCounts.total} → {afterCounts.total}
        {measurable && <> {t("· 总合计")}{beforeCounts.totalAmount} → {afterCounts.totalAmount}</>}
        {before.metric.status !== 'unverified' && after.metric.status !== 'unverified' && beforeCounts.total === afterCounts.total
          && (!measurable || beforeCounts.totalAmount === afterCounts.totalAmount) && <> {t("· 总量一致")}</>}</p>
      <div className="st-table-scroll"><table><thead><tr><th scope="col">{t("归属")}</th><th scope="col">{t("基线记录数")}</th><th scope="col">{t("结果记录数")}</th>
        {measurable && <><th scope="col">{t("基线合计")}</th><th scope="col">{t("结果合计")}</th></>}</tr></thead><tbody>
        {[...groups].map(([name, row])=><tr key={JSON.stringify(name)}><th scope="row">{name ?? t("未归因")}</th>
          <td>{row.before ?? (before.preview?.truncated ? '—' : '0')}</td><td>{row.after ?? (after.preview?.truncated ? '—' : '0')}</td>
          {measurable && <><td>{row.beforeAmount ?? (before.preview?.truncated ? '—' : '0')}</td>
            <td>{row.afterAmount ?? (after.preview?.truncated ? '—' : '0')}</td></>}</tr>)}
      </tbody></table></div>
    </>}
  </section>;
}
