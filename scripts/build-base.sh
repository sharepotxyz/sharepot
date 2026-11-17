#!/usr/bin/env bash
# Builds web/<outdir> (default dist-base): the SharePot Perp site, with the chain, RPC, explorer and pool/token
# addresses taken from server/evm/chains.json through scripts/base-env.mjs (checked there), never typed by hand.
# Usage: bash scripts/build-base.sh [chain-key=base-sepolia] [outdir=dist-base]
set -euo pipefail
R=$(cd "$(dirname "$0")/.." && pwd)
envs=$(node "$R/scripts/base-env.mjs" "${1:-base-sepolia}")
eval "$envs"
cd "$R/web"
VITE_OUT_DIR="${2:-dist-base}" npm run build 2>&1 | tail -2
test -f "${2:-dist-base}/perp.html" && test -f "${2:-dist-base}/perp-history.html" && test -f "${2:-dist-base}/perp-me.html" && test -f "${2:-dist-base}/perp-docs.html" || { echo "build-base: a page is missing"; exit 5; }
echo "build-base: ${VITE_EVM_NAME} (chain ${VITE_EVM_CHAIN_ID}) pool ${VITE_PERP} → web/${2:-dist-base}"
