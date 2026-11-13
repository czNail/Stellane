import { createHash } from 'node:crypto';

// PostgreSQL JSONB and SQLite can return object keys in different orders.
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

export function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

export function searchTerms(query: string): string[] {
  const words = query.normalize('NFKC').toLocaleLowerCase().match(/[a-z0-9_]+|[\p{Script=Han}]+/gu) ?? [];
  return [...new Set(words.flatMap(word => {
    if (!/\p{Script=Han}/u.test(word) || word.length <= 2) return [word];
    return [word, ...Array.from({ length: word.length - 1 }, (_, index) => word.slice(index, index + 2))];
  }))].slice(0, 32);
}

export function relevance(terms: string[], text: string): number {
  const normalized = text.normalize('NFKC').toLocaleLowerCase();
  return terms.reduce((total, term) => total + Number(normalized.includes(term)), 0);
}
