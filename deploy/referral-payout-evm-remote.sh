#!/usr/bin/env bash
# Weekly referral payout for the EVM deployment, run where the rebate key lives (not on the app host): pull the
# chain's settlement log, referral bindings and token registry from the app host, pay from the rebate wallet
# (server/evm/referral-payout.mjs), push the payout ledger back so the site shows what was paid.
#
#   REMOTE=sharepot-ops EVM_CHAIN=robinhood-testnet REBATE_KEY_FILE=/path/to/key deploy/referral-payout-evm-remote.sh
#   DRY_RUN=1 previews. REMOTE_DATA defaults to data/evm/<chain> on the app host; LOCAL_DATA to ../payout-data/evm-<chain>.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${REMOTE:?ssh host alias of the app host}" "${EVM_CHAIN:?robinhood-testnet|robinhood}" "${REBATE_KEY_FILE:?path to the rebate wallet key}"
REMOTE_DATA="${REMOTE_DATA:-data/evm/$EVM_CHAIN}"
LOCAL_DATA="${LOCAL_DATA:-$(pwd)/../payout-data/evm-$EVM_CHAIN}"
NODE="${NODE:-$(command -v node)}"
mkdir -p "$LOCAL_DATA"
log() { echo "$(date -u +%FT%TZ) $*"; }

# 1. pull: settlements (append-only), bindings and the token registry. The payout ledger is NOT pulled: this host is
#    the only writer (see deploy/referral-payout-remote.sh for why); it is fetched once, only when there is none here.
rsync -az "$REMOTE:$REMOTE_DATA/settlements.jsonl" "$REMOTE:$REMOTE_DATA/referrals.json" "$REMOTE:$REMOTE_DATA/chain-tokens.json" "$LOCAL_DATA/" 2>/dev/null || true
LEDGER="$LOCAL_DATA/referral-payouts.jsonl"
if [ ! -f "$LEDGER" ]; then
  if ! has=$(ssh -o BatchMode=yes -o ConnectTimeout=20 "$REMOTE" "[ -f $REMOTE_DATA/referral-payouts.jsonl ] && echo yes || echo no"); then log "cannot reach the app host to look for a ledger; not paying"; exit 1; fi
  if [ "$has" = yes ]; then rsync -az "$REMOTE:$REMOTE_DATA/referral-payouts.jsonl" "$LOCAL_DATA/" || { log "ledger exists on the app host but could not be fetched; not paying"; exit 1; }; log "ledger fetched from the app host (first run here)"; fi
fi
rows() { [ -f "$1" ] && wc -l < "$1" || echo 0; }
log "pulled: settlements $(rows "$LOCAL_DATA/settlements.jsonl") rows, ledger $(rows "$LEDGER") rows"

# 2. pay
set +e
EVM_CHAIN="$EVM_CHAIN" DATA_DIR="$LOCAL_DATA" REBATE_KEY_FILE="$REBATE_KEY_FILE" DRY_RUN="${DRY_RUN:-0}" "$NODE" server/evm/referral-payout.mjs
rc=$?
set -e

# 3. push the ledger back (the site reads it for "paid so far"); a failed push only delays what the site shows
if [ "${DRY_RUN:-0}" != 1 ] && [ -f "$LEDGER" ]; then
  rsync -az "$LEDGER" "$REMOTE:$REMOTE_DATA/referral-payouts.jsonl" && log "ledger pushed ($(rows "$LEDGER") rows)" || log "WARNING: ledger push failed; the site shows stale payouts until the next run"
fi
exit $rc
