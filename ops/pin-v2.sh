#!/usr/bin/env bash
# Pins the exact bytes Olien v2 deploys from, into deployments/v2/creation.json.
#
#   ops/pin-v2.sh --rpc <url>
#
# v2's three new contracts are built here, under the v2 profile that strips the
# compiler's metadata, so their creation code depends on their code alone. The factory
# is not rebuilt: it is v1's pinned factory with its one constructor argument, the
# implementation address, swapped for v2's, so the proxy it embeds is byte for byte the
# one every v1 account runs and a v2 account has the same code hash as a v1 account.
# The sub-account implementation is v1's, already on every chain.
#
# The RPC is only read: the runtime code of a contract with immutables is what its
# constructor leaves behind, and eth_call with a create answers that without sending.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="$HOME/.foundry/bin:$PATH"
V1="$ROOT/deployments/v1/creation.json"
OUT="$ROOT/deployments/v2/creation.json"

RPC=""
while [ $# -gt 0 ]; do
  case "$1" in
    --rpc) RPC="${2:-}"; shift 2 ;;
    *) echo "unknown flag: $1"; exit 1 ;;
  esac
done
[ -n "$RPC" ] || { echo "pass --rpc <url>; it is only read"; exit 1; }

(cd "$ROOT/contracts" && forge build --skip test --skip script >/dev/null)

DEPLOYER="$(jq -r .deployer "$V1")"
ENTRY_POINT="$(jq -r .entryPoint "$V1")"
SUB="$(jq -r .contracts.subAccountImplementation.address "$V1")"
V1_IMPL="$(jq -r .contracts.implementation.address "$V1")"

salt() { cast keccak "olien.v2.$1"; }
artifact() { jq -r .bytecode.object "$ROOT/contracts/out/$1.sol/$1.json"; }
predict() {
  local digest
  digest="$(cast keccak "$(cast concat-hex 0xff "$DEPLOYER" "$1" "$(cast keccak "$2")")")"
  cast to-check-sum-address "0x${digest: -40}"
}
runtime_hash() { cast keccak "$(cast call --create "$1" --rpc-url "$RPC")"; }

VERIFIER_INIT="$(artifact OlienVerifierV2)"
VERIFIER_SALT="$(salt verifier)"
VERIFIER="$(predict "$VERIFIER_SALT" "$VERIFIER_INIT")"

POLICY_INIT="$(artifact OlienPolicy)"
POLICY_SALT="$(salt policy)"
POLICY="$(predict "$POLICY_SALT" "$POLICY_INIT")"

IMPL_INIT="$(cast concat-hex "$(artifact OlienV2)" "$(cast abi-encode "c(address,address,address,address)" "$ENTRY_POINT" "$VERIFIER" "$SUB" "$POLICY")")"
IMPL_SALT="$(salt implementation)"
IMPL="$(predict "$IMPL_SALT" "$IMPL_INIT")"

# v1's factory bytes end with its constructor argument; the same bytes with v2's.
V1_FACTORY_INIT="$(jq -r .contracts.factory.initCode "$V1")"
TAIL="${V1_FACTORY_INIT: -64}"
[ "0x$TAIL" = "$(cast to-uint256 "$V1_IMPL" 2>/dev/null || cast abi-encode 'c(address)' "$V1_IMPL")" ] || {
  echo "v1's factory bytes do not end with v1's implementation address; refusing to guess"; exit 1; }
FACTORY_INIT="${V1_FACTORY_INIT:0:${#V1_FACTORY_INIT}-64}$(cast abi-encode 'c(address)' "$IMPL" | cut -c3-)"
FACTORY_SALT="$(salt factory)"
FACTORY="$(predict "$FACTORY_SALT" "$FACTORY_INIT")"

mkdir -p "$(dirname "$OUT")"
jq -n \
  --arg deployer "$DEPLOYER" --arg entryPoint "$ENTRY_POINT" \
  --arg accountCodeHash "$(jq -r .accountCodeHash "$V1")" \
  --arg sub "$SUB" \
  --arg verifierSalt "$VERIFIER_SALT" --arg verifier "$VERIFIER" --arg verifierInit "$VERIFIER_INIT" --arg verifierHash "$(runtime_hash "$VERIFIER_INIT")" \
  --arg policySalt "$POLICY_SALT" --arg policy "$POLICY" --arg policyInit "$POLICY_INIT" --arg policyHash "$(runtime_hash "$POLICY_INIT")" \
  --arg implSalt "$IMPL_SALT" --arg impl "$IMPL" --arg implInit "$IMPL_INIT" --arg implHash "$(runtime_hash "$IMPL_INIT")" \
  --arg factorySalt "$FACTORY_SALT" --arg factory "$FACTORY" --arg factoryInit "$FACTORY_INIT" --arg factoryHash "$(runtime_hash "$FACTORY_INIT")" \
  '{
    note: "The exact creation code Olien v2 deploys from. The verifier, the policy and the implementation are built from contracts/src/v2 with no metadata hash, so these bytes are a function of the code alone; the factory is v1'"'"'s pinned factory with v2'"'"'s implementation as its constructor argument, so the proxy it embeds is the one every v1 account runs. ops/pin-v2.sh writes this file and ops/deploy-olien.sh --book v2 sends it.",
    deployer: $deployer,
    entryPoint: $entryPoint,
    subAccountImplementation: $sub,
    order: ["verifier", "policy", "implementation", "factory"],
    contracts: {
      verifier: { salt: $verifierSalt, address: $verifier, initCode: $verifierInit, runtimeCodeHash: $verifierHash },
      policy: { salt: $policySalt, address: $policy, initCode: $policyInit, runtimeCodeHash: $policyHash },
      implementation: { salt: $implSalt, address: $impl, initCode: $implInit, runtimeCodeHash: $implHash },
      factory: { salt: $factorySalt, address: $factory, initCode: $factoryInit, runtimeCodeHash: $factoryHash }
    },
    accountCodeHash: $accountCodeHash,
    accountCodeNote: "The same proxy as v1'"'"'s, so a v2 account has the code hash a v1 account has; which implementation it runs is read from its ERC-1967 slot."
  }' > "$OUT"

echo "pinned to $OUT"
jq '{verifier: .contracts.verifier.address, policy: .contracts.policy.address, implementation: .contracts.implementation.address, factory: .contracts.factory.address}' "$OUT"
