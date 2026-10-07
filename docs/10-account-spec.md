# Olien account: specification

The account contract this product is built on. Written to be handed to a reviewer:
every rule the contract enforces is here, every hash is defined, and the invariants
at the end are the ones the test suite and an audit check. The reasons behind the
design are in `05-onchain-design.md`; this document is the what, not the why.

**Olien** is the name, chosen on 2026-09-04 in place of the placeholder the first
draft carried. It is the string `Olien` in the EIP-712 domain, so every hash depends
on it and a rename would be a new protocol. Version `1`. Code: `contracts/src/olien/`;
tests: `contracts/test/olien/`.

The first draft (2026-09-04, morning) was reviewed adversarially before any code was
written; the 26 findings and what was done about each are summarised in §19. The
contract described here is the one that passed that review's fixes and the tests.

## 1. Model

An account is a proxy with its own storage and one implementation. It holds money,
a set of **signers**, a **threshold**, a set of **policies** (spending limits,
recovery, time lock) and an **epoch** that changes whenever the signer set or the
rules of consensus change.

Everything the account does is one of these authorization paths, resolved inside
the contract from what is being asked and who signed:

| Path | Who authorizes | What it can do | Delay |
| --- | --- | --- | --- |
| Threshold | `threshold` signers with APPROVE | any calls; configuration calls are scheduled; `cancel` and `removeSpendingLimit` run at once | `configDelay` for configuration, none otherwise |
| Recovery | one signer with RECOVER, optionally plus one signer with APPROVE and without RECOVER | replace one signer with another of equal permissions | `recoveryDelay`, or `recoveryCoSignDelay` when co-signed |
| Spend | one signer named on a spending limit | transfer up to the limit to allowed destinations | none |
| Veto | `effectiveVetoThreshold` signers with VETO | kill a scheduled change | none |
| Approve | any signer | record its approval of a hash on-chain | none |

There is no delegatecall anywhere. Batches are native. There are no modules in
version 1 (§17). Gas is paid by whoever submits, or by the account itself through
ERC-4337.

## 2. Contracts

| Contract | Role | Bytes (runtime) |
| --- | --- | --- |
| `Olien` | the implementation: all logic; compiled through the IR pipeline | 24,545 |
| `OlienProxy` | OpenZeppelin `ERC1967Proxy`, one per account; the implementation pointer is changeable only by the account's own configuration path, and can be frozen forever | 130 |
| `OlienFactory` | CREATE2 deployment of proxies; ERC-4337 `initCode` target | 1,967 |
| `OlienVerifier` | stateless P-256 and passkey checks, kept outside the account for code size | 4,126 |
| `SubAccount` | a money-holding address operated only by its parent; one implementation, EIP-1167 clones per account and index | 1,456 |
| `OlienHash` (library) | the EIP-712 hashes | inlined |
| `WebAuthn` (library) | the passkey envelope | inlined in the verifier |

The account fits the EIP-170 limit with about 30 bytes to spare. Anything added to
version 1 has to take something out.

## 3. Storage

Namespaced (ERC-7201) at `STORAGE_LOCATION =
keccak256(abi.encode(uint256(keccak256("olien.account.v1")) - 1)) & ~0xff`, so a
later implementation can add fields without touching what is below, and must answer
`STORAGE_LOCATION()` with the same value to be accepted (§7.7).

```
struct Signer {
    uint8   kind;         // 0 none, 1 ECDSA, 2 P256, 3 WEBAUTHN, 4 CONTRACT
    uint8   permissions;  // bit 0 APPROVE, bit 1 VETO, bit 2 RECOVER
    uint8   flags;        // bit 0 UV_REQUIRED (WEBAUTHN only)
    uint64  since;        // epoch the signer was added in
    uint32  index;        // 1-based position in signerList
    uint256 x;            // P256 and WEBAUTHN: public key; otherwise 0
    uint256 y;
}

struct ScheduleEntry {
    uint48  readyAt;      // 0 means nothing scheduled under this hash
    uint64  epoch;        // must still be current to execute
    uint8   path;         // 1 threshold, 2 recovery
    bytes32 excluded;     // the signer this change removes, who may not veto it (threshold path only)
    bytes32 callsHash;    // keccak256(abi.encode(calls))
}

struct SpendingLimit {
    address token;        // an ERC-20; USDC on Arc
    address from;         // address(0): the account; otherwise one of its sub-accounts
    uint128 amount;       // per period, in the token's own units
    uint128 remaining;
    uint48  period;       // seconds; 0 means a one-time budget with no reset
    uint48  resetAt;      // start of the next period
    bool    anyDestination;
    bool    exists;
    uint32  generation;   // bumps on every (re)set; signer and destination sets are keyed by it
    uint64  epoch;        // when set; a signer added later is not this limit's signer
}

struct Storage {
    mapping(bytes32 => Signer) signers;
    bytes32[] signerList;
    uint16  threshold;
    uint16  vetoThreshold;                 // 0 means automatic (§7.4)
    uint16  approverCount;                 // signers with APPROVE
    uint16  vetoerCount;                   // signers with VETO
    uint16  approverVetoerCount;           // signers with both
    uint16  recovererCount;                // signers with RECOVER
    uint48  configDelay;
    uint48  recoveryDelay;
    uint48  recoveryCoSignDelay;
    uint64  epoch;                         // 0 only before initialize
    bool    implementationFrozen;
    mapping(uint192 => uint64) nonces;     // 2D nonces: key => next sequence
    mapping(bytes32 => mapping(bytes32 => bool)) approvals;              // hash => signerId
    mapping(bytes32 => ScheduleEntry) scheduled;
    mapping(bytes32 => mapping(bytes32 => bool)) vetoes;                 // hash => signerId
    mapping(bytes32 => uint16) vetoCount;
    mapping(bytes32 => bool) dead;                                       // killed by veto or cancel
    mapping(uint256 => SpendingLimit) limits;
    mapping(uint256 => mapping(uint32 => mapping(bytes32 => bool))) limitSigners;      // id => generation => signerId
    mapping(uint256 => mapping(uint32 => mapping(address => bool))) limitDestinations; // id => generation => to
    uint256 nextLimitId;
}
```

Transient storage (EIP-1153) holds three things that never outlive a transaction:
what `validateUserOp` established for each operation (keyed by `userOpHash`), the
signer a single-signer self call is running for, and the reentrancy latch.

Immutables on the implementation: `ENTRY_POINT` (ERC-4337 v0.7), `VERIFIER`,
`SUB_ACCOUNT_IMPLEMENTATION`. Constants: `SCHEDULE_WINDOW = 7 days`,
`MAX_VALIDITY = 30 days`, `MAX_DELAY = 30 days`, `MIN_RECOVERY_DELAY = 1 hours`.

### 3.1 Signer identity

```
signerId(ECDSA or CONTRACT, address a) = bytes32(uint256(uint160(a)))
signerId(P256 or WEBAUTHN, x, y)       = keccak256(abi.encode(x, y))
```

A key registers once, with one kind. Refused at registration: the zero address, the
account itself, the EntryPoint, a CONTRACT signer with no code, a P-256 point that is
not on the curve, permission bits above 7, flag bits above 1.

## 4. Hashing

EIP-712. Domain `EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)`
with `name = "Olien"`, `version = "1"`, `verifyingContract` = the account.

```
Call(address to,uint256 value,bytes data)

Transaction(uint256 nonce,uint64 epoch,Call[] calls,uint48 validAfter,uint48 validUntil)

UserOperation(address sender,uint256 nonce,bytes initCode,bytes callData,
              uint128 verificationGasLimit,uint128 callGasLimit,uint256 preVerificationGas,
              uint128 maxPriorityFeePerGas,uint128 maxFeePerGas,bytes paymasterAndData,
              uint48 validAfter,uint48 validUntil,uint64 epoch,address entryPoint)

Message(bytes32 hash)
```

- `nonce` in `Transaction` is `(nonceKey << 64) | sequence`, the sequence read from
  storage. The caller supplies only the key. The 4337 nonce is the EntryPoint's, also
  two-dimensional.
- `epoch` is read from storage. A client includes the current value in what it asks a
  wallet to sign; if the epoch moves first, the signature matches nothing.
- `Call[]` hashes as `keccak256(concat(hashStruct(call_i)))` per EIP-712.
- `Message` wraps a foreign 32-byte digest (a USDC authorization, another account's
  transaction hash) so a signature for one purpose is never valid for another. It
  carries no epoch on purpose: a cheque is meant to outlive rule changes, and USDC
  has its own way to void one (`cancelAuthorization`). The threshold can still kill
  a message hash with `cancel` (§9).

Views: `domainSeparator()`, `getTransactionHash(Transaction)` (at the current nonce
and epoch), `getMessageHash(bytes32)`. The user-operation hash is computed by the
client with the same library; the tests pin it against the contract.

## 5. Signatures

### 5.1 Packed format

```
signatures = entry_1 ‖ entry_2 ‖ ... ‖ entry_n
entry      = signerId (32 bytes) ‖ length (2 bytes, big-endian) ‖ signature (length bytes)
```

Entries are sorted by `signerId` strictly ascending; a repeat or a descending pair
makes the set invalid. `length = 0` means "approved on-chain": the contract checks
`approvals[hash][signerId]`. A CONTRACT signer whose own answer would need an empty
signature records an on-chain approval instead (§11). The format has no offsets and
no dynamic tail, so it cannot alias two entries to one signature. A set whose bytes
do not parse reverts `MalformedSignatures`; a set that parses but does not verify is
simply invalid.

### 5.2 Per kind

| kind | signature | check |
| --- | --- | --- |
| ECDSA | 65 bytes `r ‖ s ‖ v` | `s` in the low half of the curve order. `v ∈ {0, 1}` is lifted to `{27, 28}`; `v ∈ {31, 32}` means the wallet signed `"\x19Ethereum Signed Message:\n32" ‖ hash` and is lowered by 4. `ecrecover` must return the id's address |
| P256 | 64 bytes `r ‖ s` | `s` in the low half of the curve order (authenticators do not normalise; the client does, `s' = n - s` is the same signature). Then `OlienVerifier.verifyP256` (§5.4) |
| WEBAUTHN | `abi.encode(bytes authenticatorData, bytes clientDataFields, uint256 r, uint256 s)` | `authenticatorData.length >= 37`; flag bit 0 (user present) set; flag bit 2 (user verified) set when the signer's `UV_REQUIRED` flag is set. The client data JSON is rebuilt as `{"type":"webauthn.get","challenge":"` ‖ base64url(hash), no padding ‖ `",` ‖ `clientDataFields` ‖ `}`, which is the serialisation every browser produces, so the type and the challenge the authenticator signed are exactly the ones checked. Then `verifyP256(sha256(authenticatorData ‖ sha256(clientDataJSON)), r, s, x, y)`. Origin, rpIdHash and the counter are left unchecked on purpose: the relying party bound the key to its origin at registration and the platform enforces it at every assertion; a public verifier cannot know which origin is right. Coinbase Smart Wallet and Safe's passkey signer make the same choice |
| CONTRACT | any bytes | `IERC1271(id).isValidSignature(hash, signature)` by staticcall must return `0x1626ba7e`; a revert or another answer is invalid |

The hash handed to every kind is the typed hash of §4 for the action being
authorized, never a re-hash of it.

### 5.3 What a set establishes

`_tryVerify(hash, signatures)` returns, for the strictly ordered set of valid entries:
`count`, `first` (the first id), `approvers` (APPROVE), `plainApprovers` (APPROVE
without RECOVER), `recoverers` (RECOVER). One entry that does not verify makes the
whole set invalid; the contract never counts "some of them".

### 5.4 P-256 verification

`OlienVerifier.verifyP256(hash, r, s, x, y)`: rejects `s = 0` or `s` above half
the order; calls the RIP-7212 precompile at `0x100` with `hash ‖ r ‖ s ‖ x ‖ y`; a
32-byte answer decides. An empty answer is the precompile's word for "wrong", and
also what a chain without the precompile returns, so the precompile is then asked
about the RIP-7212 specification vector: if that returns 32 bytes the precompile is
there and the signature was wrong; only if the probe is empty too does OpenZeppelin's
Solidity verifier run. On Arc the Solidity code never decides a signature.

## 6. Transactions

### 6.1 `execute(Transaction calldata txn, bytes calldata signatures)`

Callable by anyone; the signatures are the authority, the caller pays gas. Guarded
against reentrancy (§6.5).

```
struct Transaction { uint192 nonceKey; Call[] calls; uint48 validAfter; uint48 validUntil; }
```

1. `validAfter <= now`, `validUntil != 0`, `now <= validUntil`, `validUntil <= now + MAX_VALIDITY`.
   A signature never lives more than 30 days.
2. `nonce = (nonceKey << 64) | nonces[nonceKey]`; `hash = hashTransaction(nonce, epoch, calls, validAfter, validUntil)`.
3. `!dead[hash]`.
4. `nonces[nonceKey] += 1` (before any call). A reverting execution unwinds this, so a
   transaction that failed for a reason outside the account (a blocklisted
   recipient) can be retried until `validUntil`.
5. Verify the set (§5.3); resolve the path (§6.3).
6. If the path has no delay: run the calls (§6.4), emit `Executed(hash, nonce, path)`.
   Otherwise schedule (§8.1).

### 6.2 Classification of calls

For every call with `to == this`:

- `data.length < 4` reverts `SelfCallRefused`.
- A **configuration selector** marks the transaction as configuration:
  `addSigner`, `removeSigner`, `replaceSigner`, `setThreshold`, `setVetoThreshold`,
  `setDelays`, `setSpendingLimit`, `allowLimitSigner`, `allowLimitDestination`,
  `setImplementation`, `freezeImplementation`.
- An **immediate self selector** is allowed without a delay: `cancel`,
  `removeSpendingLimit`.
- Any other selector reverts `SelfCallRefused`. The account never calls its own entry
  points (`execute`, `approve`, `veto`, `spend`, …) from inside a batch. Deposits and
  stake at the EntryPoint are plain external calls to the EntryPoint, so they need
  no special function.

The classification also yields `target`: when exactly one call is `removeSigner(id)`
or `replaceSigner(id, …)`, `target = id`; with two or more removals, `target = 0`.
And `recoveryOnly`: exactly one call, to `this`, selector `replaceSigner`, with
standard ABI encoding (the tuple offset word is `0x40`), whose new signer's
permissions equal the old signer's. Any other encoding is not a recovery.

### 6.3 Resolution

```
if approvers >= threshold:
    path = Threshold; delay = config ? configDelay : 0
elif recoveryOnly and recoverers >= 1:
    path = Recovery; delay = plainApprovers >= 1 ? recoveryCoSignDelay : recoveryDelay
else:
    revert Unauthorized
```

The co-signer of a recovery must be an approver that holds no RECOVER bit, so a key
that is both guardian and approver cannot shorten its own delay.

### 6.4 Running calls

For each call in order: `to.call{value}(data)`. A failure reverts the whole
transaction with the callee's revert data. Calls to `this` run the configuration
functions under `msg.sender == this`. After the last call of a configuration
transaction, `_checkConfig()` (§7.5) must pass.

### 6.5 Reentrancy

`execute`, `executeScheduled`, `spend`, and the batch half of `executeUserOp` take a
transient latch; a callee that re-enters any of them reverts `Reentered`. The
single-signer half of `executeUserOp` is one self call into a latched function, so
it needs no latch of its own. `approve`, `veto` and `cancel` make no external calls.

## 7. Configuration

Every function here is `onlySelf`, reached only through §6.4: a threshold execution,
a scheduled execution, or a recovery execution.

### 7.1 Epoch

`addSigner`, `removeSigner`, `replaceSigner`, `setThreshold`, `setVetoThreshold`,
`setDelays`, `setImplementation` and `freezeImplementation` end with `epoch += 1` and
`EpochAdvanced(epoch)`. Every transaction hash and operation hash includes the
epoch, so a change of who decides invalidates everything signed under the old rules,
including other scheduled changes (Squads' stale transaction index; the Drift
lesson). Spending-limit changes and cancellations do not move the epoch: they change
what one key may do alone, not what the threshold agreed to, so a five-signer
batch mid-collection survives a payroll adjustment.

### 7.2 Signers

```
addSigner(SignerInput s)                        // kind, permissions, flags, bytes key (20 or 64 bytes)
removeSigner(bytes32 id)
replaceSigner(bytes32 oldId, SignerInput s)     // remove + add in one epoch step; the recovery path's only verb
```

`Signer.since` records the epoch at registration.

### 7.3 Threshold and delays

```
setThreshold(uint16 t)
setVetoThreshold(uint16 v)                      // 0 = automatic
setDelays(uint48 configDelay, uint48 recoveryDelay, uint48 recoveryCoSignDelay)
```

### 7.4 Veto threshold

```
effectiveVetoThreshold = vetoThreshold != 0 ? vetoThreshold
                       : max(1, approverVetoerCount - threshold + 1)
```

The automatic value is the smallest number of signers holding both APPROVE and VETO
whose refusal makes the threshold unreachable: in a 2-of-2 it is 1, in a 2-of-3 it
is 2, in a 3-of-5 it is 3; a VETO-only compliance key in an account whose approvers
have no VETO vetoes alone. An explicit value must be reachable (§7.5). Setting it
to 1 gives one designated signer a brake on every scheduled change; that signer
cannot brake its own removal by the threshold (§8.3), so the brake is not a lock.

### 7.5 `_checkConfig()`

Runs at `initialize` and after any configuration execution:

- `signerList.length >= 1`, `approverCount >= 1`
- `1 <= threshold <= approverCount`
- `vetoThreshold == 0` or `vetoThreshold <= vetoerCount`
- each delay `<= MAX_DELAY` (30 days)
- if any signer has RECOVER: `recoveryDelay >= MIN_RECOVERY_DELAY` (1 hour). A
  guardian acting alone always leaves a window to object. The co-signed delay may
  be zero.

A configuration that fails reverts the whole execution, so the account is never
left without a way to act, and never with an instant guardian.

### 7.6 Spending limits

```
setSpendingLimit(uint256 id, SpendingLimitInput in) returns (uint256 id)
    // id == 0 creates (assigns nextLimitId); else replaces
    // in: token, subAccount (0 = the account, else index + 1), amount, period, anyDestination
allowLimitSigner(uint256 id, bytes32 signerId)
allowLimitDestination(uint256 id, address to)
removeSpendingLimit(uint256 id)                 // immediate under the threshold
```

`token` must have code. A sub-account named by index is created if it does not
exist. Setting or replacing a limit bumps its `generation`, records the current
`epoch`, sets `remaining = amount` and `resetAt = now + period`; signers and
destinations are then added under the new generation, in the same batch or later.
Replacing a limit therefore retires every previous signer and destination. A limit
with `anyDestination = false` and no destination added pays nobody.

A signer named on a limit may hold no permission bits at all, which is how a
payroll key that can spend under a cap and do nothing else is expressed.

### 7.7 Implementation

```
setImplementation(address impl)      // reverts if implementationFrozen
freezeImplementation()               // irreversible
```

`setImplementation` staticcalls `impl.STORAGE_LOCATION()` and requires the same
value as its own, so an implementation with another storage layout, which would see
the account as uninitialized, is refused. Then it writes the ERC-1967 slot.

## 8. Scheduled execution, veto, cancel

### 8.1 Schedule

When §6.3 returns a delay, the transaction stores

```
scheduled[hash] = ScheduleEntry(readyAt = now + delay, epoch, path,
                                excluded = path == Threshold ? target : 0,
                                keccak256(abi.encode(calls)))
```

emits `Scheduled(hash, readyAt, path, excluded)` and stops. The nonce is consumed at
this point, so nothing else can take the slot. `validUntil` bounds the scheduling,
not the later execution; the window does that.

### 8.2 `executeScheduled(bytes32 hash, Call[] calldata calls)`

Anyone may call it once `readyAt <= now`. Requirements: an entry exists,
`keccak256(abi.encode(calls)) == callsHash`, `entry.epoch == epoch`, and
`now <= readyAt + SCHEDULE_WINDOW` (7 days). The entry is deleted, the calls run
(§6.4), `_checkConfig` runs, `ScheduledExecuted(hash)`. A change that missed its
window is gone and must be proposed again; nothing approved long ago can fire later.

### 8.3 `veto(bytes32 hash)`

By one signer with VETO (who is calling: §11). Requirements: the hash is scheduled;
the signer has not vetoed it; and, on the threshold path, the signer is not the one
the change removes. The quorum removing a signer is not stopped by that signer; a
guardian replacing one is, which is the consumer's protection against a stolen
mailbox. Records the veto, increments `vetoCount[hash]`; at
`effectiveVetoThreshold` sets `dead[hash]`, deletes the entry, emits
`Cancelled(hash)`. A dead hash can never execute.

Vetoes apply to scheduled changes only. A pending transaction with harvested
approvals is killed by the threshold with `cancel`, or dies with its `validUntil`.

### 8.4 `cancel(bytes32 hash)`

An immediate self call under the threshold: sets `dead[hash]`, deletes any schedule,
emits `Cancelled(hash)`. Works on transaction hashes, operation hashes and wrapped
message hashes alike. `dead` is never cleared.

## 9. EIP-1271

```
isValidSignature(bytes32 hash, bytes signature) returns (bytes4)   // 0x1626ba7e
isValidSignature(bytes data, bytes signature) returns (bytes4)     // 0x20c13b0b, over keccak256(data)
```

Valid when `wrapped = hashMessage(hash)` is not dead and the set verifies with
`approvers >= threshold` over `wrapped`. The legacy overload is what Safe 1.4.1 asks
contract owners with the transaction pre-image, so an Olien can own a Safe.

**Nested accounts.** An Olien that is a CONTRACT signer of another Olien signs
`Message(outerHash)` in its own domain with its own threshold; the outer account
calls `isValidSignature(outerHash, innerPacked)`. Two levels cost one extra external
call and the inner checks. Nested signers inside a user operation touch storage the
bundler rules (ERC-7562) do not associate with the sender, so such operations go
through the project's own `handleOps` relay or an account that has staked at the
EntryPoint (a plain call from a threshold batch), not the public mempool.

## 10. ERC-4337 (EntryPoint v0.7)

```
validateUserOp(PackedUserOperation calldata op, bytes32 userOpHash, uint256 missingFunds)
    returns (uint256 validationData)
executeUserOp(PackedUserOperation calldata op, bytes32 userOpHash)     // IAccountExecute
```

Both only from `ENTRY_POINT`. `op.callData` is always
`executeUserOp.selector ‖ abi.encode(Call[] calls)`; because the selector is
`IAccountExecute`'s, the EntryPoint hands the whole operation and its hash to the
execution phase, so what was validated is what runs. Any other callData reverts
`BadCallData`.

`op.signature = validAfter (6 bytes) ‖ validUntil (6 bytes) ‖ packed signatures`.
`hash = hashUserOperation(op fields, validAfter, validUntil, epoch, ENTRY_POINT)`.
Validation requires `validUntil != 0`, `!dead[hash]`, a set that verifies with at
least one entry, and then, by the shape of `calls`:

| calls | path | requirement |
| --- | --- | --- |
| exactly one call to `this` with selector `spend` | Single | one entry; the limit exists; its signer is named on the limit's current generation |
| … `veto` | Single | one entry; the signer has VETO |
| … `approve` | Single | one entry |
| … `execute`, `executeScheduled`, `createSubAccount` | Single | any entries: these carry their own authority or none; any signer may have the account pay the gas |
| anything else | Threshold or Recovery | §6.3 over `calls`; configuration is allowed and is scheduled at execution |

The decision (hash, path, delay, configuration flag, epoch, and the single signer or
the excluded signer) is written to transient storage under `userOpHash`, whether or
not the signatures verified: the path is what the calls imply, so a bundler
estimating gas with a placeholder signature simulates the real execution, and the
EntryPoint never executes an operation whose validation reported a failure. A
failed signature check returns `SIG_VALIDATION_FAILED` (1) rather than reverting, as
the standard wants for estimation. `missingFunds` is paid to the EntryPoint whether or
not the signatures were right, so estimation with a dummy signature reports a
signature failure rather than an unpaid prefund. The return packs
`validAfter`/`validUntil` per the standard; the EntryPoint enforces them.

`executeUserOp` reads and clears the record (`NotValidated` if absent), requires the
epoch unchanged (`Stale`) and the hash alive (`Dead`), then either runs the one self
call for the named signer (§11) or lands the batch exactly as §6.1 step 6 would,
under the reentrancy latch. Two operations of one account in one bundle keep their
own records; a configuration operation in the same bundle as a transfer schedules
while the transfer runs.

Consequences: the account pays its own gas in USDC on Arc with no paymaster and no
token approval; any EOA can submit a bundle by calling `EntryPoint.handleOps`
directly and is repaid by the EntryPoint from the account's deposit, so a relayer of
ours needs no bundler service; a P-256 or passkey signer spends, approves and
vetoes through an operation signed by it alone. A signer named on a limit can spend
the account's gas on operations that fail at execution; the bound is the operations
it can produce, each worth about a cent.

The factory is a valid `initCode` target for a counterfactual account (§13).

## 11. Single-signer functions and who is calling

```
approve(bytes32 hash)
veto(bytes32 hash)
spend(uint256 id, address to, uint256 amount)
```

The signer is whoever is calling: an ECDSA or CONTRACT signer from its own address
(`signerId = msg.sender`), or, when the account calls itself inside a validated
single-signer operation, the signer the validation named. P256 and WEBAUTHN signers
therefore act through user operations; a CONTRACT signer records an on-chain
approval by calling `approve` from its own address, which for a nested Olien is
a threshold transaction with one call.

`spend` additionally requires `signers[signerId].since <= limit.epoch` (a key
re-added after the limit was set is not the limit's signer) and the current
generation's signer and destination sets; it resets the budget at the period
boundary (`resetAt` advances by whole periods), debits `remaining` before the
transfer, and checks the token's return value. From a sub-account it calls
`SubAccount.transfer`, which checks the same.

## 12. Sub-accounts

```
createSubAccount(uint256 index) returns (address)     // anyone; idempotent
subAccount(uint256 index) view returns (address)
```

A minimal proxy (EIP-1167) of `SUB_ACCOUNT_IMPLEMENTATION`, deployed by the account
with `salt = bytes32(index)` and initialised with the account as `parent` in the
same transaction, so its address is a pure function of the account and the index.
`execute(Call[])` and `transfer(token, to, amount)` are callable only by the parent;
it accepts native value and ERC-721 tokens. Sub-accounts are for operational
separation (payroll, a vendor programme, a card) under one signer set, not for
different rules; different rules mean a different account, which can be a CONTRACT
signer here (§9).

## 13. Factory

```
createAccount(Init calldata init, bytes32 salt) returns (address)   // idempotent
getAddress(Init calldata init, bytes32 salt) view returns (address)
```

`Init`: `SignerInput[] signers, uint16 threshold, uint16 vetoThreshold, uint48 configDelay,
uint48 recoveryDelay, uint48 recoveryCoSignDelay`. The proxy's creation code embeds
the implementation and the `initialize(init)` call, so the CREATE2 address commits to
the first signer set and the first rules: money sent before deployment can only ever
be controlled by those signers, and `initialize` runs inside the constructor, with
nothing to front-run. `initialize` reverts if `epoch != 0`, sets `epoch = 1`, adds the
signers, sets the rules, runs `_checkConfig`. The implementation's own storage is
marked initialised in its constructor.

The address is bound to one implementation version; a later version has its own
factory. The EntryPoint calls the factory only for a sender with no code (an existing
sender with `initCode` is `AA10`); the idempotency is for clients racing each other.
`AccountCreated(account, salt)` is emitted on creation.

## 14. Events

```
Initialized(uint16 threshold, uint16 vetoThreshold, uint48 configDelay, uint48 recoveryDelay, uint48 recoveryCoSignDelay)
SignerAdded(bytes32 indexed id, uint8 kind, uint8 permissions, uint8 flags, uint256 x, uint256 y)
SignerRemoved(bytes32 indexed id)
ThresholdChanged(uint16)   VetoThresholdChanged(uint16)   DelaysChanged(uint48, uint48, uint48)
EpochAdvanced(uint64 epoch)
Executed(bytes32 indexed hash, uint256 nonce, uint8 path)            // path 1 threshold, 2 recovery, 3 single
Scheduled(bytes32 indexed hash, uint48 readyAt, uint8 path, bytes32 excluded)
ScheduledExecuted(bytes32 indexed hash)
Approved(bytes32 indexed hash, bytes32 indexed signerId)
Vetoed(bytes32 indexed hash, bytes32 indexed signerId, uint16 count)
Cancelled(bytes32 indexed hash)
SpendingLimitSet(uint256 indexed id, uint32 generation, address token, address from, uint128 amount, uint48 period, bool anyDestination)
LimitSignerAllowed(uint256 indexed id, uint32 generation, bytes32 indexed signerId)
LimitDestinationAllowed(uint256 indexed id, uint32 generation, address indexed to)
SpendingLimitRemoved(uint256 indexed id)
Spent(uint256 indexed id, bytes32 indexed signerId, address to, uint256 amount)
ImplementationChanged(address)   ImplementationFrozen()
SubAccountCreated(uint256 indexed index, address subAccount)
AccountCreated(address indexed account, bytes32 salt)                // on the factory
```

Plus OpenZeppelin's `Upgraded(address)` from the proxy slot write. The indexer needs
nothing else: the signer set, the rules, the queue and the money are reconstructible
from these plus token `Transfer` events and the EntryPoint's `UserOperationEvent`.

Views: `getSigner(id)`, `getSigners()`, `getConfig()` (threshold, veto threshold,
effective veto threshold, the four counts, signer count, delays, epoch, limit count,
frozen), `getNonce(key)`, `getScheduled(hash)`, `isDead(hash)`,
`isApproved(hash, id)`, `getVeto(hash, id)`, `getLimitBudget(id)`,
`isLimitSigner(id, signer)`, `isLimitDestination(id, to)`, `implementation()`,
`subAccount(index)`, the three hashes of §4.

## 15. Invariants

"Never" means under any sequence of calls by any party. Each has a test.

1. **No execution without authorization.** Every path that moves value or changes
   state is one of §1's five. There is no other entry point.
2. **Threshold is the floor for arbitrary calls.** Only the Threshold path runs
   arbitrary calls; Recovery runs one fixed selector with equal permissions; Spend
   runs one fixed transfer.
3. **Rules change slower than money moves**, when the account says so. A
   configuration call is never executed in the transaction that authorized it when
   `configDelay > 0`; a guardian alone never acts in under an hour.
4. **A dead hash stays dead.** `dead[hash]` is never cleared; a scheduled entry
   whose hash died is gone.
5. **An epoch change invalidates every transaction and operation.** No signature or
   on-chain approval made under epoch `e` authorizes a transaction, an operation, or
   a scheduled execution under `e' != e`. (Message signatures are the stated
   exception, §4.)
6. **Nonces never repeat.** A `(key, sequence)` pair is consumed at most once by a
   completed execution or a schedule.
7. **Signature sets are exact.** A set with one invalid, duplicate, unknown or
   out-of-order entry authorizes nothing.
8. **A signer's key is checked as its kind.** No path recovers an address for a
   P256 signer or calls a contract for an ECDSA one.
9. **Spending limits cannot exceed their budget in any period**, cannot pay a
   destination not on the current generation's list, cannot be used by a signer not
   on it or added after the limit was set, and spend nothing once removed.
10. **Recovery cannot escalate.** The replacing signer's permissions equal the
    replaced signer's; recovery cannot change threshold, delays, limits or the
    implementation, cannot add a signer, and cannot shorten its own delay by
    co-signing itself.
11. **The account is never bricked.** After `initialize` and every configuration
    execution `_checkConfig` holds.
12. **Frozen means frozen.** After `freezeImplementation`, `setImplementation`
    reverts forever.
13. **Sub-accounts obey one parent.**
14. **No delegatecall** outside the proxy's forwarding to the stored implementation.
15. **EIP-1271 answers are bound to this account and this hash**, through
    `Message(hash)` in the account's domain, and honour `dead`.
16. **What a user operation validated is what it executes**, keyed by the
    operation's own hash, once, in the same epoch.
17. **A signer cannot brake its own removal by the quorum**; it can brake its
    replacement by a guardian.

## 16. Gas (measured)

Forge, `optimizer_runs = 200`, IR pipeline. Where a P-256 signature is involved the
test suite has Daimo's Solidity verifier standing in for the precompile, which costs
about 320k more than the real thing; the Arc column is what the chain charged.

| Operation | Forge | Arc testnet (§18) |
| --- | --- | --- |
| Create an account | 307k (two signers) | 407k (three signers, one a guardian) |
| `execute`, one ERC-20 transfer, 2 ECDSA | 88k (median of the suite) | not run |
| `execute`, one USDC transfer, P256 + ECDSA | 406k with the stand-in | **127k** |
| `execute`, a two-call configuration batch, scheduled | | 137k |
| `executeScheduled`, the same batch | | 176k |
| `spend` under a limit, ECDSA signer calling | 33k (mock token) | 75k (USDC) |
| `execute`, a guardian's recovery, scheduled | | 115k |
| Nested: outer 2-of-2 where one signer is a 2-of-2 Olien with a P256 key | 88k | 153k |
| User operation, P256 + ECDSA, one USDC transfer | 553k with the stand-in (whole bundle) | 171k charged to the account; 169k for the bundle |
| User operation, one P256 signer vetoing | | 251k charged; 238k for the bundle |

The Arc figures include the USDC transfer itself, which runs in the chain's token
implementation and costs about 40k more than a plain ERC-20. For comparison on Arc
(from `02-arc-facts.md`): Safe deploy with the 4337 module 336k; Safe 2-of-3 user
operation with a `P256Owner` 203k; nested Safe 156k. A P-256 signature costs the
account about 12k on Arc, against 44k through a `P256Owner` on Safe.

One client rule the proofs taught: a bundler estimates verification gas with a
placeholder signature, and a placeholder fails at the first packed entry, so the
estimate never covers the second signer's check. The client adds a margin (80k in
the proof script) or estimates with a signature that fails last.

## 17. Out of scope for version 1

Modules and hooks (the built-in policies cover the product; a later implementation
can add an executor interface; the code-size budget is the reason they left
version 1), on-chain signed messages (`signMessage`), weighted signers, session
keys, native (non-token) spending limits, sub-account EIP-1271, ERC-7579
compatibility, a paymaster, a signed meta-transaction shape for single-signer
actions (user operations cover the case; the relayer can call `handleOps` itself).

## 18. Deployment

The four contracts deploy through the Arachnid CREATE2 proxy
(`0x4e59b44847b379578588920ca78fbf26c0b4956c`) with fixed salts
(`olien.v1.verifier`, `olien.v1.sub-account`, `olien.v1.implementation`,
`olien.v1.factory`), so their addresses are the same on Arc testnet, Arc mainnet
and any chain with that deployer and EntryPoint v0.7
(`0x0000000071727De22E5E9d8BAf0edAc6f37da032`). The same addresses need the same
creation code, and the compiler ends that with a hash of the source paths, so v1 is
deployed from the bytes pinned in `deployments/v1/creation.json` by
`ops/deploy-olien.sh`, never by recompiling; addresses are recorded in
`deployments/<chain>.json` under `olien`.

| Contract | Address (Arc testnet, 2026-09-04) | Deployment | Arc mainnet |
| --- | --- | --- | --- |
| `OlienVerifier` | `0xE196558Ce080229B256dDE6e62CDA2B051B882fC` | `0xf609fe5cb614739258d7be4121aa801729a316cc11385276e2e5fc182b0b2d91`, 947,463 gas | pending |
| `SubAccount` implementation | `0xDfc576536187eF72689c514f8c7ea6487960a637` | `0x0f06a22dd855dc73c1e66aa38e35ef5cd48afbbf5aa62b5bcf9a184f1b7c0fc1`, 391,315 gas | pending |
| `Olien` v1 implementation | `0x8BFf8CCe4edbE882a21197D3942978CCd06fA427` | `0x439487259851a12d0780efd093f19963b0750eef99213d602d0c7f148391be0b`, 5,397,471 gas | pending |
| `OlienFactory` | `0xaF8c108D09E6A159D4dcE0919Ca6A81d6019f131` | `0x25476c642f95450f14b927f16fa8ccad48d09a393a4f0a4bbb222e3113abf968`, 481,351 gas | pending |

Two deployments preceded these the same day and are superseded. The first
(implementation `0xEcE0d813…`, factory `0x9C21E35f…`) did not record the validation
decision when a placeholder signature failed, which broke bundler gas estimation.
The second (verifier `0x8ec5622f…`, sub-account `0x392b9502…`, implementation
`0xD1919C6c…`, factory `0x18aD0C7b…`) carried the placeholder name in its EIP-712
domain and salts; the name became final that evening, and since the name is in
every hash the contracts were deployed again under it. The code is otherwise the
same, 24,545 bytes. The addresses above are the ones the proofs below ran against;
the placeholder deployment's proofs are in the git history of this file.

### Proofs by transaction

All on Arc testnet on the evening of 2026-09-04, against the deployment above,
from the attestor key `0xD6c5…983A`. The consumer account
`0x12808a601475b87ce7b343A18f11062cc74Eae81` has three signers: a P-256 device
key (APPROVE, VETO), the attestor EOA (APPROVE, VETO), and a guardian EOA
`0xb05A…236b` (RECOVER); threshold 2, `configDelay` 300 s, `recoveryDelay` 3600 s,
`recoveryCoSignDelay` 0 (the proof exercises the guardian-alone path; the product
default for consumers is an hour, `09-open-questions.md` item 24). The team
account `0x038B127a98ECD06640DFAEd105E2eF4deB492890` has the attestor and the
consumer account (CONTRACT) as signers, threshold 2, no delays. Every step
succeeded on its first submission.

| What | Transaction | Gas |
| --- | --- | --- |
| Create the consumer account through the factory | `0xb27af3e86d42b508dc65d221444f48b4cb00bedca544619770a373ef5eb2cddf` | 407,068 |
| `execute`: USDC transfer signed by the device (P-256, verified by the precompile) and the attestor | `0xf6a1b2b47809812b4095e4d5098af3d723ead21b5135bf1142d138231be91819` | 127,113 |
| `execute`: a spending-limit batch (`setSpendingLimit` + `allowLimitSigner`), scheduled 300 s out | `0xcdba8e4f8089d55ccd880658243762c09bebc596f530f2fc16d88d9d97e5c38d` | 136,792 |
| `execute`: the guardian alone schedules `replaceSigner(device, newDevice)` 3600 s out | `0x9c599421fc0f77e72ac90130247c588231d325e860853c869a8b08f03e3a7686` | 114,825 |
| **The device vetoes the recovery through a user operation** sent to Pimlico, signed by the P-256 key alone, gas paid by the account (0.0064 USDC); `isDead` is true afterwards | `0x50fbaff32c52cb94e352fd6de0994f9abdb618e9bb7edf690d34f9d72a8fd986` | 250,507 charged; bundle 238,168 |
| **Threshold user operation**: device + attestor pay 0.005 USDC through Pimlico (0.0044 USDC gas) | `0xf4f0bd13e13652153c3faab92f9d8bd530c4f687f6b9affa870f74da95738ba2` | 171,038 charged; bundle 169,065 |
| `executeScheduled`: the limit batch, after the delay, submitted by the attestor | `0x3595524249cb72a4b961315457bdafe4d56446b6d6fbe3bf9f09afb92aff9cee` | 176,438 |
| `spend` under the limit by the attestor calling from its own address; budget 50,000 to 30,000 | `0x423b9480b35365a306cf11bf8b956e81ee0bfd50085a4fbaec7e82bf619c819b` | 75,305 |
| Create the team account | `0x089ed725fc1ac780f0cdd059ba58b94b1526aa93c1c45de093c53a847d459856` | 309,943 |
| **Nested**: the team account executes with the attestor's signature and the consumer account's contract signature (inner: device P-256 + attestor over `Message(outerHash)`) | `0x9fbc2eb3bcb59c6c6aa842eb0a0db82efd5030c783a4bd0d90d9c560b9177481` | 153,497 |

Script: the scratch `olien_proofs*.sh` files of the session (cast, openssl and
curl; not part of the repository). The nested and user-operation rows are the two
that matter most: a consumer account is a first-class member of a team with no
extra contract, and a phone key acts alone on the chain with nothing but the
account's own USDC.

## 19. Review log

The first draft was reviewed adversarially on 2026-09-04 before implementation
(26 findings). What changed as a result, in the order of severity the review gave:

- **Execution bound to validation** (high): the plain `executeUserOp(Call[])` had no
  link to the validated operation, so two operations in a bundle could swap paths.
  Now `IAccountExecute.executeUserOp(op, userOpHash)` with a per-operation
  transient record; `dead` and the epoch are rechecked at execution.
- **Threshold could not cancel** (high): `cancel` added as an immediate self call.
- **Limit membership survived replacement** (high): sets keyed by generation;
  `since` versus the limit's epoch.
- **Initialize skipped the config check** (high): it runs it; the implementation is
  locked in its constructor.
- **A vetoer could block its own removal forever** (medium): vetoes apply to
  scheduled changes only, and the removed signer is excluded on the threshold path.
- **Recovery escalations** (medium): distinct co-signer without RECOVER; one-hour
  floor for a guardian alone; recovery is exactly one standard-encoded
  `replaceSigner`.
- **Removing power was delayed** (medium): `removeSpendingLimit` and `cancel` are
  immediate; limits no longer move the epoch.
- **1271 ignored `dead`** (medium): it honours it; the epoch trade-off is stated.
- **Unbounded validity** (medium): `validUntil` required and capped at 30 days.
- **Fallback verifier on every wrong signature** (medium): the probe (§5.4).
- **Nested signers under bundler rules** (medium): stated in §9.
- **`missingFunds` paid only on success** (medium): paid always.
- **Legacy 1271 return value** (medium): `0x20c13b0b`.
- **No relayable single-signer path for P-256** (medium): user operations with a
  single-signer path, submittable by any relayer through `handleOps`.
- **Limit edge cases, veto arithmetic, signer hygiene, upgrade checks, module reach,
  receivers, reentrancy** (medium to low): each fixed as described in the sections
  above; modules were removed from version 1 rather than fenced.
- Not adopted: probation for recovered signers (the exclusion rule covers the
  escalation the review described); signed meta-actions with their own EIP-712
  structs (code size; user operations cover the case); `clearExpired` for lapsed
  schedules (harmless storage).

## 20. Version 2

A second implementation exists, `contracts/src/v2/OlienV2.sol`, and `16-account-v2.md`
is the difference: everything above still holds, and what v2 adds is listed there with
its own invariants, numbered on from §15. The hashes of §4, the signatures of §5, the
paths of §6 and the storage of §3 are unchanged, which is what lets a v1 account adopt
v2 through §7.7 and keep its signers, its rules and its epoch.
