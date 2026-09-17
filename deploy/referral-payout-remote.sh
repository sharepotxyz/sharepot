#!/usr/bin/env bash
# Weekly referral payout, run where the treasury key lives (not on the app host): pull the settlement log and the
# referral bindings from the app host, pay from the treasury's own token accounts (rebates are a share of collected
# fees, so the treasury always holds enough), push the payout ledger back so the site shows what was paid.
#
#   REMOTE=sharepot-ops CLUSTER=devnet TREASURY_KEYPAIR=/path/to/key.json deploy/referral-payout-remote.sh
#   DRY_RUN=1 previews. REMOTE_DATA defaults to ~/data on the app host; LOCAL_DATA to ../payout-data/<cluster>.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${REMOTE:?ssh host alias of the app host}" "${CLUSTER:?devnet|mainnet}" "${TREASURY_KEYPAIR:?path to the treasury keypair}"
REMOTE_DATA="${REMOTE_DATA:-data}"                      # relative to the remote user's home
LOCAL_DATA="${LOCAL_DATA:-$(pwd)/../payout-data/$CLUSTER}"
RPC="${CLUSTER_RPC:-$([ "$CLUSTER" = mainnet ] && echo https://api.mainnet-beta.solana.com || echo https://api.devnet.solana.com)}"
NODE="${NODE:-$(command -v node)}"
mkdir -p "$LOCAL_DATA"
log() { echo "$(date -u +%FT%TZ) $*"; }

# 1. pull: settlements (append-only), bindings, the token registry (names / decimals) and the ledger as it stands
rsync -az "$REMOTE:$REMOTE_DATA/settlements.jsonl" "$REMOTE:$REMOTE_DATA/referrals.json" "$REMOTE:$REMOTE_DATA/chain-tokens.json" "$LOCAL_DATA/" 2>/dev/null || true
rsync -az "$REMOTE:$REMOTE_DATA/referral-payouts.jsonl" "$LOCAL_DATA/" 2>/dev/null || true
rows() { [ -f "$1" ] && wc -l < "$1" || echo 0; }
before=$(rows "$LOCAL_DATA/referral-payouts.jsonl")

# 2. pay from the treasury
CLUSTER="$CLUSTER" CLUSTER_RPC="$RPC" DATA_DIR="$LOCAL_DATA" REBATE_KEYPAIR="$TREASURY_KEYPAIR" DRY_RUN="${DRY_RUN:-0}" "$NODE" server/referral-payout.mjs

# 3. push the ledger back (only this job ever appends to it, so the local copy is the truth)
after=$(rows "$LOCAL_DATA/referral-payouts.jsonl")
if [ "$after" -gt "$before" ]; then
  rsync -az "$LOCAL_DATA/referral-payouts.jsonl" "$REMOTE:$REMOTE_DATA/referral-payouts.jsonl"
  log "ledger pushed: $before → $after rows"
else
  log "nothing paid; ledger unchanged ($after rows)"
fi
