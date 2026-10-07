# Olien

A team account for stablecoins. Members approve together, spend under a limit, and
sign with a passkey rather than a seed phrase.

Ethereum has Safe and Solana has Squads. Olien is the account protocol for chains that
have neither, with a transaction service and a console on top of it.

Console: **https://www.olien.org**

## Live on Monad testnet, chain 10143

Deployed 2026-09-16 through the Arachnid CREATE2 deployer, so every address is a pure
function of a fixed salt and the creation code. That creation code is pinned in
`deployments/v1/creation.json` and `ops/deploy-olien.sh` sends those bytes rather than
compiling, because the compiler ends creation code with a hash of the source paths:
the same Solidity built from this repository lands somewhere else, and a team's account
on a new chain would not be at the address it already holds. A test keeps the pinned
bytes and the source the same contract.

| Contract | Address |
| --- | --- |
| OlienFactory | `0xaF8c108D09E6A159D4dcE0919Ca6A81d6019f131` |
| Olien implementation | `0x8BFf8CCe4edbE882a21197D3942978CCd06fA427` |
| SubAccount implementation | `0xDfc576536187eF72689c514f8c7ea6487960a637` |
| OlienVerifier | `0xE196558Ce080229B256dDE6e62CDA2B051B882fC` |
| EntryPoint v0.7 | `0x0000000071727De22E5E9d8BAf0edAc6f37da032` |

The same four addresses hold on Arc testnet, and the deployed bytecode was read off both
chains and hashed to confirm it: identical.

## Layout

| Path | What it is |
| --- | --- |
| `contracts/` | The account: the verifier, the sub-account, the account and its factory |
| `service/` | The transaction service and the chain indexer |
| `console/` | The web console, one deployment per chain |
| `docs/` | The research and the design, including the account specification |
| `deployments/` | One address book per chain, named by chain id, and `v1/creation.json`, the exact bytes v1 deploys from |
| `ops/` | Chain readiness checks, the deploy script, a local chain, and a hash verifier that needs no console |

## What changed, 30 September to 4 October 2026

A lot landed in one push. If you were not there for it, this is what moved, what is live,
and what now needs a decision. The long version, with the evidence for every point, is
`docs/14-audit-vs-enterprise.md`.

It started as an audit: Olien measured against what Fireblocks, BitGo, Safe and Squads
do, and against the large multisig thefts of the last three years. Most of what follows
is that audit's list being worked through. The two most serious items were not on the
list at first. They were found by building, not by reading.

### Live on olien.org now

- **What you sign is read from the transaction itself.** The signing screen used to show
  a payment's recipient and amount from the description stored beside a proposal, not
  from its calldata. Anyone who could propose could show "250 USDC to Acme" over calldata
  that paid someone else, and a passkey shows its holder nothing, so the screen was all
  a member knew. The console now decodes the calls it is about to sign, builds every
  hash itself, and uses the description only as a note when it agrees with the calls.
  One that contradicts them switches approving off. This is `console/lib/signing.ts`.
- **A call the console cannot read, an upgrade, or an allowance needs a tick** before
  Approve appears.
- **The browser runs a proposal's calls itself.** It says which call reverts and
  whether the account can afford the batch, where it used to repeat the service's
  verdict.
- **Links work.** Every link to an account or a transaction pointed at `/olien/...`,
  the path from before this was its own site, and had been a 404 since 17 September.
- **The create wizard refuses an account that one lost key would lock forever.** The
  screens also say what a zero delay, a fixed spending window and a synced passkey
  really mean, and a new account lets any one member veto a rule change.

### Live since 7 October 2026, on this repository's own service

Until 7 October the console on olien.org talked to a service built from a different
repository, and the service here had never been deployed. It now runs in a Railway
project of its own, with its own database and its own relayer, and olien.org talks
to it. `docs/15-own-service.md` is the runbook for the move and for going back. On the
day it went live it was put through a whole account's life on Monad testnet with keys
made for the run, thirteen checks, every one passed; `ops/live-check.mjs` repeats that
run against any service URL. The console shows each screen below only when the service
it is talking to says it can do it.

- The service refuses a proposal whose description contradicts its calls.
- It refuses to start unless the contracts it is pointed at are Olien v1.
- A signer can open an Olien by its address, and the service rebuilds it from the chain.
- API keys expire, ninety days out unless you choose otherwise.
- A `Dockerfile` at the root builds the service, and Railway builds it from there.
- **A treasury policy.** A payment above an amount needs more approvals than the
  threshold, a payment to an address nobody vouched for waits, a newly added address
  waits a set time, and nothing runs outside set hours. Tightening it is immediate;
  loosening it waits the account's own config delay and any member can cancel it.
  Cheques answer to it too. It is the service's and not the chain's, and every
  screen says so.
- **A signed address book.** An entry is a member's signature over the address, the
  label and the time. The service checks it and so does every browser, and a row
  nobody signed counts for nothing. This is what the policy means by a known address.
- **An audit trail.** Every act on an account, in order, each row carrying the hash
  of the one before it, readable in Settings and exportable as CSV.
- **A limiter.** Per session, per API key, per sign-in, and on wrong keys.
- **A second RPC.** With `RPC_URL_SECONDARY` set, what decides whether a proposal can
  run is read from two endpoints and nothing is sent while they disagree. The console
  also asks the chain itself and stops signing if the service's picture of the
  account differs.

### Changed for anyone working here

- **Never deploy the contracts with `forge script`.** Use `ops/deploy-olien.sh`. The
  compiler ends creation code with a hash of the source paths, and this repository
  moved them, so a build made here lands on different addresses from the ones Olien
  holds on Arc and Monad. The script sends the original bytes from
  `deployments/v1/creation.json`.
- **Editing a contract now fails a test, on purpose.** `OlienCanonical.t.sol` holds the
  source to what is deployed. A change that alters the account's code is a new version
  with new addresses, not an edit, and that test is where it gets noticed.
- **`ops/local-chain.sh`** starts a local chain with Olien on it and prints the command
  to run the service against it. Everything service-side above was proved there.
- **The console has tests.** `cd console && npm test`. Two of them read the source: one
  for a link to the old path, one for any screen that signs something it did not build.
- **`docs/11-service-api.md`** has the new routes: the policy, the signed address
  book, the audit trail, importing an account, and the limits.
- **`npm run lint` in the console does not run.** ESLint 9 wants a config file this
  project does not have. It predates this week and is a good small thing to pick up.

### What needs a person

1. **Reopen your Olien.** The move started from an empty database, so each account is
   opened again from the start page by its address. Names, labels and proposals still
   collecting signatures did not carry over; the chain's own state did.
2. **The relayer.** `0x3f6CacC63449952Fc8b519B781b21ceBc8f13BcB` pays for creations and
   executions on Monad testnet and holds just under 5 MON, which is where the health
   line starts saying low. A whole account life costs it about 0.05.
3. **What is still open from the audit** is on the chain, and is a second version of
   the account: a delay on large or unfamiliar payments that the account itself
   enforces, a way for one member to stop everything in flight, a sliding window for
   spending limits, and a recovery path for an account whose keys are lost. The
   policy above is the blueprint for the first of those. `docs/14` has the list.
4. **None of the service work has been tried by anyone but its author.** It passes its
   own tests, an end-to-end run on a local chain, and the live run on Monad. It has
   not met a real team.

## Getting it

The contracts use submodules, so a plain clone gives a `contracts/` that will not build.

```sh
git clone --recursive https://github.com/jamesonchain/olien.git
cd olien
```

Already cloned without them: `git submodule update --init --recursive`.

## Running it

**Contracts.** 65 tests, no network needed. Three of them hold the deployed bytes to
this source: a change that alters the account's code fails there, because that is a new
version with new addresses and not an edit.

```sh
cd contracts && forge test
```

**Service.** 73 tests, and none of them need a database: every query is a runtime
`sqlx::query_as`, so nothing is checked against a live schema at compile time.

```sh
cd service && cargo test
```

To run it you need Postgres and a deployment file. Migrations apply themselves at boot.

```sh
DATABASE_URL=postgres://olien:olien@localhost:5432/olien \
DEPLOYMENTS_PATH=../deployments/10143.json \
RELAYER_PK=0x... \
cargo run
```

| Variable | Default | What it does |
| --- | --- | --- |
| `DATABASE_URL` | local Postgres | Where the projection lives. Losing it loses convenience, never authority: a signer adds an Olien back by its address and the service rebuilds the row from the chain. Labels and proposals still collecting signatures were never on the chain and do not come back |
| `DEPLOYMENTS_PATH` | `../deployments/10143.json` | Which chain this instance serves. A file with no `olien` key is refused at boot |
| `RELAYER_PK` | none | Pays for account creation and executions. Without it the service reads and serves but cannot send |
| `RPC_URL` | per chain | Overrides the built-in endpoint |
| `RPC_URL_SECONDARY` | none | A second, independent endpoint for the same chain. When set, the epoch, the threshold, the signer set and the lanes are read from both, and nothing is marked ready or sent while they disagree. One that cannot be reached says nothing and holds nothing up |
| `PORT` | `8080` | Binds `::`, dual stack |
| `CORS_ALLOWED_ORIGINS` | empty, meaning permissive | Comma separated. Set it in production to the console's origin |
| `MEMBERS_URL` | none | An optional directory that resolves `@handle` to an address. Without one, members are named by address |
| `LOG_CHUNK_BLOCKS` | per chain | How wide one `eth_getLogs` may be. 100 on Monad, 5,000 on Arc |
| `OLIEN_SKIP_CODE_CHECK` | unset | At boot the service refuses to start unless the four contracts in the deployment file are Olien v1, by address and by the hash of their code. Set this only for a local chain carrying a build of your own |

As a container, from the repository root, which is the build context because the binary
compiles `deployments/v1/creation.json` into itself:

```sh
docker build -t olien-service .
```

**Console.** One chain per build. `npm test` runs the rules the screens share, which
shapes the wizard refuses and what the warnings say, on Node's own runner; no browser.

```sh
cd console && npm install
NEXT_PUBLIC_OLIEN_CHAIN=monad-testnet npm run build
```

| Variable | What it does |
| --- | --- |
| `NEXT_PUBLIC_OLIEN_CHAIN` | Which chain this build talks to |
| `NEXT_PUBLIC_BACKEND_URL` | Where the service is |
| `NEXT_PUBLIC_PASSKEY_RP_ID` | Pins the domain a passkey is bound to. Leave it unset locally, where inheriting the origin is right |

**Checking a hash** without the console. The script has no dependencies, not even for
keccak, so it runs on a machine the console has never touched, and `--self-test` pins it
to vectors read off a live account before it is trusted with anything.

```sh
node ops/olien-hash.mjs --self-test
node ops/olien-hash.mjs --calls proposal.json --rpc https://testnet-rpc.monad.xyz
```

`proposal.json` is what the service serves at `/api/treasury/accounts/<account>/proposals/<hash>`,
or a plain list of `{to, value, data}`. With `--rpc` it also asks the account's own
`getTransactionHash` and says whether every answer agrees; without it, the chain id,
nonce and epoch come from the file or from flags.

**Checking a chain** before deploying to it. Reads the chain, writes nothing.

```sh
ops/monad-check.sh              # testnet, 10143
ops/monad-check.sh --mainnet    # mainnet, 143
```

**A local chain** with Olien at the addresses it holds everywhere else, a token standing
in for USDC, and the commands to run the service against it.

```sh
ops/local-chain.sh
```

**Deploying** to a chain. Simulates unless told otherwise, skips what is already there,
and stops if the pinned bytes no longer predict their recorded addresses.

```sh
ops/deploy-olien.sh --rpc <url>           # say what would be deployed
ops/deploy-olien.sh --rpc <url> --live    # send it
```

**Checking a running service** by living a whole account through it with keys made for
the run: creation, policy, a signed book entry, a key, a rule change approved with the
console's own hashing and scheduled by the chain, the audit trail, and reopening. It
spends about 0.05 of the gas token from the service's relayer.

```sh
node ops/live-check.mjs https://olien-service-production.up.railway.app
```

## Notes

Gas on Monad is MON, not the stablecoin. `eth_getLogs` is capped at 100 blocks on every
public Monad testnet endpoint tested, so the indexer takes its chunk size from the chain
rather than a constant.

A passkey is bound to the domain that created it and cannot be moved to another one.
`NEXT_PUBLIC_PASSKEY_RP_ID` exists so that binding is a deployment decision rather than
an accident of which URL someone happened to open.

`docs/15-own-service.md` is how the console on olien.org moves onto the service in this
repository, which as of 2026-10-04 it is not on.

`docs/10-account-spec.md` is the contract, normatively. `docs/12-metropolis.md` records
what has been proved on chain, with transaction hashes.

## Contributing

Open issues are the place to start; several are small and self-contained on purpose.
Two house rules, both about the same thing:

- **Comments say why, not what.** If a comment restates the line below it, delete it.
- **Commit messages explain the reasoning**, not the diff. The diff is already in the
  commit.

Before you push, the three suites: `forge test` in `contracts/`, `cargo test` in
`service/`, `npm test` in `console/`. None of them needs a network or a database.
