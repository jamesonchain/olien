// The /api/auth routes: the console's wallet sign-in, plus the token rotation and revoke
// that keep it signed in. Thin: parse, hand to sessions, map its error to a status.

use actix_web::http::{header, StatusCode};
use actix_web::{web, HttpRequest, HttpResponse};
use alloy::primitives::Address;
use serde::Deserialize;
use serde_json::json;
use sqlx::PgPool;
use std::str::FromStr;

use crate::limit::{self, Limiter};
use crate::routes::{caller_address, too_many};
use crate::sessions;

#[derive(Deserialize)]
pub struct WalletChallengeRequest {
    address: String,
}

#[derive(Deserialize)]
pub struct WalletLoginRequest {
    address: String,
    nonce: String,
    signature: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshRequest {
    refresh_token: String,
}

/// POST /api/auth/wallet/challenge - the text a wallet signs to enter the Olien console.
/// Public: the nonce is single-use and worthless without the signature.
pub async fn wallet_challenge(
    pool: web::Data<PgPool>,
    limiter: web::Data<Limiter>,
    req: HttpRequest,
    body: web::Json<WalletChallengeRequest>,
) -> HttpResponse {
    // Every challenge is a row, so an unlimited caller can fill a table.
    if let Err(wait) = limiter.take(&format!("sign-in:{}", caller_address(&req)), limit::SIGN_IN, std::time::Instant::now()) {
        return too_many(wait);
    }
    let Ok(address) = Address::from_str(body.address.trim()) else {
        return error_response(400, "malformed address");
    };
    match sessions::issue_challenge(pool.get_ref()).await {
        Ok(c) => HttpResponse::Ok().json(json!({
            "nonce": c.nonce,
            "expiresAt": c.expires_at,
            "message": sessions::wallet_login_message(address, &c.nonce, c.expires_at),
        })),
        Err(e) => {
            let (_, msg) = e.parts();
            tracing::error!("issue_challenge: {msg}");
            HttpResponse::InternalServerError().json(json!({ "error": "challenge failed" }))
        }
    }
}

/// POST /api/auth/wallet - verify the wallet's signature over its challenge text and issue
/// a session whose identity is the address.
pub async fn wallet_login(
    pool: web::Data<PgPool>,
    limiter: web::Data<Limiter>,
    req: HttpRequest,
    body: web::Json<WalletLoginRequest>,
) -> HttpResponse {
    if let Err(wait) = limiter.take(&format!("sign-in:{}", caller_address(&req)), limit::SIGN_IN, std::time::Instant::now()) {
        return too_many(wait);
    }
    match sessions::login_wallet(pool.get_ref(), &body.address, &body.nonce, &body.signature).await {
        Ok(grant) => HttpResponse::Ok().json(grant),
        Err(error) => account_error_response("wallet login", error),
    }
}

/// POST /api/auth/refresh - rotate both opaque tokens. A refresh token is single-use
/// because the stored hash is replaced atomically under a row lock.
pub async fn refresh(pool: web::Data<PgPool>, body: web::Json<RefreshRequest>) -> HttpResponse {
    match sessions::refresh_session(pool.get_ref(), &body.refresh_token).await {
        Ok(grant) => HttpResponse::Ok().json(grant),
        Err(error) => account_error_response("refreshing account session", error),
    }
}

/// POST /api/auth/logout - revoke the complete server session represented by this access
/// token. The console separately drops its local copy.
pub async fn logout(pool: web::Data<PgPool>, req: HttpRequest) -> HttpResponse {
    let token = match bearer_token(&req) {
        Ok(token) => token,
        Err((status, message)) => return error_response(status, &message),
    };
    match sessions::revoke_access_token(pool.get_ref(), token).await {
        Ok(()) => HttpResponse::NoContent().finish(),
        Err(error) => account_error_response("revoking account session", error),
    }
}

/// GET /api/me - who this access token belongs to.
///
/// The console calls it on every load to decide whether it is signed in, so it is part
/// of the auth surface rather than an extra. An address is the whole identity here:
/// there is no name or email behind a wallet login, and the console shows the address.
pub async fn me(pool: web::Data<PgPool>, req: HttpRequest) -> HttpResponse {
    let token = match bearer_token(&req) {
        Ok(token) => token,
        Err((status, message)) => return error_response(status, &message),
    };
    match sessions::account_for_access_token(pool.get_ref(), token).await {
        Ok(profile) => HttpResponse::Ok().json(profile),
        Err(error) => account_error_response("reading account session", error),
    }
}

pub(crate) fn bearer_token(req: &HttpRequest) -> Result<&str, (u16, String)> {
    req.headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .filter(|value| !value.trim().is_empty())
        .ok_or((401, "bearer access token required".to_string()))
}

pub(crate) fn account_error_response(
    operation: &str,
    error: sessions::AccountAuthError,
) -> HttpResponse {
    let (status, message) = error.parts();
    if status >= 500 {
        tracing::error!("{operation}: {message}");
    }
    error_response(status, &message)
}

pub fn error_response(status: u16, message: &str) -> HttpResponse {
    let code = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    HttpResponse::build(code).json(json!({ "error": message }))
}
