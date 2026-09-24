// Positions on the EVM contract live in a mapping, so who holds one is only known from events. This keeps a local
// copy of every BetPlaced / PositionSettled / PositionForfeited event (append-only jsonl + a block cursor), scanning
// in windows the public RPC accepts, and derives the set of positions still open. Idempotent; run before settling and
// from cron, or import `sync` + `openPositions`.
//   env: DATA_DIR, EVM_CHAIN (chain.mjs), EVM_FROM_BLOCK (first scan only; default chains.json deployBlock)
import fs from "node:fs";
import path from "node:path";
import { parseAbiItem } from "viem";
import { publicClient, potAddress, chainCfg, CHAIN_KEY } from "./chain.mjs";

const EVENTS = [
  parseAbiItem("event BetPlaced(uint256 indexed id, address indexed user, uint8 bucket, uint256 amount, uint16 feeBps, uint256[8] pools)"),
  parseAbiItem("event PositionSettled(uint256 indexed id, address indexed user, uint256 payout, uint256 fee)"),
  parseAbiItem("event PositionForfeited(uint256 indexed id, address indexed user, uint256 amount)"),
  parseAbiItem("event MarketSeeded(uint256 indexed id, address indexed funder, uint256 amount)"),
];
const WINDOW = Number(process.env.EVM_LOG_WINDOW ?? 40_000);
const log = (...a) => console.log(new Date().toISOString(), ...a);

export const evmDir = (dataDir) => path.join(dataDir, "evm", CHAIN_KEY);
const cursorFile = (dataDir) => path.join(evmDir(dataDir), "events.cursor");
export const eventsFile = (dataDir) => path.join(evmDir(dataDir), "events.jsonl");

/** Scan new blocks for the contract's position events and append them. Returns the number of events added. */
export async function sync(dataDir) {
  fs.mkdirSync(evmDir(dataDir), { recursive: true });
  const head = Number(await publicClient.getBlockNumber());
  let from = Number(fs.existsSync(cursorFile(dataDir)) ? fs.readFileSync(cursorFile(dataDir), "utf8") : (process.env.EVM_FROM_BLOCK ?? chainCfg.deployBlock ?? head));
  let added = 0;
  while (from <= head) {
    const to = Math.min(head, from + WINDOW - 1);
    const logs = await publicClient.getLogs({ address: potAddress(), events: EVENTS, fromBlock: BigInt(from), toBlock: BigInt(to) });
    const rows = logs.map((l) => ({ event: l.eventName, id: Number(l.args.id), user: l.args.user ?? l.args.funder, block: Number(l.blockNumber), tx: l.transactionHash, logIndex: l.logIndex,
      ...(l.eventName === "BetPlaced" ? { bucket: Number(l.args.bucket), amount: l.args.amount.toString(), feeBps: Number(l.args.feeBps) } : {}),
      ...(l.eventName === "PositionSettled" ? { payout: l.args.payout.toString(), fee: l.args.fee.toString() } : {}),
      ...(l.eventName === "PositionForfeited" || l.eventName === "MarketSeeded" ? { amount: l.args.amount.toString() } : {}) }));
    // the cursor is written after the rows: a crash between the two re-scans a window, and readers drop duplicates
    if (rows.length) fs.appendFileSync(eventsFile(dataDir), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    fs.writeFileSync(cursorFile(dataDir) + ".tmp", String(to + 1)); fs.renameSync(cursorFile(dataDir) + ".tmp", cursorFile(dataDir));
    added += rows.length; from = to + 1;
  }
  return added;
}

export function readEvents(dataDir) {
  let lines = []; try { lines = fs.readFileSync(eventsFile(dataDir), "utf8").split("\n").filter(Boolean); } catch (e) { if (e.code !== "ENOENT") throw e; }
  const seen = new Set(), out = [];
  for (const l of lines) { let r; try { r = JSON.parse(l); } catch { continue; } const k = `${r.tx}:${r.logIndex}`; if (seen.has(k)) continue; seen.add(k); out.push(r); }
  return out;
}

/** { "<id>": Set<owner> } of positions that have been bet on and not yet settled or forfeited, per the event log. */
export function openPositions(dataDir) {
  const open = new Map();
  for (const r of readEvents(dataDir)) {
    if (r.event === "BetPlaced") { if (!open.has(r.id)) open.set(r.id, new Set()); open.get(r.id).add(r.user.toLowerCase()); }
    else if (r.event === "PositionSettled" || r.event === "PositionForfeited") open.get(r.id)?.delete(r.user.toLowerCase());
  }
  return open;
}

/** Every bet a wallet placed, newest first, with the settlement row when there is one. */
export function walletHistory(dataDir, wallet) {
  const w = String(wallet).toLowerCase(), bets = [], settled = new Map();
  for (const r of readEvents(dataDir)) {
    if (r.user?.toLowerCase() !== w) continue;
    if (r.event === "BetPlaced") bets.push(r); else if (r.event !== "MarketSeeded") settled.set(r.id, r);
  }
  return { bets: bets.reverse(), settled: Object.fromEntries(settled) };
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const dataDir = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
  const n = await sync(dataDir);
  const open = openPositions(dataDir);
  log(`${CHAIN_KEY}: ${n} new event(s); open positions: ${[...open.entries()].map(([id, s]) => `#${id}×${s.size}`).join(" ") || "none"}`);
}
