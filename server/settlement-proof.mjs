// Proof that a settlement row is real, for the machine that pays rebates out of the treasury.
//
// settlements.jsonl is written on the app host, the one machine in this system that is online and holds a hot key. The
// treasury key lives elsewhere precisely so that the app host cannot move treasury money — which is worth nothing if
// the treasury then pays whatever that host's files say. So before a row earns anybody a rebate, the payer asks the
// chain: the row's signature must be a successful transaction in which THIS program emitted PositionSettled for the
// same market, owner and fee, and the row's mint must be a token that moved in it. A forged row has no such
// transaction. Bindings stay the app host's word, but a false binding can only redirect a share (at most 40 %) of a
// fee that was really paid, never create one.
//
// Verdicts are remembered in a local file (rows never change), so each row costs one RPC call, once.
import fs from "node:fs";
import anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import idlJson from "../idl/sharepot.json" with { type: "json" };

const programId = new PublicKey(idlJson.address);
const parser = new anchor.EventParser(programId, new anchor.BorshCoder(idlJson));

/** Pure check of one fetched transaction against one row. Returns null when it proves the row, else the reason. */
export function disproof(row, tx) {
  if (!tx) return "transaction not found";
  if (tx.meta?.err) return "transaction failed on-chain";
  const mints = new Set([...(tx.meta?.preTokenBalances ?? []), ...(tx.meta?.postTokenBalances ?? [])].map((b) => b.mint));
  if (!mints.has(row.mint)) return "the row's token did not move in this transaction";
  for (const ev of parser.parseLogs(tx.meta?.logMessages ?? [])) {
    if (ev.name !== "PositionSettled" && ev.name !== "positionSettled") continue;
    const d = ev.data;
    if (d.market.toBase58() === row.market && d.user.toBase58() === row.owner && d.fee.toString() === String(row.fee)) return null;
  }
  return "no PositionSettled event of this program matches the row's market, owner and fee";
}

/**
 * Split rows into those the chain confirms and those it does not. Only rows that can earn a rebate are looked up
 * (`wanted(row)`); the rest pass through untouched, they move no money. A lookup that fails (RPC down, rate limit) is
 * "unknown": the row is held back this run and asked again next time, never paid on faith.
 */
export async function provenRows(conn, rows, { cacheFile, wanted, log = () => {}, pauseMs = 400 }) {
  let cache = {}; try { cache = JSON.parse(fs.readFileSync(cacheFile, "utf8")); } catch (e) { if (e?.code !== "ENOENT") throw e; }
  const ok = [], rejected = [], unknown = [];
  for (const r of rows) {
    if (!wanted(r)) { ok.push(r); continue; }
    if (!r.signature) { rejected.push({ row: r, why: "row has no signature" }); continue; }
    const key = `${r.signature}:${r.owner}:${r.fee}:${r.mint}`;
    if (cache[key] === true) { ok.push(r); continue; }
    if (typeof cache[key] === "string") { rejected.push({ row: r, why: cache[key] }); continue; }
    let tx, failed = false;
    for (let attempt = 1; attempt <= 4; attempt++) {
      try { tx = await conn.getTransaction(r.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }); failed = false; break; }
      catch (e) { failed = true; await new Promise((res) => setTimeout(res, 1500 * attempt)); }
    }
    if (failed) { unknown.push({ row: r, why: "lookup failed" }); continue; }
    // "not found" can be a node that has not caught up or has pruned: hold, do not brand the row a forgery for good
    if (!tx) { unknown.push({ row: r, why: "transaction not found (yet)" }); continue; }
    const why = disproof(r, tx);
    cache[key] = why ?? true;
    if (why) { rejected.push({ row: r, why }); log(`REJECTED settlement row ${r.signature}: ${why}`); } else ok.push(r);
    await new Promise((res) => setTimeout(res, pauseMs));
  }
  const tmp = `${cacheFile}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(cache)); fs.renameSync(tmp, cacheFile);
  return { ok, rejected, unknown };
}
