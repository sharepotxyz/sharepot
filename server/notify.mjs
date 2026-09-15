// Telegram alert for events that need a human decision (disputes, held-back or failed settlements).
// Never throws: alerting must not take the caller down. Throttled per key (default 30 min). Config file
// ~/secrets/telegram.json = { "bot_token": "...", "chat_id": "..." }; without it every call is a silent no-op.
import fs from "node:fs"; import path from "node:path"; import os from "node:os";
const CFG = process.env.TELEGRAM_CONFIG ?? path.join(os.homedir(), "secrets", "telegram.json");
const last = new Map();
export async function notify(title, body, key = title, throttleMin = 30) {
  try {
    if (!fs.existsSync(CFG)) return false;
    const { bot_token, chat_id } = JSON.parse(fs.readFileSync(CFG, "utf8"));
    const now = Date.now(); if (key && last.has(key) && now - last.get(key) < throttleMin * 60_000) return false; if (key) last.set(key, now);
    const text = `SharePot · ${title}\n${body}`.slice(0, 3900);
    const r = await fetch(`https://api.telegram.org/bot${bot_token}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id, text, disable_web_page_preview: true }), signal: AbortSignal.timeout(10_000) });
    return r.ok;
  } catch { return false; }
}
