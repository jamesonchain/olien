// Where this service learns which chain it is on.
//
// Every address comes from a deployment file named by chain id, never from a constant
// here, so pointing the service at another chain is a settings change and not a
// release. DEPLOYMENTS_PATH selects the file.
//
// The one contract this service insists on is Olien itself. The consumer backend keeps
// `olien` optional because it has an app to serve without it; here a file with no Olien
// describes a chain this binary has no work to do on, so it refuses to start rather
// than booting into a service where every route answers that the treasury is off.

use alloy::primitives::Address;
use anyhow::{bail, Context, Result};
use serde::Deserialize;
use std::path::PathBuf;

use crate::olien::{OlienDeployment, OlienV2Deployment};

/// The deployment file, read for the parts an Olien service needs.
///
/// The consumer contracts may be present in the same file (they are on Arc) and are
/// simply not read here. That is deliberate: one file per chain stays the shape both
/// repositories agree on, and this service ignores what is not its business.
#[derive(Debug, Deserialize)]
pub struct Deployment {
    pub usdc: Address,
    #[serde(rename = "chainId")]
    pub chain_id: u64,
    #[serde(default)]
    pub olien: Option<OlienDeployment>,
    /// The second implementation, once it is on this chain (docs/16-account-v2.md).
    #[serde(default, rename = "olienV2")]
    pub olien_v2: Option<OlienV2Deployment>,
}

/// What pays for gas on this chain. On Arc it is USDC itself, 18 decimals in the native
/// slot; on Monad it is MON. The relayer's balance, an Olien's EntryPoint deposit and
/// the ledger's gas rows are all in this unit, and the console names it from here
/// rather than assuming dollars.
#[derive(Debug, Clone, Copy, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeToken {
    pub symbol: &'static str,
    pub decimals: u8,
}

#[derive(Debug, Clone)]
pub struct Config {
    pub database_url: String,
    pub rpc_url: String,
    /// A second, independent endpoint for the same chain. When set, what decides
    /// whether a proposal may run is read from both, and they must agree.
    pub rpc_url_secondary: Option<String>,
    pub port: u16,
    pub index_interval_secs: u64,
    /// The widest block range one log query may ask for on this chain.
    pub log_chunk_blocks: u64,
    pub chain_id: u64,
    pub chain_name: String,
    pub native: NativeToken,
    pub explorer_url: String,
    pub olien: OlienDeployment,
    /// v2's four contracts, from the same file; served only when their code is there.
    pub olien_v2: Option<OlienV2Deployment>,
    /// Pays for account creation and executions. Absent means the service reads and
    /// serves but cannot send, which is a legitimate way to run a replica.
    pub relayer_pk: Option<String>,
    pub usdc: Address,
    /// EURC on this chain, where it exists. Monad has none at all, so a treasury there
    /// holds dollars only.
    pub eurc: Option<Address>,
    /// Allowed browser origins. Empty means permissive, which is the local default;
    /// set CORS_ALLOWED_ORIGINS in production to the console's own origin.
    pub cors_allowed_origins: Vec<String>,
    /// An optional directory that resolves @handles to addresses and lists the accounts
    /// behind one. Absent means members are named by address, which is all Olien needs.
    pub members_url: Option<String>,
    pub members_token: Option<String>,
}

pub fn native_for(chain_id: u64) -> NativeToken {
    match chain_id {
        5042 | 5042002 => NativeToken { symbol: "USDC", decimals: 18 },
        143 | 10143 => NativeToken { symbol: "MON", decimals: 18 },
        _ => NativeToken { symbol: "ETH", decimals: 18 },
    }
}

pub fn chain_name_for(chain_id: u64) -> &'static str {
    match chain_id {
        5042 => "Arc",
        5042002 => "Arc Testnet",
        143 => "Monad",
        10143 => "Monad Testnet",
        _ => "Unknown chain",
    }
}

/// The block explorer for links the console and the alerts hand out. EXPLORER_URL wins;
/// the defaults are the hosts checked on 2026-09-10.
fn explorer_for(chain_id: u64) -> String {
    if let Some(url) = optional_env("EXPLORER_URL") {
        return url.trim_end_matches('/').to_string();
    }
    match chain_id {
        5042002 => "https://testnet.arcscan.app".into(),
        10143 => "https://testnet.monadexplorer.com".into(),
        143 => "https://monadexplorer.com".into(),
        _ => String::new(),
    }
}

/// RPC_URL wins, and the default follows the deployment file's chain so a Monad file
/// needs no RPC setting at all.
fn rpc_url_for(chain_id: u64) -> String {
    if let Some(url) = optional_env("RPC_URL") {
        return url;
    }
    match chain_id {
        10143 => "https://testnet-rpc.monad.xyz".into(),
        143 => "https://rpc.monad.xyz".into(),
        _ => "https://arc-testnet.drpc.org".into(),
    }
}

/// How many blocks one `eth_getLogs` may cover on this chain.
///
/// A fact about the chain's RPCs rather than a constant. Arc's gateway allows 10,000
/// and the indexer asks for 5,000; every public Monad endpoint tested on 2026-09-12
/// refuses more than 100, because a block every 300ms makes a wide range enormous.
/// Asking for more than the endpoint allows fails every call, so on Monad this is the
/// difference between an indexer and nothing at all.
fn log_chunk_for(chain_id: u64) -> u64 {
    if let Some(value) = optional_env("LOG_CHUNK_BLOCKS").and_then(|v| v.trim().parse::<u64>().ok()) {
        return value.max(1);
    }
    match chain_id {
        143 | 10143 => 100,
        5042 | 5042002 => 5_000,
        _ => 2_000,
    }
}

/// Verified on Arc testnet on 2026-09-07: symbol EURC, six decimals. Overridable so a
/// chain that gains one later needs a setting rather than a release.
fn eurc_for(chain_id: u64) -> Option<Address> {
    if let Some(text) = optional_env("EURC_ADDRESS") {
        return text.trim().parse().ok();
    }
    match chain_id {
        5042002 => "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a".parse().ok(),
        _ => None,
    }
}

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

fn optional_env(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

impl Config {
    pub fn from_env() -> Result<Self> {
        let deployments_path =
            PathBuf::from(env_or("DEPLOYMENTS_PATH", "../deployments/10143.json"));
        let raw = std::fs::read_to_string(&deployments_path).with_context(|| {
            format!("reading deployment file at {}", deployments_path.display())
        })?;
        let deployment: Deployment =
            serde_json::from_str(&raw).context("parsing deployment JSON")?;

        let Some(olien) = deployment.olien else {
            bail!(
                "{} describes a chain with no Olien deployment, so this service has nothing to serve",
                deployments_path.display()
            );
        };

        Ok(Self {
            database_url: env_or(
                "DATABASE_URL",
                "postgres://olien:olien@localhost:5433/olien",
            ),
            rpc_url: rpc_url_for(deployment.chain_id),
            rpc_url_secondary: optional_env("RPC_URL_SECONDARY"),
            port: env_or("PORT", "8080").parse().context("PORT")?,
            index_interval_secs: env_or("INDEX_INTERVAL_SECS", "15")
                .parse()
                .context("INDEX_INTERVAL_SECS")?,
            log_chunk_blocks: log_chunk_for(deployment.chain_id),
            chain_id: deployment.chain_id,
            chain_name: chain_name_for(deployment.chain_id).to_string(),
            native: native_for(deployment.chain_id),
            explorer_url: explorer_for(deployment.chain_id),
            olien,
            olien_v2: deployment.olien_v2,
            // RELAYER_PK is the name; ATTESTOR_PK is accepted because the testnet
            // deployment shares one key and inventing a second would be ceremony.
            relayer_pk: optional_env("RELAYER_PK").or_else(|| optional_env("ATTESTOR_PK")),
            usdc: deployment.usdc,
            eurc: eurc_for(deployment.chain_id),
            cors_allowed_origins: optional_env("CORS_ALLOWED_ORIGINS")
                .map(|raw| {
                    raw.split(',')
                        .map(|origin| origin.trim().to_string())
                        .filter(|origin| !origin.is_empty())
                        .collect()
                })
                .unwrap_or_default(),
            members_url: optional_env("MEMBERS_URL"),
            members_token: optional_env("MEMBERS_TOKEN"),
        })
    }
}

#[cfg(test)]
mod deployment_file_tests {
    use super::Deployment;

    // Both chains this service is deployed on, pinned in both directions. The Monad file
    // carries no consumer contracts and must still parse, and the Arc file carries them
    // and must not confuse the parser that ignores them.

    #[test]
    fn the_monad_file_yields_an_olien_and_a_chain() {
        let raw = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../deployments/10143.json"
        ))
        .expect("deployments/10143.json");
        let d: Deployment = serde_json::from_str(&raw).expect("the Monad file must parse");
        assert_eq!(d.chain_id, 10143);
        assert!(d.olien.is_some(), "the Olien contracts are the point of this file");
    }

    #[test]
    fn a_chain_without_olien_is_refused() {
        // Not a fixture on disk, because the point is the shape rather than any file.
        let d: Deployment = serde_json::from_str(
            r#"{"chainId":1,"usdc":"0x0000000000000000000000000000000000000001"}"#,
        )
        .expect("a file may legitimately lack Olien");
        assert!(d.olien.is_none(), "Config::from_env turns this into a refusal to boot");
    }

    #[test]
    fn gas_is_mon_on_monad_and_usdc_on_arc() {
        assert_eq!(super::native_for(10143).symbol, "MON");
        assert_eq!(super::native_for(5042002).symbol, "USDC");
    }

    // Arc's gateway allows 10,000 and Monad's refuses anything over 100. Asking for more
    // than the endpoint allows fails every call, so this constant is the indexer.
    #[test]
    fn the_log_chunk_follows_the_chain() {
        assert_eq!(super::log_chunk_for(10143), 100);
        assert_eq!(super::log_chunk_for(5042002), 5_000);
    }
}
