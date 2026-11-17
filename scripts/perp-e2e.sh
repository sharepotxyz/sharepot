#!/usr/bin/env bash
# End-to-end check of the SharePot Perp pool and its daily job (server/evm/perp.mjs) on a local anvil chain whose clock
# starts at 2026-11-02 12:00Z, driven by the real NVDA closes of 2026-11-02 … 11-05 (Yahoo + Nasdaq + Chainlink on
# Base mainnet, all read live). Covers: scheduling, proposing the first close and chained moves, the independent
# verify (match and mismatch, rejecting with the guardian's reject-only key), the operator's move cap, a re-propose, settling after the dispute
# window, entries that are the user's position without any claim, and an exit the user withdraws (nothing is paid on
# anyone's behalf). Keys are anvil's public test mnemonic; alerts are disabled.
# Exit 0 only when every check holds.   Usage: bash scripts/perp-e2e.sh
set -euo pipefail
export PATH=/root/stocklana/tools/node22/bin:$HOME/.foundry/bin:$PATH
R=$(cd "$(dirname "$0")/.." && pwd); D=$(mktemp -d); RPC=http://127.0.0.1:${PERP_E2E_PORT:-8546}
MN="test test test test test test test test test test test junk"
key() { cast wallet private-key --mnemonic "$MN" --mnemonic-index "$1"; }
K0=$(key 0); K1=$(key 1); K3=$(key 3); K4=$(key 4); K5=$(key 5)   # admin, operator, alice, bob, guardian
A1=$(cast wallet address "$K1"); A2=$(cast wallet address "$(key 2)"); A3=$(cast wallet address "$K3"); A4=$(cast wallet address "$K4"); A5=$(cast wallet address "$K5")
printf '%s\n' "$K1" > "$D/operator.key"
export EVM_CHAIN=anvil EVM_CHAINS=$D/chains.json EVM_RPC=$RPC EVM_PROPOSER_KEY_FILE=$D/operator.key DATA_DIR=$D/data TELEGRAM_CONFIG=/nonexistent NOTIFY_STATE=$D/notify.json
anvil --timestamp "$(date -d '2026-11-02T12:00:00Z' +%s)" --port "${RPC##*:}" --silent & AP=$!
trap 'kill $AP 2>/dev/null; rm -rf "$D"' EXIT
timeout 15 bash -c "until cast block-number --rpc-url $RPC >/dev/null 2>&1; do sleep 0.2; done"
fails=0
check() { if eval "$2"; then echo "  ok   $1"; else echo "  FAIL $1"; fails=$((fails + 1)); fi; }
warp() { cast rpc evm_setNextBlockTimestamp "$(date -d "$1" +%s)" --rpc-url $RPC >/dev/null; cast rpc evm_mine --rpc-url $RPC >/dev/null; }
job() { (cd "$R" && node server/evm/perp.mjs "$@" 2>&1 | sed 's/^[0-9TZ:.-]* //' | tee -a "$D/job.log"); }
tx() { cast send "$@" --rpc-url $RPC >/dev/null 2>&1; }

out=$(cd "$R/evm" && OPERATOR=$A1 GUARDIAN=$A5 TREASURY=$A2 forge script script/DeployPerp.s.sol --rpc-url $RPC --private-key "$K0" --broadcast 2>&1)
TOKEN=$(echo "$out" | awk '/MockStock NVDAc/{print $3}'); PERP=$(echo "$out" | awk '/SharePotPerp 0x/{print $2}')
cat > "$D/chains.json" <<JSON
{ "anvil": { "name": "anvil", "chainId": 31337, "rpc": "$RPC", "explorer": "", "stocks": [], "perp": "$PERP", "perpToken": "$TOKEN",
  "perpSymbol": "NVDA", "perpDeployBlock": 0, "perpFeed": "0x04689a41629776563E6822F76f2e57D148d28513",
  "perpMainnetToken": "0xb20000000000000000000078ee7ce2fE4908108C" } }
JSON
for k in "$K3" "$K4"; do a=$(cast wallet address "$k"); tx "$TOKEN" "mint(address,uint256)" "$a" 100000000000 --private-key "$k"; tx "$TOKEN" "approve(address,uint256)" "$PERP" "$(cast max-uint)" --private-key "$k"; done
call() { cast call "$PERP" "$@" --rpc-url $RPC | awk '{print $1}'; }
state() { cast call "$PERP" "epochs(uint256)(uint64,uint8,uint64,uint256,bytes32,uint256)" "$1" --rpc-url $RPC | sed -n 2p; }

echo "== schedule and requests"
job run >/dev/null
check "eleven sessions scheduled (11-02 … 11-16)" '[ "$(call "lastScheduled()(uint256)")" = 11 ]'
tx "$PERP" "requestDeposit(uint8,uint256)" 0 10000000000 --private-key "$K3"   # alice: long 2x, 100 tokens
tx "$PERP" "requestDeposit(uint8,uint256)" 1 10000000000 --private-key "$K4"   # bob: hedge, 100 tokens
job run >/dev/null
check "nothing proposed before the bell" '[ "$(state 1)" = 1 ]'

echo "== day 1 (first close) and day 2 (chained move)"
warp 2026-11-02T21:31:00Z; job run >/dev/null; v=$(job verify)
check "day 1 proposed at the 11-02 close (202.06) and verified" '[[ "$v" == *"verified 202.06"* ]]'
warp 2026-11-03T03:32:00Z; job run >/dev/null
check "day 1 settled after the dispute window" '[ "$(state 1)" = 3 ]'
check "both entries are their positions with no claim" '[ "$(call "sharesOf(address,uint8)(uint256)" "$A3" 0)" != 0 ] && [ "$(call "sharesOf(address,uint8)(uint256)" "$A4" 1)" != 0 ]'
warp 2026-11-03T21:31:00Z; job run >/dev/null; v=$(job verify)
check "day 2 = 202.06 × (1 + 11-03 move), verified" '[[ "$v" == *"verified 206.6898"* ]]'
warp 2026-11-04T03:32:00Z; job run >/dev/null

echo "== a wrong proposal on day 3"
warp 2026-11-04T21:31:00Z
Z=0x0000000000000000000000000000000000000000000000000000000000000000
check "operator cannot propose a 5x move (cap 50 %)" '! tx "$PERP" "propose(uint256,uint256,bytes32)" 3 99900000000 $Z --private-key "$K1"'
tx "$PERP" "propose(uint256,uint256,bytes32)" 3 16000000000 $Z --private-key "$K1"
v=$(job verify)
check "verify without a key flags the wrong value (and leaves it)" '[[ "$v" == *"MISMATCH"* ]] && [ "$(state 3)" = 2 ]'
printf '%s\n' "$K5" > "$D/guardian.key"
check "the guardian key cannot settle inside the dispute window (the admin could)" '! tx "$PERP" "settle(uint256)" 3 --private-key "$K5"'
v=$(PERP_GUARDIAN_KEY_FILE=$D/guardian.key job verify)
check "verify with the guardian key rejects it on-chain" '[[ "$v" == *"rejected"* ]] && [ "$(state 3)" = 1 ]'
job run >/dev/null; v=$(job verify)
check "after the reject, the job proposes the right value" '[[ "$v" == *"verified 200.1296"* ]]'
v=$(PERP_GUARDIAN_KEY_FILE=$D/guardian.key job verify)
check "verify with the key leaves a right value alone" '[[ "$v" == *"verified 200.1296"* ]] && [ "$(state 3)" = 2 ]'

echo "== exit"
warp 2026-11-05T03:32:00Z
ash=$(call "sharesOf(address,uint8)(uint256)" "$A3" 0)
tx "$PERP" "requestRedeem(uint8,uint256)" 0 "$ash" --private-key "$K3"
job run >/dev/null; warp 2026-11-05T21:31:00Z; job run >/dev/null; warp 2026-11-06T03:32:00Z; job run >/dev/null
check "day 4 settled (alice's exit filled)" '[ "$(state 4)" = 3 ]'
balOf() { cast call "$TOKEN" "balanceOf(address)(uint256)" "$1" --rpc-url $RPC | awk '{print $1}'; }
check "nothing paid on alice's behalf: her tokens wait in the contract" '[ "$(balOf "$A3")" = 90000000000 ]'
tx "$PERP" "claim(address,uint256,uint8)" "$A3" 4 0 --private-key "$K3"
bal=$(balOf "$A3")
# 99.9 tokens in after the fee; NVDA +2.29 %, −3.17 %, −9.26 % at about 2x → about 88.7 tokens back
check "alice withdraws her exit (88–90 of 100 tokens back)" '[ "$bal" -gt 98800000000 ] && [ "$bal" -lt 99000000000 ]'
echo "== a skipped day"
warp 2026-11-06T21:31:00Z
job skip 5 >/dev/null
check "day 5 (11-06) skipped by hand" '[ "$(state 5)" = 4 ]'
warp 2026-11-09T21:31:00Z; job run >/dev/null; v=$(job verify)
# 11-05 → 11-09 over the bars that exist (11-06, 11-09); chained day by day it was 178.6695
check "day 6 is proposed across the skipped day and verifies" '[[ "$v" == *"verified 178.6"* ]]'
warp 2026-11-10T03:32:00Z; job run >/dev/null
check "day 6 settles" '[ "$(state 6)" = 3 ]'
held=0; for t in 0 1 2 3; do h=$(cast call "$PERP" "tierInfo(uint8)((uint8,bool,uint32,uint256,uint256))" $t --rpc-url $RPC | tr -d '()' | awk -F', ' '{print $4}' | awk '{print $1}'); held=$((held + h)); done
cb=$(cast call "$TOKEN" "balanceOf(address)(uint256)" "$PERP" --rpc-url $RPC | awk '{print $1}')
check "the contract holds every tier's tokens" '[ "$cb" -ge "$held" ]'
echo "alice back: $bal raw; contract $cb raw for tiers holding $held"
[ "$fails" = 0 ] && echo "PERP E2E PASSED" || { echo "PERP E2E FAILED ($fails)"; exit 1; }
