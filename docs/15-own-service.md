# Running Olien on its own service

As of 2026-10-04 the console on olien.org talks to
`olien-monad-testnet-production.up.railway.app`, which is another product's backend
pointed at Monad. The service in this repository has been run on a local chain and
never deployed. This is what moving onto it takes, what it costs, and how to go back.

## What is ready

- **A container build.** `Dockerfile` at the repository root, with `railway.json`
  beside it. The release build with the lock file enforced passes; the image itself has
  not been built yet.
- **A database from nothing.** Nine migrations apply themselves at boot to an empty
  Postgres.
- **A check of what it is pointed at.** The service refuses to start unless the four
  contracts in the deployment file are Olien v1, by address and by the hash of their
  code, and keeps asking while an RPC is down instead of crashing on it.
- **A way back in for accounts.** A signer adds an Olien by its address and the
  service rebuilds its row from the chain.
- **A console that adapts.** The console offers importing and key expiry only when the
  service names them in `/api/treasury/chain`, so the same build is right against
  either backend.

All of it was driven end to end on a local chain carrying the canonical deployment:
sign in, create, pay with two approvals, lose the row, import it as a signer, pay
again. `ops/local-chain.sh` brings that chain up.

## What moving costs

The new service starts with an empty database, and only what is on the chain can be
rebuilt. So, for every existing Olien:

| Comes back | Does not |
| --- | --- |
| The account, its members, permissions and threshold | Its name and its members' labels |
| Delays, limits, sub-accounts and their balances | The address book |
| Money, and every executed transaction on the explorer | Proposals still collecting signatures |
| Scheduled changes already on the chain | API keys, payroll templates, webhooks |
| | Cheques written and not yet cashed stay cashable, but are no longer listed |
| | The ledger before the day of the import |

Everyone signs in again. A proposal that was waiting for signatures is proposed again.
On a testnet with a handful of accounts this is an afternoon's inconvenience. It would
not be acceptable with real customers, and copying the tables across instead is
possible: the schemas share a lineage, but the other backend's migration history
differs from this crate's, so it is a dump of the `olien_*` tables and the accounts
behind them into a database this service migrated, not a pointing of this service at
that database.

## Steps

1. **A Railway service built from this repository**, with a Postgres of its own.
   Railway reads `railway.json` and builds the `Dockerfile` from the repository root.
2. **Variables.**

   | Variable | Value |
   | --- | --- |
   | `DATABASE_URL` | the new Postgres |
   | `RELAYER_PK` | a new key, made for this service and held nowhere else |
   | `CORS_ALLOWED_ORIGINS` | `https://www.olien.org,https://olien.org` |
   | `DEPLOYMENTS_PATH` | leave unset for Monad testnet |

   The relayer only pays gas; any key will do, and a fresh one means two services never
   race on one nonce. Set it without it touching a shell history:

   ```sh
   openssl rand -hex 32 | sed 's/^/0x/' | railway variable set --service <name> --stdin RELAYER_PK
   ```
3. **A domain**, with its target port set to 8080. Railway's generated domains start
   with no target port and answer nothing until one is set.
4. **Fund the relayer.** Its address is in the boot log and in `/health`. It needs MON.
5. **Check it before anyone uses it.** `/health` answers, and the log carries
   `the four contracts are Olien v1, by address and by code`.
6. **Point the console at it.** `NEXT_PUBLIC_BACKEND_URL` on the Vercel project, then a
   production deploy. Environment values are inlined at build time, so the deploy is
   what moves it.
7. **Each team opens its Olien** from the start page, by address.

## Where the move stands, 7 October 2026

Done, in a Railway project of its own named `olien`, so nothing of it sits inside
another product's project:

| | |
| --- | --- |
| Service | `olien-service`, at `https://olien-service-production.up.railway.app`, built from this repository's `Dockerfile` |
| Database | `Postgres`, new and empty, referenced as `DATABASE_URL` |
| Relayer | `0x3f6CacC63449952Fc8b519B781b21ceBc8f13BcB`, a key made on the service and held nowhere else |
| Variables | `RELAYER_PK`, `DATABASE_URL`, `CORS_ALLOWED_ORIGINS` for olien.org, `RPC_URL_SECONDARY` on a second provider (Ankr's public Monad testnet endpoint since 7 October: drpc's refused eth_call, first over its gas cap and then outright, and a witness that cannot be read is a witness that says nothing), `INDEX_INTERVAL_SECS` |
| Domain | target port set to 8080 |

The console was pointed at it the same day: `NEXT_PUBLIC_BACKEND_URL` on the Vercel
project, then a production deploy, checked by reading the served scripts for the old
address (none) and the new one. olien.org talks to this service now.

The relayer was funded with 5 MON the same day, and the service was then put through a
whole account's life on Monad testnet with keys made for the run: an account created
through the relayer, its code checked against `deployments/v1`, a policy set, an address
signed into the book, a key minted with a last day, a rule change proposed, approved
twice with the console's own hashing, executed and scheduled by the chain, the audit
trail read back intact, and the account reopened by a signer and refused to a stranger.
Thirteen checks, all passed, and `ops/live-check.mjs` repeats the run against any
service URL. The first account is `0xd82d081799d3897df0e680e8e61b77d6c72ec165` and a run
costs the relayer 0.053 MON, so one MON pays for roughly twenty such lives.

The health line says `low` under 5 MON, which the run dipped the relayer just under. It
is a note on the health line and nothing else reads it; another MON clears it.

Still to do:

1. **Reopen each Olien** from the start page by address, giving the block it was
   created in if its ledger should reach back that far.

## Going back

Set `NEXT_PUBLIC_BACKEND_URL` to the old value and deploy. Nothing on the old side was
touched, so it is exactly as it was left. The one thing to watch is a proposal executed
through the new service in between: the old service's indexer sees it on the chain and
catches up, since the chain is the authority for both.

## Version 2 on the same service

The service carries v2's four addresses from `deployments/10143.json` and checks them
at boot like v1's: all four present with the pinned code means new accounts are made on
v2 and the console gets the move, the policy and the brake; none present means v1 only,
said once in the log, until a restart finds them; anything else refuses to start. So the
order is: send the bytes (`ops/deploy-olien.sh --book v2 --live`, with the relayer's key
through `railway run`), restart the service, watch the boot line say v2 is served, then
`ops/live-check.mjs` against the service.
