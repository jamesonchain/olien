#!/usr/bin/env bash
# A local chain with Olien on it, at the same addresses it holds on Arc and Monad.
#
#   ops/local-chain.sh            start anvil on 8546, deploy, print how to run the service
#   ops/local-chain.sh --port N   on another port
#
# anvil has the CREATE2 deployer and nothing else Olien needs, so this puts EntryPoint
# v0.7 at its canonical address from the bytecode the tests already carry, sends the
# pinned creation code through ops/deploy-olien.sh, and deploys a token with events to
# stand in for USDC. The service then boots against it exactly as it would against a
# real chain, including the check that the four contracts are Olien v1.
#
# The key below is anvil's first published test key. It holds nothing anywhere but on a
# chain this script starts.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="$HOME/.foundry/bin:$PATH"
PORT=8546
[ "${1:-}" = "--port" ] && PORT="${2:?--port needs a number}"
RPC="http://127.0.0.1:$PORT"
ANVIL_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
ENTRY_POINT=0x0000000071727De22E5E9d8BAf0edAc6f37da032
BOOK="${TMPDIR:-/tmp}/olien-local-$PORT.json"

if cast chain-id --rpc-url "$RPC" >/dev/null 2>&1; then
  echo "something already answers on $RPC; stop it or pass --port"
  exit 1
fi
anvil --port "$PORT" --silent &
ANVIL=$!
trap 'kill $ANVIL 2>/dev/null || true' INT TERM
for _ in $(seq 1 50); do cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 0.1; done

cast rpc anvil_setCode "$ENTRY_POINT" "$(tr -d '\n' < "$ROOT/contracts/test/fixtures/entrypoint-v07.hex")" --rpc-url "$RPC" >/dev/null
DEPLOY_PK="$ANVIL_KEY" "$ROOT/ops/deploy-olien.sh" --rpc "$RPC" --live | sed -n '1,5p'
USDC="$(cd "$ROOT/contracts" && forge create test/MockUSDC.sol:MockUSDC --rpc-url "$RPC" --private-key "$ANVIL_KEY" --broadcast 2>/dev/null | awk '/Deployed to/ {print $3}')"
[ -n "$USDC" ] || { echo "the token did not deploy"; kill $ANVIL; exit 1; }

jq --arg usdc "$USDC" --argjson chain "$(cast chain-id --rpc-url "$RPC")" \
  '{network: "local", chainId: $chain, usdc: $usdc, olien: {entryPoint: .entryPoint, factory: .contracts.factory.address, implementation: .contracts.implementation.address, subAccountImplementation: .contracts.subAccountImplementation.address, verifier: .contracts.verifier.address}}' \
  "$ROOT/deployments/v1/creation.json" > "$BOOK"

cat <<NOTE

Olien is on $RPC. The deployment file is $BOOK, and the token standing in for USDC is
$USDC; mint to an account with
  cast send $USDC "mint(address,uint256)" <account> 1000000000 --rpc-url $RPC --private-key $ANVIL_KEY

Run the service against it, with a Postgres of your own:
  cd service && DATABASE_URL=postgres://... DEPLOYMENTS_PATH=$BOOK RPC_URL=$RPC \\
    RELAYER_PK=$ANVIL_KEY INDEX_INTERVAL_SECS=3 cargo run

The chain runs until this is stopped with Ctrl-C.
NOTE
wait $ANVIL
