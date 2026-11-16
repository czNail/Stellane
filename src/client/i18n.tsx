import { useSyncExternalStore } from 'react';
import { english } from './translations.ts';

export type Locale = 'zh' | 'en';
type Preference = Locale | 'auto';
const storageKey = 'stellane.language';
const subscribers = new Set<() => void>();
function storedPreference(): Preference {
  try { const value = globalThis.localStorage?.getItem(storageKey); return value === 'zh' || value === 'en' ? value : 'auto'; }
  catch { return 'auto'; }
}
let preference = storedPreference();
function emit() { for (const subscriber of subscribers) subscriber(); }
function subscribe(subscriber: () => void) {
  subscribers.add(subscriber);
  const storage = () => { preference = storedPreference(); emit(); };
  globalThis.addEventListener?.('storage', storage);
  globalThis.addEventListener?.('languagechange', emit);
  return () => { subscribers.delete(subscriber); globalThis.removeEventListener?.('storage', storage); globalThis.removeEventListener?.('languagechange', emit); };
}
export function locale(): Locale {
  return preference === 'auto' ? (globalThis.navigator?.language?.toLowerCase().startsWith('zh') ? 'zh' : 'en') : preference;
}
export function useLocale(): Locale { return useSyncExternalStore(subscribe, locale, () => 'en'); }
export function setLanguage(value: Preference) {
  preference = value;
  try { if (value === 'auto') globalThis.localStorage?.removeItem(storageKey); else globalThis.localStorage?.setItem(storageKey, value); }
  catch { /* The current tab can still change language when storage is unavailable. */ }
  emit();
}
/** Explicit UI strings only. Values supplied for placeholders are never translated. */
export function t(source: string, ...values: unknown[]): string {
  const translated = locale() === 'en' ? english[source] ?? source : source;
  return translated.replace(/\{(\d+)\}/g, (placeholder, index: string) => Number(index) < values.length ? String(values[Number(index)] ?? '') : placeholder);
}
/** Keep module-level label maps reactive without translating user-provided data. */
export function labels<T extends Record<string, string>>(values: T): T {
  return Object.defineProperties({}, Object.fromEntries(Object.entries(values).map(([key, value]) => [key, {
    enumerable: true, get: () => t(value),
  }]))) as T;
}
export function LanguageSwitch() {
  useLocale();
  const selected = useSyncExternalStore(subscribe, () => preference, () => 'auto');
  return <label className="st-language"><span className="st-sr-only">{t('语言')}</span>
    <select aria-label={t('语言')} value={selected} onChange={event => setLanguage(event.target.value as Preference)}>
      <option value="auto">{t('跟随浏览器')}</option><option value="en">English</option><option value="zh">中文</option>
    </select>
  </label>;
}

/** Translate known system messages only; identifiers and user content are preserved. */
export function systemMessage(source: string): string {
  if (locale() === 'zh') return source;
  if (english[source]) return t(source);
  const coded = source.match(/^([\s\S]+)（([A-Z0-9_]{2,40})）$/);
  if (coded && english[coded[1]!]) return `${t(coded[1]!)} (${coded[2]})`;
  const sentences = source.split(/(?<=。)\s*/).filter(Boolean);
  if (sentences.length > 1 && sentences.every(sentence => english[sentence])) return sentences.map(sentence => t(sentence)).join(' ');
  const patterns: [RegExp, (...parts: string[]) => string][] = [
    [/^数据库操作失败（([A-Z0-9_]{2,40})），请检查连接、权限或查询。$/, code => `Database operation failed (${code}). Check the connection, permissions and query.`],
    [/^项目最多保留 (\d+) 个环境或待核实派生，请清理资源后继续。$/, limit => `This project can retain ${limit} environments or unresolved branches. Remove retained resources before continuing.`],
    [/^每个环境最多保留 (\d+) 条/, limit => `This environment has reached its ${limit}-record limit. Archive older observations to continue.`],
    [/^Stello 操作失败（([^）]+)），请核对权限与资源状态。([\s\S]*)$/, (code, suffix) => `Stello request failed (${code}). Check permissions and the original resource status.${suffix.replace('操作记录：', ' Operation: ')}`],
    [/^(.+)：数据库连接等待超时，请检查网络和数据库是否正在启动。$/, () => 'The database connection timed out. Check the network and whether the database is starting. Verify the original operation before retrying a write.'],
    [/^指标「([\s\S]+)」的统计范围(?:（([\s\S]+)）)?内有 (\d+) 条记录未匹配、(\d+) 条(?:记录)?存在多个候选匹配，旧的完整关联已失效。$/, (scope, filter, missing, ambiguous) => `Within metric “${scope}”${filter ? ` (${filter})` : ''}, ${missing} records have no match and ${ambiguous} have multiple candidate matches. The previous complete relationship is invalidated.`],
  ];
  for (const [pattern, format] of patterns) { const match = source.match(pattern); if (match) return format(...match.slice(1)); }
  return source;
}
