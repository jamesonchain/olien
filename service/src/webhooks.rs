// Webhooks (docs/treasury/11-service-api.md, "Webhooks"): a treasury tells an outside
// system when money moved or a proposal changed. The other half of API keys.
//
// Nothing is sent from inside a request. Each hook keeps a cursor into the ledger and
// into proposal updates; the indexer's cycle turns whatever is past the cursor into
// delivery rows, then works through the due ones with retries. Every delivery is
// signed with the hook's secret so the receiver can tell it came from here.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use chrono::{DateTime, Duration, Utc};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use std::time::Duration as StdDuration;
use tracing::{info, warn};

use crate::treasury::{self, bad, context_for, load_account_by_id, Res, Treasury, TreasuryError};

const MAX_ATTEMPTS: i32 = 8;
/// Past this many deliveries in a row that never got through, the hook is switched off
/// rather than hammered forever; the console shows why.
const MAX_FAILURES: i32 = 20;
const PER_CYCLE: i64 = 25;
const TIMEOUT: StdDuration = StdDuration::from_secs(10);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Topic {
    Ledger,
    Proposals,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebhookBody {
    pub url: String,
    pub events: Vec<Topic>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebhookView {
    pub id: i64,
    pub url: String,
    pub events: Vec<Topic>,
    pub disabled_reason: Option<String>,
    pub last_delivery_at: Option<i64>,
    pub last_status: Option<i32>,
    pub pending: i64,
    pub created_at: i64,
}

/// The one response that carries the secret.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedWebhook {
    pub secret: String,
    #[serde(flatten)]
    pub view: WebhookView,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryView {
    pub id: i64,
    pub event: String,
    pub attempts: i32,
    pub delivered_at: Option<i64>,
    pub abandoned_at: Option<i64>,
    pub last_status: Option<i32>,
    pub last_error: Option<String>,
    pub created_at: i64,
}

#[derive(sqlx::FromRow)]
struct HookRow {
    id: i64,
    url: String,
    events: Value,
    disabled_reason: Option<String>,
    last_delivery_at: Option<DateTime<Utc>>,
    last_status: Option<i32>,
    created_at: DateTime<Utc>,
}

// ---------------------------------------------------------------------------
// Signing. HMAC-SHA256 by hand over sha2, the textbook construction, held to the RFC
// 4231 vector by a test. The header is `t=<unix>,v1=<hex>` over `"<t>.<body>"`, the
// shape receivers already know how to check, with the timestamp inside the signed
// text so a captured delivery cannot be replayed later as if new.

pub fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; 32] {
    const BLOCK: usize = 64;
    let mut k = [0u8; BLOCK];
    if key.len() > BLOCK {
        k[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        k[..key.len()].copy_from_slice(key);
    }
    let mut inner = Sha256::new();
    inner.update(k.iter().map(|b| b ^ 0x36).collect::<Vec<u8>>());
    inner.update(message);
    let inner = inner.finalize();
    let mut outer = Sha256::new();
    outer.update(k.iter().map(|b| b ^ 0x5c).collect::<Vec<u8>>());
    outer.update(inner);
    outer.finalize().into()
}

pub fn signature_header(secret: &str, timestamp: i64, body: &str) -> String {
    let signed = format!("{timestamp}.{body}");
    format!("t={timestamp},v1={}", alloy::hex::encode(hmac_sha256(secret.as_bytes(), signed.as_bytes())))
}

fn new_secret() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    format!("whsec_{}", URL_SAFE_NO_PAD.encode(bytes))
}

fn topics_of(value: &Value) -> Vec<Topic> {
    serde_json::from_value(value.clone()).unwrap_or_default()
}

/// Only https, and only a host, so a hook cannot be pointed at the service itself or
/// at something on the same network.
fn checked_url(url: &str) -> Res<String> {
    let url = url.trim();
    let parsed = reqwest::Url::parse(url).map_err(|_| bad("the URL does not parse"))?;
    if parsed.scheme() != "https" {
        return Err(bad("a webhook URL must be https"));
    }
    let host = parsed.host_str().unwrap_or("");
    if host.is_empty() || host == "localhost" || host.ends_with(".local") || host.parse::<std::net::IpAddr>().is_ok() {
        return Err(bad("a webhook URL needs a public host name"));
    }
    Ok(url.to_string())
}

async fn view_of(pool: &PgPool, row: HookRow) -> Res<WebhookView> {
    let (pending,): (i64,) =
        sqlx::query_as("SELECT count(*) FROM olien_webhook_deliveries WHERE webhook_id = $1 AND delivered_at IS NULL AND abandoned_at IS NULL")
            .bind(row.id)
            .fetch_one(pool)
            .await?;
    Ok(WebhookView {
        id: row.id,
        url: row.url,
        events: topics_of(&row.events),
        disabled_reason: row.disabled_reason,
        last_delivery_at: row.last_delivery_at.map(|t| t.timestamp()),
        last_status: row.last_status,
        pending,
        created_at: row.created_at.timestamp(),
    })
}

const SELECT: &str = "SELECT id, url, events, disabled_reason, last_delivery_at, last_status, created_at FROM olien_webhooks";

pub async fn list(pool: &PgPool, user: i64, address: &str) -> Res<Vec<WebhookView>> {
    let ctx = context_for(pool, user, address).await?;
    let rows: Vec<HookRow> = sqlx::query_as(&format!("{SELECT} WHERE olien_id = $1 ORDER BY created_at")).bind(ctx.row.id).fetch_all(pool).await?;
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        out.push(view_of(pool, row).await?);
    }
    Ok(out)
}

pub async fn create(pool: &PgPool, user: i64, address: &str, body: WebhookBody) -> Res<CreatedWebhook> {
    let ctx = context_for(pool, user, address).await?;
    let url = checked_url(&body.url)?;
    if body.events.is_empty() {
        return Err(bad("pick at least one event"));
    }
    let secret = new_secret();
    // Start from now: a new hook hears what happens next, not the whole history.
    let (ledger_cursor,): (Option<i64>,) = sqlx::query_as("SELECT max(id) FROM olien_ledger WHERE olien_id = $1").bind(ctx.row.id).fetch_one(pool).await?;
    let row: HookRow = sqlx::query_as(&format!(
        "INSERT INTO olien_webhooks (olien_id, url, secret, events, ledger_cursor, created_by) VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, url, events, disabled_reason, last_delivery_at, last_status, created_at"
    ))
    .bind(ctx.row.id)
    .bind(&url)
    .bind(&secret)
    .bind(serde_json::to_value(&body.events).unwrap_or(Value::Null))
    .bind(ledger_cursor.unwrap_or(0))
    .bind(user)
    .fetch_one(pool)
    .await?;
    crate::audit::record(pool, ctx.row.id, &ctx.row.address, Some(user), None, "webhook.created", Some(&row.id.to_string()), serde_json::json!({ "url": url })).await;
    Ok(CreatedWebhook { secret, view: view_of(pool, row).await? })
}

pub async fn delete(pool: &PgPool, user: i64, address: &str, id: i64) -> Res<()> {
    let ctx = context_for(pool, user, address).await?;
    let done = sqlx::query("DELETE FROM olien_webhooks WHERE id = $1 AND olien_id = $2").bind(id).bind(ctx.row.id).execute(pool).await?;
    if done.rows_affected() == 0 {
        return Err(TreasuryError::NotFound("no such webhook".into()));
    }
    crate::audit::record(pool, ctx.row.id, &ctx.row.address, Some(user), None, "webhook.deleted", Some(&id.to_string()), serde_json::json!({})).await;
    Ok(())
}

/// Switch a stopped hook back on and clear its failure count.
pub async fn enable(pool: &PgPool, user: i64, address: &str, id: i64) -> Res<WebhookView> {
    let ctx = context_for(pool, user, address).await?;
    let row: Option<HookRow> = sqlx::query_as(&format!(
        "UPDATE olien_webhooks SET disabled_at = NULL, disabled_reason = NULL, failures = 0 WHERE id = $1 AND olien_id = $2
         RETURNING id, url, events, disabled_reason, last_delivery_at, last_status, created_at"
    ))
    .bind(id)
    .bind(ctx.row.id)
    .fetch_optional(pool)
    .await?;
    view_of(pool, row.ok_or_else(|| TreasuryError::NotFound("no such webhook".into()))?).await
}

/// A ping, so the receiver can be checked before anything real happens.
pub async fn test(pool: &PgPool, user: i64, address: &str, id: i64) -> Res<DeliveryView> {
    let ctx = context_for(pool, user, address).await?;
    let exists: Option<(i64,)> = sqlx::query_as("SELECT id FROM olien_webhooks WHERE id = $1 AND olien_id = $2").bind(id).bind(ctx.row.id).fetch_optional(pool).await?;
    if exists.is_none() {
        return Err(TreasuryError::NotFound("no such webhook".into()));
    }
    let delivery_id = enqueue(pool, id, "ping", &ctx.row.address, json!({ "message": "Hello from Olien" })).await?;
    Ok(DeliveryView {
        id: delivery_id,
        event: "ping".into(),
        attempts: 0,
        delivered_at: None,
        abandoned_at: None,
        last_status: None,
        last_error: None,
        created_at: Utc::now().timestamp(),
    })
}

pub async fn deliveries(pool: &PgPool, user: i64, address: &str, id: i64) -> Res<Vec<DeliveryView>> {
    let ctx = context_for(pool, user, address).await?;
    #[derive(sqlx::FromRow)]
    struct Row {
        id: i64,
        event: String,
        attempts: i32,
        delivered_at: Option<DateTime<Utc>>,
        abandoned_at: Option<DateTime<Utc>>,
        last_status: Option<i32>,
        last_error: Option<String>,
        created_at: DateTime<Utc>,
    }
    let rows: Vec<Row> = sqlx::query_as(
        "SELECT d.id, d.event, d.attempts, d.delivered_at, d.abandoned_at, d.last_status, d.last_error, d.created_at
         FROM olien_webhook_deliveries d JOIN olien_webhooks w ON w.id = d.webhook_id
         WHERE d.webhook_id = $1 AND w.olien_id = $2 ORDER BY d.id DESC LIMIT 50",
    )
    .bind(id)
    .bind(ctx.row.id)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| DeliveryView {
            id: r.id,
            event: r.event,
            attempts: r.attempts,
            delivered_at: r.delivered_at.map(|t| t.timestamp()),
            abandoned_at: r.abandoned_at.map(|t| t.timestamp()),
            last_status: r.last_status,
            last_error: r.last_error,
            created_at: r.created_at.timestamp(),
        })
        .collect())
}

async fn enqueue(pool: &PgPool, webhook_id: i64, event: &str, account: &str, data: Value) -> Res<i64> {
    let (id,): (i64,) = sqlx::query_as(
        "INSERT INTO olien_webhook_deliveries (webhook_id, event, payload) VALUES ($1, $2, $3) RETURNING id",
    )
    .bind(webhook_id)
    .bind(event)
    .bind(json!({ "event": event, "account": account, "data": data }))
    .fetch_one(pool)
    .await?;
    Ok(id)
}

// ---------------------------------------------------------------------------
// The cycle: collect, then send.

/// Called from the indexer's cycle after it has written what the chain said.
pub async fn dispatch(pool: &PgPool, treasury: &Treasury, http: &reqwest::Client) -> anyhow::Result<()> {
    collect(pool, treasury).await?;
    send_due(pool, http).await
}

#[derive(sqlx::FromRow)]
struct Live {
    id: i64,
    olien_id: i64,
    events: Value,
    ledger_cursor: i64,
    proposal_cursor: DateTime<Utc>,
    created_by: Option<i64>,
}

/// New ledger rows and proposal updates past each hook's cursors become deliveries.
async fn collect(pool: &PgPool, treasury: &Treasury) -> anyhow::Result<()> {
    let hooks: Vec<Live> = sqlx::query_as(
        "SELECT id, olien_id, events, ledger_cursor, proposal_cursor, created_by FROM olien_webhooks WHERE disabled_at IS NULL",
    )
    .fetch_all(pool)
    .await?;
    for hook in hooks {
        let topics = topics_of(&hook.events);
        let account = match load_account_by_id(pool, hook.olien_id).await {
            Ok(row) => row,
            Err(e) => {
                warn!("webhook {}: {}", hook.id, e.parts().1);
                continue;
            }
        };
        if topics.contains(&Topic::Ledger) {
            let entries = treasury::ledger_entries(pool, hook.olien_id, None, Some(hook.ledger_cursor), PER_CYCLE)
                .await
                .map_err(|e| anyhow::anyhow!("{}", e.parts().1))?;
            let mut newest = hook.ledger_cursor;
            // Oldest first, so a receiver sees them in the order they happened.
            for entry in entries.into_iter().rev() {
                newest = newest.max(entry.id);
                enqueue(pool, hook.id, "ledger.entry", &account.address, serde_json::to_value(&entry)?).await.map_err(|e| anyhow::anyhow!("{}", e.parts().1))?;
            }
            if newest != hook.ledger_cursor {
                sqlx::query("UPDATE olien_webhooks SET ledger_cursor = $2 WHERE id = $1").bind(hook.id).bind(newest).execute(pool).await?;
            }
        }
        if topics.contains(&Topic::Proposals) {
            let updated: Vec<(String, DateTime<Utc>)> = sqlx::query_as(
                "SELECT tx_hash, updated_at FROM olien_proposals WHERE olien_id = $1 AND updated_at > $2 ORDER BY updated_at LIMIT $3",
            )
            .bind(hook.olien_id)
            .bind(hook.proposal_cursor)
            .bind(PER_CYCLE)
            .fetch_all(pool)
            .await?;
            let mut newest = hook.proposal_cursor;
            for (tx_hash, at) in updated {
                newest = newest.max(at);
                // Seen as the member who made the hook, the same as an API key would.
                let Some(user) = hook.created_by else { continue };
                match treasury::proposal_view(pool, treasury.chain_id, user, &account, &tx_hash).await {
                    Ok(view) => {
                        enqueue(pool, hook.id, &format!("proposal.{}", view.status), &account.address, serde_json::to_value(&view)?)
                            .await
                            .map_err(|e| anyhow::anyhow!("{}", e.parts().1))?;
                    }
                    Err(e) => warn!("webhook {}: proposal {tx_hash}: {}", hook.id, e.parts().1),
                }
            }
            if newest != hook.proposal_cursor {
                sqlx::query("UPDATE olien_webhooks SET proposal_cursor = $2 WHERE id = $1").bind(hook.id).bind(newest).execute(pool).await?;
            }
        }
    }
    Ok(())
}

#[derive(sqlx::FromRow)]
struct Due {
    id: i64,
    webhook_id: i64,
    event: String,
    payload: Value,
    attempts: i32,
    url: String,
    secret: String,
}

/// Retries wait 30 seconds, then a minute, two, four... about an hour by the last.
fn backoff(attempts: i32) -> Duration {
    Duration::seconds(30 * (1i64 << attempts.clamp(0, 7)))
}

async fn send_due(pool: &PgPool, http: &reqwest::Client) -> anyhow::Result<()> {
    let due: Vec<Due> = sqlx::query_as(
        "SELECT d.id, d.webhook_id, d.event, d.payload, d.attempts, w.url, w.secret
         FROM olien_webhook_deliveries d JOIN olien_webhooks w ON w.id = d.webhook_id
         WHERE d.delivered_at IS NULL AND d.abandoned_at IS NULL AND d.next_attempt_at <= now() AND w.disabled_at IS NULL
         ORDER BY d.id LIMIT $1",
    )
    .bind(PER_CYCLE)
    .fetch_all(pool)
    .await?;
    for item in due {
        let timestamp = Utc::now().timestamp();
        let mut payload = item.payload.clone();
        if let Some(map) = payload.as_object_mut() {
            map.insert("id".into(), json!(item.id));
            map.insert("createdAt".into(), json!(timestamp));
        }
        let body = serde_json::to_string(&payload)?;
        let outcome = http
            .post(&item.url)
            .header("content-type", "application/json")
            .header("user-agent", "Olien-Webhooks/1")
            .header("x-olien-event", &item.event)
            .header("x-olien-delivery", item.id.to_string())
            .header("x-olien-signature", signature_header(&item.secret, timestamp, &body))
            .timeout(TIMEOUT)
            .body(body)
            .send()
            .await;
        let attempts = item.attempts + 1;
        match outcome {
            Ok(response) if response.status().is_success() => {
                let status = response.status().as_u16() as i32;
                sqlx::query("UPDATE olien_webhook_deliveries SET delivered_at = now(), attempts = $2, last_status = $3, last_error = NULL WHERE id = $1")
                    .bind(item.id)
                    .bind(attempts)
                    .bind(status)
                    .execute(pool)
                    .await?;
                sqlx::query("UPDATE olien_webhooks SET failures = 0, last_delivery_at = now(), last_status = $2 WHERE id = $1")
                    .bind(item.webhook_id)
                    .bind(status)
                    .execute(pool)
                    .await?;
            }
            other => {
                let (status, error) = match other {
                    Ok(response) => (Some(response.status().as_u16() as i32), format!("the receiver answered {}", response.status())),
                    Err(e) => (None, format!("{e}")),
                };
                let abandoned = attempts >= MAX_ATTEMPTS;
                sqlx::query(
                    "UPDATE olien_webhook_deliveries SET attempts = $2, last_status = $3, last_error = $4, next_attempt_at = $5,
                        abandoned_at = CASE WHEN $6 THEN now() ELSE NULL END WHERE id = $1",
                )
                .bind(item.id)
                .bind(attempts)
                .bind(status)
                .bind(&error)
                .bind(Utc::now() + backoff(attempts))
                .bind(abandoned)
                .execute(pool)
                .await?;
                let (failures,): (i32,) = sqlx::query_as(
                    "UPDATE olien_webhooks SET failures = failures + 1, last_delivery_at = now(), last_status = $2 WHERE id = $1 RETURNING failures",
                )
                .bind(item.webhook_id)
                .bind(status)
                .fetch_one(pool)
                .await?;
                warn!("webhook {} delivery {} attempt {attempts}: {error}", item.webhook_id, item.id);
                if failures >= MAX_FAILURES {
                    sqlx::query("UPDATE olien_webhooks SET disabled_at = now(), disabled_reason = $2 WHERE id = $1 AND disabled_at IS NULL")
                        .bind(item.webhook_id)
                        .bind(format!("Switched off after {failures} deliveries in a row did not get through. Last answer: {error}"))
                        .execute(pool)
                        .await?;
                    info!("webhook {} switched off after {failures} failures", item.webhook_id);
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// RFC 4231, test case 2.
    #[test]
    fn hmac_matches_the_rfc_vector() {
        let mac = hmac_sha256(b"Jefe", b"what do ya want for nothing?");
        assert_eq!(alloy::hex::encode(mac), "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
    }

    #[test]
    fn a_long_key_is_hashed_first_as_the_rfc_says() {
        // RFC 4231, test case 6: a 131-byte key.
        let key = [0xaau8; 131];
        let mac = hmac_sha256(&key, b"Test Using Larger Than Block-Size Key - Hash Key First");
        assert_eq!(alloy::hex::encode(mac), "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54");
    }

    #[test]
    fn the_header_binds_the_timestamp_to_the_body() {
        let a = signature_header("whsec_x", 1_700_000_000, "{}");
        let b = signature_header("whsec_x", 1_700_000_001, "{}");
        assert!(a.starts_with("t=1700000000,v1="));
        assert_ne!(a.split(",v1=").nth(1), b.split(",v1=").nth(1), "a replay a second later signs differently");
    }

    #[test]
    fn only_public_https_hosts_are_accepted() {
        assert!(checked_url("https://hooks.example.com/olien").is_ok());
        assert!(checked_url("http://hooks.example.com/olien").is_err());
        assert!(checked_url("https://localhost/x").is_err());
        assert!(checked_url("https://10.0.0.1/x").is_err());
        assert!(checked_url("https://backend.local/x").is_err());
        assert!(checked_url("not a url").is_err());
    }

    #[test]
    fn retries_back_off_to_about_an_hour() {
        assert_eq!(backoff(1).num_seconds(), 60);
        assert_eq!(backoff(3).num_seconds(), 240);
        assert_eq!(backoff(7).num_seconds(), 3840);
        assert_eq!(backoff(40).num_seconds(), 3840, "and no further");
    }

    #[test]
    fn a_new_secret_is_recognisable_and_fresh() {
        let s = new_secret();
        assert!(s.starts_with("whsec_"));
        assert_eq!(s.len(), 6 + 43);
        assert_ne!(new_secret(), s);
    }
}
