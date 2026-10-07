// The Olien treasury service.
//
// One job, three parts: an indexer that mirrors what the chain says about every Olien
// it knows, an API the console reads and writes through, and a relayer that pays for
// the transactions members have approved. Everything the chain decides is only
// mirrored here; the indexer overwrites this projection from events, so losing the
// database loses convenience and never authority.

mod app;
mod audit;
mod auth;
mod canonical;
mod config;
mod indexer;
mod limit;
mod members;
mod olien;
mod payroll;
mod policy;
mod routes;
mod sessions;
mod treasury;
mod treasury_cheques;
mod treasury_keys;
mod webhooks;

use std::sync::{Arc, Mutex};

use actix_web::HttpServer;
use anyhow::Result;
use sqlx::postgres::PgPoolOptions;
use tracing_subscriber::EnvFilter;

use crate::config::Config;
use crate::members::Members;
use crate::olien::OlienClient;
use crate::treasury::{ChainInfo, Treasury};

#[actix_web::main]
async fn main() -> Result<()> {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .init();

    // Boot progress is logged step by step so a hang before the server binds is visible.
    // A hosted database that never answers otherwise looks identical to a crash.
    tracing::info!("olien-service booting");
    let config = Config::from_env()?;
    tracing::info!("config loaded; connecting to Postgres");
    // acquire_timeout bounds the first connection: an unreachable database errors loudly
    // in a few seconds rather than hanging. On Railway the private *.railway.internal
    // host can hang; if it does, use the public database URL.
    let pool = PgPoolOptions::new()
        .max_connections(5)
        .acquire_timeout(std::time::Duration::from_secs(10))
        .connect(&config.database_url)
        .await?;
    tracing::info!("Postgres connected; applying migrations");
    sqlx::migrate!("./migrations").run(&pool).await?;
    tracing::info!("migrations applied");

    treasury::set_chain_tokens(config.usdc, config.eurc);
    let mut treasury = build_treasury(&config, true)?;
    if let Some(client) = treasury.client.clone() {
        hold_to_v1(client.clone()).await?;
        if config.olien_v2.is_some() && !hold_v2(&client).await? {
            treasury = build_treasury(&config, false)?;
        }
    }

    if treasury.client.is_some() {
        let pool = pool.clone();
        let treasury = treasury.clone();
        let interval = config.index_interval_secs;
        let chunk = config.log_chunk_blocks;
        actix_web::rt::spawn(async move {
            indexer::run(treasury, pool, interval, chunk).await;
        });
    } else {
        // Reads still work against whatever the projection already holds, which is a
        // legitimate way to run a replica, so this is a warning and not a refusal.
        tracing::warn!("no relayer key: the indexer is off and nothing can be executed");
    }

    tracing::info!(
        "olien-service listening on :{} ({}, chain {})",
        config.port,
        config.chain_name,
        config.chain_id
    );
    // Bind IPv6 dual-stack (::) rather than 0.0.0.0: Railway's healthcheck reaches the
    // container over IPv6, so an IPv4-only bind fails it. On Linux dual-stack, :: also
    // accepts IPv4, so nothing public changes.
    let bind = ("::", config.port);
    let port = config.port;
    // One limiter for the whole process: built per worker it would be ten allowances.
    let limiter = actix_web::web::Data::new(limit::Limiter::default());
    HttpServer::new(move || app::build_app(pool.clone(), config.clone(), treasury.clone(), limiter.clone()))
        .bind(bind)
        .map_err(|e| anyhow::anyhow!("binding :{port}: {e}"))?
        .run()
        .await?;

    Ok(())
}

/// Refuses to start against anything but Olien v1, and keeps asking when the chain
/// cannot be read.
///
/// A wrong address or wrong code is definitive and stops the boot. An unreachable RPC
/// is not: it says nothing about what is on the chain, and failing on it would turn an
/// RPC outage into a restart loop. So the service starts, a task asks again every half
/// minute, and the first definite answer either settles it or ends the process.
/// OLIEN_SKIP_CODE_CHECK exists for a local chain carrying a build of one's own.
async fn hold_to_v1(client: OlienClient) -> Result<()> {
    if std::env::var("OLIEN_SKIP_CODE_CHECK").is_ok_and(|v| !v.trim().is_empty()) {
        tracing::warn!("OLIEN_SKIP_CODE_CHECK is set: the contracts were not checked against Olien v1");
        return Ok(());
    }
    match canonical::verify(&client).await {
        canonical::Verdict::Verified => {
            tracing::info!("the four contracts are Olien v1, by address and by code");
            Ok(())
        }
        canonical::Verdict::Mismatch(reason) => anyhow::bail!("refusing to start: {reason}"),
        canonical::Verdict::Unreachable(reason) => {
            tracing::warn!("the contracts could not be checked yet ({reason}); starting, and asking again");
            actix_web::rt::spawn(async move {
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(30)).await;
                    match canonical::verify(&client).await {
                        canonical::Verdict::Verified => {
                            tracing::info!("the four contracts are Olien v1, by address and by code");
                            return;
                        }
                        canonical::Verdict::Mismatch(reason) => {
                            tracing::error!("stopping: {reason}");
                            std::process::exit(1);
                        }
                        canonical::Verdict::Unreachable(_) => {}
                    }
                }
            });
            Ok(())
        }
    }
}

/// Whether v2 is served: its four contracts are on the chain by address and by code.
/// Not there at all means v1 only, said once; anything else that is not v2 is refused.
async fn hold_v2(client: &OlienClient) -> Result<bool> {
    let Some(v2) = client.v2.as_ref() else { return Ok(false) };
    match canonical::verify_v2(client, v2).await {
        canonical::VerdictV2::Verified => {
            tracing::info!("the four contracts of Olien v2 are on this chain, by address and by code: new accounts are made on v2");
            Ok(true)
        }
        canonical::VerdictV2::NotThere => {
            tracing::warn!("Olien v2 is named in the deployment file and not on this chain yet: serving v1 only until a restart finds it");
            Ok(false)
        }
        canonical::VerdictV2::Mismatch(reason) => anyhow::bail!("refusing to start: {reason}"),
        canonical::VerdictV2::Unreachable(reason) => {
            tracing::warn!("v2 could not be checked ({reason}): serving v1 only until a restart can");
            Ok(false)
        }
    }
}

/// The relayer pays for account creation and for every execution, so without a key this
/// service reads but cannot write to the chain. The contracts themselves are not
/// optional: `Config::from_env` has already refused to start without them. v2 is
/// carried only when `with_v2`, which the boot check decides.
fn build_treasury(config: &Config, with_v2: bool) -> Result<Treasury> {
    let deployment = &config.olien;
    let v2 = config.olien_v2.clone().filter(|_| with_v2);
    let client = match &config.relayer_pk {
        Some(pk) => {
            let client = OlienClient::new(
                &config.rpc_url,
                pk,
                deployment.clone(),
                v2.clone(),
                config.usdc,
                config.eurc,
                config.rpc_url_secondary.as_deref(),
            )?;
            match client.has_witness() {
                true => tracing::info!("a second RPC is set: what gates execution is read from both and must agree"),
                false => tracing::warn!("no RPC_URL_SECONDARY: what gates execution is read from one endpoint and believed"),
            }
            tracing::info!(
                "relayer {:#x} (factory {:#x}, implementation {:#x}, verifier {:#x}, sub-accounts {:#x})",
                client.relayer(),
                deployment.factory,
                deployment.implementation,
                deployment.verifier,
                deployment.sub_account_implementation
            );
            Some(client)
        }
        None => {
            tracing::warn!("no RELAYER_PK or ATTESTOR_PK: this instance cannot send transactions");
            None
        }
    };

    let members = Members::from_config(config.members_url.as_deref(), config.members_token.as_deref());
    match members.configured() {
        true => tracing::info!("member directory enabled: signers may be named by @handle"),
        false => tracing::info!("no member directory: signers are named by address"),
    }

    let chain = ChainInfo {
        chain_id: config.chain_id,
        name: config.chain_name.clone(),
        native: config.native,
        explorer_url: config.explorer_url.clone(),
        usdc: format!("{:#x}", config.usdc),
        eurc: config.eurc.map(|a| format!("{a:#x}")),
        entry_point: Some(format!("{:#x}", deployment.entry_point)),
        factory: Some(format!("{:#x}", deployment.factory)),
        implementation: Some(format!("{:#x}", deployment.implementation)),
        factory_v2: v2.as_ref().map(|v| format!("{:#x}", v.factory)),
        implementation_v2: v2.as_ref().map(|v| format!("{:#x}", v.implementation)),
        implementation_v2_code_hash: v2.as_ref().map(|_| format!("{:#x}", canonical::implementation_v2_code_hash())),
        policy: v2.as_ref().map(|v| format!("{:#x}", v.policy)),
        verifier_v2: v2.as_ref().map(|v| format!("{:#x}", v.verifier)),
        features: if v2.is_some() { treasury::FEATURES_V2 } else { treasury::FEATURES },
    };

    Ok(Treasury {
        client,
        chain_id: config.chain_id,
        chain,
        relayer: Arc::new(Mutex::new(None)),
        members,
    })
}
