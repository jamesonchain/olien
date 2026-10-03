#!/usr/bin/env bash
# Deploys Olien v1 to any chain, from the exact bytes it was first deployed from.
#
#   ops/deploy-olien.sh --rpc <url>           simulate: say what would be deployed, send nothing
#   ops/deploy-olien.sh --rpc <url> --live    broadcast
#
# The four contracts are in deployments/v1/creation.json as creation code, and this
# sends that code through the deterministic CREATE2 deployer. It does not compile
# anything. That is deliberate: the compiler ends creation code with a hash of the
# source paths, so the same Solidity built from this repository lands on different
# addresses than the ones Arc and Monad hold, and a team's account on a new chain
# would not be at the address they already have. contracts/test/OlienCanonical.t.sol
# holds the pinned bytes to the source, so "not compiled here" does not mean
# "not this code".
#
# Rerunnable: a piece already on the chain is skipped, so a run that dies halfway is
# finished by running it again. The deploying key comes from DEPLOY_PK, or RELAYER_PK
# or ATTESTOR_PK in service/.env, and is never printed. Which key pays does not
# change where anything lands.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="$HOME/.foundry/bin:$PATH"
BOOK="$ROOT/deployments/v1/creation.json"

RPC=""
LIVE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --rpc) RPC="${2:-}"; shift 2 ;;
    --live) LIVE=1; shift ;;
    *) echo "unknown flag: $1"; exit 1 ;;
  esac
done
[ -n "$RPC" ] || { echo "which chain? pass --rpc <url>"; exit 1; }

CHAIN="$(cast chain-id --rpc-url "$RPC")"
DEPLOYER="$(jq -r .deployer "$BOOK")"
ENTRY_POINT="$(jq -r .entryPoint "$BOOK")"
has_code() { [ "$(cast code "$1" --rpc-url "$RPC")" != "0x" ]; }

echo "chain $CHAIN at $RPC"
has_code "$DEPLOYER" || { echo "the CREATE2 deployer $DEPLOYER is not on this chain; nothing can land where it should"; exit 1; }
has_code "$ENTRY_POINT" || { echo "EntryPoint v0.7 is not at $ENTRY_POINT on this chain; the account is built against it"; exit 1; }

KEY=""
if [ "$LIVE" -eq 1 ]; then
  key_from_env() { grep -E "^$1=" "$ROOT/service/.env" 2>/dev/null | cut -d= -f2- | tr -d '"'"'"' ' || true; }
  KEY="${DEPLOY_PK:-}"
  [ -n "$KEY" ] || KEY="$(key_from_env RELAYER_PK)"
  [ -n "$KEY" ] || KEY="$(key_from_env ATTESTOR_PK)"
  [ -n "$KEY" ] || { echo "no deploying key: set DEPLOY_PK, or RELAYER_PK or ATTESTOR_PK in service/.env"; exit 1; }
fi

for NAME in $(jq -r '.order[]' "$BOOK"); do
  SALT="$(jq -r ".contracts.$NAME.salt" "$BOOK")"
  RECORDED="$(jq -r ".contracts.$NAME.address" "$BOOK")"
  INIT="$(jq -r ".contracts.$NAME.initCode" "$BOOK")"
  # The address is a hash of the bytes, so recomputing it is what proves the file was
  # not edited since it was recorded.
  DIGEST="$(cast keccak "$(cast concat-hex 0xff "$DEPLOYER" "$SALT" "$(cast keccak "$INIT")")")"
  PREDICTED="$(cast to-check-sum-address "0x${DIGEST: -40}")"
  if [ "$PREDICTED" != "$RECORDED" ]; then
    echo "$NAME: the pinned bytes predict $PREDICTED, the file records $RECORDED. Stopping."
    exit 1
  fi
  if has_code "$RECORDED"; then
    printf "  %-26s %s  already there\n" "$NAME" "$RECORDED"
    continue
  fi
  if [ "$LIVE" -eq 1 ]; then
    cast send "$DEPLOYER" "$(cast concat-hex "$SALT" "$INIT")" --rpc-url "$RPC" --private-key "$KEY" >/dev/null
    has_code "$RECORDED" || { echo "$NAME: sent, and there is still no code at $RECORDED. Stopping."; exit 1; }
    printf "  %-26s %s  deployed\n" "$NAME" "$RECORDED"
  else
    printf "  %-26s %s  would be deployed\n" "$NAME" "$RECORDED"
  fi
done

echo
if [ "$LIVE" -eq 1 ]; then
  echo "Done. The address book entry for deployments/$CHAIN.json:"
else
  echo "Simulated only; nothing was sent. Add --live to broadcast. The address book entry will be:"
fi
jq '{olien: {entryPoint: .entryPoint, factory: .contracts.factory.address, implementation: .contracts.implementation.address, subAccountImplementation: .contracts.subAccountImplementation.address, verifier: .contracts.verifier.address}}' "$BOOK"
