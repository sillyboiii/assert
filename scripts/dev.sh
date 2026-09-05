#!/usr/bin/env bash
set -euo pipefail

export PATH="$HOME/.foundry/bin:$PATH"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONTRACTS="$ROOT/contracts"
FRONTEND="$ROOT/frontend"
RPC_URL="http://localhost:8545"
CHAIN_ID=84532

ANVIL_KEY0=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
DEMO_ADDRESS=0x70997970C51812dc3A010C7d01b50e0d17dc79C8

if ! curl -s -o /dev/null --max-time 2 http://localhost:8545; then
  echo "Starting anvil (Base Sepolia chain id $CHAIN_ID)…"
  anvil --chain-id $CHAIN_ID --port 8545 --silent &
  sleep 2
fi

echo "Deploying Commitment contract…"
DEPLOY_OUTPUT=$(cd "$CONTRACTS" && PRIVATE_KEY=$ANVIL_KEY0 TREASURY=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 \
  forge script script/Deploy.s.sol:Deploy --rpc-url $RPC_URL --broadcast 2>&1)
echo "$DEPLOY_OUTPUT" | tail -3

ADDR=$(echo "$DEPLOY_OUTPUT" | awk '/Commitment deployed at:/{print $NF}')
if [ -z "$ADDR" ]; then
  echo "Deployment failed:" >&2
  echo "$DEPLOY_OUTPUT" | tail -20 >&2
  exit 1
fi

cat > "$FRONTEND/.env.local" <<EOF
VITE_COMMITMENT_ADDRESS=$ADDR
VITE_RPC_URL=$RPC_URL
VITE_ENABLE_DEMO_WALLET=true
VITE_DEMO_ADDRESS=$DEMO_ADDRESS
EOF

echo "Wrap up: writing frontend/.env.local"
echo "  contract : $ADDR"
echo "  rpc      : $RPC_URL"
echo "  demo acct: $DEMO_ADDRESS"
echo ""
echo "Next:"
echo "  cd frontend && npm run dev"
echo "  open http://localhost:5173"
echo "  click 'Demo wallet' and create a commitment!"