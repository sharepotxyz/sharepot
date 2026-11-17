// SharePot Perp — how it works (/docs): the long-form explanation, from perp-i18n/docs.<lang>.json (our own markup),
// with a table of contents and the live contract addresses.
import { PERP } from "./config";
import { P, PL, TOKEN, addrLink, esc } from "./perp-core";
import { health, mountShell, onHealth } from "./perp-shell";
import en from "./perp-i18n/docs.en.json";
import zhTW from "./perp-i18n/docs.zh-TW.json";

const dict: Record<string, string> = { ...en, ...(({ "zh-TW": zhTW } as Record<string, Record<string, string>>)[PL] ?? {}) };
const vars = { sym: esc(PERP.symbol), tok: esc(PERP.tokenSymbol) };
const dt = (k: string) => (dict[k] ?? k).replace(/\{(\w+)\}/g, (m, v) => (v in vars ? (vars as any)[v] : m));
const SECTIONS = ["why", "tiers", "day", "money", "check", "trust", "try", "contracts", "faq"];

function render() {
  const contracts = `<dl class="pkv"><dt>${esc(dt("d.contracts.pool"))}</dt><dd>${addrLink(P, P)}</dd><dt>${esc(dt("d.contracts.token"))}</dt><dd>${addrLink(TOKEN, TOKEN)}</dd></dl>
    <p><a href="https://repo.sourcify.dev/84532/${esc(P)}" target="_blank" rel="noopener">${esc(dt("d.contracts.verified"))}</a></p>${dt("d.contracts.api")}
    ${health.demoWallets.length || health.treasury ? `<h3>${esc(dt("d.ours.h"))}</h3><p>${dt("d.ours.b")}</p><ul class="pours">${health.treasury ? `<li>${addrLink(health.treasury, health.treasury)} · ${esc(dt("d.ours.treasury"))}</li>` : ""}${health.demoWallets.map((a) => `<li>${addrLink(a, a)} · ${esc(dt("d.ours.bot"))}</li>`).join("")}</ul>` : ""}`;
  const body = (s: string) => (s === "contracts" ? contracts : dt(`d.${s}.b`));
  document.getElementById("perp")!.innerHTML = `<section class="phero"><h1>${esc(dt("d.title"))}</h1><p>${esc(dt("d.intro"))}</p></section>
    <nav class="card ptoc" aria-label="${esc(dt("d.toc"))}"><b>${esc(dt("d.toc"))}</b><ol>${SECTIONS.map((s) => `<li><a href="#${s}">${esc(dt(`d.${s}.h`))}</a></li>`).join("")}</ol></nav>
    ${SECTIONS.map((s) => `<section class="card pdoc" id="${s}"><h2>${esc(dt(`d.${s}.h`))}</h2>${body(s)}</section>`).join("")}`;
}

mountShell("docs");
document.title = `SharePot Perp · ${dt("d.title")}`;
render();
onHealth(() => render());
if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
