# Olien

A team account for stablecoins. Members approve together, spend under a limit, and
sign with a passkey rather than a seed phrase.

Ethereum has Safe and Solana has Squads. Olien is the account protocol for chains that
have neither, with a transaction service and a console on top of it.

Console: **https://www.olien.org**

## Live on Monad testnet, chain 10143

Deployed 2026-09-16 through the Arachnid CREATE2 deployer, so every address is a pure
function of a fixed salt and the creation code.

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
| `deployments/` | One address book per chain, named by chain id |
| `ops/` | Chain readiness checks and deploy scripts |

## Getting it

The contracts use submodules, so a plain clone gives a `contracts/` that will not build.

```sh
git clone --recursive https://github.com/sQuiDbOb18/olien.git
cd olien
```

Already cloned without them: `git submodule update --init --recursive`.

## Running it

**Contracts.** 62 tests, no network needed.

```sh
cd contracts && forge test
```

**Service.** 41 tests, and none of them need a database: every query is a runtime
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
| `DATABASE_URL` | local Postgres | Where the projection lives. Losing it loses convenience, never authority: the indexer rebuilds it from the chain |
| `DEPLOYMENTS_PATH` | `../deployments/10143.json` | Which chain this instance serves. A file with no `olien` key is refused at boot |
| `RELAYER_PK` | none | Pays for account creation and executions. Without it the service reads and serves but cannot send |
| `RPC_URL` | per chain | Overrides the built-in endpoint |
| `PORT` | `8080` | Binds `::`, dual stack |
| `CORS_ALLOWED_ORIGINS` | empty, meaning permissive | Comma separated. Set it in production to the console's origin |
| `MEMBERS_URL` | none | An optional directory that resolves `@handle` to an address. Without one, members are named by address |
| `LOG_CHUNK_BLOCKS` | per chain | How wide one `eth_getLogs` may be. 100 on Monad, 5,000 on Arc |

**Console.** One chain per build.

```sh
cd console && npm install
NEXT_PUBLIC_OLIEN_CHAIN=monad-testnet npm run build
```

| Variable | What it does |
| --- | --- |
| `NEXT_PUBLIC_OLIEN_CHAIN` | Which chain this build talks to |
| `NEXT_PUBLIC_BACKEND_URL` | Where the service is |
| `NEXT_PUBLIC_PASSKEY_RP_ID` | Pins the domain a passkey is bound to. Leave it unset locally, where inheriting the origin is right |

**Checking a chain** before deploying to it. Reads the chain, writes nothing.

```sh
ops/monad-check.sh              # testnet, 10143
ops/monad-check.sh --mainnet    # mainnet, 143
```

## Notes

Gas on Monad is MON, not the stablecoin. `eth_getLogs` is capped at 100 blocks on every
public Monad testnet endpoint tested, so the indexer takes its chunk size from the chain
rather than a constant.

A passkey is bound to the domain that created it and cannot be moved to another one.
`NEXT_PUBLIC_PASSKEY_RP_ID` exists so that binding is a deployment decision rather than
an accident of which URL someone happened to open.

`docs/10-account-spec.md` is the contract, normatively. `docs/12-metropolis.md` records
what has been proved on chain, with transaction hashes.

## Contributing

Open issues are the place to start; several are small and self-contained on purpose.
Two house rules, both about the same thing:

- **Comments say why, not what.** If a comment restates the line below it, delete it.
- **Commit messages explain the reasoning**, not the diff. The diff is already in the
  commit.
