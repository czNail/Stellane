import { z } from 'zod';
import { fingerprint } from './context-utils.ts';
import type { MetricEvidence, MetricPlan } from '../shared/metric-models.ts';
import type { Run } from '../shared/models.ts';

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const literal = (value: string) => `E'${value.replaceAll('\\', '\\\\').replaceAll("'", "''")}'`;
const table = (endpoint: { schema: string; table: string }) => `${quote(endpoint.schema)}.${quote(endpoint.table)}`;

export function metricSql(plan: MetricPlan): string {
  const relationships = plan.relationships;
  const source = relationships[0]!.from;
  const last = relationships.length;
  const indexes = relationships.map(({ to }, i) => {
    const keys = to.columns.map(quote);
    return `k${i + 1} AS MATERIALIZED (
      SELECT ${keys.map((key,j)=>`${key} AS key${j}`).join(', ')}, pg_catalog.count(*) AS hits
      FROM ONLY ${table(to)} GROUP BY ${keys.join(', ')}
    )`;
  });
  const equality = (from: string, to: string, pairs: [string, string][]) =>
    pairs.map(([a,b]) => `${from}.${quote(a)} OPERATOR(pg_catalog.=) ${to}.${quote(b)}`).join(' AND ');
  const joins = relationships.map(({ from, to }, i) => {
    const n = i + 1;
    const pairs = from.columns.map((col, j): [string,string] => [col,to.columns[j]!]);
    return `LEFT JOIN k${n} ON ${equality(`t${i}`, `k${n}`, pairs.map(([col],j)=>[col,`key${j}`]))}
      LEFT JOIN ONLY ${table(to)} t${n} ON k${n}.hits = 1 AND ${equality(`t${i}`, `t${n}`, pairs)}`;
  });
  const marks = relationships.flatMap(({ from }, i) => [
    `k${i+1}.hits AS m${i+1}`,
    `(${from.columns.map(name => `t${i}.${quote(name)} IS NULL`).join(' OR ')}) AS n${i+1}`,
  ]);
  const check = (previous: string, n: number) => `(SELECT pg_catalog.jsonb_build_object(
      'eligible', pg_catalog.count(*) FILTER (WHERE ${previous})::text,
      'missing', pg_catalog.count(*) FILTER (WHERE (${previous}) AND m${n} IS NULL)::text,
      'ambiguous', pg_catalog.count(*) FILTER (WHERE (${previous}) AND m${n} > 1)::text,
      'nullSourceKeys', pg_catalog.count(*) FILTER (WHERE (${previous}) AND n${n})::text) FROM rows)`;
  const checks = relationships.map((_, i) => check(i ? `m${i} = 1` : 'true',i+1));
  const objects = [...new Set([source, ...relationships.map(item=>item.to)].map(table))];
  const targets = objects.map(name => `pg_catalog.to_regclass(${literal(name)})`).join(', ');
  return `WITH ${indexes.join(',\n')},
    rows AS MATERIALIZED (
      SELECT t${last}.${quote(plan.groupColumn)}::text AS bucket,
        ${plan.amountColumn ? `t0.${quote(plan.amountColumn)}` : '0'}::numeric AS amount, ${marks.join(', ')}
      FROM ONLY ${table(source)} t0 ${joins.join('\n')}
      ${plan.filter ? `WHERE t0.${quote(plan.filter.column)} OPERATOR(pg_catalog.=) $1` : ''}
    ),
    buckets AS MATERIALIZED (
      SELECT bucket, pg_catalog.count(*)::text AS orders, COALESCE(pg_catalog.sum(amount),0)::text AS amount
      FROM rows GROUP BY bucket
    )
    SELECT pg_catalog.pg_current_snapshot()::text AS snapshot,
      (SELECT pg_catalog.count(*) = ${objects.length} FROM pg_catalog.pg_class c
        WHERE c.oid IN (${targets}) AND c.relkind='r' AND NOT c.relrowsecurity
        AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_inherits i WHERE i.inhparent=c.oid)) AS safe,
      (SELECT pg_catalog.jsonb_build_object(
        'total', pg_catalog.count(*)::text,
        'attributed', pg_catalog.count(bucket)::text,
        'unattributed', pg_catalog.count(*) FILTER (WHERE bucket IS NULL)::text,
        'nullAmounts', pg_catalog.count(*) FILTER (WHERE amount IS NULL OR amount::text IN ('NaN','Infinity','-Infinity'))::text,
        'totalAmount', COALESCE(pg_catalog.sum(amount),0)::text,
        'attributedAmount', COALESCE(pg_catalog.sum(amount) FILTER (WHERE bucket IS NOT NULL),0)::text,
        'unattributedAmount', COALESCE(pg_catalog.sum(amount) FILTER (WHERE bucket IS NULL),0)::text
      ) FROM rows) AS counts,
      pg_catalog.jsonb_build_array(${checks.join(', ')}) AS checks,
      (SELECT pg_catalog.count(*) FROM buckets)::text AS "groupCount",
      (SELECT COALESCE(pg_catalog.jsonb_agg(g ORDER BY g.bucket NULLS LAST),'[]'::jsonb)
        FROM (SELECT * FROM buckets ORDER BY bucket NULLS LAST LIMIT 200) g) AS groups`;
}

const integer = z.string().regex(/^\d+$/);
const amount = z.string();
const proof = z.object({
  snapshot: z.string().min(1), safe: z.boolean(), groupCount: integer,
  groups: z.array(z.object({ bucket: z.string().nullable(), orders: integer, amount })),
  counts: z.object({ total: integer, attributed: integer, unattributed: integer, nullAmounts: integer,
    totalAmount: amount, attributedAmount: amount, unattributedAmount: amount }),
  checks: z.array(z.object({ eligible: integer, missing: integer, ambiguous: integer, nullSourceKeys: integer })),
});

export function withMetric(run: Run, plan: MetricPlan): Run {
  const { name: _displayName, ...definition } = plan;
  const evidence: MetricEvidence = { plan, status: 'unverified', version: fingerprint({ ...definition,
    relationships: plan.relationships.map(({ from, to }) => ({ from, to })),
  }) };
  const parsed = proof.safeParse(run.preview?.rows[0]);
  if (run.status !== 'succeeded' || !parsed.success || run.preview?.truncated || parsed.data.checks.length !== plan.relationships.length) {
    return { ...run, preview: undefined, metric: { ...evidence, reason: run.error ?? '查询未取得完整覆盖证据。' } };
  }
  const data = parsed.data;
  const metric: MetricEvidence = { ...evidence, snapshot: data.snapshot, counts: data.counts, checks: data.checks };
  if (!data.safe) metric.reason = '有参与对象超出可验证的普通表范围。';
  else if (data.checks.some(item => item.ambiguous !== '0')) metric.reason = '在统计范围内存在多个候选匹配，归因需要核实。';
  else if (data.counts.nullAmounts !== '0') metric.reason = '统计范围内有缺失或无效金额。';
  else if (BigInt(data.groupCount) > BigInt(data.groups.length)) metric.reason = '分组数超过可完整交付的范围。';
  else metric.status = data.counts.unattributed === '0' ? 'complete' : 'partial';
  return { ...run, metric, preview: {
    ...run.preview!, columns: plan.amountColumn ? ['归属','记录数','合计'] : ['归属','记录数'],
    rows: data.groups.map(group=>({ 归属: group.bucket, 记录数: group.orders, ...(plan.amountColumn ? { 合计: group.amount } : {}) })),
    rowCount: data.groups.length, truncated: BigInt(data.groupCount) > BigInt(data.groups.length),
  } };
}
