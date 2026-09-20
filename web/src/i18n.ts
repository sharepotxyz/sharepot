// Languages. The server picks one per request (?lang= → the sp_lang cookie → Accept-Language, see server/i18n.mjs),
// translates the static HTML and the first-paint markup, and hands this bundle the same dictionary as
// window.__I18N__ = { lang, dict } from a cacheable /i18n/<lang>.js — so the page and the scripts always agree and
// nothing flashes in English first. English is bundled and is the fallback for any key a language lacks.
// Adding a language = one web/src/i18n/<lang>.json (+ docs.<lang>.json) and a row in LANGS here and in server/i18n.mjs.
import en from "./i18n/en.json";

export const LANGS: [string, string][] = [["en", "English"], ["zh-TW", "繁體中文"], ["zh-CN", "简体中文"], ["ja", "日本語"], ["ko", "한국어"], ["es", "Español"]];
const served = (globalThis as any).__I18N__ as { lang?: string; dict?: Record<string, string> } | undefined;
export const LANG: string = served?.lang && served.dict && LANGS.some(([k]) => k === served.lang) ? served.lang : "en";
const base = en as Record<string, string>;
const dict: Record<string, string> = LANG === "en" ? base : { ...base, ...served!.dict };

/** Locales for dates. English keeps what the site always printed ("18 Sept 2026, 14:10 GMT+8", "Fri, Sep 18"). */
export const DATE_LOCALE = LANG === "en" ? "en-GB" : LANG;
export const DAY_LOCALE = LANG === "en" ? "en-US" : LANG;

/** The string for `key` with {name} slots filled. Strings are our own files and may carry markup; whatever goes into a
 *  slot is the caller's to escape. */
export function t(key: string, vars?: Record<string, string | number>): string {
  const s = dict[key] ?? key;
  return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s;
}
const plural = new Intl.PluralRules(LANG);
/** Counted strings: "<key>_one" / "<key>_other" (languages without a singular only carry _other); {n} is the count. */
export function tn(key: string, n: number, vars?: Record<string, string | number>): string {
  const form = `${key}_${plural.select(n)}`;
  return t(dict[form] != null ? form : `${key}_other`, { n, ...vars });
}
/** The picker remembers the choice in a cookie, because the server has to know it before it renders the page. */
export function setLang(lang: string) {
  if (!LANGS.some(([k]) => k === lang)) return;
  document.cookie = `sp_lang=${lang}; path=/; max-age=31536000; samesite=lax`;
  const u = new URL(location.href);
  if (u.searchParams.has("lang")) { u.searchParams.delete("lang"); location.href = u.toString(); } else location.reload();
}
