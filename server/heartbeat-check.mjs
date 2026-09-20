// Dead-man check for the independent verification host. That host (where the admin key lives) re-derives every proposed
// result and voids a wrong one — but if the whole machine is down, nothing there can say so, and proposals would
// finalize unchecked. So it pushes a small heartbeat file here every few minutes (data/tokyo-heartbeat.json:
// { at, verifyDone, sampled }, ISO times), and this job — on the app host, every 10 minutes — alerts when it goes stale.
// Read-only: no keys, no RPC.
import fs from "node:fs"; import path from "node:path";
import { notify } from "./notify.mjs";

export const LIMITS_MIN = { at: 30, verifyDone: 40, sampled: 15 };

/** Pure: heartbeat object (or null when the file is missing/unreadable) + now (ms) → list of { key, title, body }. */
export function heartbeatProblems(hb, now = Date.now()) {
  const ageMin = (iso) => { const t = Date.parse(iso ?? ""); return Number.isFinite(t) ? (now - t) / 60_000 : Infinity; };
  const fmt = (m) => (m === Infinity ? "從來沒有" : `${Math.round(m)} 分鐘前`);
  if (!hb || ageMin(hb.at) > LIMITS_MIN.at) {
    return [{ key: "heartbeat-host", title: "🛑 東京核對主機沒有回報", body: `最後一次心跳：${fmt(ageMin(hb?.at))}（應每 5 分一次）\n這段期間沒有人獨立核對提案，也沒有人能自動作廢錯的結果；提案會照常在爭議窗後定案。\n先看東京主機是否活著，再看它的同步與核對排程是否還在。` }];
  }
  const out = [];
  if (ageMin(hb.verifyDone) > LIMITS_MIN.verifyDone) out.push({ key: "heartbeat-verify", title: "⚠️ 東京主機活著，但核對機沒有跑完", body: `最後一次核對完成：${fmt(ageMin(hb.verifyDone))}（應每 10 分一次）\n看東京核對排程的日誌。` });
  if (ageMin(hb.sampled) > LIMITS_MIN.sampled) out.push({ key: "heartbeat-sample", title: "⚠️ 東京主機活著，但報價取樣停了", body: `最後一次取樣：${fmt(ageMin(hb.sampled))}（應每分鐘）\n取樣缺太多，東京就核對不了當天的鏈上價格盤。看東京取樣排程的日誌。` });
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const DATA = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
  let hb = null; try { hb = JSON.parse(fs.readFileSync(path.join(DATA, "tokyo-heartbeat.json"), "utf8")); } catch { /* missing or torn: same as no heartbeat */ }
  const problems = heartbeatProblems(hb);
  for (const p of problems) await notify(p.title, p.body, p.key, 360);
  console.log(`${new Date().toISOString()} heartbeat ${hb?.at ?? "none"}: ${problems.length ? problems.map((p) => p.key).join(", ") : "ok"}`);
}
