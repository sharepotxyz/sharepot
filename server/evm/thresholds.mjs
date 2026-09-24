// Four-bucket cut-offs for a stock: the 25th / 50th / 75th percentile of its close-to-close moves (bps) over the last
// 60 New York sessions, from Yahoo's daily bars — the rule stock-templates.json's thresholdsBps follow.
//   node server/evm/thresholds.mjs TSLA AMZN PLTR
const syms = process.argv.slice(2);
const now = Math.floor(Date.now() / 1000);
for (const s of syms) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${s}?period1=${now - 120 * 86400}&period2=${now}&interval=1d`;
  const r = (await (await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (SharePot)" } })).json()).chart?.result?.[0];
  const closes = (r?.indicators?.quote?.[0]?.close ?? []).filter((c) => typeof c === "number");
  const bars = closes.slice(-61);
  const moves = bars.slice(1).map((c, i) => Math.round((c / bars[i] - 1) * 1e4)).sort((a, b) => a - b);
  const q = (p) => moves[Math.min(moves.length - 1, Math.floor(p * moves.length))];
  console.log(JSON.stringify({ symbol: s, sessions: moves.length, thresholdsBps: [q(0.25), q(0.5), q(0.75)], last: bars.at(-1) }));
}
