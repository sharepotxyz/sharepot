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

# 1. pull: settlements (append-only), bindings and the token registry (names / decimals). The payout ledger is NOT
#    pulled: this host is the only writer, so the local copy is the truth and the app host only ever holds a copy.
#    (Pulling it would overwrite local rows whenever the previous push had failed — and pay them all again.) It is
#    fetched once, only when this host has no ledger at all (first run, or a rebuilt host).
rsync -az "$REMOTE:$REMOTE_DATA/settlements.jsonl" "$REMOTE:$REMOTE_DATA/referrals.json" "$REMOTE:$REMOTE_DATA/chain-tokens.json" "$LOCAL_DATA/" 2>/dev/null || true
LEDGER="$LOCAL_DATA/referral-payouts.jsonl"
if [ ! -f "$LEDGER" ]; then rsync -az "$REMOTE:$REMOTE_DATA/referral-payouts.jsonl" "$LOCAL_DATA/" 2>/dev/null && log "ledger fetched from the app host (this host had none)" || true; fi
rows() { [ -f "$1" ] && wc -l < "$1" || echo 0; }
before=$(rows "$LEDGER")

# 2. pay from the treasury. A non-zero exit still pushes whatever the ledger now holds (step 3), so a payment recorded
#    before a crash is never invisible to the site.
status=0
CLUSTER="$CLUSTER" CLUSTER_RPC="$RPC" DATA_DIR="$LOCAL_DATA" REBATE_KEYPAIR="$TREASURY_KEYPAIR" DRY_RUN="${DRY_RUN:-0}" "$NODE" server/referral-payout.mjs || status=$?

# 3. push the ledger back, always: the app host must never be ahead of, or diverge from, this copy
after=$(rows "$LEDGER")
if [ -f "$LEDGER" ]; then
  rsync -az "$LEDGER" "$REMOTE:$REMOTE_DATA/referral-payouts.jsonl"
  log "ledger pushed: $before → $after rows"
fi
exit $status
