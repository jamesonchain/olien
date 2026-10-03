#!/usr/bin/env bash
# Deploys the Olien account protocol to Monad.
#
#   ops/deploy-olien-monad.sh                  testnet, simulate only
#   ops/deploy-olien-monad.sh --live           testnet, broadcast
#   ops/deploy-olien-monad.sh --mainnet --live mainnet, broadcast
#
# The four contracts go through the Arachnid CREATE2 deployer with fixed salts, from the
# creation code pinned in deployments/v1/creation.json, so they land on the addresses
# Olien already holds on Arc and a piece that is already there is skipped. That makes
# this rerunnable: a run that dies halfway is finished by running it again.
#
# Simulation is the default because broadcasting is the irreversible half. The readiness
# check runs first either way, since deploying onto a chain whose EntryPoint is not the
# one the code expects is the failure worth spending thirty seconds to avoid.
#
# The deploying key comes from DEPLOY_PK, or RELAYER_PK in service/.env, and is never
# printed. Gas is MON.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="$HOME/.foundry/bin:$PATH"

MAINNET=0
LIVE=0
for arg in "$@"; do
  case "$arg" in
    --mainnet) MAINNET=1 ;;
    --live) LIVE=1 ;;
    *) echo "unknown flag: $arg"; exit 1 ;;
  esac
done

if [ "$MAINNET" -eq 1 ]; then
  RPC="${MONAD_RPC:-https://rpc.monad.xyz}"
  BOOK="deployments/143.json"
  "$ROOT/ops/monad-check.sh" --mainnet
else
  RPC="${MONAD_RPC:-https://testnet-rpc.monad.xyz}"
  BOOK="deployments/10143.json"
  "$ROOT/ops/monad-check.sh"
fi

# The deploy itself is ops/deploy-olien.sh, which sends the pinned creation code and
# compiles nothing; this wrapper only adds the Monad readiness check and the RPC.
echo
if [ "$LIVE" -eq 1 ]; then
  "$ROOT/ops/deploy-olien.sh" --rpc "$RPC" --live
  echo
  echo "Confirming what is actually on the chain:"
  if [ "$MAINNET" -eq 1 ]; then "$ROOT/ops/monad-check.sh" --mainnet; else "$ROOT/ops/monad-check.sh"; fi
  echo "Put the address book entry above under \"olien\" in $BOOK if it is not there yet."
else
  "$ROOT/ops/deploy-olien.sh" --rpc "$RPC"
fi
