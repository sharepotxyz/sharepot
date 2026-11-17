#!/usr/bin/env bash
# Localnet test run: a fresh validator with the program preloaded, then mocha. Leaves nothing running.
set -euo pipefail
export PATH=/root/stocklana/tools/node22/bin:/root/.cargo/bin:/root/.local/share/solana/install/active_release/bin:$PATH
cd "$(dirname "$0")/.."
PROGRAM_ID=8TzdVXpqa52o3fBvYynSxHTWP4zuWfZmTvSkpdLT9rWW
WALLET=/root/stocklana/secrets/localnet-admin.json
LEDGER=/root/stocklana/ledger-test
RPC=http://127.0.0.1:8899

rm -rf "$LEDGER"
# The validator runs ahead of everything else on the host: starved of CPU it makes slots late, its clock falls 10-30 s
# behind and then jumps to catch up, and windows of a few seconds in the tests are gone before a bet lands (2026-11-17,
# load 13 on 6 cores during the weekly audit). Without root `nice` only warns and runs it at normal priority.
nice -n -10 solana-test-validator --reset --quiet --ledger "$LEDGER" --mint "$(solana-keygen pubkey "$WALLET")" \
  --bpf-program "$PROGRAM_ID" target/deploy/sharepot.so > /root/stocklana/logs/validator.log 2>&1 &
VPID=$!
trap 'kill "$VPID" 2>/dev/null; wait "$VPID" 2>/dev/null || true' EXIT

for _ in $(seq 1 60); do
  solana -u "$RPC" cluster-version >/dev/null 2>&1 && break
  sleep 1
done

ANCHOR_PROVIDER_URL="$RPC" ANCHOR_WALLET="$WALLET" npx ts-mocha -p ./tsconfig.json -t 180000 "tests/**/*.ts"
