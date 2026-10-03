// The route table and the shared state behind it.
//
// Two scopes and nothing else: /api/auth, where a wallet signature becomes a session,
// and /api/treasury, the service proper. Split out from main so the tests can build the
// same application the binary serves.

use actix_cors::Cors;
use actix_web::dev::{ServiceFactory, ServiceRequest, ServiceResponse};
use actix_web::{web, App, Error, HttpResponse};
use serde_json::json;
use sqlx::PgPool;

use crate::config::Config;
use crate::limit::Limiter;
use crate::treasury::Treasury;
use crate::{auth, routes};

/// What the deployment reports about itself. Read by whoever is watching, and by the
/// platform's healthcheck, so it answers before the chain is reachable rather than
/// failing when it is not: an unreachable RPC is a thing to see, not a reason to be
/// restarted in a loop.
pub async fn health(config: web::Data<Config>, treasury: web::Data<Treasury>) -> HttpResponse {
    let relayer = treasury.relayer.lock().ok().and_then(|r| r.clone());
    HttpResponse::Ok().json(json!({
        "status": "ok",
        "chainId": config.chain_id,
        "chain": config.chain_name,
        "relayer": relayer,
        "secondRpc": treasury.client.as_ref().is_some_and(|client| client.has_witness()),
    }))
}

fn cors(config: &Config) -> Cors {
    // Permissive is the local default because the console runs on some port or other in
    // development. Production sets CORS_ALLOWED_ORIGINS to the console's own origin,
    // and then nothing else may call it from a browser.
    if config.cors_allowed_origins.is_empty() {
        return Cors::permissive();
    }
    let mut cors = Cors::default()
        .allow_any_method()
        .allow_any_header()
        .supports_credentials()
        .max_age(3600);
    for origin in &config.cors_allowed_origins {
        cors = cors.allowed_origin(origin);
    }
    cors
}

pub fn build_app(
    pool: PgPool,
    config: Config,
    treasury: Treasury,
    limiter: web::Data<Limiter>,
) -> App<
    // The body type is left open because the CORS middleware wraps it in an Either to
    // answer preflights itself, so naming BoxBody here would not match what is built.
    impl ServiceFactory<
        ServiceRequest,
        Config = (),
        Response = ServiceResponse<impl actix_web::body::MessageBody>,
        Error = Error,
        InitError = (),
    >,
> {
    App::new()
        .wrap(cors(&config))
        .app_data(web::Data::new(pool))
        .app_data(limiter)
        .app_data(web::Data::new(config))
        .app_data(web::Data::new(treasury))
        .route("/health", web::get().to(health))
        // Registered before /api: a scope matches by prefix, so /api/treasury has to be
        // mounted as its own scope rather than nested inside a broader one that would
        // swallow it.
        .service(routes::routes(web::scope("/api/treasury")))
        .route("/api/me", web::get().to(auth::me))
        .service(
            web::scope("/api/auth")
                .route("/wallet/challenge", web::post().to(auth::wallet_challenge))
                .route("/wallet", web::post().to(auth::wallet_login))
                .route("/refresh", web::post().to(auth::refresh))
                .route("/logout", web::post().to(auth::logout)),
        )
}
