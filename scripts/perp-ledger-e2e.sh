#!/usr/bin/env bash
# Checks the /me ledger (web/src/perp-ledger.ts: each settled day's price move and funding per position, the fees)
# against a real SharePotPerp on a local anvil chain; the days and checks are in scripts/perp-ledger-e2e.mjs.
# Exit 0 only when every check holds.   Usage: bash scripts/perp-ledger-e2e.sh   (PERP_LEDGER_SRC=<file> checks another copy)
set -euo pipefail
export PATH=/root/stocklana/tools/node22/bin:$HOME/.foundry/bin:$PATH
R=$(cd "$(dirname "$0")/.." && pwd); D=$(mktemp -d); RPC=http://127.0.0.1:${PERP_LEDGER_E2E_PORT:-8547}
MN="test test test test test test test test test test test junk"
K0=$(cast wallet private-key --mnemonic "$MN" --mnemonic-index 0)
A0=$(cast wallet address "$K0"); A2=$(cast wallet address "$(cast wallet private-key --mnemonic "$MN" --mnemonic-index 2)")
anvil --port "${RPC##*:}" --silent & AP=$!
trap 'kill $AP 2>/dev/null; rm -rf "$D"' EXIT
timeout 15 bash -c "until cast block-number --rpc-url $RPC >/dev/null 2>&1; do sleep 0.2; done"
# the admin is also the operator here: it schedules, proposes, skips and settles at once
out=$(cd "$R/evm" && OPERATOR=$A0 TREASURY=$A2 forge script script/DeployPerp.s.sol --rpc-url $RPC --private-key "$K0" --broadcast 2>&1)
TOKEN=$(echo "$out" | awk '/MockStock NVDAc/{print $3}'); PERP=$(echo "$out" | awk '/SharePotPerp 0x/{print $2}')
[ -n "$TOKEN" ] && [ -n "$PERP" ] || { echo "deploy failed"; echo "$out" | tail -20; exit 1; }
"$R/web/node_modules/.bin/esbuild" "${PERP_LEDGER_SRC:-$R/web/src/perp-ledger.ts}" --format=esm --log-level=warning --outfile="$D/ledger.mjs"
node "$R/scripts/perp-ledger-e2e.mjs" "$RPC" "$PERP" "$TOKEN" "$D/ledger.mjs"
