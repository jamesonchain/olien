# The account, version 2

The second implementation of Olien, built 2026-10-07, in `contracts/src/v2/`. It closes
the on-chain half of `14-audit-vs-enterprise.md`: C1, H2, H3, C2's inactivity path, L7,
L8, the recordable half of M6, and the scheduled view the console needed to stop trusting
the service about what is waiting. Every rule of v1 holds. v1's three test suites run
against v2 unchanged, apart from six tests that assert the things v2 changed on purpose.

`10-account-spec.md` stays the specification of what both versions share. This document
is the difference.

## What is new, in one sentence each

- **Money can be made to wait.** A payment above a tier, or to an address the account
  does not know, is scheduled instead of run, and any vetoer can kill it while it waits.
- **One vetoer can stop everything in flight.** `panic()` moves the epoch and nothing
  else.
- **A lost colleague is recoverable.** After a long silence, one approver alone may
  replace a signer's key, slowly, and the replaced signer can veto it.
- **A vetoed guardian is suspended** until the members replace it.
- **An upgrade names its code**, not just its address.
- **Spending limits refill continuously**, so "so much per day" means that.
- **A synced passkey is recorded as one.**
- **What is waiting can be read in one call**, with no event log and no service.

## Where the code lives, and why

v1's account was 31 bytes under the 24,576-byte code limit. Arc keeps that limit; Monad
raised its own to 128 KB, but an Olien sits at the same address on every chain, so the
smaller limit rules. Spending limits were 3,779 bytes of v1. The way to room was to move
things out of the account into contracts it already trusts, and that is the shape of v2:

| Contract | Bytes | Holds |
| --- | --- | --- |
| `OlienV2` | 24,320 (256 to spare) | signers, rules, nonces, schedule, epoch: everything that decides |
| `OlienPolicy` | 5,961 | every account's spending limits, transfer policy and known addresses |
| `OlienVerifierV2` | 7,028 | every signature check, and the EIP-712 hashes signers sign |

**OlienPolicy** is one contract for all accounts. Each row is keyed by `msg.sender`, and
an account reaches it only from functions that only the account itself can call, so an
account is the only writer of its own rows. Nothing in it moves money or decides who may:
a debit answers which token and sub-account to pay from, and the account pays; an
evaluation answers whether a batch waits, and the account schedules it. A bug there could
mis-count a budget. It could not spend.

**OlienVerifierV2** does what v1's verifier did for P-256 and passkeys, for every kind of
key, and also computes the transaction and user operation hashes from `OlienHash`, which
is unchanged. The account trusted its verifier completely in v1, since the verifier said
whether a signature was good; hashing in the same place adds no trust. The hashes are
the same bytes as v1's, so the console's `lib/signing.ts`, `ops/olien-hash.mjs` and the
service's vectors all still agree with the chain, and the EIP-712 domain version stays
`1`.

Both addresses are immutables on the implementation, as `VERIFIER` was.

v2 is compiled with `bytecode_hash = "None"` (`foundry.toml`, the `v2` profile), so its
creation code carries no metadata and its CREATE2 addresses depend on its code alone,
not on where the source files sat when it was built. That is the L11 lesson applied
before the fact.

## Money waits

A `Policy` lives in OlienPolicy for each account:

| Field | Meaning |
| --- | --- |
| `token` | the token the tier is counted in |
| `tier` | a batch sending more than this of `token` in one go waits; 0 means never by amount |
| `delay` | how long a held batch waits; required and at most 30 days if anything holds |
| `requireKnown` | a batch touching any address the account does not know waits |
| `learn` | a batch that waited and ran makes its addresses known |
| `lockedUntil` | loosening any of the above is refused before this time |

When a batch arrives under the threshold path, and the account's `policyOn` bit says the
policy holds something, the account asks `OlienPolicy.evaluate(calls)`. For each call
not to the account itself, the destination is the recipient of an ERC-20 `transfer`, the
spender of an `approve`, the recipient of a `transferFrom`, or otherwise the callee; the
amount counts toward the tier only when the call is to `token`. The batch waits if
`requireKnown` and any destination is unknown, or if `tier` is set and the amounts sum
past it. Native value is not tiered, but a plain call to a stranger still has to be
known. A batch that both changes a rule and pays waits the longer of the two delays.

A held batch is scheduled on the threshold path exactly as a rule change is: the same
`Scheduled` event, the same `executeScheduled`, the same veto with the same threshold,
and nothing is excluded from vetoing it. When it runs, if `learn` is on, every address it
paid becomes known, since the wait was the vetting. Two transfers each under the tier
wait as one batch when together they exceed it.

**Known addresses.** `setKnown(address[] list, bool known)` on the account. Knowing is a
rule change: it waits `configDelay` and can be vetoed. Forgetting is immediate under the
threshold, as taking a power away always is. The account does not know its own
sub-accounts by default; a team that pays into one lists it.

**Tightening at once, loosening slowly.** `setTransferPolicy(Policy)` is classified by
`OlienPolicy.loosens`: a higher or dropped tier, a changed token, a shorter delay,
`requireKnown` turned off, `learn` turned on, or an earlier `lockedUntil` is loosening,
and the call is a rule change like any other, waiting `configDelay` and vetoable. Anything
else is tightening and runs at once under the threshold. The first policy on an account
that holds nothing is always tightening. While `block.timestamp < lockedUntil`, a
loosening call is refused outright with `PolicyLocked`, so a locked rule cannot even be
scheduled away; that is BitGo's lock date, in the account.

The service's treasury policy (`11-service-api.md`) is the same idea enforced by a
service, which members holding the threshold can walk past. This one they cannot.

## Panic

`panic()` may be called by any signer holding VETO, directly or as the single self call
of a user operation. It moves the epoch, so every open approval, every validated but
unexecuted operation and every scheduled change dies at once, and emits `Panicked`. It
changes no rule, no member and no balance; the team re-proposes what it still wants.
Once a day per account, so a griefer can only ever delay, and a second pull within the
day would find nothing left to stop. Spending limits are untouched, as the audit
specified: a limit the team no longer trusts is removed by the threshold, immediately.

## Silence

`setDelays` takes a fourth delay, `inactivityDelay`, between 7 and 730 days or zero for
off. Every act by a signer touches `lastActivity`: an execution, a scheduled execution,
an approval, a veto, a spend, a panic. When more than `inactivityDelay` has passed since
the last one, one approver alone may open the recovery path: exactly one standard
`replaceSigner` keeping the old signer's permissions, scheduled behind `recoveryDelay`,
which has its one-hour floor whenever inactivity is on. Nobody is excluded from vetoing
it, so the colleague being replaced, if they are there, stops it with one veto, and that
veto is activity, which starts the clock again. Nothing else opens: the path can swap a
key for a key with the same role, as a guardian's can, and no more.

An account upgraded from v1 has `lastActivity` of zero until its first act under v2. Its
first act is the upgrade's own execution only if that ran under v2, which it does not,
so the first execution, approval or veto after the move sets it.

## Guardians

A recovery entry now records its guardian in the `excluded` field, which had no meaning
on the recovery path. When a recovery is vetoed to death, that guardian's RECOVER power
is suspended (`FLAG_SUSPENDED` on its signer record, `SignerSuspended` emitted): it still
approves whatever it may approve, and it cannot open recovery again. The members put it
back by replacing it with itself, `replaceSigner(id, same key)`, under the threshold,
which makes a fresh record. That closes L8's loop without a new function.

## Upgrades name their code

`setImplementation(address newImplementation, bytes32 codeHash)` refuses with
`CodeMismatch` unless `newImplementation.codehash == codeHash`. The hash is inside the
signed calls, so what the veto window judged is what runs, by construction and not by
the chain's fork schedule (L7).

## Limits

The budget refills continuously, at `amount` per `period`, up to `amount`: at any moment
`remaining + amount * elapsed / period`, capped. Over any span of one period a signer
can move at most `amount` beyond what was already there. v1's window reset on a clock,
which allowed twice the amount across the reset (H3). A `period` of zero is still a
one-time budget.

The account numbers its limits in the slot v1 used, so ids continue from where v1 left
them; the rows are in OlienPolicy, and so are `budget`, `isSigner`, `isDestination` and
the four limit events, each with the account as its first indexed topic. **v1's limits do
not cross the upgrade**: their rows stay in the account's old slots, unread, and the team
makes them again. `getConfig().limitCount` still counts.

## Synced passkeys

`FLAG_SYNCED` (bit 1 of a signer's flags) is accepted at `addSigner` and recorded, so the
chain knows which passkeys live in a cloud account. The rule that a rule change needs one
non-synced key was built and then taken out again for room; the console keeps it as the
warning phase 1 added. `FLAG_SUSPENDED` (bit 2) in an input is refused: only the account
sets it.

## The scheduled log

`getScheduledLog(from, limit)` returns every hash the account ever scheduled, in order.
A reader keeps a cursor and asks `getScheduled(hash)` which are still waiting. The log
only grows; entries that executed, were vetoed, went stale or lapsed stay in it, which is
what makes it cheap enough to fit. This is the view the console and `ops/watch-scheduled.mjs`
read so that a service which hides a scheduled change is caught by anyone who asks the
chain.

## Storage

The namespaced struct keeps every v1 field where it was. The four limit slots stay as
`__v1Limits`, `__v1LimitSigners`, `__v1LimitDestinations` and `nextLimitId`, so that
what follows lands after them: `lastActivity`, `inactivityDelay`, `lastPanic`, `policyOn`
(one packed slot) and `scheduledLog`. `ScheduleEntry` gains a `policy` bit in the packing
space after `path`, so a v1 entry read by v2 has it clear. `STORAGE_LOCATION` is
unchanged, which is what `setImplementation` checks before accepting new code.

## The ABI

Removed: `isValidSignature(bytes,bytes)` (the hash-shaped EIP-1271 call stays),
`getLimitBudget`, `isLimitSigner`, `isLimitDestination` (ask OlienPolicy),
`setDelays(uint48,uint48,uint48)`, `setImplementation(address)`.

Added on the account: `setDelays(uint48,uint48,uint48,uint48)`,
`setImplementation(address,bytes32)`, `setTransferPolicy(Policy)`,
`setKnown(address[],bool)`, `panic()`, `getState()` (inactivity delay, last activity,
policy on), `getScheduledLog(uint256,uint256)`, `POLICY()`. Events `Panicked`,
`DelaysChanged` with four fields, `SignerSuspended`. Errors `Cooldown`, `CodeMismatch`.

On OlienPolicy: `policyOf`, `knownSince`, `budget`, `isSigner`, `isDestination`,
`canSpend`; events `SpendingLimitSet`, `LimitSignerAllowed`, `LimitDestinationAllowed`,
`SpendingLimitRemoved`, `TransferPolicySet`, `DestinationKnown`, `DestinationForgotten`,
all with the account as the first indexed topic; error `PolicyLocked`.

Unchanged: every hash, every v1 event the account still emits, `getConfig`,
`getScheduled`, `Spent`.

## Gas

Forge, mock token, `optimizer_runs = 1`. v2 pays for two external calls it did not make
before: the hash, and each signature's check.

| Operation | v1 | v2 |
| --- | --- | --- |
| `execute`, nested 2-of-2 inside a 2-of-2 | 87,655 | 95,663 |
| `execute`, P-256 + ECDSA, with the Solidity P-256 stand-in | 407,335 | 417,996 |
| `spend` under a limit | 33,222 | 35,143 |

With a policy on, an execution also asks OlienPolicy once, a few thousand more.

## Invariants added

Numbered on from `10-account-spec.md` §15.

18. **A held payment is a scheduled entry.** It can only run through `executeScheduled`
    after `policy.delay`, in the epoch it was scheduled in, and any vetoer can kill it.
19. **A policy only tightens at once.** A call that loosens it waits `configDelay`, and
    is refused while the policy is locked.
20. **Panic changes the epoch and nothing else**, and not twice in a day.
21. **Silence opens recovery and no more**: one approver, one `replaceSigner` keeping
    the role, behind `recoveryDelay`, vetoable by anyone with VETO.
22. **A vetoed guardian cannot recover again** until the members replace it.
23. **New code runs only with the hash it was named by.**
24. **A budget never exceeds its amount**, and refills at most `amount` per `period`.

Each has a test in `test/v2/OlienV2.t.sol`.

## The move

An account adopts v2 by `setImplementation(v2, keccak256(v2.code))` under v1, which
waits `configDelay` and can be vetoed; `test_aV1AccountMovesToV2AndKeepsItself` is that
move, with a limit before it and a panic after. New accounts come from a factory built
with the v2 implementation; `OlienFactory`'s source is unchanged and only needs the
implementation address.

What the clients do, as of 2026-10-07:

1. **Console**: the signing screen reads v2's calls; Settings shows which version an
   account runs and proposes the move, with the code hash this browser computed from
   the chain's bytes; a v2 account gets the transfer policy panel, the known-address
   list held against the chain, and the brake, by wallet or by passkey; the signing
   page asks the policy contract itself whether a transaction will be held; and the
   chain-agreement check reads `getScheduledLog` and names a scheduled change the
   service does not show.
2. **Service**: knows the new selectors; carries v2's addresses from the chain file
   and serves v2 only when its boot check finds the code at all four, v1 only until
   then; makes new accounts on v2's factory when it does; indexes the policy contract's
   limit events by the account topic; reads budgets from either place; opens an account
   on either implementation; and prepares a panic operation for a passkey.
3. **Deployment**: `ops/pin-v2.sh` wrote `deployments/v2/creation.json`; the four Monad
   addresses are in `deployments/10143.json`; `ops/deploy-olien.sh --book v2` sends the
   bytes; `ops/live-check.mjs` proves a v2 account end to end once the service carries
   it.

| | Monad testnet |
| --- | --- |
| verifier | `0x2aaeb413EA006f3Be4a3509Ef090d792C75657df` |
| policy | `0x31d8b74ae00E4F186ad4D85905F59CA60C4e3C91` |
| implementation | `0x319D127eA9f2E84cd65b353c41FBd1da3992B98b` |
| factory | `0xf9Cca12e97E2af0516c554816873fb7c71743F50` |

The same bytes through the same deployer land on the same four addresses on any chain
with the EntryPoint and v1's sub-account implementation, so these are also v2's
addresses on Arc.

## Known limits

- Validation of a user operation that calls `spend` no longer asks the limit, so a
  signer the limit does not name pays for a refused spend. The service's relayer
  submits `handleOps` itself and does not care; a public bundler would also have
  refused OlienPolicy's nested storage under ERC-7562, which is the other reason.
- The tier counts one token. A treasury holding two stablecoins tiers one of them, and
  the other is held only by the known-address rule.
- An approval of a known spender is instant, which is right, and an approval amount
  counts toward the tier, which is conservative.
- `learn` makes every address a waited batch paid known, contracts included.
- Panic is once a day per account, not per signer. A compromised vetoer can delay the
  team once a day; the team removes it under the threshold, immediately.
- The scheduled log never shrinks. A reader pages it.
- The synced-passkey rule is the console's, not the chain's.
