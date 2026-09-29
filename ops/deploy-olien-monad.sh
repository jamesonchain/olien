#!/usr/bin/env bash
# Deploys the Olien account protocol to Monad.
#
#   ops/deploy-olien-monad.sh                  testnet, simulate only
#   ops/deploy-olien-monad.sh --live           testnet, broadcast
#   ops/deploy-olien-monad.sh --mainnet --live mainnet, broadcast
#
# The four contracts go through the Arachnid CREATE2 deployer with fixed salts, so they
# land on the addresses Olien already holds on Arc and a piece that is somehow already
# there is reused rather than deployed twice. That makes this rerunnable: a run that
# dies halfway leaves the finished pieces standing and the next run skips them.
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

# RELAYER_PK is the name the service reads, and service/.env.example documents it.
# The attestor stays as a fallback because the testnet deployment shares one key and
# inventing a second would be ceremony. Which key pays does not change where anything
# lands: CREATE2 makes every address a function of the salt and the creation code,
# not of the sender.
key_from_env() { grep -E "^$1=" "$ROOT/service/.env" 2>/dev/null | cut -d= -f2- | tr -d '"'"'"' ' || true; }
KEY="${DEPLOY_PK:-}"
[ -n "$KEY" ] || KEY="$(key_from_env RELAYER_PK)"
[ -n "$KEY" ] || KEY="$(key_from_env ATTESTOR_PK)"
[ -n "$KEY" ] || { echo "no deploying key: set DEPLOY_PK, or RELAYER_PK or ATTESTOR_PK in service/.env"; exit 1; }

echo
echo "deploying against $RPC, writing $BOOK"
cd "$ROOT/contracts"

if [ "$LIVE" -eq 1 ]; then
  # --broadcast is the only difference between the two paths, so what is simulated is
  # exactly what is sent.
  forge script script/DeployOlien.s.sol:DeployOlien \
    --rpc-url "$RPC" --private-key "$KEY" --broadcast
  echo
  echo "Deployed. Confirming what is actually on the chain:"
  cd "$ROOT"
  if [ "$MAINNET" -eq 1 ]; then ops/monad-check.sh --mainnet; else ops/monad-check.sh; fi
else
  forge script script/DeployOlien.s.sol:DeployOlien \
    --rpc-url "$RPC" --private-key "$KEY"
  echo
  echo "Simulated only. Nothing was sent and $BOOK was not written."
  echo "Add --live to broadcast."
fi
