// Proof that an EVM settlement row is real, for the machine that pays rebates out of the treasury (the same idea as
// server/settlement-proof.mjs on Solana): the row's transaction must be a successful one in which THIS contract
// emitted PositionSettled for the same market id, owner and fee, and — when it paid anything — the row's token must
// have moved in it. A forged row has no such transaction. Verdicts are remembered in a local file (rows never change).
import fs from "node:fs";
import { decodeEventLog, parseAbiItem } from "viem";

const SETTLED = parseAbiItem("event PositionSettled(uint256 indexed id, address indexed user, uint256 payout, uint256 fee)");
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** Pure check of one receipt against one row. Returns null when it proves the row, else the reason. */
export function disproof(row, receipt, pot) {
  if (!receipt) return "transaction not found";
  if (receipt.status !== "success") return "transaction failed on-chain";
  const potL = String(pot).toLowerCase(), mintL = String(row.mint).toLowerCase(), ownerL = String(row.owner).toLowerCase();
  let matched = null;
  for (const l of receipt.logs) {
    if (String(l.address).toLowerCase() !== potL) continue;
    let ev; try { ev = decodeEventLog({ abi: [SETTLED], data: l.data, topics: l.topics }); } catch { continue; }
    if (ev.eventName !== "PositionSettled") continue;
    if (Number(ev.args.id) === Number(row.id) && String(ev.args.user).toLowerCase() === ownerL && ev.args.fee.toString() === String(row.fee)) { matched = ev.args; break; }
  }
  if (!matched) return "no PositionSettled event of this contract matches the row's market, owner and fee";
  if (matched.payout > 0n && !receipt.logs.some((l) => String(l.address).toLowerCase() === mintL && l.topics[0] === TRANSFER_TOPIC)) return "the row's token did not move in this transaction";
  return null;
}

/**
 * Split rows into those the chain confirms and those it does not. Only rows that can earn a rebate are looked up
 * (`wanted(row)`); the rest pass through untouched. A lookup that fails (RPC down, rate limit) is "unknown": the row
 * is held back this run and asked again next time, never paid on faith.
 */
export async function provenRows(publicClient, pot, rows, { cacheFile, wanted, log = () => {}, pauseMs = 300 }) {
  let cache = {}; try { cache = JSON.parse(fs.readFileSync(cacheFile, "utf8")); } catch (e) { if (e?.code !== "ENOENT") throw e; }
  const ok = [], rejected = [], unknown = [];
  for (const r of rows) {
    if (!wanted(r)) { ok.push(r); continue; }
    if (!r.tx) { rejected.push({ row: r, why: "row has no transaction hash" }); continue; }
    const key = `${r.tx}:${r.owner}:${r.fee}:${r.mint}`;
    if (cache[key] === true) { ok.push(r); continue; }
    if (typeof cache[key] === "string") { rejected.push({ row: r, why: cache[key] }); continue; }
    let receipt, failed = false, missing = false;
    for (let attempt = 1; attempt <= 4; attempt++) {
      try { receipt = await publicClient.getTransactionReceipt({ hash: r.tx }); failed = false; missing = false; break; }
      catch (e) { if (/not (be )?found|could not be found/i.test(String(e?.shortMessage ?? e?.message ?? e))) { missing = true; failed = false; break; } failed = true; await new Promise((res) => setTimeout(res, 1500 * attempt)); }
    }
    if (failed) { unknown.push({ row: r, why: "lookup failed" }); continue; }
    if (missing) { unknown.push({ row: r, why: "transaction not found (yet)" }); continue; }
    const why = disproof(r, receipt, pot);
    cache[key] = why ?? true;
    if (why) { rejected.push({ row: r, why }); log(`REJECTED settlement row ${r.tx}: ${why}`); } else ok.push(r);
    await new Promise((res) => setTimeout(res, pauseMs));
  }
  const tmp = `${cacheFile}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(cache)); fs.renameSync(tmp, cacheFile);
  return { ok, rejected, unknown };
}
