// Languages: every dictionary matches English key for key, slot for slot and tag for tag; every key the pages and
// scripts ask for exists; the static HTML still says what en.json says; and the server picks and applies a language.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { LANGS, resolveLang, translateHtml, translator, langScript } from "./i18n.mjs";

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../web"), DIR = path.join(WEB, "src/i18n");
const json = (f) => JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8"));
const en = json("en.json"), enDocs = json("docs.en.json");
const pages = fs.readdirSync(WEB).filter((f) => f.endsWith(".html")).map((f) => [f, fs.readFileSync(path.join(WEB, f), "utf8")]);
const slots = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join();
const tags = (s) => [...s.matchAll(/<\/?\w+[^>]*>/g)].map((m) => m[0]).sort().join();
const MARKED = /<(\w+)\b[^>]*?\sdata-t="([\w.-]+)"[^>]*>([\s\S]*?)<\/\1>/g;

test("every language has every key, with the same slots and the same markup", () => {
  for (const lang of LANGS.filter((l) => l !== "en")) for (const [base, src] of [["", en], ["docs.", enDocs]]) {
    const tr = json(`${base}${lang}.json`);
    assert.deepEqual(Object.keys(tr).sort(), Object.keys(src).sort(), `${base}${lang}: keys`);
    for (const k of Object.keys(src)) {
      assert.equal(slots(tr[k]), slots(src[k]), `${base}${lang} ${k}: slots`);
      assert.equal(tags(tr[k]), tags(src[k]), `${base}${lang} ${k}: tags`);
      assert.ok(!/<script|javascript:|\son\w+=/i.test(tr[k]), `${base}${lang} ${k}: markup that runs`);
      assert.ok(tr[k].trim().length > 0 || src[k].trim().length === 0, `${base}${lang} ${k}: empty`);
    }
  }
});
test("the pages' marked text is what en.json says, and no marked element nests its own tag", () => {
  const all = { ...en, ...enDocs };
  for (const [f, html] of pages) {
    for (const m of html.matchAll(MARKED)) {
      assert.equal(m[3], all[m[2]], `${f}: ${m[2]} differs from the dictionary`);
      assert.ok(!new RegExp(`<${m[1]}\\b`).test(m[3]), `${f}: ${m[2]} contains another <${m[1]}>`);
    }
    for (const m of html.matchAll(/\sdata-t-attr="([^"]+)"/g)) for (const pair of m[1].split(";")) assert.ok(all[pair.split(":")[1]] != null, `${f}: ${pair}`);
  }
});
test("every key the scripts ask for exists, and every UI key is used", () => {
  const files = [...fs.readdirSync(path.join(WEB, "src")).filter((f) => f.endsWith(".ts")).map((f) => path.join(WEB, "src", f)), path.join(WEB, "../server/ssr.mjs")];
  const code = files.map((f) => fs.readFileSync(f, "utf8")).join("\n"), html = pages.map(([, h]) => h).join("\n");
  for (const m of code.matchAll(/\bt\(\s*"([\w.-]+)"/g)) if (!m[1].endsWith(".")) assert.ok(en[m[1]] != null, `t("${m[1]}") has no English string`);   // "prefix." + value is checked below
  for (const m of code.matchAll(/\btn\(\s*"([\w.-]+)"/g)) assert.ok(en[m[1] + "_other"] != null, `tn("${m[1]}") has no _other form`);
  const dynamic = ["status.chain.", "pf.kind.", "cat."];   // built from a value at run time
  for (const d of dynamic) assert.ok(Object.keys(en).some((k) => k.startsWith(d)), `${d}* has no strings`);
  for (const k of Object.keys(en)) assert.ok(code.includes(`"${k.replace(/_(one|other)$/, "")}"`) || html.includes(`${k}"`) || html.includes(`:${k}`) || dynamic.some((d) => k.startsWith(d)), `${k} is never used`);
});
test("language choice: ?lang= over the cookie over Accept-Language, Chinese by script", () => {
  const req = (h) => ({ headers: h }), url = (s) => new URL("http://x/" + s);
  assert.equal(resolveLang(req({}), url("")).lang, "en");
  assert.equal(resolveLang(req({ "accept-language": "zh-TW,zh;q=0.9,en;q=0.8" }), url("")).lang, "zh-TW");
  assert.equal(resolveLang(req({ "accept-language": "zh-HK" }), url("")).lang, "zh-TW");
  assert.equal(resolveLang(req({ "accept-language": "zh-Hans-SG" }), url("")).lang, "zh-CN");
  assert.equal(resolveLang(req({ "accept-language": "fr-FR,fr;q=0.9,es-419;q=0.7" }), url("")).lang, "es");
  assert.equal(resolveLang(req({ "accept-language": "fr" }), url("")).lang, "en");
  assert.equal(resolveLang(req({ "accept-language": "ja", cookie: "a=1; sp_lang=ko" }), url("")).lang, "ko");
  assert.deepEqual(resolveLang(req({ cookie: "sp_lang=ko" }), url("?lang=ES")), { lang: "es", fromQuery: true });
  assert.equal(resolveLang(req({ cookie: "sp_lang=<script>" }), url("?lang=../x")).lang, "en");
});
test("a translated page: lang attribute, content, attributes, the dictionary script; English is left alone", () => {
  const [, home] = pages.find(([f]) => f === "index.html");
  assert.equal(translateHtml(home, "en"), home);
  const zh = json("zh-TW.json"), out = translateHtml(home, "zh-TW");
  assert.ok(out.includes(`<html lang="zh-TW">`) && out.includes(`>${zh["nav.docs"]}</a>`) && out.includes(`placeholder="${zh["top.searchPh"]}"`) && out.includes(zh["hero.p"]));
  assert.match(out, /<script src="\/i18n\/zh-TW\.js\?v=[0-9a-f]{10}"><\/script><\/head>/);
  assert.ok(!out.includes(en["hero.p"]));
  for (const [f, html] of pages) for (const lang of LANGS) { const o = translateHtml(html, lang), all = { ...json(lang === "en" ? "en.json" : `${lang}.json`), ...json(lang === "en" ? "docs.en.json" : `docs.${lang}.json`) };
    for (const m of o.matchAll(MARKED)) assert.equal(m[3], all[m[2]], `${f} ${lang}: ${m[2]} was not replaced`); }
  assert.equal(langScript("en"), null); assert.equal(langScript("xx"), null);
  assert.ok(langScript("ja").startsWith("window.__I18N__={") && !langScript("ja").includes("<"));
  const tr = translator("en"); assert.equal(tr.tn("bettors", 1), "1 bettor"); assert.equal(tr.tn("bettors", 3), "3 bettors"); assert.equal(tr.t("home.pot", { usd: "$5" }), "$5 pot");
});
