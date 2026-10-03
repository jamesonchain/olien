# Transaction service API

The routes the console and the iOS app talk to for Olien accounts. This is the
contract between `backend/` and the clients; `04-architecture.md` says why the
service exists and `06-algorithms.md` how it computes what it stores. Version 1,
2026-09-04. Everything is JSON, camelCase, addresses lowercase hex, hashes and
signer ids `0x` plus 64 hex digits, amounts as decimal strings in the token's
smallest unit (USDC has 6 decimals), times as unix seconds.

All routes sit under `/api/treasury` and need the bearer session the rest of the
API uses (`Authorization: Bearer <accessToken>`; `lib/session.ts` refreshes it),
or an API key in the same header for the routes the "API keys" section lists.
Errors are `{ "error": "<message>" }` with the usual status codes: 400 for a
request the service cannot use, 401 without a session, 403 for an account the
caller is not a member of, 404 for a missing thing, 409 for a state conflict
(a slot already executed, a proposal that cannot take that action), 502 when the
chain or the relayer failed.

## Which chain

```
GET /api/treasury/chain   -> { chainId, name, native: { symbol, decimals }, explorerUrl, usdc, eurc, entryPoint, factory, implementation, features }
```

`features` names what this service does beyond the first version of this API:
`import`, `key-expiry`, `synced`, `signed-book`, `policy`, `audit`. A client offers a
thing only when it is named, so one client build is right against an older service
and a newer one.

Public, no session. One deployment of the service runs against one chain, chosen
by its deployment file; the console is built for one chain too
(`NEXT_PUBLIC_OLIEN_CHAIN`, `web/lib/chain.ts`) and holds this answer against
its own in Settings, so a console pointed at a service on another chain says so.
`native` is what pays gas: USDC with 18 decimals on Arc, MON on Monad. The
relayer's balance, an account's EntryPoint deposit and the ledger's gas rows are
in this unit.

## Signing in with a wallet

The console's only door, the way Squads opens on a connected wallet: the address
is the identity. Two public routes under `/api/auth`:

```
POST /api/auth/wallet/challenge  { address }     -> { message, nonce, expiresAt }
POST /api/auth/wallet  { address, nonce, signature }
                                                 -> SessionGrant (the same shape /api/auth/google returns)
```

The wallet signs `message` with `personal_sign` (EIP-191), verbatim. The text is
built by the service from the checksummed address, a single-use nonce and the
nonce's expiry, so the service rebuilds it from what it stored and a signature
over anything else recovers a different address:

```
Sign in to Olien

Address: 0xAbC…
Nonce: 0x…
Expires: 1757000000
```

A nonce lives five minutes and is consumed on first use. The account the session
belongs to has `provider` `wallet` and `providerUserId` equal to the lowercase
address; the same address always maps to the same account. The address is linked
(below) in the same transaction, so every Olien naming it as a signer is visible
from the first sign-in.

## Who may see an account

A user sees an account when they created it, when one of the account's ECDSA
signers is an address the user has linked, or when a contract signer is the
user's own Safe (the smart account the iOS app provisioned), which needs no
link at all: a Recourse account is a member the moment a treasury names it.
Wallet sign-in links its own address; these routes link further addresses to
the same session, which the iOS app and tests use. Linking proves control of
the address once; every account that names it as a signer becomes visible.

```
GET  /api/treasury/linked-addresses            -> [{ address, linkedAt }]
POST /api/treasury/link-address  { address, signature }
                                                -> { address, linkedAt }
```

The signature is `personal_sign` (EIP-191) over exactly this text, with the address
lowercase and the account id decimal, newline-separated, no trailing newline:

```
Recourse treasury link
address: 0xabc…
account: 42
```

The service recovers the signer and refuses anything else. Signatures with `v` of
0 or 1 are lifted to 27 or 28.

## Accounts

```
GET  /api/treasury/accounts                      -> [AccountSummary]
POST /api/treasury/accounts                      -> AccountView   (creates on chain, waits for the receipt)
GET  /api/treasury/accounts/{address}            -> AccountView
```

`POST /accounts` sends the creation transaction from the relayer and answers only
when the receipt is in, ten to thirty seconds on testnet, so a client shows a
waiting state rather than retrying. A signer is `{ kind, address, label,
permissions }` for `ecdsa` (the default) and `contract`, and `{ kind, x, y,
label, permissions, uvRequired }` for `p256` and `webauthn`, where `x` and `y`
are the public key's coordinates as 32-byte hex and `uvRequired` (passkeys only,
default true) asks the account to insist on Touch ID or Face ID. A signer may
instead be `{ handle, label?, permissions }`: the service resolves the @handle to
the person's account address and picks the kind itself, `contract` when that
address is a Safe the app provisioned (the Olien then checks the person's
signatures through the Safe's EIP-1271), `ecdsa` before that; the label
defaults to the handle. The same shapes are used by the signers builder below.
Body:

```json
{
  "name": "Northwind treasury",
  "signers": [
    { "kind": "ecdsa", "address": "0x…", "label": "Ada (Ledger)", "permissions": ["approve", "veto"] },
    { "kind": "ecdsa", "address": "0x…", "label": "Grace" }
  ],
  "threshold": 2,
  "vetoThreshold": 0,
  "configDelay": 86400,
  "recoveryDelay": 86400,
  "recoveryCoSignDelay": 0
}
```

`permissions` defaults to `["approve", "veto"]`. Version 1 of the console creates
ECDSA signers only; the service accepts `contract` signers too (`address` of an
Olien or a Safe) so a consumer account can be a member (spec §9). `vetoThreshold`
0 means automatic (spec §7.4). Delays are seconds; `recoveryDelay` under 3600 is
refused by the contract when a recover signer exists. The service builds the
`Init`, predicts the address, sends `createAccount` from the relayer, waits for
the receipt and answers with the live account. The salt is random and stored.

`AccountSummary`:

```json
{ "address": "0x…", "name": "Northwind treasury", "status": "live", "threshold": 2,
  "signerCount": 3, "usdcBalance": "1250000000", "openProposals": 2, "scheduledChanges": 1, "createdAt": 1788600000 }
```

`AccountView`:

```json
{
  "address": "0x…", "name": "…", "status": "live", "chainId": 5042002,
  "implementation": "0x…", "implementationFrozen": false, "epoch": 1,
  "threshold": 2, "vetoThreshold": 0, "effectiveVetoThreshold": 1,
  "configDelay": 86400, "recoveryDelay": 86400, "recoveryCoSignDelay": 0,
  "signers": [
    { "signerId": "0x…", "kind": "ecdsa", "address": "0x…", "label": "Ada (Ledger)",
      "permissions": ["approve", "veto"], "since": 1, "mine": true }
  ],
  "usdcBalance": "1250000000", "entryPointDeposit": "0",
  "lanes": [{ "nonceKey": "0", "chainSequence": 4 }],
  "limits": [
    { "id": 1, "generation": 1, "token": "0x…", "from": "0x…", "amount": "50000000", "remaining": "30000000",
      "period": 86400, "resetAt": 1788700000, "anyDestination": true, "signers": ["0x…"], "destinations": [] }
  ],
  "subAccounts": [{ "index": 0, "address": "0x…", "label": "Payroll" }],
  "createTx": "0x…", "createdAt": 1788600000,
  "membership": { "creator": true, "signerIds": ["0x…"] }
}
```

`signers[].mine` and `membership.signerIds` say which signers the caller controls
through linked addresses; the console uses them to decide whether to offer
"Confirm" and "Veto". `status` is `deploying` while the creation transaction is
pending, `live` after, `disabled` if the once-per-account hash self-check failed
(`06-algorithms.md` §1), in which case every write route answers 409.

```
PUT  /api/treasury/accounts/{address}/name  { name }   -> AccountView
```

The name lives in the service, not on chain; any member changes it at once.

## Proposals

```
GET  /api/treasury/accounts/{address}/proposals?status=open,ready,scheduled    -> [ProposalView]
POST /api/treasury/accounts/{address}/proposals                                 -> ProposalView
GET  /api/treasury/accounts/{address}/proposals/{txHash}                        -> ProposalView
POST /api/treasury/accounts/{address}/proposals/{txHash}/confirmations  { signerId, signature }  -> ProposalView
POST /api/treasury/accounts/{address}/proposals/{txHash}/execute                -> ProposalView   (relayer sends execute; waits for the receipt)
POST /api/treasury/accounts/{address}/proposals/{txHash}/cancel                 -> ProposalView   (a new proposal carrying cancel(txHash))
DELETE /api/treasury/accounts/{address}/proposals/{txHash}                      -> 204            (only while it has no confirmations)
```

A confirmation's `signature` depends on the signer's kind. ECDSA: the EIP-712
signature over the proposal's typed data (65 bytes, `v` 27 or 28; a wrapped
EIP-191 signature is accepted with `v` 31 or 32). P-256: `r ‖ s`, 64 bytes,
`s` in the low half of the curve order. Passkey: the WebAuthn assertion packed
as `abi.encode(bytes authenticatorData, string clientDataFields, uint256 r,
uint256 s)`, where the challenge the authenticator saw is the base64url of the
transaction hash and `clientDataFields` is the client data JSON with its
`{"type":"webauthn.get","challenge":"…",` prefix removed, which the verifier
puts back. An empty `signature` records an on-chain `approve` the indexer has
already seen. An ECDSA or contract signature is accepted only from a session that
has linked that signer's address; a P-256 or passkey signature over this very
hash is its own proof of control and needs no link, which is how a laptop's
Touch ID approves from the console.

`POST /proposals` body. `calls` is the batch exactly as the account will run it;
`kind` and `intent` are what people see. The service refuses a call to the
account itself whose selector is outside spec §6.2 (it would revert), and it
refuses `validUntil` more than 30 days out.

```json
{
  "kind": "transfer",
  "intent": { "recipients": [{ "to": "0x…", "amount": "250000000", "label": "Acme Ltd", "memo": "Invoice 1042" }], "token": "0x…" },
  "calls": [{ "to": "0x3600000000000000000000000000000000000000", "value": "0", "data": "0xa9059cbb…" }],
  "nonceKey": "0",
  "sequence": null,
  "validAfter": 0,
  "validUntil": null
}
```

`kind` is one of `transfer`, `batch`, `signer_change`, `rule_change`,
`limit_change`, `cancel`, `contract_call`. `nonceKey` defaults to `"0"`;
`sequence` null means the next free slot in the lane, a number means compete for
that slot. `validUntil` null means 7 days from now. Convenience builders exist so
the console does not encode calldata for the common cases; each answers the same
`ProposalView`:

```
POST /api/treasury/accounts/{address}/proposals/transfer       { recipients: [{ to, amount, label?, memo? }], token?, nonceKey?, validUntil? }
POST /api/treasury/accounts/{address}/proposals/signers        { add: [{ kind, address, label, permissions }], remove: [signerId], replace: [{ signerId, with: {…} }], threshold?, vetoThreshold?, delays?: { configDelay, recoveryDelay, recoveryCoSignDelay } }
POST /api/treasury/accounts/{address}/proposals/limit          { id?: null, token, amount, period, anyDestination, signers: [signerId], destinations: [address], subAccount?: null }
POST /api/treasury/accounts/{address}/proposals/remove-limit   { id }
```

A `signers` proposal is one batch of `addSigner`, `removeSigner`,
`replaceSigner`, `setThreshold`, `setVetoThreshold`, `setDelays` calls in that
order; the console sends the target state and the service computes the calls. It
is a configuration batch, so executing it schedules it (spec §8.1) and the
`ProposalView` says so in `hardRules` before anyone signs.

`ProposalView`:

```json
{
  "txHash": "0x…", "account": "0x…",
  "nonceKey": "0", "sequence": 4, "nonce": "4", "epoch": 1,
  "kind": "transfer", "intent": { … },
  "calls": [{ "to": "0x…", "value": "0", "data": "0x…" }],
  "decoded": [{ "to": "0x…", "label": "USDC", "summary": "transfer 250.00 USDC to 0x… (Acme Ltd)", "selector": "0xa9059cbb", "readable": true }],
  "validAfter": 0, "validUntil": 1789200000,
  "path": "threshold",
  "status": "open",
  "confirmations": [{ "signerId": "0x…", "address": "0x…", "label": "Ada (Ledger)", "kind": "offchain", "signedAt": 1788600100 }],
  "required": 2, "approvals": 1,
  "missing": [{ "signerId": "0x…", "label": "Grace", "mine": true }],
  "blockedBy": null,
  "hardRules": [{ "rule": "delay", "seconds": 86400, "text": "Executing schedules this change for 24 hours; 1 veto stops it." }],
  "simulation": { "ok": true, "error": null, "checkedAt": 1788600050 },
  "scheduledReadyAt": null, "scheduledWindowEndsAt": null, "scheduledExcluded": null,
  "vetoes": [], "effectiveVetoThreshold": 1,
  "executedTx": null, "executedAt": null,
  "proposer": { "accountId": 42, "name": "Ada" }, "createdAt": 1788600000,
  "typedData": {
    "domain": { "name": "Olien", "version": "1", "chainId": 5042002, "verifyingContract": "0x…" },
    "types": {
      "EIP712Domain": [{ "name": "name", "type": "string" }, { "name": "version", "type": "string" }, { "name": "chainId", "type": "uint256" }, { "name": "verifyingContract", "type": "address" }],
      "Call": [{ "name": "to", "type": "address" }, { "name": "value", "type": "uint256" }, { "name": "data", "type": "bytes" }],
      "Transaction": [{ "name": "nonce", "type": "uint256" }, { "name": "epoch", "type": "uint64" }, { "name": "calls", "type": "Call[]" }, { "name": "validAfter", "type": "uint48" }, { "name": "validUntil", "type": "uint48" }]
    },
    "primaryType": "Transaction",
    "message": { "nonce": "4", "epoch": 1, "calls": [{ "to": "0x…", "value": "0", "data": "0x…" }], "validAfter": 0, "validUntil": 1789200000 }
  }
}
```

`status`: `open` (collecting), `ready` (threshold met, slot is next, inside its
validity), `blocked` (threshold met but a lower sequence in the lane is still
open), `executing` (relayer sent it), `executed`, `scheduled` (a configuration
batch waiting out its delay; `scheduledReadyAt` and `scheduledWindowEndsAt`
set), `vetoed`, `cancelled`, `replaced` (another transaction took the slot),
`stale` (the epoch moved), `expired`, `failed` (the relayer's transaction
reverted; the slot is still free).

A confirmation is `{ signerId, signature }`. For an ECDSA signer the signature is
the 65-byte `eth_signTypedData_v4` result over `typedData`; the service checks
it as the contract will (`06-algorithms.md` §4) and answers 400 with the reason
otherwise. An empty signature means "I called `approve(hash)` on chain"; the
service checks `isApproved` before storing. The client must compute
`hashTypedData(typedData)` itself and refuse to sign when it differs from
`txHash`: the hash is what a hardware wallet shows, and the console shows it too.

`execute` is accepted when `status` is `ready`. The relayer packs the entries in
ascending signer id order, calls `execute`, waits for the receipt, and answers
with the proposal as the indexer will see it (`executed`, or `scheduled` for a
configuration batch). A revert answers 502 with the decoded error name when it
is one of the account's (`Stale`, `Dead`, `Expired`, `InvalidSignatures`,
`SelfCallRefused`…) and marks the proposal `failed`.

## Spending from a limit

A member named on a spending limit pays from it alone, without the threshold
(spec §11). The route answers how this caller's signer does that.

```
POST /api/treasury/accounts/{address}/limits/{id}/spend  { to, amount, signerId }
     -> { call: { to, data }, operation: PreparedOperation | null }
```

The service checks first what the contract's `spend` would check, so a refusal
costs no gas and comes with a reason: the limit exists and is active, the signer
is named on its current generation, the destination is allowed, and the amount is
within what the chain says is left right now. A wallet signer (which the caller
must have linked) sends `call` from its own wallet, `spend(id, to, amount)` to
the account, paying its own gas; `operation` is null. A passkey or P-256 signer
gets `operation`, the same shape as a veto's, signs its `hash`, and sends it to
`POST /operations`, which accepts a single self call to `spend` as it accepts one
to `veto` and checks the signer is named on the limit before the relayer submits
it. The indexer turns `Spent` into the limit's new `remaining` and a ledger row
tagged with the limit within one interval.

## Scheduled changes

```
GET  /api/treasury/accounts/{address}/scheduled                       -> [ScheduledView]
GET  /api/treasury/accounts/{address}/scheduled/{hash}/veto-call      -> { to, data, signerIds: ["0x…"], operationSignerIds: ["0x…"] }
GET  /api/treasury/accounts/{address}/scheduled/{hash}/veto-operation?signerId=0x…
                                                                       -> { operation, hash, signerId }
POST /api/treasury/accounts/{address}/operations  { operation, signerId, signature }
                                                                       -> { txHash, hash }   (relayer calls handleOps)
POST /api/treasury/accounts/{address}/scheduled/{hash}/execute        -> ProposalView   (relayer calls executeScheduled)
```

`ScheduledView` is a `ProposalView` with `status: "scheduled"`; `vetoes` lists
`{ signerId, label, tx, at }` and `effectiveVetoThreshold` says how many end it.
A veto from an ECDSA signer is sent by that signer's own wallet, not the relayer:
`veto-call` answers the calldata (`veto(bytes32)` to the account) and the
caller's signer ids that may still veto (holding VETO, not `scheduledExcluded`,
not already counted). The wallet pays the gas in USDC.

A passkey or P-256 signer has no wallet to send from, so it vetoes through a user
operation (spec §10 and §11) that the relayer submits with `handleOps`, the
account paying the gas from its own balance and deposit. `veto-call` lists those
signers in `operationSignerIds`. `veto-operation` prepares the operation: one
self call to `veto(hash)`, the EntryPoint nonce in key 0, fixed gas limits, the
RPC's fee estimate, and a one-hour validity; `hash` is the account's own EIP-712
hash of it, which the signer signs the way it signs a confirmation (a passkey
signs the hash as its challenge). `operation` carries every field the hash
covers plus `validAfter`, `validUntil` and `epoch`, and comes back verbatim in
`POST /operations` with the signer id and signature. The service holds nothing
in between: it recomputes the hash from what came back, checks the signature
against the signer's key, refuses any calldata that is not a single self call to
`veto`, an operation for another account, a stale epoch or an expired window,
and only then spends relayer gas. The indexer turns the resulting `Vetoed` into
`vetoes` within one interval, and the EntryPoint's `UserOperationEvent` into a
ledger row in gas. The hash is pinned to the contract's own library by a printed
vector (`contracts/test/olien/OlienVectors.t.sol`).

## Ledger and address book

```
GET  /api/treasury/accounts/{address}/ledger?limit=100&before=<id>   -> [LedgerEntry]
GET  /api/treasury/accounts/{address}/address-book                     -> [AddressBookEntry]
POST /api/treasury/accounts/{address}/address-book  { address, label, category?, signerId, signature, addedAt }  -> AddressBookEntry
DELETE /api/treasury/accounts/{address}/address-book/{entry}           -> 204
```

`LedgerEntry`: `{ id, tx, logIndex, token, symbol, decimals, direction: "in" |
"out", counterparty, counterpartyLabel, amount, blockNumber, blockTime,
proposalTxHash, limitId, subAccount, memo }`. Entries come from USDC and EURC
`Transfer` logs where the account or one of its sub-accounts is a party, and from
the EntryPoint's `UserOperationEvent` for operations the account sent: those rows
have `symbol` `gas`, `decimals` 18 (the others are 6), the EntryPoint as
counterparty, `actualGasCost` as the amount, and a `memo` saying so, or saying the
operation ran but the account's call reverted, since the gas was paid either way.
A reverted operation the service sent also moves its proposal to `failed`. For
transfers, `memo` and `counterpartyLabel` come from the proposal's intent and the
address book.

`AddressBookEntry`: `{ address, label, category, createdAt, signerId, signature,
addedAt }`; `category` is an empty string when none was given. Posting an address
that exists replaces it.

An entry is signed. The member signs `AddressBookEntry(address entry,string
label,string category,uint48 addedAt)` in the account's own EIP-712 domain, a struct
the account never verifies, so the signature is worth nothing on the chain. The
service checks it as it checks a confirmation, refuses a signer who cannot approve,
and refuses an `addedAt` more than ten minutes from its own clock, because that time
is what a new destination's wait is counted from. Every client is handed the
signature and checks it again before it shows the label or treats the address as
known: the service stores the book and is the one party that must not be able to
write in it. A row with no signature, or one signed by someone who is no longer a
signer, labels nothing and makes nothing known. Any member deletes an entry at once.

## Treasury policy

```
GET    /api/treasury/accounts/{address}/policy          -> PolicyView
PUT    /api/treasury/accounts/{address}/policy  Policy  -> PolicyView
DELETE /api/treasury/accounts/{address}/policy/pending  -> PolicyView
```

`Policy`: `{ tiers: [{ above, approvals }], requireKnownDestination,
newDestinationDelay, hours: { days, start, end, utcOffset } | null }`. `above` is in
the token's smallest unit; `days` are 0 for Sunday to 6; `start` and `end` are
minutes of the day at `utcOffset` minutes from UTC. `PolicyView`: `{ policy,
pending: { policy, effectiveAt, proposedBy, loosens } | null, changeDelay }`.

The account decides who may approve and how many it takes; this decides how much, to
whom and when (`06-algorithms.md` §6). A payment whose total is above a tier needs
that tier's approvals, never fewer than the threshold and never more than there are
approvers. With `requireKnownDestination`, a payment waits until its recipient is a
signed address book entry at least `newDestinationDelay` old; the account's own
sub-accounts are always known. With `hours`, a payment waits for them. A call the
service cannot read as a payment is held to the highest tier, and its target has to
be known. A change to the account's own rules is not money and is never held.

A proposal the policy holds stays `open` and carries `softRules: [{ rule, text,
until }]`, with `required` raised to what the tier asks; `execute` answers 409 with
the reason. Cheques answer to the same rules before they are issued.

A `PUT` that only tightens takes effect at once. One that loosens anything waits the
account's `configDelay` as `pending`, and any member may `DELETE` it in that time; a
second loosening cannot be stacked on the first. Only a signer may change the
policy.

It is soft. Members holding the threshold's signatures can execute on the chain
without this service, and every client says so beside the rule.

## Audit trail

```
GET /api/treasury/accounts/{address}/audit?limit=200&before=<id>&format=csv   -> { rows, intact } | text/csv
```

Who did what, newest first: accounts, proposals, approvals, executions, the address
book, the policy, keys, webhooks and cheques. A `read` key may fetch it. Each row is
`{ id, at, actor, via, action, subject, detail, previous, hash }`, where `hash` is
the keccak256 of `previous` and the row's canonical JSON, so the rows of one account
form a chain. `intact` is whether the rows returned hash to what they say and each
names the one before it; the CSV carries it in the `x-olien-audit-intact` header.

## Limits

Requests are limited per caller, in the process: a session at 20 a second with a
burst of 300, an API key at 2 a second with a burst of 60, signing in at one every
two seconds per address with a burst of 20. Keys that do not exist are counted per
address they came from, ten and then one every ten seconds, and that count is
checked before the key is. A limited request answers 429 with `retry-after`.

## Payroll runs

A run is a template: a name, a token, the people and amounts, and maybe a
schedule. Running it opens a batch proposal of kind `payroll` in lane 1, the
payroll lane, through the same path a hand-typed payment takes, so it needs the
threshold's signatures like anything else and nothing here moves money by itself.
The proposal's `intent` carries `payroll: { id, name }` beside the recipients, and
the console names the transaction after the run.

```
GET    /api/treasury/accounts/{address}/payrolls              -> [PayrollRun]
POST   /api/treasury/accounts/{address}/payrolls              -> PayrollRun
PUT    /api/treasury/accounts/{address}/payrolls/{id}         -> PayrollRun
DELETE /api/treasury/accounts/{address}/payrolls/{id}         -> 204
POST   /api/treasury/accounts/{address}/payrolls/{id}/run     -> ProposalView
```

Body for `POST` and `PUT`: `{ name, token?, recipients: [{ to, amount, label?,
memo? }], period: "none" | "weekly" | "fortnightly" | "monthly", nextRunAt? }`.
Recipients are checked on save the way a run would check them, so a bad address
fails now rather than on payday. `nextRunAt` (unix seconds) is required when
`period` is not `none` and is the first scheduled run; it may not be in the past.

`PayrollRun`: `{ id, name, token, recipients, total, period, nextRunAt, lastRunAt,
lastRunTxHash, lastError, createdAt }`.

A scheduled run is opened by the service on the day, once, as the member who
saved it (`PUT` makes the editor that member). Dates missed while the service was
down collapse into one run, not a pile. If opening fails, the reason is written
to `lastError` and the run waits for its next date; if that member is no longer
one, `lastError` says so and nothing opens. `POST /run` opens it now, as the
caller, without moving the schedule; a `propose` API key may call it. The three
writing routes are session only.

## Cheques

The consumer app's cheque with the treasury as the writer (06-algorithms.md §10).
A cheque is USDC's `TransferWithAuthorization`, signed offline and cashed by the
recipient when they like; for an Olien the signature is the account's EIP-1271
answer, `threshold` approvers over `Message(digest)` in its own domain (spec §9).
So writing one is a signing round like a proposal's, except nothing lands on
chain: when enough members have signed, the packed set is stored in the same
`cheques` table the consumer app reads its inbox from, and the recipient cashes
it there.

```
GET  /api/treasury/accounts/{address}/cheques                        -> [Cheque]
POST /api/treasury/accounts/{address}/cheques  { to, amount, memo?, validFor? }   -> Cheque
GET  /api/treasury/accounts/{address}/cheques/{id}                   -> Cheque
POST /api/treasury/accounts/{address}/cheques/{id}/signatures  { signerId, signature }  -> Cheque
POST /api/treasury/accounts/{address}/cheques/{id}/void              -> Cheque, or 204 for a draft
```

`Cheque`: `{ id, to, toLabel, amount, validAfter, validBefore, nonce, digest,
messageHash, typedData, memo, status, signatures, required, voidProposalTxHash,
proposer, createdAt, issuedAt, cashedAt }`. `validFor` is seconds from now, ninety
days by default, a year at most. `digest` is the token's EIP-712 digest (domain
`USDC` version `2` on Arc, pinned to the phone's golden vector), `messageHash` is
`Message(digest)` in the account's domain, and `typedData` is the EIP-712 a
wallet shows for it. A signature is accepted the way a confirmation is: a wallet
signs the typed data, a passkey signs `messageHash` as its challenge, and the
service checks it against the signer's key before storing it. There is no
on-chain approval for a cheque.

`status` runs `open` (collecting signatures), `issued` (stored for the
recipient), `cashed` (the token says the nonce is used, seen by the indexer),
`voiding` (a cancellation is in the queue), `voided` (the account's `cancel` over
`messageHash` ran, seen as a `Cancelled` event; the token now refuses the
signature), or `expired`. `void` on a draft deletes it; on an issued cheque it
opens a `cancel` proposal for the threshold, no delay, and links it in
`voidProposalTxHash`. A `propose` API key may write a cheque; signing and voiding
are session only.

## API keys

For finance tooling: a payroll run that puts the month's payouts in the queue, an
accounting system that reads the ledger. A key is a bearer token in the same
`Authorization` header a session uses, told apart by its `olk_` prefix, and it is
scoped to one account and one of two things:

- `read`: everything a member can `GET` on that account: the account view,
  proposals, scheduled changes, the ledger, the address book.
- `propose`: `read` plus `POST /proposals` and `POST /proposals/transfer`.

A key never signs, executes, cancels, confirms, changes signers or limits, or
mints another key; those answer 403 `this API key cannot do that`. A key used on
another account's route answers 403 `this API key belongs to a different account`,
before the service checks anything else, and a revoked or unknown key answers 401.

A key acts as the member who minted it: the proposals it opens carry that member
as proposer, with the key's name beside them in `proposer.via`, and they need the
same signatures as any proposal. If that member stops being one, every key they
minted stops working with them. Any member can mint a key and any member can
revoke any key, since a leaked key is the whole team's problem.

```
GET    /api/treasury/accounts/{address}/api-keys              -> [ApiKey]
POST   /api/treasury/accounts/{address}/api-keys  { name, scope }   -> ApiKey plus `key`
DELETE /api/treasury/accounts/{address}/api-keys/{id}         -> 204
```

`ApiKey`: `{ id, name, scope, hint, createdBy, createdAt, lastUsedAt }`. `hint` is
the key's last four characters. The `POST` response is the only one that carries
`key`; the service keeps a hash and cannot show it again. Session only: a key
cannot reach these three routes.

## Webhooks

The other half of API keys: a key lets a system act, a webhook tells it what
happened. The service posts a signed JSON delivery to the hook's URL when a
ledger row lands (`ledger` topic) or a proposal changes (`proposals` topic), so
an accounting system reconciles as it happens instead of polling.

```
GET    /api/treasury/accounts/{address}/webhooks                     -> [Webhook]
POST   /api/treasury/accounts/{address}/webhooks  { url, events }    -> Webhook plus `secret`
DELETE /api/treasury/accounts/{address}/webhooks/{id}                -> 204
POST   /api/treasury/accounts/{address}/webhooks/{id}/enable         -> Webhook
POST   /api/treasury/accounts/{address}/webhooks/{id}/test           -> Delivery   (queues a `ping`)
GET    /api/treasury/accounts/{address}/webhooks/{id}/deliveries     -> [Delivery]  (the last fifty)
```

`Webhook`: `{ id, url, events, disabledReason, lastDeliveryAt, lastStatus,
pending, createdAt }`. `events` is a list of `"ledger"` and `"proposals"`. The
URL must be https with a public host name. The `POST` response is the only one
that carries `secret`. All six routes are session only.

A delivery is `POST` with `content-type: application/json` and the headers
`x-olien-event`, `x-olien-delivery` (its id) and `x-olien-signature`. The body:

```json
{ "id": 42, "event": "ledger.entry", "account": "0x…", "createdAt": 1757400000, "data": { ...LedgerEntry } }
```

`event` is `ledger.entry` with a `LedgerEntry` as `data`, `proposal.<status>`
with a `ProposalView` as `data` (one delivery per change of the row, so a
proposal that is approved twice then executed sends three), or `ping`. The
signature header is `t=<unix>,v1=<hex>`, where `v1` is HMAC-SHA256 under the
secret of the string `<t>.<body>`, `body` being the exact bytes received. Check
it in constant time and refuse a `t` older than a few minutes; the timestamp is
inside the signed text so a captured delivery cannot be replayed as new.

A hook starts from now, not from history. Deliveries are made from the indexer's
cycle, oldest first; a non-2xx answer or a timeout (ten seconds) is retried with
a growing wait, thirty seconds doubling to about an hour, eight times, then the
delivery is given up and shows so in `deliveries`. Twenty deliveries in a row
that never get through switch the hook off with the reason in `disabledReason`;
`enable` switches it back on. Deliveries are at least once: a receiver should
treat `id` as the key to ignore a repeat.

## Push tokens

`PUT /api/me/push-token` with `{ "token": "<hex>", "environment": "sandbox" | "production" }`
records the phone's APNs token under the signed-in account; `DELETE` with the same body
removes it. The service sends two alerts, each with `route: { kind: "proposal",
account, txHash }` so a tap opens the proposal:

- a new proposal, to every member of the treasury except the proposer;
- a scheduled change, to every member, since any of them may veto it.

Members are Recourse accounts whose live Safe is a signer, and console wallets
linked to an account. Sending is best effort and never delays the request that
caused it. A token Apple reports as gone is deleted on the spot.

## Health

`GET /health` (outside `/api`) carries `relayer: { address, balance, symbol,
decimals, low, checkedAt }` once the indexer has read the relayer's balance of
the chain's gas token, about a minute after boot and every minute after; `low`
is true under five of that token, and the same reading is a warning in the
logs, because the relayer pays for every creation and execution.

## What the indexer guarantees

Every view above is served from Postgres and refreshed by the indexer at the
backend's `INDEX_INTERVAL_SECS` (15 s on Railway). After a write route returns,
the state it reports is already what the chain shows; other members see it on
their next fetch. Nothing in the service is authoritative over the chain: a
proposal the chain says executed is `executed` even if the service never sent it,
and a slot the chain consumed makes every other proposal at it `replaced`.
