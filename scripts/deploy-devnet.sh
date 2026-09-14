#!/usr/bin/env bash
# Deploy the program to devnet from the dedicated deployer wallet, then bootstrap mock xStocks, the faucet and config.
# Peak need is ~5.1 SOL (upload buffer + program data, 360 KB each); ~2.5 SOL stays locked as program rent, the buffer
# is refunded, and the bootstrap spends ~0.75 SOL (proposer 0.2, faucet 0.5, mint/account rent).
set -euo pipefail
export PATH=/root/stocklana/tools/node22/bin:/root/.cargo/bin:/root/.local/share/solana/install/active_release/bin:$PATH
cd "$(dirname "$0")/.."
DEPLOYER=/root/stocklana/secrets/devnet-deployer.json
# RPC carries an API key: never echo it; mask it in any output. Read from $DEVNET_RPC or /root/stocklana/secrets/devnet-rpc.
RPC=${DEVNET_RPC:-$(cat /root/stocklana/secrets/devnet-rpc 2>/dev/null)}
[ -n "$RPC" ] || { echo "set DEVNET_RPC or write the URL to /root/stocklana/secrets/devnet-rpc"; exit 1; }
mask() { sed -E 's#https?://[^ ]+#<rpc>#g'; }

BAL=$(solana balance -k "$DEPLOYER" -u "$RPC" 2>&1 | awk '{print $1}')
echo "deployer $(solana-keygen pubkey "$DEPLOYER") balance: $BAL SOL"
if ! awk -v b="$BAL" 'BEGIN { exit !(b + 0 >= 5.1) }'; then echo "need at least 5.1 SOL for the deploy peak — fund the deployer first"; exit 1; fi

if solana program show 8TzdVXpqa52o3fBvYynSxHTWP4zuWfZmTvSkpdLT9rWW -u "$RPC" >/dev/null 2>&1; then
  echo "program already deployed — upgrading"
fi
solana program deploy target/deploy/sharepot.so --program-id target/deploy/sharepot-keypair.json -k "$DEPLOYER" -u "$RPC" --use-rpc 2>&1 | mask

mkdir -p /root/stocklana/secrets/devnet && chmod 700 /root/stocklana/secrets/devnet
ANCHOR_PROVIDER_URL="$RPC" ANCHOR_WALLET="$DEPLOYER" SHAREPOT_SECRETS=/root/stocklana/secrets/devnet FAUCET_FUND_SOL=0.5 \
  npx ts-node -P tsconfig.json scripts/devnet-setup.ts 2>&1 | mask
solana balance -k "$DEPLOYER" -u "$RPC" 2>&1 | mask
