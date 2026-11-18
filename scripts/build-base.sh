#!/usr/bin/env bash
# Builds web/<outdir> (default dist-base): the SharePot Perp site, with the chain, RPC, explorer and pool/token
# addresses taken from server/evm/chains.json through scripts/base-env.mjs (checked there), never typed by hand.
# Usage: bash scripts/build-base.sh [chain-key=base-sepolia] [outdir=dist-base]
set -euo pipefail
R=$(cd "$(dirname "$0")/.." && pwd)
envs=$(node "$R/scripts/base-env.mjs" "${1:-base-sepolia}")
eval "$envs"
cd "$R/web"
# Built beside the live directory and swapped in when complete: the site keeps serving the previous build meanwhile
# (vite empties its outDir first). The previous build's assets are kept for a week: Cloudflare keeps a page up to a
# minute (s-maxage=60, perp-site.mjs), and that copy still names the old hashed files.
out="${2:-dist-base}"; out="${out%/}"; tmp="$out.building"
rm -rf "$tmp"
VITE_OUT_DIR="$tmp" npm run build 2>&1 | tail -2
for page in perp perp-history perp-me perp-faucet perp-docs; do test -f "$tmp/$page.html" || { echo "build-base: $page.html is missing"; rm -rf "$tmp"; exit 5; }; done
if [ -d "$out/assets" ]; then
  cp -pn "$out"/assets/* "$tmp/assets/" 2>/dev/null || true
  find "$tmp/assets" -type f -mtime +7 -delete
fi
rm -rf "$out.old"; if [ -d "$out" ]; then mv "$out" "$out.old"; fi; mv "$tmp" "$out"; rm -rf "$out.old"
echo "build-base: ${VITE_EVM_NAME} (chain ${VITE_EVM_CHAIN_ID}) pool ${VITE_PERP} → web/$out"
