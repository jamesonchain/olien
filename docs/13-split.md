# The repo split

Written 2026-09-10 for execution on 2026-09-17, the first task of the Monad week
(12-metropolis.md). The aim: a public `olien` repository a judge can clone, with
every commit's date intact, and the consumer app staying private in `recourse`.

## What moves, by path

Extracted with `git filter-repo --path <each> --path-rename` so history follows
the files. Paths are as they are in `recourse` today; the right column is where
they land.

| From `recourse` | To `olien` |
| --- | --- |
| `contracts/src/olien/**` | `contracts/src/**` |
| `contracts/test/olien/**` | `contracts/test/**` |
| `contracts/script/DeployOlien.s.sol` | `contracts/script/Deploy.s.sol`, removed 2026-10-04: moving the sources changed the creation code, so v1 deploys from `deployments/v1/creation.json` through `ops/deploy-olien.sh` (audit L11) |
| `contracts/foundry.toml`, `contracts/lib/**`, `contracts/remappings.txt` | same (the `compilation_restrictions` for the via-IR path come along) |
| `backend/src/services/olien.rs`, `treasury.rs`, `treasury_keys.rs`, `treasury_cheques.rs`, `payroll.rs`, `webhooks.rs` | `service/src/**` |
| `backend/src/jobs/olien_indexer.rs` | `service/src/indexer.rs` |
| `backend/src/handlers/treasury.rs` | `service/src/routes.rs` |
| `backend/migrations/0013, 0018 (cloud_rotations stays), 0019, 0020, 0021, 0022, 0023, 0024` | `service/migrations/**`, renumbered from 0001, the `olien_*` tables only |
| `web/app/olien/**`, `web/components/olien/**` | `console/app/**`, `console/components/**` |
| `web/lib/treasury.ts`, `chain.ts`, `session.ts`, `passkey.ts`, `api.ts`, `wagmi.ts` | `console/lib/**` |
| `docs/treasury/**` | `docs/**` |
| `deployments/arc-testnet.json` (the `olien` object only) | `deployments/5042002.json`; Monad adds `10143.json` and `143.json` |

What does not move: the consumer contracts (escrow, vault, policy engine,
P256Owner, deposit factory), the consumer backend (handles, cheques inbox,
invoices, evidence, orders, smart accounts, recovery, deposits, push to phones),
the marketing site, the film pipeline, the phone. The phone keeps its Olien
signer and API client, since the phone is the app that uses them.

## The three cut points

Everything the treasury modules import from the rest of the backend, from the
`use crate::` lines on 2026-09-10:

1. **Sessions and wallet sign-in.** `handlers/treasury.rs` uses
   `account_sessions::account_for_access_token` and `handlers::auth`'s bearer and
   error helpers; wallet sign-in lives in `handlers/auth.rs` (`wallet_challenge`,
   `wallet`) and `account_sessions` (`wallet_login_message`, the token store).
   The service needs exactly the wallet path and the token store. **Cut:** copy
   the wallet challenge, the wallet login, the session token issue and lookup, and
   the `accounts` table's minimum (id, provider `wallet`, subject) into
   `service/src/auth.rs` with migrations of their own. Apple, Google, passkey
   sign-in and everything else in `account_sessions` stay behind.
2. **Members by handle and by Safe.** `treasury.rs` calls `handles::resolve` for
   @handle invites and reads `smart_accounts` for a Recourse account's Safe
   (`linked_set`, `resolve_handles`, the signer view join); `push::member_accounts`
   joins `smart_accounts` to find phones. **Cut:** a `MemberDirectory` trait with
   two methods, resolve a handle to an address and list the accounts behind an
   address, with a `None` implementation and an HTTP implementation that calls
   the Recourse backend when `RECOURSE_URL` and a service key are set. Push to
   phones goes the same way: the Recourse backend exposes one internal route
   that takes account ids and a message. On Monad the directory is `None` and
   nothing is lost.
3. **Cheques.** `treasury_cheques.rs` inserts into the consumer `cheques` table so
   the phone's inbox sees an issued cheque. **Cut:** the service keeps its own
   `olien_cheques` as the source and stops writing `cheques`; the Recourse backend
   reads issued cheques for an address from `GET /api/treasury/cheques/issued?to=`
   (new, session-less, keyed by the same service key) and merges them into the
   phone's inbox. The console's cashing page, planned for the Monad week, is the
   other reader.

`olien.rs` imports nothing from the rest, and neither do keys, payroll or
webhooks beyond `treasury.rs` itself.

## The service becomes a crate of its own

`service/Cargo.toml` with the same dependencies the backend uses today (actix,
sqlx, alloy, reqwest, sha2, chrono, rand, base64, serde). `main.rs` is the
backend's `build_treasury` plus the route mount plus the indexer spawn, about a
hundred lines. Config is the deployment file, `DATABASE_URL`, `RELAYER_PK`,
optional `RPC_URL`, `EXPLORER_URL`, `EURC_ADDRESS`, `RECOURSE_URL`, and the APNs
settings if push is wanted. One process serves one chain; a second chain is a
second process with its own database, which is also what the console assumes
(`lib/chain.ts`). A chain switcher in the console is a list of API bases.

## Deploys

- Railway: a second service, `olien-arc-testnet`, from `service/Dockerfile`,
  same shape as the backend's (mind the cargo mtime trap in memory). Then
  `olien-monad-testnet` and `olien-monad` when the contracts are there.
- Vercel: a second project from `console/`, one deployment per chain by
  `NEXT_PUBLIC_OLIEN_CHAIN` and `NEXT_PUBLIC_BACKEND_URL`, on its own domain.
- The Recourse backend keeps serving `/api/treasury` until the console has
  moved, then the routes and modules are deleted from `recourse` in one commit.

## Checked the day before, 2026-09-16

Re-derived from the source rather than trusted, because the file table and the cut
points above were both taken from the code on 2026-09-10 and the backend changed after
that. Everything holds, with two corrections.

- **The three cut points are unchanged.** `handlers/treasury.rs` still reaches only
  `handlers::auth` and `account_sessions`, `treasury.rs` only `handles`, and
  `olien_indexer.rs` only `push`. `olien.rs` imports nothing from the rest, and keys,
  payroll and webhooks reach no further than `treasury.rs`.
- **`cargo test` needs no database.** There is not one `sqlx::query!` macro in the
  backend, only the 203 runtime forms, and no `#[sqlx::test]` and no `backend/tests`.
  Nothing connects at build time or at test time, so the step 2 gate is green without
  Postgres running. `ops/docker-compose.yml` has one on port 5433 if a later step wants
  it.
- **Correction:** `contracts/remappings.txt` is in the table above but does not exist.
  Drop it from the filter-repo path list.
- All eight migrations are present: 0013, 0018 through 0024.
- Tooling is installed and signed in: `git-filter-repo`, git 2.50.1, Python 3.9.6, `gh`
  as frankolien.
- `backend/Cargo.toml` is a single package, there is no root `Cargo.toml` and no
  `service/`, so the workspace in step 2 starts from nothing, as the plan assumes.
- **The Dockerfile is at the repository root**, not `backend/Dockerfile`. It already
  guards the cargo mtime trap, and it hardcodes `DEPLOYMENTS_PATH` to
  `arc-testnet.json`, so `service/Dockerfile` should take that as a variable given one
  process serves one chain.

## Order of work on the 17th

1. `git filter-repo` into a fresh clone, verify `git log` dates survive.
2. Cargo workspace and `main.rs`; the three cuts; `cargo test` green (the 30 or so
   treasury tests and the vectors).
3. Console builds with `NEXT_PUBLIC_OLIEN_CHAIN=arc-testnet` against the moved
   service running locally on a scratch Postgres.
4. Deploy both to Arc testnet, point the console at it, sign in, see the proof
   accounts.
5. Only then Monad: deployment files, contracts via CREATE2, a second service and
   console.
