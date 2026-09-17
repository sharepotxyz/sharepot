// Telegram alert for events that need a human decision (disputes, held-back or failed settlements).
// Never throws: alerting must not take the caller down. Throttled per key (default 30 min). Config file
// ~/secrets/telegram.json = { "bot_token": "...", "chat_id": "..." }; without it every call is a silent no-op.
// NOTIFY_EXEC=<program> hands the alert to that program instead (args: title, body, key) — for a host that already has
// its own alerting and no Telegram config of its own.
import fs from "node:fs"; import path from "node:path"; import os from "node:os"; import { spawnSync } from "node:child_process";
const CFG = process.env.TELEGRAM_CONFIG ?? path.join(os.homedir(), "secrets", "telegram.json");
const EXEC = process.env.NOTIFY_EXEC ?? null;
// Throttle state lives on disk: the resolver is a fresh process every cron run, so an in-memory map would re-send.
const STATE = process.env.NOTIFY_STATE ?? path.join(os.homedir(), ".sharepot-notify.json");
const loadState = () => { try { return JSON.parse(fs.readFileSync(STATE, "utf8")); } catch { return {}; } };
export async function notify(title, body, key = title, throttleMin = 30) {
  try {
    if (!EXEC && !fs.existsSync(CFG)) return false;
    const now = Date.now(), st = loadState();
    if (key && st[key] && now - st[key] < throttleMin * 60_000) return false;
    if (key) { st[key] = now; for (const k of Object.keys(st)) if (now - st[k] > 7 * 864e5) delete st[k]; fs.writeFileSync(STATE, JSON.stringify(st)); }
    if (EXEC) return spawnSync(EXEC, [`SharePot · ${title}`, String(body).slice(0, 3000), String(key ?? title)], { stdio: "ignore", timeout: 20_000 }).status === 0;
    const { bot_token, chat_id } = JSON.parse(fs.readFileSync(CFG, "utf8"));
    const text = `SharePot · ${title}\n${body}`.slice(0, 3900);
    const r = await fetch(`https://api.telegram.org/bot${bot_token}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id, text, disable_web_page_preview: true }), signal: AbortSignal.timeout(10_000) });
    return r.ok;
  } catch { return false; }
}
