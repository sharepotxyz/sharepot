// An event is one stock × one New York session ("Where does SPCX close on Tue, Sep 15?"). Every issuer's token of that
// stock has its own pool (an on-chain market); they share the thresholds and the result. The home page shows events;
// the event page lets you pick the token and see its pool.
import { NO_OUTCOME, totalPool, type MarketView } from "./chain";
import { STOCK_NAMES, categoryOf, parseMetric, priceOf, tokenSymbol, tokensOf, uiAmount, type Category } from "./stocks";

export type EventStatus = "open" | "trading" | "proposed" | "resolved";
export type EventView = {
  key: string; symbol: string; name: string; date: string; markets: MarketView[]; nBuckets: number; category: Category; kind: "close" | "day";
  closeTs: number; resolveAfterTs: number; status: EventStatus;
  potUsd: number | null; bettors: number;
  dist: number[];                 // share of the money on each range (dollar-weighted across tokens), sums to 1 or all 0
  outcome: number | null;         // final range once resolved
  proposed: number | null;        // proposed range while in the dispute window
  moveValue: number | null;       // observed move in ppm, once proposed
};
export const eventKey = (m: MarketView) => { const p = parseMetric(m.metric); return p ? `${p.symbol}:${p.date}` : `m${m.id}`; };
export function statusOf(m: MarketView): EventStatus {
  if (m.status === 0) return Date.now() / 1000 < m.closeTs ? "open" : "trading";
  return m.status === 1 ? "proposed" : "resolved";
}
const RANK: Record<EventStatus, number> = { open: 0, trading: 1, proposed: 2, resolved: 3 };
export const STATUS_LABEL: Record<EventStatus, string> = { open: "Betting open", trading: "Awaiting close", proposed: "Result proposed", resolved: "Resolved" };

export function buildEvents(ms: MarketView[]): EventView[] {
  const by = new Map<string, MarketView[]>();
  for (const m of ms) { const k = eventKey(m); if (!by.has(k)) by.set(k, []); by.get(k)!.push(m); }
  const out: EventView[] = [];
  for (const [key, list] of by) {
    const p = parseMetric(list[0].metric), symbol = p?.symbol ?? "?";
    const order = tokensOf(symbol).map((t) => t.token);
    list.sort((a, b) => order.indexOf(tokenSymbol(a)) - order.indexOf(tokenSymbol(b)) || a.id - b.id);
    const n = list[0].nBuckets;
    const usd = new Array(n).fill(0), frac = new Array(n).fill(0);
    let potUsd = 0, priced = false, fracCount = 0;
    for (const m of list) {
      const tot = totalPool(m), px = priceOf(m);
      if (tot) { m.pools.forEach((v, i) => (frac[i] += v / tot)); fracCount++; }
      if (px) { priced = true; m.pools.forEach((v, i) => (usd[i] += uiAmount(m, v) * px)); potUsd += uiAmount(m, tot + m.seed) * px; }
    }
    const usdTot = usd.reduce((a, b) => a + b, 0);
    const dist = usdTot > 0 ? usd.map((v) => v / usdTot) : fracCount ? frac.map((v) => v / fracCount) : new Array(n).fill(0);
    const final = list.find((m) => (m.status === 2 || m.status === 4) && m.outcome !== NO_OUTCOME);
    const prop = list.find((m) => m.status === 1);
    out.push({
      key, symbol, name: STOCK_NAMES[symbol] ?? symbol, date: p?.date ?? "", markets: list, nBuckets: n, category: categoryOf(symbol), kind: p?.kind ?? "close",
      closeTs: Math.min(...list.map((m) => m.closeTs)), resolveAfterTs: Math.max(...list.map((m) => m.resolveAfterTs)),
      status: list.map(statusOf).sort((a, b) => RANK[a] - RANK[b])[0],
      potUsd: priced ? potUsd : null, bettors: list.reduce((a, m) => a + m.positions, 0), dist,
      outcome: final ? final.outcome : null, proposed: prop ? prop.proposedOutcome : null,
      moveValue: final?.proposedAt ? final.proposedValue : prop ? prop.proposedValue : null,
    });
  }
  return out;
}

/** What a winning stake returns per unit staked on range i of market m if the pools stay as they are (fee included).
 *  null when nobody has backed that range yet (the first backer would take the whole pot). */
export function payoutMultiple(m: MarketView, i: number, feeBps: number) {
  const win = m.pools[i], lose = totalPool(m) - win;
  if (!win) return null;
  return 1 + (lose * (1 - feeBps / 10000) + m.seed) / win;
}
