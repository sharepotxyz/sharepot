// Every time the site shows — timestamps and the rules' wording alike — is the viewer's own clock, with its zone named
// ("18 Sept 2026, 14:10 GMT+8"). Nobody should have to convert from UTC or New York in their head.
import { DATE_LOCALE, DAY_LOCALE, t } from "./i18n";
const at = (ts: number) => new Date(ts * 1000);
// 24-hour clock in every language (several locales default to a 12-hour one)
const H23 = { hourCycle: "h23" } as const;
/** "18 Sept 2026, 14:10 GMT+8" */
export const fmtTs = (ts: number) => at(ts).toLocaleString(DATE_LOCALE, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "shortOffset", ...H23 });
/** "18 Sept, 14:10 GMT+8": for tight spots where the year is obvious */
export const fmtTsShort = (ts: number) => at(ts).toLocaleString(DATE_LOCALE, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZoneName: "shortOffset", ...H23 });
/** "14:10 GMT+8" */
export const fmtHm = (ts: number) => at(ts).toLocaleTimeString(DATE_LOCALE, { hour: "2-digit", minute: "2-digit", timeZoneName: "shortOffset", ...H23 });
const hm = (ts: number) => at(ts).toLocaleTimeString(DATE_LOCALE, { hour: "2-digit", minute: "2-digit", ...H23 });
/** "07:00–08:00 GMT+8" */
export const fmtHmRange = (a: number, b: number) => `${hm(a)}–${fmtHm(b)}`;
/** "Fri, Sep 18", the viewer's calendar day */
export const fmtDay = (ts: number) => at(ts).toLocaleDateString(DAY_LOCALE, { weekday: "short", month: "short", day: "numeric" });
/** A "<SYMBOL>.day:<date>" market covers one UTC day; these are its edges as moments. */
export const dayStart = (date: string) => Date.parse(date + "T00:00:00Z") / 1000;
export const dayEnd = (date: string) => dayStart(date) + 86400;

export function timeLeft(ts: number) {
  const s = ts - Date.now() / 1000; if (s <= 0) return t("time.closed");
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d > 0 ? t("time.dh", { d, h }) : h > 0 ? t("time.hm", { h, m }) : t("time.m", { m });
}

/** Static pages write fixed daily times as <span data-utc="11:00">11:00 UTC</span> (or "23:00-24:00"); rewrite them in the viewer's zone. */
export function localizeUtc(root: ParentNode = document) {
  const today = Math.floor(Date.now() / 86400000) * 86400;
  const sec = (s: string) => { const [h, m] = s.split(":").map(Number); return today + h * 3600 + (m || 0) * 60; };
  root.querySelectorAll<HTMLElement>("[data-utc]").forEach((el) => {
    const [a, b] = (el.dataset.utc ?? "").split("-");
    if (!/^\d{1,2}:\d{2}$/.test(a) || (b && !/^\d{1,2}:\d{2}$/.test(b))) return;
    el.textContent = b ? fmtHmRange(sec(a), sec(b)) : fmtHm(sec(a));
  });
  // <span data-ny="09:30">: a New York wall-clock time (the opening bell), whatever New York's offset is today
  const ny = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" })).getTime(), here = new Date(new Date().toLocaleString("en-US")).getTime();
  root.querySelectorAll<HTMLElement>("[data-ny]").forEach((el) => {
    const v = el.dataset.ny ?? ""; if (!/^\d{1,2}:\d{2}$/.test(v)) return;
    const [h, mi] = v.split(":").map(Number), d = new Date(); d.setHours(h, mi, 0, 0);
    el.textContent = t("time.nyOpen", { time: fmtHm((d.getTime() + (here - ny)) / 1000) });
  });
}
