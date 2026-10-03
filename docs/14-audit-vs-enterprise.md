# Olien against the enterprise bar

An audit of the account, the service and the console as they stand on 2026-09-29,
measured against how institutional custody products control money and against
what the large multisig failures of the last three years actually turned on.
Written to be acted on, so every finding names the file and the line, says why it
matters with an incident or a vendor control beside it, and says what to build.

## Method

Three sources, kept separate on purpose because they disagree in places:

- **The documents**: `10-account-spec.md`, `07-security-model.md`,
  `05-onchain-design.md`, `06-algorithms.md`, `01-landscape.md`,
  `09-open-questions.md`. They say what was intended.
- **The code**: `contracts/src/*.sol`, `service/src/*.rs`,
  `console/components/olien/*.tsx`. It says what is true. Where the two disagree
  below, the code wins and the disagreement is itself a finding.
- **Outside**: vendor documentation for Fireblocks, BitGo, Coinbase Prime, Anchorage,
  Squads and Safe, and the post-mortems of Bybit, Radiant, WazirX, Ronin, Drift and
  Parity. Cited in §4 and §5.

Every claim about the code was checked by reading it, not the docs about it.

## 1. What is genuinely strong

Credit first, because most of this list would be findings against other products.

- **Cross-chain replay is closed.** The account sits at the same address on Arc and
  Monad by design, which is exactly the precondition for replaying a signature from
  one chain on the other. `OlienHash.domain()` puts `block.chainid` and the account
  address into every EIP-712 domain, and `Message(bytes32)` wraps every foreign
  digest in that domain, so a set of signatures is valid on one chain only.
  (`contracts/src/OlienHash.sol:24`)
- **Nobody can claim your address with different signers.** The factory derives the
  address from the initializer, which carries the signer set, and the salt
  (`contracts/src/OlienFactory.sol:24`). Money sent to the address on a chain where
  the account does not exist yet can only ever be claimed by the same signers.
  Safe's cross-chain replay incident was the opposite property.
- **No delegatecall, no modules, no hooks, no guards.** Invariant 14. The Bybit
  attack was a client flipping `operation` to delegatecall; the account has no such
  bit to flip. The implementation moves only through `setImplementation` behind
  `configDelay` and the veto, or never after `freezeImplementation`
  (`contracts/src/Olien.sol:449`).
- **The console signs only what it built, over calls it decoded itself.** True since
  2026-10-04, and not before. When this audit was first written the console did
  rebuild the typed data and refuse a mismatched hash, and this list credited it with
  the Radiant and Bybit lesson for that. It had half of it: the hash was checked and
  the screen was not. See C0, which is the largest thing the first pass missed.
- **Canonical signatures only.** Both curves reject high-s (`Olien.sol:74`,
  `OlienVerifier.sol:38`), so a malleated signature cannot be replayed as a
  different one.
- **Validation is bound to execution.** What a user operation validated is what it
  runs, keyed by its own hash, once, in one epoch (invariant 16). This closes the
  bundle-swap class of ERC-4337 bugs.
- **Recovery cannot escalate and a guardian alone always waits an hour.** Invariants
  10 and `_checkConfig` (`Olien.sol:990`). A stolen mailbox cannot become an
  instant takeover.
- **API keys cannot sign.** Scopes are `read` and `propose` only
  (`service/src/treasury_keys.rs:25`), and `Need::Person` names what a key may never
  do. That is stricter than Fireblocks' API co-signer and it is the right call.
- **Webhooks are signed** with an RFC-style HMAC over timestamp and body
  (`service/src/webhooks.rs:113`).
- **The prior review was real.** 26 findings changed the design before code, and
  four of them (execution bound to validation, threshold can cancel, limit membership
  by generation, the recovery co-signer rule) are the kind an auditor charges for.

## 2. Findings

Severity is about money, not code style. Critical means a plausible path to loss or
lock-up under the product's own threat model. High means a control every serious
vendor has and this one lacks. Medium means the design promises it and the code does
not deliver. Low is hygiene.

### C0. The signing screen showed the proposer's description, not the calldata

*Found 2026-10-04 while starting phase 2. Fixed in the console the same day and live
on olien.org; the service half is committed and not yet deployed (see §6).*

**What.** For a payment, the transaction page showed the recipient, the amount and
the label from `intent.recipients`, the free-form description stored beside a
proposal. The generic route `POST /proposals` kept any intent with any calls, from
any member and from any API key scoped to `propose`. The hash check compared the
typed data with `txHash` and never compared either with what was on the screen. So a
proposal could read "250 USDC to Acme Ltd", pay any address any amount, and pass
every check the console made. A passkey shows its holder nothing, so for a passkey
member the screen was the whole of what they knew.

The same trust ran through every other signature. A cheque signed the typed data and
the hash the service supplied; the account answers ERC-1271 for any `Message(hash)`
and a passkey signs a bare hash, so the supplied hash did not even have to be a
cheque's. A veto and a limit spend by passkey signed the operation hash as given. A
veto and a spend by wallet sent the service's `to` and `data`. The EIP-712 domain
came with the proposal, so one built for another account the member also signs for
would have been signed from this account's page. The sign-in text was whatever the
service returned.

**Evidence.** At `473446d`: `console/components/olien/transaction.tsx:41` reads
`view.intent.recipients` and line 498 renders it; `:178` and `:313` hand a passkey a
hash from the service; `payroll.tsx:281` and `:301`; `settings.tsx:343` and `:361`;
`wallet.tsx:41`. `service/src/treasury.rs` `create_proposal` passed `body.intent`
through unchanged. `console/lib/signing-surface.test.ts` fails on exactly those
eleven lines when run against that commit.

**Why it matters.** This is the Bybit attack without needing to compromise anything:
the signers' own interface displayed a description an attacker wrote, and a leaked
payroll key was enough to write one. The first version of this document said in M2
that "the decoding is in the client". It was not. That sentence came from the
security model and was not read in the code, which is the method this document
claims for itself and did not follow there.

**Fix.** `console/lib/signing.ts` builds everything a member signs from what the
screen shows, and compares what the service sent instead of using it. Calls are
decoded from the message that is hashed, and a decode counts only when encoding it
again gives the same bytes. The domain is the console's own chain and the account in
the address bar. The intent attaches a label or a memo to a payment only when it
agrees with that payment exactly; when it contradicts the calldata it is shown
nowhere and approving is switched off. An unreadable call, an upgrade, a frozen
implementation, a zero delay and an allowance each need the member to say they have
read it before Approve appears. A cheque's digest is derived from the row. An
operation is checked to be the one call that was asked for, on this account, for at
most two hours at a bounded fee, and its hash is computed locally. The hashing is
pinned to the vectors the contract and the service pin. In the service, `describes()`
refuses a kind or an intent that contradicts the calls before it is stored.

**What remains.** A hostile service can no longer change what a member signs. It can
still leave things out: the console lists the proposals and scheduled changes the
service lists, so a scheduled change it hides is one nobody vetoes. The account does
not enumerate its scheduled hashes, so the console cannot rebuild that list from the
chain without an indexer of its own; a v2 view that lists them closes it, and until
then an independent watcher on the `Scheduled` event is the defence. Signer labels
are also still the service's, which is why a rule change is shown by address and id
and never by label.

### C1. Money moves instantly at any size, and nothing can brake it

**What.** The threshold path executes a transfer of any amount in the same
transaction that authorizes it. There is no on-chain delay, no amount tier, no
destination check, and no member who can stop it once `threshold` signatures exist.
Invariant 4 says rules change slower than money moves; money itself has no brake.

**Evidence.** `execute` runs `_runCalls` immediately for non-config calls
(`Olien.sol`, the threshold path in §6.3); the only delayed path is configuration.
`06-algorithms.md §6` designs amount tiers and a known-destination rule as soft
policy, and `service/src/treasury.rs:1830` shows the actual gate:
`count_approvals >= threshold`. Nothing else.

**Why it matters.** Every large multisig theft of the last three years was a quorum
tricked or compromised, not a signature forged: Bybit's signers approved what they
were shown, Radiant's signed an ownership transfer they read as a transfer, WazirX
signed an upgrade. Olien's hash-on-device rule shortens the odds of being tricked.
It does nothing once the quorum has been tricked, and a treasury's whole balance can
leave in one block. Fireblocks, BitGo and Coinbase all tier approvals by size and
delay or block above a line; Squads time-locks executions; Argent delays transfers to
unknown addresses. Olien has none of these on chain and none in the service.

**Recommendation, on chain (v2).** Two settings, both scheduled behind `configDelay`
like every other rule:

- `transferDelay(amountTier)`: a transfer whose outgoing value in a single
  transaction exceeds the tier is scheduled, not executed, and can be vetoed during
  the wait exactly as a config change can. Below the tier, today's behaviour.
  Denominate the tier in the token the treasury holds, since gas is USDC here.
- `knownDestinations`: an account-level allowlist. Paying an address not on it is a
  scheduled transfer regardless of size; adding an address is a config change
  (delayed, vetoable). This is Argent's trusted-contacts model for teams, and it is
  the single control that would have given every quorum in the incidents above a
  window in which someone could say no.

Two refinements the vendors argue for. **Tightening should be instant and loosening
slow**: Coinbase forces a video call with its operations team when a policy above
$1M is weakened but not when it is strengthened [C3]. Olien's config lock can be
asymmetric the same way: raising a threshold, shortening a limit or adding a delay
executes at once; the reverse waits `configDelay`. And **some rules should be
unremovable**: BitGo lets a policy carry a `lockDate` and a mutability constraint of
permanent, managed or sticky [B2]. A treasury that wants a control it cannot be
talked out of under pressure should be able to freeze that one rule the way it can
freeze the implementation.

**Recommendation, in the service (now).** Build the soft policy `06-algorithms.md
§6` already specifies: `approvalTierFor(amount)`, `requireKnownDestination`, and
hours. Mark it "Treasury policy" as the docs say, because a member holding threshold
keys can bypass it. It is not a wall. It is the wall's blueprint, and it is worth
having before the wall exists.

### C2. A treasury below threshold has no way back

**What.** A treasury with no RECOVER signer that loses enough keys to fall below
`threshold` is locked forever. The console lets a team create a 2-of-2 with no
guardian and says nothing.

**Evidence.** `_checkConfig` guarantees the *configuration* can act
(`Olien.sol:990`); it cannot guarantee the keys exist. `new-account.tsx` validates
that each member has a permission and nothing about the shape of the set; a search
for any warning about 2-of-2 or a missing recoverer finds none. `07-security-model.md`
says treasuries "have no RECOVER signer unless they name one".

**Why it matters.** BitGo holds a backup key in a 2-of-3 precisely so a customer
losing one key is a procedure and not a funeral. Anchorage and Coinbase run recovery
ceremonies. A team product that can be bricked by one lost laptop is not enterprise.

**Recommendation.** In the console, refuse to create a treasury where losing any one
key makes the threshold unreachable unless a RECOVER signer exists, and say why. Offer
two guardians that cost nothing to add: a second Olien or Safe the team already has
as a CONTRACT signer with RECOVER only, and, later, an inactivity path (v2): if no
signature has been seen for `inactivityDelay`, a designated signer may propose
`replaceSigner` behind `recoveryDelay`, vetoable by anyone else. Argent's
guardian recovery behind a security delay has shipped for years; the inactivity
trigger is that mechanism with a timer in front of it, which is why it is cheap here:
`recoveryDelay`, the veto and the exclusion rule already exist.

### H1. One honest member cannot stop a compromised quorum

**What.** The automatic veto threshold is `approverVetoerCount - threshold + 1`
(`Olien.sol:983`). In a 2-of-3 where every member can veto, two vetoes are needed,
so the one member who did not sign a hostile change cannot stop it. In a 3-of-5,
three.

**Why it matters.** The purpose of a veto is that a minority who sees something wrong
can freeze it. Under the automatic formula the minority that can veto is the same
size as the majority that can approve, so the veto adds no protection against a
compromised quorum, only against a quorum that changes its mind. The design chose
this to prevent one griefer from blocking every change forever, which is a real
concern. Both concerns are real, and the console currently chooses for the team
silently.

**Recommendation.** Make it a decision the team sees. Default treasuries to
`vetoThreshold = 1` ("any member can stop a rule change") and show the trade-off:
one member can delay changes, but never money, and never their own removal, because
the removed signer is excluded from vetoing it (invariant 17). That last property is
what makes `1` safe here where it would not be elsewhere. Keep the automatic formula
for accounts that opt out.

### H2. No brake exists that a single member can pull

**What.** There is no pause, freeze or panic. The only way to invalidate every open
approval is an epoch advance, which happens only when a *config change executes*,
which takes `configDelay` (`Olien.sol:1001`). A member who discovers their own key or
a colleague's is compromised can cancel pending hashes only with `threshold`
signatures, which is the thing they no longer trust.

**Why it matters.** Fireblocks and BitGo both let an admin freeze outbound instantly.
Radiant's remaining signers could do nothing while their colleagues' machines were
owned. The account has the primitive for a brake already: the epoch. Invariant 5 says
an epoch change invalidates every transaction and operation. It is just not
reachable by one person.

**Recommendation (v2).** `panic()`: callable by any signer holding APPROVE and VETO,
it advances the epoch and nothing else. Every open approval, pending user operation
and scheduled execution dies; balances, signers, threshold and limits are untouched;
the team re-proposes what it still wants. Griefing is bounded by a cooldown per
signer (say 24 hours) and the fact that it changes no rules. Squads does not have
this. Safe does not have this. It is one function, one event and one storage slot,
and it turns "we think a key is compromised" from an emergency into a button.

### H3. Spending limits reset on a fixed clock, so the real cap is double

**What.** A limit's window is fixed: `resetAt += period * k` (`Olien.sol:325`). A
delegate can spend the full `amount` just before `resetAt` and the full `amount`
just after. The effective cap over any short span is `2 * amount`.

**Why it matters.** BitGo's velocity limits and Argent's daily limit are sliding
windows over the trailing period, which is what "no more than X per day" means to a
CFO. A payroll key with a 10,000 USDC daily limit can move 20,000 in two minutes
here, and the console shows `remaining` as if that were not so.

**Recommendation.** Cheapest honest fix, now: the console states the true bound
("up to 2x the amount across a reset"). Real fix (v2): a sliding window, either a
ring of the last N spends or the standard "leaky bucket" refill (`remaining` grows
linearly at `amount / period` up to `amount`), which Zodiac Roles v2 already uses.
The refill form costs one extra storage read and no array.

### M1. The console does not give the warning the security model promises

**What.** `07-security-model.md` says "the client warns when an account sets the
delay to 0". No such warning exists in `new-account.tsx` or `settings.tsx`; the only
delay check is the 30-day maximum (`settings.tsx:116`).

**Why it matters.** A `configDelay` of zero means rules change as fast as money moves
and the veto never fires. The one screen where that is decided says nothing.

**Recommendation.** A red line under the field: "With no delay, a compromised quorum
can change who controls this treasury instantly. The veto never fires." Same for
`recoveryDelay` under one day.

### M2. Simulation happens once, on the server, and the signer trusts it

**What.** The service simulates at proposal time (`treasury.rs:1563`) and stores a
verdict; the console shows that verdict and otherwise "Not simulated yet."
(`transaction.tsx:550`). No signer's browser simulates independently.

**Why it matters.** The security model's own "What a compromise yields" row says a
hostile service can "propose calldata with a misleading label" and that the defence
is decoding and simulation *in the client*. The decoding is in the client since C0's
fix and was not before it. The simulation still is not, and the page now says the
result is the service's rather than printing "Simulation passed". Security Alliance's guidance, which the model adopts, is that at
least two signers simulate independently because simulations can be spoofed.

**Recommendation.** An `eth_call` from the browser against the account, through the
chain configured in `lib/chain.ts`, before the sign button enables, with the balance
deltas shown beside the decoded intent. Tenderly-style is not needed; one call from
the account's own address is.

### M3. The service has no rate limiting and no audit export

**What.** No limiter in the service (`Cargo.toml`, `src/`), and no audit log of who
proposed, signed, executed or vetoed beyond the rows themselves. The ledger exports
to CSV; the actions on it do not.

**Why it matters.** Every vendor in §4 offers an exportable, append-only audit trail;
SOC 2 auditors ask for it first. And a public API with API keys and no rate limit is
a brute-force surface for `treasury_keys::resolve`.

**Recommendation.** An `olien_audit` table written on every state transition (actor,
key id if any, action, hash, before, after, at), exposed as CSV and JSON under a
`read` key, and a per-key and per-IP limiter on `/api/treasury`.

### M4. Reads that gate execution trust one RPC

**What.** The roadmap's Phase 4 lists "second RPC for execution-gating reads". Not
done. The service reads nonces, signers and the epoch from one endpoint.

**Why it matters.** The security model's own table says an RPC provider can "lie
about balances, epoch, nonces, receipts" and that the mitigation is a cross-check.

**Recommendation.** For the three reads that gate `ready` (sequence, epoch, signer
set), read from two endpoints and refuse to mark ready on disagreement.

### M5. The address book is a database row a compromised service could write

**What.** Known destinations live in `olien_address_book` in the service's Postgres
(`service/src/treasury.rs:2699`), written by whoever holds a session. Nothing signs
an entry, and the console shows a labelled destination as known because the row says
so.

**Why it matters.** The security model's own table says a hostile service can
"propose calldata with a misleading label". An address book it controls is the
label. Fordefi has address-book entries signed by the members' device keys so a
compromised backend cannot inject a destination [D7]; BitGo time-locks new whitelist
policies for 48 hours and lets only its own support unlock them [B3]. Once C1's
`requireKnownDestination` exists, this table is the thing it trusts, and it must not
be forgeable by the service.

**Recommendation.** Now: each entry carries a signature by a member over
`(account, address, label)` in the account's EIP-712 domain, verified by the console
before it renders the label, so a row the service invented shows as unlabelled. v2:
the on-chain `knownDestinations` of C1 makes the book itself a config change, delayed
and vetoable, and the database becomes a cache of the chain.

### M6. Two passkeys on one iCloud account count as two members

**What.** A synced passkey is not a device. Apple and Google sync passkeys across
every device signed into the same account, and the authenticator says so at
enrolment through the BE and BS flags in `authenticatorData` [W3C-backup]. The
console's `createPasskey` reads the public key and nothing else
(`console/lib/passkey.ts`); the account stores kind, permissions, flags and the
curve point. So a 2-of-3 whose two passkeys live in one iCloud account is, for the
purpose of that account's compromise, a 1-of-2.

**Why it matters.** The security model already says a synced passkey is "one
anchor" and should never be the sole signer above the small-amount tier. The code
has no way to know when two anchors are the same anchor. CertiK's guidance and the
WebAuthn spec both put the security boundary at the cloud account, not the device
[CertiK][W3C-backup].

**Recommendation.** Now: record BE at enrolment and label the member "synced
passkey" in the console; refuse, or warn hard, when a threshold can be met entirely
by synced credentials. v2: a `custodian` byte on the signer (device, synced, hardware,
contract) so the account itself can require one non-synced factor for config and
recovery paths, which is requirement R23 of the incident checklist below.

### M7. The console is a normal web build, and the security model says it is not

**What.** `07-security-model.md` says "a static, verifiable build of the client is
published, as Squads does" and "no script loads from a CDN at runtime; dependencies
are pinned and integrity-checked". The console is a standard Next.js build deployed
from a laptop with `vercel deploy`; `next.config.ts` sets no static export, no
script carries an `integrity` attribute, and no build hash is published anywhere.

**Why it matters.** This is the Bybit vector exactly: not the contract, not the
keys, but the JavaScript that builds the signing payload, edited in the bucket that
serves it [Sygnia][NCC]. Olien's hash-mismatch refusal in the console is the right
defence and it runs inside the same page an attacker would edit. The model knows
this, which is why it promises a verifiable build. It has not happened.

**Recommendation.** Publish the build: a reproducible `next build` whose output hash
is committed and printed on the sign screen; SRI on every script tag; the Vercel
deploy token separated from any developer session (Safe's compromise was a hijacked
developer AWS session [Sygnia]); and, cheapest of all and independent of the rest,
the second-device verifier in L4, so a member can check a hash without trusting
any web page at all.

### L1. One key is relayer, attestor and deployer on three services

**What.** `ATTESTOR_PK` is the relayer for the Arc testnet service, the Monad service
and the Arc mainnet service, and paid for both mainnet deploys. Its nonce has already
raced between processes once.

**Recommendation.** One `RELAYER_PK` per service, funded separately; the attestor key
kept for what it attests. The playbook's "relayer key leak: rotate" step assumes the
key is rotatable without touching anything else, which is only true if it is alone.

### L2. The recovery vault key has no ceremony

**What.** `RECOVERY_VAULT_KEY` wraps every sealed recovery key at rest and has no
vendor-side copy. It was generated on a laptop and set on the service the same
minute.

**Recommendation.** Write the ceremony down: where the backup lives, who holds it,
how it is tested. Anchorage's entire product is this paragraph done well.

### L3. Passkey counter and rpIdHash are unchecked

Noted, not a finding. The spec's reasoning holds (the platform binds the credential
to its origin; a public verifier cannot know the right origin), Coinbase and Safe
made the same call, and synced passkeys report a zero counter anyway. Worth stating
in the console's member screen that a synced passkey is "one anchor, not a device".

### L4. No way to verify a hash without a web page

**What.** `getTransactionHash` is a view on the account and the service shows the
hash everywhere, but there is no tool a member can run on a second machine to
recompute it from the raw calls. Safe's answer to Bybit was exactly such a tool,
`safe-tx-hashes-util`, run on an isolated device [S7].

**Recommendation.** A 200-line script in `ops/` that takes the account, the calls,
the nonce key and the validity window, computes domain, struct and final hash with
`OlienHash`'s rules, and prints them beside the service's answer. It is the cheapest
item in this document and the one a large treasury will ask for first.

### L5. EntryPoint v0.7 carries a griefing vector fixed in v0.9

**What.** Before v0.9, an attacker could trip a must-revert condition and force a
validly signed operation to execute while it holds, so the account pays for a
reverted call; v0.9.0 requires `handleOps` from an EOA at top level [P11]. Arc and
Monad expose v0.7 and the account targets it. The cost is gas, not money at rest,
and the account's own `validUntil` bounds it.

**Recommendation.** Note it in the risk register; move when a v0.9 EntryPoint is
canonical on both chains. Nothing to do before then.

### L6. The service does not check the code it talks to

**What.** `ops/arc-mainnet-check.sh` and `ops/monad-check.sh` compare code hashes
at deploy time. The service itself never does: it reads addresses from the
deployment file and trusts them for as long as it runs.

**Recommendation.** At boot, `extcodehash` of the factory, the implementation and
the verifier against a hash pinned in the deployment file, and refuse to start on a
mismatch. One RPC call each, and it turns "someone changed the deployment file" into
a crash instead of a quiet wrong chain.

### L7. A scheduled upgrade pins an address, not the code at it

**What.** `setImplementation(newImplementation)` schedules an address. If the code
at that address could change between scheduling and execution, the veto window
would have judged different code from what runs. On a chain with Cancun semantics
this cannot happen, since `SELFDESTRUCT` no longer removes code after the creating
transaction; the Tornado Cash governance attack of 2023 used exactly that on a chain
where it still could [Halborn-TC].

**Recommendation (v2).** Record `extcodehash(newImplementation)` when the change is
scheduled and require it unchanged at `executeScheduled`. Ten lines, and it makes the
property true by construction rather than by the chain's fork schedule.

### L8. A compromised guardian can re-propose recovery as fast as it is vetoed

**What.** A veto kills one scheduled hash. A RECOVER signer whose recovery is vetoed
can schedule another at the next nonce, and each waits `recoveryDelay` and needs
another veto. Removing the guardian is the way out, and it works because the removed
signer is excluded from vetoing its own removal (invariant 17), but that removal waits
`configDelay`, during which the loop continues. OpenZeppelin's recoverable-wallet
audit found the same loop and had it fixed with an atomic cancel-and-remove [OZ-RW].

**Recommendation.** The consumer app is the only product with a RECOVER signer
today and its guardian is Recourse's own sealed key, so this is theoretical there.
For treasuries that name a guardian (C2), v2 should let a veto of a recovery also
suspend that guardian until the threshold reinstates it, which is the atomic form.

### L9. `initialize` is callable on the implementation contract

**What.** A proxy cannot be initialised twice (`Olien.sol:195`), but nothing stops
anyone from calling `initialize` on the implementation contract itself and becoming
its signer. This is the Parity library pattern [OZ-Parity]. It is harmless here for
one reason only: the account has no `selfdestruct` and no delegatecall out, so an
"owned" implementation can neither die nor act on the proxies that delegate to it.

**Recommendation.** `_disableInitializers()` in the constructor, or initialising the
implementation with a dead configuration at deployment. One line, and an auditor
will otherwise spend a page explaining why it is fine.

### L11. This repository could not reproduce its own deployment

*Found and fixed 2026-10-04.*

**What.** An account's address is a function of the factory's address, and the
factory's of its creation code. The compiler ends creation code with a hash of the
source paths. This repository was split out of the one v1 was deployed from, the
contracts moved from `src/olien/` to `src/`, and so every contract built here had a
different creation code and a different CREATE2 address: the factory at `0x06C6...`
instead of `0xaF8c...`. The factory also carries the proxy's creation code inside it,
with the proxy's own path hash, so even at the right factory address a rebuilt factory
would have made accounts at different addresses. The deploy script was pointed at a
file name that no longer existed, so it failed before it could do this.

**Why it matters.** "The same address on every chain" is a safety property here and
not a convenience: money sent to a team's address on a chain where the account does
not exist yet is claimable only if the same factory can be put at the same address
there. A mainnet deployed by recompiling would have broken that for every account,
silently, and nothing in the repository would have said so.

**Fix.** `deployments/v1/creation.json` holds the four creation codes v1 was deployed
from; each is checked to predict its recorded address. `ops/deploy-olien.sh` sends
those bytes and compiles nothing. `contracts/test/OlienCanonical.t.sol` deploys them
and asserts that the logic in each, compiler metadata aside, is the logic of the
source in this repository, so the pinned bytes cannot drift from the code people
read. The script that deployed by recompiling is gone. For v2, set
`bytecode_hash = "none"` so the address depends on the code alone.

### L10. API keys never expire

**What.** `olien_api_keys` has `revoked_at` and no `expires_at`. A `propose` key
minted for a payroll job in September proposes forever. Ronin's fifth signature was a
gas-free allowlist granted in November 2021 and never revoked [Halborn-Ronin].

**Recommendation.** `expires_at`, default 90 days, shown beside the key in the
console, with a renewal that is a fresh mint. Every vendor in §4 that scopes keys
also expires them.

## 3. Two things worth building that nobody else has

Both fall out of properties Olien already has and competitors do not.

**Money moves slower than trust.** Combine C1's two settings into one idea a team can
understand: paying someone the treasury has paid before is instant; paying someone
new, or paying more than the tier, waits a delay any member can veto. Safe cannot do
this without a module; Squads has a flat time lock; the custodians do it server-side.
Doing it inside the account, vetoable, with the exclusion rule keeping the veto
un-griefable, is a control that is trust-minimised *and* usable, which is the pair
everyone else trades off.

**The panic epoch.** H2. One function that invalidates every in-flight approval
without changing a single rule, pullable by one member, bounded by a cooldown. The
epoch already exists as a concept and an invariant; exposing it is small. In the
Radiant scenario it is the difference between watching and stopping.

## 4. Against the vendors

Primary sources only: vendor documentation and APIs, cited by tag; the source list is
at the end. "Service" means enforced off chain by the vendor before it co-signs;
"account" means enforced by a contract or program the customer controls. Olien's
column is the code as of this audit, not the documents.

| Control | Fireblocks | BitGo | Coinbase Prime | Fordefi | Squads | Safe | Olien today |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Destination allowlist, additions governed | Admin quorum per address; `dstAddressType` [F1][F3] | Whitelist rules; new ones lock 48h [B2][B3] | Address book behind consensus [C4] | Entries signed by device keys [D7] | Only inside spending limits [Q2] | Only via Zodiac Roles or Shield [S10][S4] | Only inside spending limits; a service-side book (M5) |
| Amount tiers raising approvals | `2-TIER` with `authorizationGroups` [F1] | `transfer.amount` + `minRequired` [B5] | Ten tiers from $10K to $100M [C2] | Amount max, allow/block/approve [D1] | Single threshold [Q5] | Fixed M-of-N [S5] | **None** (C1) |
| Cumulative limit per window | `amountScope: TIMEFRAME` [F1] | `velocityLimit`, 1 to 30 days [B2] | Daily withdrawal tiers [C8] | Periodic amount [D1] | Per-limit, fixed period [Q4] | Allowance module, fixed period [S9] | Per-limit, fixed period (H3) |
| Policy change governed harder than payment | Admin quorum; any admin can deny [F2] | No self-approval; `lockDate` [B4][B2] | Weakening above $1M forces a call [C3] | More than two admins [D6] | Config tx cancels every pending tx [Q5][Q3] | Ordinary threshold tx; Delay Modifier optional [S13] | `configDelay` + veto; epoch cancels pending (invariant 5). Veto default weak (H1) |
| Initiator, approver, executor separated | Non-Signing Admin; designated signers [F5][F1] | `initiatorIsAllowedToApprove` [B5] | Four-eyes principle named [C7] | No single account authorizes alone [D2] | Proposer / Voter / Executor bitmask [Q7] | Not natively [S10] | Proposer is service-only; API keys cannot sign (good); no on-chain initiator rule |
| Verification that does not trust the web UI | Mobile Face ID + native decoding [F14] | Video ID above $250k/day [B6] | YubiKey, video [C7][C3] | Separate mobile signature key [D5] | Hardware wallets from different makers [Q6] | safe-tx-hashes, delegatecall warning [S7][S16] | Console recomputes the hash and refuses on mismatch; hardware members compare `txHash` |
| Simulation wired into approval | Simulation + Blockaid + Policy Inspector [F13][F8] | Webhook rule [B2] | Not found for withdrawals | Policy evaluated on simulated effects [D4] | None in protocol [Q6] | Shield Copilot, Hypernative auto-block [S3][S5] | Service simulates once at proposal (M2) |
| Emergency freeze | Any admin freezes; only Owner via Support unfreezes [F6] | Freeze cannot be lifted early [B7] | Not found | Not found | None [Q5] | Guard can block; pause-only Guardian Safe pattern [S2][S15] | **None** (H2) |
| API keys scoped and governed | Roles, enclave co-signer, IP allowlist [F5][F4][F17] | Scopes, mandatory CIDR, spend limit [B9] | Withdrawals need UI consensus [C16] | Authorized only by admin quorum [D10] | Proposer-only keys [Q7] | Zodiac Roles for bots [S10] | `read` / `propose`, minted by a member; no IP or spend scoping |
| Audit log export | Audit Logs API, policy export [F7][F8] | Audit log with admin-action flag, policy history [B10][B11] | Auditor role [C6] | Not verified | On chain [Q1] | On chain + Transaction Service [S18] | Ledger CSV only (M3) |
| Recovery below threshold | Recovery Kit + open-source verifier [F10] | Backup key + KRS [B8][B15] | Consensus decrypts keys [C11] | Backup gated by quorum [D3] | Members hold keys; Fuse adds recovery key [Q13] | RecoveryHub, 28-day delay, rejectable [S8] | RECOVER signer if named; else **none** (C2) |
| Third-party attestation | SOC 2 II, ISO 27001, CCSS L3 [F12] | SOC 1/2 Type 2 [B13] | SOC 1/2 Type 2 [C12] | SOC 2 II, NCC crypto audit [D5] | OtterSec, Neodyme, Certora [Q8][Q10] | Years of audits | Adversarial spec review; **no audit yet** |

Three things the table says that the findings above do not.

**Where Olien already leads.** No custodian on this table lets a customer verify a
transaction against a contract that has no delegatecall and no module; Safe and
Squads can, and Olien's account is stricter than either. Olien's epoch does what
Squads does when the threshold changes, cancelling everything pending, and does it
for every config change [Q5][Q3]. And API keys that structurally cannot sign are
tighter than Fireblocks' enclave co-signer, which can [F4].

**The closest published analogue is Fuse.** Device key behind Face ID, a 2FA key in
iCloud, a recovery key, and a small weekly allowance that needs no 2FA [Q13]. That is
Olien's consumer account with a spending limit. The difference is that Fuse sits on
Squads and Recourse sits on Safe until Olien is audited (`05-onchain-design.md`).

**Delay is a backstop, not the control.** Anchorage's position is that
"delay-as-a-feature only makes sense when custodians can't be certain that a given
transaction is authentic" [A5]. That is the right frame for C1: the transfer delay
and the allowlist are what catches a quorum after it has been fooled; the hash
verification and simulation are what stop it being fooled. A treasury needs both,
and the vendors that ship only the second have nothing left once the second fails.

Sources for this section: see "Sources" at the end.

## 5. Against the incidents

Nine incident classes were reduced to 32 requirements an engineer can check a
codebase against (the post-mortems are cited in Sources). Each is answered here from
the code. "Met" means read in the source; "partly" and "not met" name the finding.

| # | Requirement | Olien | Where |
| --- | --- | --- | --- |
| 1 | No arbitrary delegatecall | **Met** | `Olien.sol`, invariant 14 |
| 2 | Owners, threshold, implementation only through time-locked, vetoable functions | **Met** | 8 config setters, all `onlySelf`, all advance the epoch |
| 3 | Implementations initialised atomically; `initialize` unreachable afterwards | Partly | proxies yes (`Olien.sol:195`); implementation no (L9) |
| 4 | No `selfdestruct`, no metamorphic code, explicit fallback | **Met** | `receive()` only |
| 5 | Execute and upgrade gated to EntryPoint or self | **Met** | `executeUserOp` is `onlyEntryPoint` |
| 6 | Validation covers every field a bundler can inflate | **Met** | `UserOperation` type hashes all gas fields |
| 7 | EIP-1271 rehashed under the account's domain | **Met** | `Message(hash)`, invariant 15. Not ERC-7739-shaped, which matters only for interop |
| 8 | Every signed payload carries chainId, contract, nonce | **Met** | `OlienHash.domain`; Message relies on the wrapped digest's own nonce, stated in §4 |
| 9 | Config signatures bind nonce, type, account | **Met** | config is a `Transaction` |
| 10 | Chain-agnostic ops reference by value, not index | **Met** | signers are ids, never indices |
| 11 | Hashes verifiable from a second device | Partly | on-chain views exist; no tool (L4) |
| 12 | Double-signing at one nonce is visible | Not verified | `07-security-model.md` claims it; not traced |
| 13 | Limits and allowlists enforced in the account | Partly | limits yes; allowlist only inside limits (C1) |
| 14 | Automated co-signers cannot sign transfers | **Met** | relayer pays gas only; recovery key is RECOVER-only |
| 15 | Over-limit transfers wait on chain | **Not met** | C1 |
| 16 | Per-period outflow cap on the account | **Not met** | C1 |
| 17 | Every delegation expires | Partly | proposals expire (`validUntil`); API keys do not (L10) |
| 18 | No single custodian reaches threshold | **Met** by construction | relayer + recovery key can never approve |
| 19 | Config needs a strict majority independent of the payment threshold | Not met | same threshold, delay and veto instead; the veto default is the weak point (H1) |
| 20 | Synced credentials counted as one custodian | **Not met** | M6 |
| 21 | Low-s enforced, key validated | **Met** | both curves; the precompile rejects an invalid point |
| 22 | `webauthn.get`, exact challenge, UP and UV | **Met**, UV per signer | `UV_REQUIRED`, default on in the service |
| 23 | No PRF dependency; loss goes through delayed recovery | **Met** | plain assertions; recovery path exists for consumer accounts, absent for treasuries (C2) |
| 24 | Paymaster hygiene | N/A | no paymaster; EntryPoint v0.7 noted (L5) |
| 25 | Reproducible build, SRI, isolated deploy credentials | **Not met** | M7 |
| 26 | CREATE2 salt commits to the initialiser | **Met** | `OlienFactory.sol:24` |
| 27 | Code hashes pinned and checked at startup | Partly | ops scripts yes; service no (L6) |
| 28 | Scheduled ops bind effects; installed code pinned | Partly | hash binds calls; upgrade pins address only (L7) |
| 29 | Delay and vetoer changes cannot be batched past the delay | **Met** | the batch itself is delayed |
| 30 | Stop is instant, go is delayed | **Not met** | H2; `cancel` needs the threshold |
| 31 | Recovery: no timer reset, atomic cancel-and-remove | Partly | veto works; re-proposal loop bounded by `configDelay` (L8) |
| 32 | Vetoers removable through a path they cannot veto | **Met** | invariant 17 |

Twenty of thirty-two met outright, and the eight that are not met are the same
five findings from four directions: C1, H2, H1, M6, M7. That convergence is the
most useful thing this audit produced. The incidents, the vendors and the code all
point at the same gap: **once a quorum is fooled, nothing in the account slows the
money down, and one honest member cannot stop it.**

What the incidents say about the order. Bybit and Radiant were both quorums fooled
through the signing surface, and both would have been caught by a transfer delay on
a new destination (C1) or stopped by a single member with a brake (H2). WazirX was a
policy that lived in a UI; Olien's limits live in the account, which is the right
side of that line, and C1 moves the rest of the policy there too. Ronin was a
delegation nobody revoked (L10). Parity was an implementation anyone could claim
(L9). The Wintermute replay was an address that did not commit to its owners, which
Olien already prevents (26). Every one of them has a row above.

## 6. Order of work

1. **Console, days**: the C2 refusal, the M1 warning, the H3 disclosure, the H1
   default and its explanation, M6's synced-passkey label, L4's verifier script.
   No chain change, no audit dependency.
2. **Service, a week**: the soft policy of `06-algorithms.md §6` (C1, service half)
   with M5's signed address book underneath it, M2 browser simulation, M3 audit
   export and limiter, M4 second RPC, L6 startup code-hash check, L10 key expiry.
3. **Build, a day**: M7. A reproducible build with its hash on the sign screen and
   a deploy credential no laptop session can reach.
4. **Contract v2, after Metropolis and before the audit**: C1's `transferDelay` and
   `knownDestinations`, H2's `panic()`, H3's sliding window, C2's inactivity path,
   M6's custodian byte, L7's pinned code hash, L8's guardian suspension, L9's
   disabled initialiser. The account is 30 bytes under the size limit, so v2 is a
   new implementation, not an edit, and `setImplementation` behind the delay is how
   every existing account adopts it. Audit v2 once rather than v1 and then v2.

**Phase 1 shipped, 2026-09-30.** The console refuses to create a treasury that any one
lost key would lock, and warns a live account before a removal or threshold change that
would leave it that way (C2). A config delay of zero and a recovery delay under a day
are marked in red where they are set and on the Time lock panel where they stand (M1).
The fixed-window bound is stated wherever a limit is made or described (H3). New
treasuries default to a veto threshold of one with the trade-off beside the choice, and
passkeys hold Veto by default, since they veto through the relayer (H1). A passkey is
read for its backup-eligible flag at enrolment and named as synced, and a threshold of
two or more that synced passkeys alone could meet is called out; the service does not
yet store the flag, which is phase 2 (M6). `ops/olien-hash.mjs` recomputes any
transaction hash with no dependencies, pinned by `--self-test` to the vectors the
service pins, and compares it with the account's own view (L4). The rules the screens
share live in `console/lib/resilience.ts` with their tests.

**Found on the way into phase 2, 2026-10-04.** C0 above, fixed. And the console's
links: twenty-six of them, the ones built from a template with the address in them,
still pointed at `/olien/...`, the path the console had inside another application,
so the sidebar, the account list and every transaction link were a 404 on olien.org
from 17 September. Fixed, with a test that reads the source for the old prefix.

**The service in this repository is not the one that is running.** olien.org's
console talks to `olien-monad-testnet-production.up.railway.app`, and that is the
Recourse backend, built from the Recourse repository and pointed at Monad: its
`/health` carries that backend's own fields. `service/` here has never been
deployed. So every service-side item in this document, C0's guard and the Monad USDC
fix included, is committed and not live, and the backend that is live has C0's hole
on the proposing side. Moving over needs a container build for this crate, a Railway
service built from this repository, and a decision about the database: its migration
table records that backend's twenty-five migrations, this crate carries eight with
different contents, and sqlx refuses to boot on the difference. That decision comes
before the rest of phase 2, because nothing else in phase 2 reaches a user without it.

**Phase 2, what is built, 2026-10-04.** Committed, tested on a local chain carrying
the canonical deployment, and waiting on the move in `15-own-service.md` to reach a
user: the service refuses to start against anything but Olien v1 (L6); API keys end
(L10); the synced flag is stored and shown (M6, service half); an Olien can be opened
from the chain by a signer, which makes the claim that the database is convenience
and not authority true for the account row too; L11's pinned deployment. Live on
olien.org already, because it needs nothing from the service: the browser runs a
proposal's calls itself and sets the account's balance against what would leave (M2).
Not built: the soft policy and the signed address book under it (C1's service half,
M5), the audit trail and rate limiter (M3), the second RPC (M4).

## Sources

Vendor documentation and APIs, fetched 2026-09-29. Marketing pages are marked.

**Incidents and standards**
- [Sygnia] https://www.sygnia.co/blog/sygnia-investigation-bybit-hack/
- [NCC] https://www.nccgroup.com/research/in-depth-technical-analysis-of-the-bybit-hack/
- [Verichains] https://blog.verichains.io/p/technical-analysis-of-the-bybit-hot
- [Safe-statement] https://safefoundation.org/blog/safe-ecosystem-foundation-statement
- [Halborn-Radiant] https://www.halborn.com/blog/post/explained-the-radiant-capital-hack-october-2024
- [Radiant] https://medium.com/@RadiantCapital/radiant-post-mortem-fecd6cd38081
- [WazirX] https://wazirx.com/blog/preliminary-report-cyber-attack-on-wazirx-multisig-wallet/
- [Cobo-WazirX] https://www.cobo.com/post/wazirx-hack-incident-analysis
- [Halborn-Ronin] https://www.halborn.com/blog/post/explained-the-ronin-hack-march-2022
- [Harmony] https://medium.com/harmony-one/harmonys-horizon-bridge-hack-1e8d283b6d66
- [Chainalysis-Multichain] https://www.chainalysis.com/blog/multichain-exploit-july-2023/
- [OZ-Parity] https://www.openzeppelin.com/news/parity-wallet-hack-reloaded
- [Alchemy-1271] https://www.alchemy.com/blog/erc-1271-signature-replay-vulnerability
- [ERC-7739] https://eips.ethereum.org/EIPS/eip-7739
- [C4-Coinbase] https://code4rena.com/reports/2024-03-coinbase
- [ToB-4337] https://blog.trailofbits.com/2026/03/11/six-mistakes-in-erc-4337-smart-accounts/
- [P11] https://blog.projecteleven.com/posts/erc-4337-entrypoint-v09-fixing-a-griefing-vector-in-account-abstraction
- [CertiK] https://www.certik.com/blog/security-considerations-for-passkey-based-web3-wallets
- [W3C-backup] https://www.w3.org/TR/webauthn-3/#sctn-credential-backup
- [Daimo-p256] https://github.com/daimo-eth/p256-verifier
- [SlowMist-OP] https://slowmist.medium.com/slowmist-key-to-the-theft-of-20-million-op-tokens-transaction-replay-490baaf45f26
- [Safe-changelog] https://github.com/safe-fndn/safe-smart-account/blob/main/CHANGELOG.md
- [OZ-timelock] https://github.com/OpenZeppelin/openzeppelin-contracts/security/advisories/GHSA-fg47-3c2x-m2wr
- [Halborn-TC] https://www.halborn.com/blog/post/explained-the-tornado-cash-hack-may-2023
- [OZ-RW] https://www.openzeppelin.com/news/recoverable-wallet-audit
- [Argent] https://raw.githubusercontent.com/argentlabs/argent-contracts/develop/contracts/modules/SecurityManager.sol

**Fireblocks**
- [F1] https://developers.fireblocks.com/reference/configure-transaction-authorization-policy
- [F2] https://developers.fireblocks.com/docs/define-approval-quorums
- [F3] https://developers.fireblocks.com/docs/whitelist-addresses
- [F4] https://developers.fireblocks.com/docs/cosigner-architecture-overview
- [F5] https://developers.fireblocks.com/docs/manage-users
- [F6] https://developers.fireblocks.com/reference/freezeworkspace
- [F7] https://developers.fireblocks.com/docs/audit-logs-api
- [F8] https://www.fireblocks.com/blog/new-in-fireblocks-security-summer-2026
- [F10] https://github.com/fireblocks/recovery
- [F12] https://trust.fireblocks.com/
- [F13] https://www.fireblocks.com/blog/fireblocks-expands-defi-security-capabilities-to-protect-institutions-from-ever-evolving-threats
- [F14] https://www.fireblocks.com/blog/bybit-attack-security-flaws-fireblocks-nation-state-resilient-solutions
- [F17] https://developers.fireblocks.com/reference/getwhitelistipaddresses

**BitGo**
- [B2] https://developers.bitgo.com/reference/v2walletcreatepolicy
- [B3] https://developers.bitgo.com/docs/wallets-whitelists-create
- [B4] https://developers.bitgo.com/guides/policies/update
- [B5] https://developers.bitgo.com/docs/crypto-as-a-service-policies
- [B6] https://support.bitgo.com/support/solutions/articles/158000445960-understanding-your-bitgo-enforced-policy-rules
- [B7] https://developers.bitgo.com/guides/wallets/manage/freeze
- [B8] https://developers.bitgo.com/guides/wallets/create/keys
- [B9] https://developers.bitgo.com/docs/get-started-access-tokens
- [B10] https://developers.bitgo.com/api/v2.auditlog.list
- [B11] https://www.bitgo.com/resources/blog/product-release-notes/
- [B13] https://www.bitgo.com/resources/blog/bitgos-commitment-to-security-and-trust-the-soc-2-advantage/
- [B15] https://github.com/BitGo/key-recovery-service

**Coinbase Prime** (help pages were reachable only through search excerpts; URLs given)
- [C2] https://help.coinbase.com/en/prime/securing-your-account/transfer-policies
- [C3] https://help.coinbase.com/en/prime/securing-your-account/edit-policies
- [C4] https://help.coinbase.com/en/prime/managing-your-account/trusted-address-book-protection
- [C6] https://help.coinbase.com/en/prime/roles-and-permissions/roles-and-permissions
- [C7] https://help.coinbase.com/en/prime/managing-your-account/coinbase-prime-approvals-faq
- [C8] https://help.coinbase.com/en/prime/securing-your-account/daily-withdrawal-limits
- [C11] https://www.coinbase.com/blog/how-we-keep-digital-assets-safe
- [C12] https://www.coinbase.com/blog/in-another-first-coinbase-custody-attains-its-soc-1-and-soc-2-reports
- [C16] https://docs.cdp.coinbase.com/prime/concepts/transactions/withdrawals

**Anchorage**
- [A5] https://www.anchorage.com/insights/the-need-for-speed

**Fordefi**
- [D1] https://docs.fordefi.com/user-guide/policies/policy-rules-conditions-and-actions
- [D2] https://docs.fordefi.com/user-guide/policies/best-practices
- [D3] https://docs.fordefi.com/user-guide/admin-quorum
- [D4] https://docs.fordefi.com/developers/simulate-transactions
- [D5] https://docs.fordefi.com/user-guide/welcome/product-security
- [D6] https://blog.fordefi.com/fortify-your-assets-a-guide-to-fordefi-transaction-policy-engine-1
- [D7] https://blog.fordefi.com/fortify-your-assets-a-guide-to-fordefi-transaction-policy-engine-2
- [D10] https://docs.fordefi.com/user-guide/policies

**Squads and Fuse**
- [Q1] https://docs.squads.so/main/development/reference/accounts
- [Q2] https://docs.squads.so/main/development/typescript/instructions/create-config-transaction
- [Q3] https://docs.squads.so/main/navigating-your-squad/settings/time-locks
- [Q4] https://docs.squads.so/main/navigating-your-squad/settings/spending-limits
- [Q5] https://docs.squads.so/main/navigating-your-squad/settings
- [Q6] https://docs.squads.so/main/additional-resources/advanced-security-best-practices
- [Q7] https://squads.xyz/blog/permissions-roles-in-multisig
- [Q8] https://squads.xyz/blog/v4-and-new-squads-app
- [Q10] https://github.com/Squads-Protocol/smart-account-program
- [Q13] https://fusewallet.com/blog/solana-s-most-secure-wallet

**Safe and Zodiac**
- [S2] https://docs.safe.global/advanced/smart-account-guards
- [S3] https://help.safe.global/articles/6434169802-understanding-safe-shield-copilot
- [S4] https://safe.global/blog/safe-launches-shield-to-protect-ethereum-s-trilliondollar-economy
- [S5] https://safe.global/blog/safe-partners-with-hypernative-to-launch-enterprise-security-integration
- [S7] https://github.com/pcaversaccio/safe-tx-hashes-util
- [S8] https://help.safe.global/articles/9622260218-account-recovery-with-saferecoveryhub
- [S9] https://help.safe.global/articles/3961440620-set-up-and-use-spending-limits
- [S10] https://docs.roles.gnosisguild.org/
- [S13] https://github.com/gnosisguild/zodiac-modifier-delay
- [S15] https://safe.global/blog/how-to-configure-your-safe-for-secure-protocol-operations
- [S16] https://help.safe.global/en/articles/40794-why-do-i-see-an-unexpected-delegate-call-warning-in-my-transaction
- [S18] https://www.cyfrin.io/blog/safe-wallet-hack-bybit-exploit
