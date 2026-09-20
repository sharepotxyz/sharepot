// Languages on the server: which one a request gets, the static HTML in that language, and the dictionary the page's
// scripts receive (web/src/i18n.ts). The dictionaries live with the front end (web/src/i18n/<lang>.json for the UI,
// docs.<lang>.json for the long "How it works" page, which only the server needs); English is the HTML itself and the
// fallback for any key a language lacks.
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

export const LANGS = ["en", "zh-TW", "zh-CN", "ja", "ko", "es"];
const DIR = process.env.I18N_DIR ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../web/src/i18n");
const read = (name) => { try { return JSON.parse(fs.readFileSync(path.join(DIR, name), "utf8")); } catch { return {}; } };
const en = read("en.json"), enDocs = read("docs.en.json");
// per language: ui = what the browser gets, all = ui + docs for the static HTML, js = the script body, v = its cache key
const packs = new Map();
for (const lang of LANGS) {
  const ui = lang === "en" ? en : { ...en, ...read(`${lang}.json`) }, all = lang === "en" ? { ...en, ...enDocs } : { ...ui, ...enDocs, ...read(`docs.${lang}.json`) };
  const js = `window.__I18N__=${JSON.stringify({ lang, dict: ui }).replace(/</g, "\\u003c")};`;
  packs.set(lang, { ui, all, js, v: crypto.createHash("sha256").update(js).digest("hex").slice(0, 10), plural: new Intl.PluralRules(lang) });
}

/** Accept-Language tag → one of ours. Chinese goes by script/region: Taiwan, Hong Kong, Macau and "Hant" read Traditional. */
function match(tag) {
  const t = String(tag).trim().toLowerCase(); if (!t) return null;
  const exact = LANGS.find((l) => l.toLowerCase() === t); if (exact) return exact;
  if (t === "zh" || t.startsWith("zh-")) return /-(tw|hk|mo|hant)\b/.test(t) ? "zh-TW" : "zh-CN";
  return LANGS.find((l) => l.toLowerCase() === t.split("-")[0]) ?? null;
}
/** ?lang= (a link someone shared) → the sp_lang cookie (the picker) → the browser's Accept-Language → English. */
export function resolveLang(req, url) {
  const q = match(url?.searchParams.get("lang") ?? ""); if (q) return { lang: q, fromQuery: true };
  const c = String(req?.headers?.cookie ?? "").match(/(?:^|;\s*)sp_lang=([A-Za-z-]{2,10})/); const ck = c ? match(c[1]) : null; if (ck) return { lang: ck, fromQuery: false };
  const prefs = String(req?.headers?.["accept-language"] ?? "").slice(0, 400).split(",").map((p) => { const [tag, q] = p.split(";q="); return { tag, q: q == null ? 1 : Number(q) || 0 }; }).sort((a, b) => b.q - a.q);
  for (const p of prefs) { const m = match(p.tag); if (m) return { lang: m, fromQuery: false }; }
  return { lang: "en", fromQuery: false };
}

/** t / tn for server-rendered markup: the same lookups as web/src/i18n.ts. */
export function translator(lang) {
  const p = packs.get(lang) ?? packs.get("en");
  const t = (key, vars) => { const s = p.ui[key] ?? key; return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s; };
  const tn = (key, n, vars) => { const form = `${key}_${p.plural.select(n)}`; return t(p.ui[form] != null ? form : `${key}_other`, { n, ...vars }); };
  return { t, tn, lang, dayLocale: lang === "en" ? "en-US" : lang };
}

const escAttr = (v) => String(v).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
/** The page in `lang`: <html lang>, every element marked data-t="key" gets that string as its content, every
 *  data-t-attr="attr:key;…" gets those attributes, and the dictionary script is added for the page's own scripts.
 *  A marked element never contains another element of its own tag name (server/i18n.test.mjs checks the pages). */
export function translateHtml(html, lang) {
  const p = packs.get(lang); if (!p || lang === "en") return html;
  return html
    .replace(/<html lang="en">/, () => `<html lang="${lang}">`)
    .replace(/<(\w+)\b([^>]*?\sdata-t="([\w.-]+)"[^>]*)>([\s\S]*?)<\/\1>/g, (all, tag, attrs, key) => (p.all[key] != null ? `<${tag}${attrs}>${p.all[key]}</${tag}>` : all))
    .replace(/<\w+\b[^>]*\sdata-t-attr="([^"]+)"[^>]*>/g, (tag, spec) => spec.split(";").reduce((out, pair) => {
      const [attr, key] = pair.split(":"); if (!/^[\w-]+$/.test(attr ?? "") || p.all[key] == null) return out;
      return out.replace(new RegExp(`(\\s${attr}=")[^"]*(")`), (m, a, b) => a + escAttr(p.all[key]) + b);
    }, tag))
    .replace("</head>", () => `<script src="/i18n/${lang}.js?v=${p.v}"></script></head>`);
}
/** Body of /i18n/<lang>.js, or null for a language we do not have. */
export const langScript = (lang) => (lang !== "en" && packs.has(lang) ? packs.get(lang).js : null);
