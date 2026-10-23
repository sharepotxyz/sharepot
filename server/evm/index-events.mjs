// Positions on the EVM contract live in a mapping, so who holds one is only known from events. This keeps a local
// copy of every BetPlaced / PositionSettled / PositionForfeited event (append-only jsonl + a block cursor), scanning
// in windows the public RPC accepts, and derives the set of positions still open. Idempotent; run before settling and
// from cron, or import `sync` + `openPositions`. `repairGaps` re-reads a closed market whose on-chain bettor count
// the index falls short of.
//   env: DATA_DIR, EVM_CHAIN (chain.mjs), EVM_FROM_BLOCK (first scan only; default chains.json deployBlock),
//        EVM_LOG_CONFIRM (blocks below the head read again by every sync)
import fs from "node:fs";
import path from "node:path";
import { parseAbiItem } from "viem";
import { publicClient, potAddress, chainCfg, CHAIN_KEY, Status } from "./chain.mjs";

const EVENTS = [
  parseAbiItem("event BetPlaced(uint256 indexed id, address indexed user, uint8 bucket, uint256 amount, uint16 feeBps, uint256[8] pools)"),
  parseAbiItem("event PositionSettled(uint256 indexed id, address indexed user, uint256 payout, uint256 fee)"),
  parseAbiItem("event PositionForfeited(uint256 indexed id, address indexed user, uint256 amount)"),
  parseAbiItem("event MarketSeeded(uint256 indexed id, address indexed funder, uint256 amount)"),
];
const WINDOW = Number(process.env.EVM_LOG_WINDOW ?? 40_000);
// The public RPC is several nodes behind one address, and a node a few blocks behind the head another one just reported
// answers eth_getLogs for the blocks it lacks with an empty list, not an error. So every sync reads the newest CONFIRM
// blocks again (~4 minutes at ~8 blocks/s) and appends only the rows the file does not hold yet. 2026-10-21: a bet on
// #343 mined 03:43:25Z never reached the index; the position won and sat unpaid for 27 hours.
const CONFIRM = Number(process.env.EVM_LOG_CONFIRM ?? 2_000);
const REPAIR_EVERY_SECS = 3600;
const log = (...a) => console.log(new Date().toISOString(), ...a);

export const evmDir = (dataDir) => path.join(dataDir, "evm", CHAIN_KEY);
const cursorFile = (dataDir) => path.join(evmDir(dataDir), "events.cursor");
export const eventsFile = (dataDir) => path.join(evmDir(dataDir), "events.jsonl");
const repairFile = (dataDir) => path.join(evmDir(dataDir), "events.repair");
const keyOf = (r) => `${r.tx}:${r.logIndex}`;
const rowOf = (l) => ({ event: l.eventName, id: Number(l.args.id), user: l.args.user ?? l.args.funder, block: Number(l.blockNumber), tx: l.transactionHash, logIndex: l.logIndex,
  ...(l.eventName === "BetPlaced" ? { bucket: Number(l.args.bucket), amount: l.args.amount.toString(), feeBps: Number(l.args.feeBps) } : {}),
  ...(l.eventName === "PositionSettled" ? { payout: l.args.payout.toString(), fee: l.args.fee.toString() } : {}),
  ...(l.eventName === "PositionForfeited" || l.eventName === "MarketSeeded" ? { amount: l.args.amount.toString() } : {}) });
let tmpSeq = 0;

/** Reads blocks [from, to] window by window and appends the rows the file does not hold yet; `done(end)` runs after each window is on disk. */
async function scan(dataDir, from, to, client, done = () => {}) {
  const known = new Set(readEvents(dataDir).map(keyOf));
  let added = 0;
  for (; from <= to; from += WINDOW) {
    const end = Math.min(to, from + WINDOW - 1);
    const logs = await client.getLogs({ address: potAddress(), events: EVENTS, fromBlock: BigInt(from), toBlock: BigInt(end) });
    const rows = logs.map(rowOf).filter((r) => !known.has(keyOf(r)));
    if (rows.length) fs.appendFileSync(eventsFile(dataDir), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    for (const r of rows) known.add(keyOf(r));
    added += rows.length;
    done(end);
  }
  return added;
}

/** Scan new blocks for the contract's position events and append them. Returns the number of events added. */
export async function sync(dataDir, client = publicClient) {
  fs.mkdirSync(evmDir(dataDir), { recursive: true });
  const head = Number(await client.getBlockNumber());
  const start = Number(fs.existsSync(cursorFile(dataDir)) ? fs.readFileSync(cursorFile(dataDir), "utf8") : (process.env.EVM_FROM_BLOCK ?? chainCfg.deployBlock ?? head));
  // the cursor is written after the rows (a crash between the two re-scans a window) and stops CONFIRM blocks short
  // of the head; the temp name is per call, as the site and the resolver sync the same file
  return scan(dataDir, start, head, client, (end) => {
    const tmp = `${cursorFile(dataDir)}.${process.pid}.${++tmpSeq}.tmp`;
    fs.writeFileSync(tmp, String(Math.max(start, Math.min(end, head - CONFIRM) + 1))); fs.renameSync(tmp, cursorFile(dataDir));
  });
}

/** Re-reads blocks fromBlock…head and appends whatever the index lacks; the cursor is left alone. Returns the rows added. */
export async function backfill(dataDir, fromBlock, client = publicClient) {
  fs.mkdirSync(evmDir(dataDir), { recursive: true });
  return scan(dataDir, Math.max(Number(fromBlock), chainCfg.deployBlock ?? 0), Number(await client.getBlockNumber()), client);
}

/** Markets whose betting has closed (not yet swept) with more bettors on-chain than in the index. Only positions the
 *  index knows are ever settled, so a bet it never saw would stay unpaid and its market unswept for good. */
export function marketsShort(dataDir, markets, now) {
  const bettors = new Map();
  for (const r of readEvents(dataDir)) if (r.event === "BetPlaced") { if (!bettors.has(r.id)) bettors.set(r.id, new Set()); bettors.get(r.id).add(r.user.toLowerCase()); }
  return markets.filter((m) => m.status !== Status.Swept && now > m.closeTs + 120 && m.positions > (bettors.get(m.id)?.size ?? 0));
}

/** Backfills from the creation block (markets-opened.jsonl) of the oldest market `marketsShort` finds; the same markets
 *  at most once an hour, so a gap the RPC never fills costs one re-read an hour. Returns { ids, from, added } when it ran. */
export async function repairGaps(dataDir, markets, now, client = publicClient) {
  const behind = marketsShort(dataDir, markets, now);
  if (!behind.length) return null;
  const ids = behind.map((m) => m.id);
  const [lastIds, lastAt] = (fs.existsSync(repairFile(dataDir)) ? fs.readFileSync(repairFile(dataDir), "utf8") : "").trim().split(" ");
  if (lastIds === ids.join(",") && now - Number(lastAt) < REPAIR_EVERY_SECS) return null;
  const opened = new Map();
  let lines = []; try { lines = fs.readFileSync(path.join(evmDir(dataDir), "markets-opened.jsonl"), "utf8").split("\n").filter(Boolean); } catch (e) { if (e.code !== "ENOENT") throw e; }
  for (const l of lines) { try { const r = JSON.parse(l); if (Number.isInteger(r.block)) opened.set(r.id, r.block); } catch {} }
  // ids are created in order: a market missing its row starts no earlier than the nearest lower id that has one
  const createdAt = (id) => { for (let k = id; k >= 0; k--) if (opened.has(k)) return opened.get(k); return chainCfg.deployBlock ?? 0; };
  const from = Math.min(...behind.map((m) => createdAt(m.id)));
  const added = await backfill(dataDir, from, client);
  fs.writeFileSync(repairFile(dataDir), `${ids.join(",")} ${now}\n`);
  return { ids, from, added };
}

export function readEvents(dataDir) {
  let lines = []; try { lines = fs.readFileSync(eventsFile(dataDir), "utf8").split("\n").filter(Boolean); } catch (e) { if (e.code !== "ENOENT") throw e; }
  const seen = new Set(), out = [];
  for (const l of lines) { let r; try { r = JSON.parse(l); } catch { continue; } const k = keyOf(r); if (seen.has(k)) continue; seen.add(k); out.push(r); }
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
