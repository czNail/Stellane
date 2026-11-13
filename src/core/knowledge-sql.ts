import type { KnowledgeClaim, KnowledgeEndpoint } from '../shared/knowledge-models.ts';
import { catalogSql } from './catalog-sql.ts';

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

function keys(target: KnowledgeEndpoint): string {
  const columns = target.columns.map(quote);
  return `SELECT ${columns.map((column, index) => `${column} AS k${index}`).join(', ')}, pg_catalog.count(*) AS n
    FROM ONLY ${quote(target.schema)}.${quote(target.table)} GROUP BY ${columns.join(', ')}`;
}

function nonNull(alias: string, count: number): string {
  return Array.from({ length: count }, (_, i) => `${alias}.k${i} IS NOT NULL`).join(' AND ');
}

function profile(alias: string, count: number): string {
  const complete = nonNull(alias, count);
  return `(SELECT pg_catalog.jsonb_build_object(
    'rows', COALESCE(pg_catalog.sum(n),0)::text,
    'nullRows', COALESCE(pg_catalog.sum(n) FILTER (WHERE NOT (${complete})),0)::text,
    'duplicateKeys', pg_catalog.count(*) FILTER (WHERE (${complete}) AND n>1)::text) FROM ${alias})`;
}

export function knowledgeSql(claim: KnowledgeClaim): string {
  if (claim.kind === 'row-key') {
    return `WITH observed AS MATERIALIZED (${catalogSql}), source_keys AS MATERIALIZED (${keys(claim.target)})
      SELECT metadata, ${profile('source_keys', claim.target.columns.length)} AS source FROM observed`;
  }
  const count = claim.from.columns.length;
  const equality = claim.from.columns.map((_, i) => `s.k${i} OPERATOR(pg_catalog.=) t.k${i}`).join(' AND ');
  return `WITH observed AS MATERIALIZED (${catalogSql}),
    source_keys AS MATERIALIZED (${keys(claim.from)}), target_keys AS MATERIALIZED (${keys(claim.to)})
    SELECT metadata, ${profile('source_keys', count)} AS source, ${profile('target_keys', count)} AS target,
      (SELECT COALESCE(pg_catalog.sum(s.n),0)::text FROM source_keys s WHERE ${nonNull('s', count)}
        AND NOT EXISTS (SELECT 1 FROM target_keys t WHERE ${equality})) AS unmatched
    FROM observed`;
}
