// The /api/treasury routes (docs/treasury/11-service-api.md). Thin: parse, resolve the
// caller, hand to treasury, map its error to a status.

use actix_web::{web, HttpRequest, HttpResponse};
use serde::Deserialize;
use serde_json::json;
use sqlx::PgPool;
use std::time::Instant;

use crate::audit;
use crate::auth::{account_error_response, bearer_token, error_response};
use crate::limit::{self, Limiter};
use crate::policy::Policy;
use crate::sessions as account_sessions;
use crate::payroll::{self, PayrollBody};
use crate::webhooks::{self, WebhookBody};
use crate::treasury::{self, Treasury, TreasuryError};
use crate::treasury_cheques::{self, ChequeSignatureBody, NewChequeBody};
use crate::treasury_keys::{self, Need};

/// Who is asking: a person with a session, or an API key standing in for the member
/// who minted it. The key id rides along so a proposal can say a key opened it.
struct Caller {
    user: i64,
    key: Option<i64>,
}

/// A session may do anything its membership allows. An API key is held to its scope
/// and to the account in the path before the service ever checks membership, so a key
/// for one treasury learns nothing about another.
async fn caller(pool: &PgPool, req: &HttpRequest, need: Need, address: Option<&str>) -> Result<Caller, HttpResponse> {
    let token = match bearer_token(req) {
        Ok(token) => token,
        Err((status, message)) => return Err(error_response(status, &message)),
    };
    let limiter = req.app_data::<web::Data<Limiter>>();
    let now = Instant::now();
    if treasury_keys::looks_like_key(token) {
        // Keys that turn out not to exist are counted against the address they came
        // from, and that count is looked at before the key is, so guessing is slow
        // whatever is guessed.
        let guesser = format!("wrong-key:{}", caller_address(req));
        if limiter.is_some_and(|limiter| limiter.exhausted(&guesser, limit::WRONG_KEY, now)) {
            return Err(too_many(10));
        }
        let grant = match treasury_keys::resolve(pool, token).await {
            Ok(Some(grant)) => grant,
            Ok(None) => {
                if let Some(limiter) = limiter {
                    let _ = limiter.take(&guesser, limit::WRONG_KEY, now);
                }
                return Err(error_response(401, "this API key is not valid"));
            }
            Err(error) => return Err(failed(error)),
        };
        if let Some(Err(wait)) = limiter.map(|limiter| limiter.take(&format!("key:{}", grant.key_id), limit::KEY, now)) {
            return Err(too_many(wait));
        }
        if let Err((status, message)) = treasury_keys::permit(&grant, need, address) {
            return Err(error_response(status, message));
        }
        return Ok(Caller { user: grant.user, key: Some(grant.key_id) });
    }
    // By the token, before it is looked up, so a loop costs the database nothing.
    let session = format!("session:{}", token.get(..16).unwrap_or(token));
    if let Some(Err(wait)) = limiter.map(|limiter| limiter.take(&session, limit::SESSION, now)) {
        return Err(too_many(wait));
    }
    account_sessions::account_for_access_token(pool, token)
        .await
        .map(|profile| Caller { user: profile.account_id, key: None })
        .map_err(|error| account_error_response("reading account session", error))
}

/// Where a request came from, as the proxy in front of the service reports it.
pub(crate) fn caller_address(req: &HttpRequest) -> String {
    req.connection_info().realip_remote_addr().unwrap_or("unknown").to_string()
}

pub(crate) fn too_many(wait_seconds: u64) -> HttpResponse {
    HttpResponse::TooManyRequests()
        .insert_header(("retry-after", wait_seconds.to_string()))
        .json(json!({ "error": "too many requests; try again shortly" }))
}

fn failed(error: TreasuryError) -> HttpResponse {
    let (status, message) = error.parts();
    if status >= 500 {
        tracing::warn!("treasury route failed: {message}");
    }
    error_response(status, &message)
}

fn reply<T: serde::Serialize>(result: Result<T, TreasuryError>) -> HttpResponse {
    match result {
        Ok(value) => HttpResponse::Ok().json(value),
        Err(error) => failed(error),
    }
}

/// A person's route: no key reaches it.
macro_rules! who {
    ($pool:expr, $req:expr) => {
        match caller($pool.get_ref(), &$req, Need::Person, None).await {
            Ok(caller) => caller.user,
            Err(response) => return response,
        }
    };
}

/// A route on one account that a key may reach with the given need.
macro_rules! who_on {
    ($pool:expr, $req:expr, $need:expr, $address:expr) => {
        match caller($pool.get_ref(), &$req, $need, Some($address)).await {
            Ok(caller) => caller,
            Err(response) => return response,
        }
    };
}

#[derive(Debug, Deserialize)]
pub struct LinkBody {
    pub address: String,
    pub signature: String,
}

#[derive(Deserialize)]
pub struct RenameBody {
    pub name: String,
}

pub async fn rename_account(
    pool: web::Data<PgPool>,
    service: web::Data<Treasury>,
    req: HttpRequest,
    path: web::Path<String>,
    body: web::Json<RenameBody>,
) -> HttpResponse {
    let user = who!(pool, req);
    reply(treasury::rename_account(pool.get_ref(), service.get_ref(), user, &path.into_inner(), &body.name).await)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubAccountBody {
    #[serde(default)]
    pub label: String,
}

/// POST /api/treasury/accounts/{address}/sub-accounts - deploy the next one.
pub async fn create_sub_account(
    pool: web::Data<PgPool>,
    service: web::Data<Treasury>,
    req: HttpRequest,
    path: web::Path<String>,
    body: web::Json<SubAccountBody>,
) -> HttpResponse {
    let user = who!(pool, req);
    reply(treasury::create_sub_account(pool.get_ref(), service.get_ref(), user, &path.into_inner(), &body.label).await)
}

/// GET /api/treasury/chain - which chain this service runs against. Public: nothing in
/// it is secret, and the console needs it before anyone signs in.
pub async fn chain(service: web::Data<Treasury>) -> HttpResponse {
    HttpResponse::Ok().json(&service.chain)
}

pub async fn linked_addresses(pool: web::Data<PgPool>, req: HttpRequest) -> HttpResponse {
    let user = who!(pool, req);
    reply(treasury::linked_addresses(pool.get_ref(), user).await)
}

pub async fn link_address(pool: web::Data<PgPool>, req: HttpRequest, body: web::Json<LinkBody>) -> HttpResponse {
    let user = who!(pool, req);
    reply(treasury::link_address(pool.get_ref(), user, &body.address, &body.signature).await)
}

pub async fn list_accounts(pool: web::Data<PgPool>, req: HttpRequest) -> HttpResponse {
    let user = who!(pool, req);
    reply(treasury::list_accounts(pool.get_ref(), user).await)
}

pub async fn create_account(
    pool: web::Data<PgPool>,
    service: web::Data<Treasury>,
    req: HttpRequest,
    body: web::Json<treasury::CreateAccountBody>,
) -> HttpResponse {
    let user = who!(pool, req);
    reply(treasury::create_account(pool.get_ref(), service.get_ref(), user, body.into_inner()).await)
}

/// POST /api/treasury/accounts/import - open an Olien that already exists on the chain.
pub async fn import_account(
    pool: web::Data<PgPool>,
    service: web::Data<Treasury>,
    req: HttpRequest,
    body: web::Json<treasury::ImportBody>,
) -> HttpResponse {
    let user = who!(pool, req);
    reply(treasury::import_account(pool.get_ref(), service.get_ref(), user, body.into_inner()).await)
}

pub async fn get_account(pool: web::Data<PgPool>, service: web::Data<Treasury>, req: HttpRequest, path: web::Path<String>) -> HttpResponse {
    let user = who_on!(pool, req, Need::Read, &path).user;
    reply(treasury::account_view(pool.get_ref(), service.get_ref(), user, &path).await)
}

#[derive(Debug, Deserialize)]
pub struct ListQuery {
    pub status: Option<String>,
}

pub async fn list_proposals(
    pool: web::Data<PgPool>,
    service: web::Data<Treasury>,
    req: HttpRequest,
    path: web::Path<String>,
    query: web::Query<ListQuery>,
) -> HttpResponse {
    let user = who_on!(pool, req, Need::Read, &path).user;
    reply(treasury::list_proposals(pool.get_ref(), service.get_ref(), user, &path, query.status.as_deref()).await)
}

pub async fn create_proposal(
    pool: web::Data<PgPool>,
    service: web::Data<Treasury>,
    req: HttpRequest,
    path: web::Path<String>,
    body: web::Json<treasury::NewProposalBody>,
) -> HttpResponse {
    let caller = who_on!(pool, req, Need::Propose, &path);
    reply(treasury::create_proposal(pool.get_ref(), service.get_ref(), caller.user, &path, body.into_inner(), caller.key).await)
}

pub async fn propose_transfer(
    pool: web::Data<PgPool>,
    service: web::Data<Treasury>,
    req: HttpRequest,
    path: web::Path<String>,
    body: web::Json<treasury::TransferBody>,
) -> HttpResponse {
    let caller = who_on!(pool, req, Need::Propose, &path);
    reply(treasury::propose_transfer(pool.get_ref(), service.get_ref(), caller.user, &path, body.into_inner(), caller.key).await)
}

pub async fn propose_signers(
    pool: web::Data<PgPool>,
    service: web::Data<Treasury>,
    req: HttpRequest,
    path: web::Path<String>,
    body: web::Json<treasury::SignersProposalBody>,
) -> HttpResponse {
    let user = who!(pool, req);
    reply(treasury::propose_signers(pool.get_ref(), service.get_ref(), user, &path, body.into_inner()).await)
}

pub async fn propose_limit(
    pool: web::Data<PgPool>,
    service: web::Data<Treasury>,
    req: HttpRequest,
    path: web::Path<String>,
    body: web::Json<treasury::LimitProposalBody>,
) -> HttpResponse {
    let user = who!(pool, req);
    reply(treasury::propose_limit(pool.get_ref(), service.get_ref(), user, &path, body.into_inner()).await)
}

pub async fn propose_remove_limit(
    pool: web::Data<PgPool>,
    service: web::Data<Treasury>,
    req: HttpRequest,
    path: web::Path<String>,
    body: web::Json<treasury::RemoveLimitBody>,
) -> HttpResponse {
    let user = who!(pool, req);
    reply(treasury::propose_remove_limit(pool.get_ref(), service.get_ref(), user, &path, body.into_inner()).await)
}

pub async fn get_proposal(
    pool: web::Data<PgPool>,
    service: web::Data<Treasury>,
    req: HttpRequest,
    path: web::Path<(String, String)>,
) -> HttpResponse {
    let user = who_on!(pool, req, Need::Read, &path.0).user;
    let (address, hash) = path.into_inner();
    reply(treasury::get_proposal(pool.get_ref(), service.get_ref(), user, &address, &hash).await)
}

pub async fn delete_proposal(pool: web::Data<PgPool>, req: HttpRequest, path: web::Path<(String, String)>) -> HttpResponse {
    let user = who!(pool, req);
    let (address, hash) = path.into_inner();
    match treasury::delete_proposal(pool.get_ref(), user, &address, &hash).await {
        Ok(()) => HttpResponse::NoContent().finish(),
        Err(error) => failed(error),
    }
}

pub async fn confirm(
    pool: web::Data<PgPool>,
    service: web::Data<Treasury>,
    req: HttpRequest,
    path: web::Path<(String, String)>,
    body: web::Json<treasury::ConfirmationBody>,
) -> HttpResponse {
    let user = who!(pool, req);
    let (address, hash) = path.into_inner();
    reply(treasury::confirm(pool.get_ref(), service.get_ref(), user, &address, &hash, body.into_inner()).await)
}

pub async fn execute(
    pool: web::Data<PgPool>,
    service: web::Data<Treasury>,
    req: HttpRequest,
    path: web::Path<(String, String)>,
) -> HttpResponse {
    let user = who!(pool, req);
    let (address, hash) = path.into_inner();
    reply(treasury::execute(pool.get_ref(), service.get_ref(), user, &address, &hash).await)
}

pub async fn cancel(
    pool: web::Data<PgPool>,
    service: web::Data<Treasury>,
    req: HttpRequest,
    path: web::Path<(String, String)>,
) -> HttpResponse {
    let user = who!(pool, req);
    let (address, hash) = path.into_inner();
    reply(treasury::propose_cancel(pool.get_ref(), service.get_ref(), user, &address, &hash).await)
}

pub async fn list_scheduled(pool: web::Data<PgPool>, service: web::Data<Treasury>, req: HttpRequest, path: web::Path<String>) -> HttpResponse {
    let user = who_on!(pool, req, Need::Read, &path).user;
    reply(treasury::list_scheduled(pool.get_ref(), service.get_ref(), user, &path).await)
}

pub async fn veto_call(pool: web::Data<PgPool>, req: HttpRequest, path: web::Path<(String, String)>) -> HttpResponse {
    let user = who!(pool, req);
    let (address, hash) = path.into_inner();
    reply(treasury::veto_call(pool.get_ref(), user, &address, &hash).await)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VetoOperationQuery {
    pub signer_id: String,
}

/// GET /api/treasury/accounts/{address}/scheduled/{hash}/veto-operation?signerId= - a
/// veto as a user operation for a passkey signer to sign.
pub async fn veto_operation(
    pool: web::Data<PgPool>,
    service: web::Data<Treasury>,
    req: HttpRequest,
    path: web::Path<(String, String)>,
    query: web::Query<VetoOperationQuery>,
) -> HttpResponse {
    let user = who!(pool, req);
    let (address, hash) = path.into_inner();
    reply(treasury::veto_operation(pool.get_ref(), service.get_ref(), user, &address, &hash, &query.signer_id).await)
}

/// POST /api/treasury/accounts/{address}/limits/{id}/spend - how the caller's signer
/// pays from a limit: a call for a wallet, or an operation for a passkey.
pub async fn spend_plan(
    pool: web::Data<PgPool>,
    service: web::Data<Treasury>,
    req: HttpRequest,
    path: web::Path<(String, i64)>,
    body: web::Json<treasury::SpendBody>,
) -> HttpResponse {
    let user = who!(pool, req);
    let (address, id) = path.into_inner();
    reply(treasury::spend_plan(pool.get_ref(), service.get_ref(), user, &address, id, body.into_inner()).await)
}

/// POST /api/treasury/accounts/{address}/operations - the signed operation, sent by the relayer.
pub async fn submit_operation(
    pool: web::Data<PgPool>,
    service: web::Data<Treasury>,
    req: HttpRequest,
    path: web::Path<String>,
    body: web::Json<treasury::SubmitOperationBody>,
) -> HttpResponse {
    let user = who!(pool, req);
    reply(treasury::submit_operation(pool.get_ref(), service.get_ref(), user, &path, body.into_inner()).await)
}

pub async fn execute_scheduled(
    pool: web::Data<PgPool>,
    service: web::Data<Treasury>,
    req: HttpRequest,
    path: web::Path<(String, String)>,
) -> HttpResponse {
    let user = who!(pool, req);
    let (address, hash) = path.into_inner();
    reply(treasury::execute_scheduled(pool.get_ref(), service.get_ref(), user, &address, &hash).await)
}

#[derive(Debug, Deserialize)]
pub struct LedgerQuery {
    pub limit: Option<i64>,
    pub before: Option<i64>,
}

pub async fn ledger(pool: web::Data<PgPool>, req: HttpRequest, path: web::Path<String>, query: web::Query<LedgerQuery>) -> HttpResponse {
    let user = who_on!(pool, req, Need::Read, &path).user;
    reply(treasury::ledger(pool.get_ref(), user, &path, query.limit.unwrap_or(100), query.before).await)
}

pub async fn address_book(pool: web::Data<PgPool>, req: HttpRequest, path: web::Path<String>) -> HttpResponse {
    let user = who_on!(pool, req, Need::Read, &path).user;
    reply(treasury::address_book(pool.get_ref(), user, &path).await)
}

pub async fn add_address(
    pool: web::Data<PgPool>,
    service: web::Data<Treasury>,
    req: HttpRequest,
    path: web::Path<String>,
    body: web::Json<treasury::AddressBookBody>,
) -> HttpResponse {
    let user = who!(pool, req);
    reply(treasury::add_address(pool.get_ref(), service.get_ref(), user, &path, body.into_inner()).await)
}

pub async fn remove_address(pool: web::Data<PgPool>, req: HttpRequest, path: web::Path<(String, String)>) -> HttpResponse {
    let user = who!(pool, req);
    let (address, entry) = path.into_inner();
    match treasury::remove_address(pool.get_ref(), user, &address, &entry).await {
        Ok(()) => HttpResponse::NoContent().finish(),
        Err(error) => failed(error),
    }
}

pub async fn get_policy(pool: web::Data<PgPool>, req: HttpRequest, path: web::Path<String>) -> HttpResponse {
    let user = who_on!(pool, req, Need::Read, &path).user;
    reply(treasury::get_policy(pool.get_ref(), user, &path).await)
}

/// PUT /api/treasury/accounts/{address}/policy - applied at once if it only tightens,
/// otherwise left waiting the account's config delay.
pub async fn set_policy(pool: web::Data<PgPool>, req: HttpRequest, path: web::Path<String>, body: web::Json<Policy>) -> HttpResponse {
    let user = who!(pool, req);
    reply(treasury::set_policy(pool.get_ref(), user, &path, body.into_inner()).await)
}

pub async fn cancel_policy_change(pool: web::Data<PgPool>, req: HttpRequest, path: web::Path<String>) -> HttpResponse {
    let user = who!(pool, req);
    reply(treasury::cancel_policy_change(pool.get_ref(), user, &path).await)
}

#[derive(Debug, Deserialize)]
pub struct AuditQuery {
    pub before: Option<i64>,
    pub limit: Option<i64>,
    pub format: Option<String>,
}

/// GET /api/treasury/accounts/{address}/audit - who did what, newest first, as JSON or
/// with ?format=csv as a file. A read key may fetch it: this is what an auditor's
/// tooling is for.
pub async fn audit_trail(pool: web::Data<PgPool>, req: HttpRequest, path: web::Path<String>, query: web::Query<AuditQuery>) -> HttpResponse {
    let user = who_on!(pool, req, Need::Read, &path).user;
    match audit::page(pool.get_ref(), user, &path, query.before, query.limit.unwrap_or(200)).await {
        Ok(page) if query.format.as_deref() == Some("csv") => HttpResponse::Ok()
            .content_type("text/csv; charset=utf-8")
            .insert_header(("x-olien-audit-intact", page.intact.to_string()))
            .body(audit::csv(&page)),
        Ok(page) => HttpResponse::Ok().json(page),
        Err(error) => failed(error),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewKeyBody {
    pub name: String,
    pub scope: String,
    /// Ninety when absent; at most a year.
    pub expires_in_days: Option<u32>,
}

pub async fn list_keys(pool: web::Data<PgPool>, req: HttpRequest, path: web::Path<String>) -> HttpResponse {
    let user = who!(pool, req);
    reply(treasury_keys::list_keys(pool.get_ref(), user, &path).await)
}

/// POST /api/treasury/accounts/{address}/api-keys - the only response that carries the key.
pub async fn mint_key(pool: web::Data<PgPool>, req: HttpRequest, path: web::Path<String>, body: web::Json<NewKeyBody>) -> HttpResponse {
    let user = who!(pool, req);
    reply(treasury_keys::mint_key(pool.get_ref(), user, &path, &body.name, &body.scope, body.expires_in_days).await)
}

pub async fn revoke_key(pool: web::Data<PgPool>, req: HttpRequest, path: web::Path<(String, i64)>) -> HttpResponse {
    let user = who!(pool, req);
    let (address, id) = path.into_inner();
    match treasury_keys::revoke_key(pool.get_ref(), user, &address, id).await {
        Ok(()) => HttpResponse::NoContent().finish(),
        Err(error) => failed(error),
    }
}

pub async fn list_payrolls(pool: web::Data<PgPool>, req: HttpRequest, path: web::Path<String>) -> HttpResponse {
    let user = who_on!(pool, req, Need::Read, &path).user;
    reply(payroll::list(pool.get_ref(), user, &path).await)
}

pub async fn create_payroll(pool: web::Data<PgPool>, service: web::Data<Treasury>, req: HttpRequest, path: web::Path<String>, body: web::Json<PayrollBody>) -> HttpResponse {
    let user = who!(pool, req);
    reply(payroll::create(pool.get_ref(), service.get_ref(), user, &path, body.into_inner()).await)
}

pub async fn update_payroll(
    pool: web::Data<PgPool>,
    service: web::Data<Treasury>,
    req: HttpRequest,
    path: web::Path<(String, i64)>,
    body: web::Json<PayrollBody>,
) -> HttpResponse {
    let user = who!(pool, req);
    let (address, id) = path.into_inner();
    reply(payroll::update(pool.get_ref(), service.get_ref(), user, &address, id, body.into_inner()).await)
}

pub async fn delete_payroll(pool: web::Data<PgPool>, req: HttpRequest, path: web::Path<(String, i64)>) -> HttpResponse {
    let user = who!(pool, req);
    let (address, id) = path.into_inner();
    match payroll::delete(pool.get_ref(), user, &address, id).await {
        Ok(()) => HttpResponse::NoContent().finish(),
        Err(error) => failed(error),
    }
}

/// POST /api/treasury/accounts/{address}/payrolls/{id}/run - open the run's proposal now.
/// A propose key may do this: it is the same thing as posting the batch itself.
pub async fn run_payroll(pool: web::Data<PgPool>, service: web::Data<Treasury>, req: HttpRequest, path: web::Path<(String, i64)>) -> HttpResponse {
    let caller = who_on!(pool, req, Need::Propose, &path.0);
    let (address, id) = path.into_inner();
    reply(payroll::run(pool.get_ref(), service.get_ref(), caller.user, &address, id, caller.key).await)
}

pub async fn list_webhooks(pool: web::Data<PgPool>, req: HttpRequest, path: web::Path<String>) -> HttpResponse {
    let user = who!(pool, req);
    reply(webhooks::list(pool.get_ref(), user, &path).await)
}

/// POST /api/treasury/accounts/{address}/webhooks - the only response that carries the secret.
pub async fn create_webhook(pool: web::Data<PgPool>, req: HttpRequest, path: web::Path<String>, body: web::Json<WebhookBody>) -> HttpResponse {
    let user = who!(pool, req);
    reply(webhooks::create(pool.get_ref(), user, &path, body.into_inner()).await)
}

pub async fn delete_webhook(pool: web::Data<PgPool>, req: HttpRequest, path: web::Path<(String, i64)>) -> HttpResponse {
    let user = who!(pool, req);
    let (address, id) = path.into_inner();
    match webhooks::delete(pool.get_ref(), user, &address, id).await {
        Ok(()) => HttpResponse::NoContent().finish(),
        Err(error) => failed(error),
    }
}

pub async fn enable_webhook(pool: web::Data<PgPool>, req: HttpRequest, path: web::Path<(String, i64)>) -> HttpResponse {
    let user = who!(pool, req);
    let (address, id) = path.into_inner();
    reply(webhooks::enable(pool.get_ref(), user, &address, id).await)
}

pub async fn test_webhook(pool: web::Data<PgPool>, req: HttpRequest, path: web::Path<(String, i64)>) -> HttpResponse {
    let user = who!(pool, req);
    let (address, id) = path.into_inner();
    reply(webhooks::test(pool.get_ref(), user, &address, id).await)
}

pub async fn webhook_deliveries(pool: web::Data<PgPool>, req: HttpRequest, path: web::Path<(String, i64)>) -> HttpResponse {
    let user = who!(pool, req);
    let (address, id) = path.into_inner();
    reply(webhooks::deliveries(pool.get_ref(), user, &address, id).await)
}

pub async fn list_cheques(pool: web::Data<PgPool>, service: web::Data<Treasury>, req: HttpRequest, path: web::Path<String>) -> HttpResponse {
    let user = who_on!(pool, req, Need::Read, &path).user;
    reply(treasury_cheques::list(pool.get_ref(), service.get_ref(), user, &path).await)
}

pub async fn write_cheque(pool: web::Data<PgPool>, service: web::Data<Treasury>, req: HttpRequest, path: web::Path<String>, body: web::Json<NewChequeBody>) -> HttpResponse {
    let user = who_on!(pool, req, Need::Propose, &path).user;
    reply(treasury_cheques::write(pool.get_ref(), service.get_ref(), user, &path, body.into_inner()).await)
}

pub async fn get_cheque(pool: web::Data<PgPool>, service: web::Data<Treasury>, req: HttpRequest, path: web::Path<(String, i64)>) -> HttpResponse {
    let user = who_on!(pool, req, Need::Read, &path.0).user;
    let (address, id) = path.into_inner();
    reply(treasury_cheques::get(pool.get_ref(), service.get_ref(), user, &address, id).await)
}

pub async fn sign_cheque(
    pool: web::Data<PgPool>,
    service: web::Data<Treasury>,
    req: HttpRequest,
    path: web::Path<(String, i64)>,
    body: web::Json<ChequeSignatureBody>,
) -> HttpResponse {
    let user = who!(pool, req);
    let (address, id) = path.into_inner();
    reply(treasury_cheques::sign(pool.get_ref(), service.get_ref(), user, &address, id, body.into_inner()).await)
}

pub async fn void_cheque(pool: web::Data<PgPool>, service: web::Data<Treasury>, req: HttpRequest, path: web::Path<(String, i64)>) -> HttpResponse {
    let user = who!(pool, req);
    let (address, id) = path.into_inner();
    match treasury_cheques::void(pool.get_ref(), service.get_ref(), user, &address, id).await {
        Ok(view) => HttpResponse::Ok().json(view),
        Err(TreasuryError::NotFound(message)) if message.starts_with("the draft") => HttpResponse::NoContent().finish(),
        Err(error) => failed(error),
    }
}

#[derive(Deserialize)]
pub struct IssuedQuery {
    to: String,
}

/// Cheques written to one recipient, for whatever app holds that recipient's inbox.
///
/// Unauthenticated, because a cheque is an authorization to pay this address and
/// nobody else: reading one grants no power over it. This replaced the treasury
/// writing rows into the consumer app's own table.
pub async fn issued_cheques(pool: web::Data<PgPool>, query: web::Query<IssuedQuery>) -> HttpResponse {
    reply(treasury_cheques::issued_to(pool.get_ref(), &query.to).await)
}

/// The route table, mounted under /api/treasury.
pub fn routes(scope: actix_web::Scope) -> actix_web::Scope {
    scope
        .route("/chain", web::get().to(chain))
        .route("/cheques/issued", web::get().to(issued_cheques))
        .route("/linked-addresses", web::get().to(linked_addresses))
        .route("/link-address", web::post().to(link_address))
        .route("/accounts", web::get().to(list_accounts))
        .route("/accounts", web::post().to(create_account))
        // Before /accounts/{address}: a path is matched to the first pattern that fits.
        .route("/accounts/import", web::post().to(import_account))
        .route("/accounts/{address}", web::get().to(get_account))
        .route("/accounts/{address}/name", web::put().to(rename_account))
        .route("/accounts/{address}/sub-accounts", web::post().to(create_sub_account))
        .route("/accounts/{address}/proposals", web::get().to(list_proposals))
        .route("/accounts/{address}/proposals", web::post().to(create_proposal))
        .route("/accounts/{address}/proposals/transfer", web::post().to(propose_transfer))
        .route("/accounts/{address}/proposals/signers", web::post().to(propose_signers))
        .route("/accounts/{address}/proposals/limit", web::post().to(propose_limit))
        .route("/accounts/{address}/proposals/remove-limit", web::post().to(propose_remove_limit))
        .route("/accounts/{address}/proposals/{hash}", web::get().to(get_proposal))
        .route("/accounts/{address}/proposals/{hash}", web::delete().to(delete_proposal))
        .route("/accounts/{address}/proposals/{hash}/confirmations", web::post().to(confirm))
        .route("/accounts/{address}/proposals/{hash}/execute", web::post().to(execute))
        .route("/accounts/{address}/proposals/{hash}/cancel", web::post().to(cancel))
        .route("/accounts/{address}/scheduled", web::get().to(list_scheduled))
        .route("/accounts/{address}/scheduled/{hash}/veto-call", web::get().to(veto_call))
        .route("/accounts/{address}/scheduled/{hash}/execute", web::post().to(execute_scheduled))
        .route("/accounts/{address}/scheduled/{hash}/veto-operation", web::get().to(veto_operation))
        .route("/accounts/{address}/operations", web::post().to(submit_operation))
        .route("/accounts/{address}/limits/{id}/spend", web::post().to(spend_plan))
        .route("/accounts/{address}/ledger", web::get().to(ledger))
        .route("/accounts/{address}/address-book", web::get().to(address_book))
        .route("/accounts/{address}/address-book", web::post().to(add_address))
        .route("/accounts/{address}/address-book/{entry}", web::delete().to(remove_address))
        .route("/accounts/{address}/policy", web::get().to(get_policy))
        .route("/accounts/{address}/policy", web::put().to(set_policy))
        .route("/accounts/{address}/policy/pending", web::delete().to(cancel_policy_change))
        .route("/accounts/{address}/audit", web::get().to(audit_trail))
        .route("/accounts/{address}/api-keys", web::get().to(list_keys))
        .route("/accounts/{address}/api-keys", web::post().to(mint_key))
        .route("/accounts/{address}/api-keys/{id}", web::delete().to(revoke_key))
        .route("/accounts/{address}/payrolls", web::get().to(list_payrolls))
        .route("/accounts/{address}/payrolls", web::post().to(create_payroll))
        .route("/accounts/{address}/payrolls/{id}", web::put().to(update_payroll))
        .route("/accounts/{address}/payrolls/{id}", web::delete().to(delete_payroll))
        .route("/accounts/{address}/payrolls/{id}/run", web::post().to(run_payroll))
        .route("/accounts/{address}/cheques", web::get().to(list_cheques))
        .route("/accounts/{address}/cheques", web::post().to(write_cheque))
        .route("/accounts/{address}/cheques/{id}", web::get().to(get_cheque))
        .route("/accounts/{address}/cheques/{id}/signatures", web::post().to(sign_cheque))
        .route("/accounts/{address}/cheques/{id}/void", web::post().to(void_cheque))
        .route("/accounts/{address}/webhooks", web::get().to(list_webhooks))
        .route("/accounts/{address}/webhooks", web::post().to(create_webhook))
        .route("/accounts/{address}/webhooks/{id}", web::delete().to(delete_webhook))
        .route("/accounts/{address}/webhooks/{id}/enable", web::post().to(enable_webhook))
        .route("/accounts/{address}/webhooks/{id}/test", web::post().to(test_webhook))
        .route("/accounts/{address}/webhooks/{id}/deliveries", web::get().to(webhook_deliveries))
}
