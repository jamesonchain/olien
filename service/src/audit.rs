// Who did what to a treasury, in order, in a form that shows when it has been altered.
//
// The proposals and their confirmations say what happened to the money. They do not
// say who renamed the account, minted a key, loosened the policy or took an address
// out of the book, and an auditor asks for exactly that list before anything else.
// Every such act is a row here.
//
// Each row carries the hash of the row before it and of itself, per account, so the
// list is a chain: a row changed or removed later breaks every hash after it. That
// does not stop whoever runs the database from rewriting the whole chain, and nothing
// kept in a database can. It does mean an export taken today can be held against an
// export taken next month, and a difference is evidence.

use alloy::primitives::{keccak256, B256};
use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::{json, Value};
use sqlx::PgPool;

use crate::treasury::{context_for, Res};

fn hex(bytes: &[u8]) -> String {
    format!("0x{}", alloy::hex::encode(bytes))
}

/// The text a row's hash covers. serde_json keeps object keys sorted, so the same row
/// is the same text on any machine that recomputes it.
pub fn canonical(olien: &str, at: i64, actor: Option<i64>, key: Option<i64>, action: &str, subject: Option<&str>, detail: &Value) -> String {
    json!({ "account": olien, "at": at, "actor": actor, "key": key, "action": action, "subject": subject, "detail": detail }).to_string()
}

pub fn entry_hash(previous: B256, canonical: &str) -> B256 {
    let mut bytes = previous.to_vec();
    bytes.extend_from_slice(canonical.as_bytes());
    keccak256(bytes)
}

/// Writes one row. An act is recorded after it has happened, so a failure here must
/// not undo it or hide it: it is logged loudly and the act stands.
pub async fn record(pool: &PgPool, olien_id: i64, olien: &str, actor: Option<i64>, key: Option<i64>, action: &str, subject: Option<&str>, detail: Value) {
    if let Err(error) = write(pool, olien_id, olien, actor, key, action, subject, &detail).await {
        tracing::error!("audit row lost for {olien} ({action}): {error:#}");
    }
}

#[allow(clippy::too_many_arguments)]
async fn write(pool: &PgPool, olien_id: i64, olien: &str, actor: Option<i64>, key: Option<i64>, action: &str, subject: Option<&str>, detail: &Value) -> anyhow::Result<()> {
    let mut tx = pool.begin().await?;
    // One writer per account at a time, or two rows would both name the same previous.
    sqlx::query("SELECT pg_advisory_xact_lock($1)").bind(olien_id).execute(&mut *tx).await?;
    let previous: Option<(String,)> = sqlx::query_as("SELECT hash FROM olien_audit WHERE olien_id = $1 ORDER BY id DESC LIMIT 1").bind(olien_id).fetch_optional(&mut *tx).await?;
    let previous = previous.and_then(|(hash,)| hash.parse::<B256>().ok()).unwrap_or(B256::ZERO);
    let at = Utc::now().timestamp();
    let hash = entry_hash(previous, &canonical(olien, at, actor, key, action, subject, detail));
    sqlx::query(
        "INSERT INTO olien_audit (olien_id, at, actor, api_key_id, action, subject, detail, previous, hash)
         VALUES ($1, to_timestamp($2), $3, $4, $5, $6, $7, $8, $9)",
    )
    .bind(olien_id)
    .bind(at as f64)
    .bind(actor)
    .bind(key)
    .bind(action)
    .bind(subject)
    .bind(detail)
    .bind(hex(previous.as_slice()))
    .bind(hex(hash.as_slice()))
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditRow {
    pub id: i64,
    pub at: i64,
    /// The member who did it, as the console names members, when a person did.
    pub actor: Option<String>,
    /// The API key it came through, by name, when one did.
    pub via: Option<String>,
    pub action: String,
    pub subject: Option<String>,
    pub detail: Value,
    pub previous: String,
    pub hash: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditPage {
    pub rows: Vec<AuditRow>,
    /// Whether each row in this page hashes to what it says, and names the row before
    /// it. False means the trail was altered after it was written.
    pub intact: bool,
}

#[derive(sqlx::FromRow)]
struct Stored {
    id: i64,
    at: DateTime<Utc>,
    actor: Option<i64>,
    api_key_id: Option<i64>,
    action: String,
    subject: Option<String>,
    detail: Value,
    previous: String,
    hash: String,
    actor_name: Option<String>,
    key_name: Option<String>,
}

/// Whether rows, oldest first, form an unbroken chain.
fn chain_holds(olien: &str, rows: &[Stored]) -> bool {
    rows.iter().enumerate().all(|(index, row)| {
        let (Ok(previous), Ok(hash)) = (row.previous.parse::<B256>(), row.hash.parse::<B256>()) else { return false };
        let follows = index == 0 || rows[index - 1].hash == row.previous;
        follows && entry_hash(previous, &canonical(olien, row.at.timestamp(), row.actor, row.api_key_id, &row.action, row.subject.as_deref(), &row.detail)) == hash
    })
}

/// A page of the trail, newest first, for any member and for a key that may read.
pub async fn page(pool: &PgPool, user: i64, address: &str, before: Option<i64>, limit: i64) -> Res<AuditPage> {
    let ctx = context_for(pool, user, address).await?;
    let mut stored: Vec<Stored> = sqlx::query_as(
        "SELECT a.id, a.at, a.actor, a.api_key_id, a.action, a.subject, a.detail, a.previous, a.hash,
            COALESCE(m.given_name, m.email, CASE WHEN m.provider = 'wallet' THEN m.provider_subject END) AS actor_name,
            k.name AS key_name
         FROM olien_audit a
         LEFT JOIN accounts m ON m.account_id = a.actor
         LEFT JOIN olien_api_keys k ON k.id = a.api_key_id
         WHERE a.olien_id = $1 AND ($2::bigint IS NULL OR a.id < $2) ORDER BY a.id DESC LIMIT $3",
    )
    .bind(ctx.row.id)
    .bind(before)
    .bind(limit.clamp(1, 1_000))
    .fetch_all(pool)
    .await?;
    stored.reverse();
    let intact = chain_holds(&ctx.row.address, &stored);
    stored.reverse();
    Ok(AuditPage {
        intact,
        rows: stored
            .into_iter()
            .map(|row| AuditRow {
                id: row.id,
                at: row.at.timestamp(),
                actor: row.actor_name.or_else(|| row.actor.map(|id| format!("member {id}"))),
                via: row.key_name,
                action: row.action,
                subject: row.subject,
                detail: row.detail,
                previous: row.previous,
                hash: row.hash,
            })
            .collect(),
    })
}

fn csv_field(value: &str) -> String {
    // A leading =, +, - or @ is a formula to a spreadsheet; a quote in front makes it text.
    let safe = if value.starts_with(['=', '+', '-', '@']) { format!("'{value}") } else { value.to_string() };
    format!("\"{}\"", safe.replace('"', "\"\""))
}

pub fn csv(page: &AuditPage) -> String {
    let mut out = String::from("id,at,actor,via,action,subject,detail,previous,hash\n");
    for row in &page.rows {
        let at = DateTime::<Utc>::from_timestamp(row.at, 0).map(|t| t.to_rfc3339()).unwrap_or_default();
        let fields = [
            row.id.to_string(),
            at,
            row.actor.clone().unwrap_or_default(),
            row.via.clone().unwrap_or_default(),
            row.action.clone(),
            row.subject.clone().unwrap_or_default(),
            row.detail.to_string(),
            row.previous.clone(),
            row.hash.clone(),
        ];
        out.push_str(&fields.iter().map(|field| csv_field(field)).collect::<Vec<_>>().join(","));
        out.push('\n');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const ACCOUNT: &str = "0x00000000000000000000000000000000000000ab";

    fn stored(id: i64, at: i64, action: &str, previous: B256) -> Stored {
        let detail = json!({ "name": "Payroll" });
        let hash = entry_hash(previous, &canonical(ACCOUNT, at, Some(7), None, action, Some("subject"), &detail));
        Stored {
            id,
            at: DateTime::<Utc>::from_timestamp(at, 0).unwrap(),
            actor: Some(7),
            api_key_id: None,
            action: action.into(),
            subject: Some("subject".into()),
            detail,
            previous: hex(previous.as_slice()),
            hash: hex(hash.as_slice()),
            actor_name: None,
            key_name: None,
        }
    }

    fn three() -> Vec<Stored> {
        let first = stored(1, 1_000, "account.created", B256::ZERO);
        let second = stored(2, 2_000, "key.minted", first.hash.parse().unwrap());
        let third = stored(3, 3_000, "key.revoked", second.hash.parse().unwrap());
        vec![first, second, third]
    }

    #[test]
    fn rows_written_in_order_form_a_chain() {
        assert!(chain_holds(ACCOUNT, &three()));
        assert!(chain_holds(ACCOUNT, &three()[1..]), "a page from the middle still holds");
        assert!(chain_holds(ACCOUNT, &[]));
    }

    #[test]
    fn a_row_changed_afterwards_breaks_it() {
        let mut rows = three();
        rows[1].action = "key.revoked".into();
        assert!(!chain_holds(ACCOUNT, &rows));
    }

    #[test]
    fn a_row_removed_afterwards_breaks_it() {
        let mut rows = three();
        rows.remove(1);
        assert!(!chain_holds(ACCOUNT, &rows));
    }

    #[test]
    fn a_row_belongs_to_its_account() {
        assert!(!chain_holds("0x00000000000000000000000000000000000000cd", &three()), "the same rows under another account are not its trail");
    }

    #[test]
    fn the_export_cannot_be_made_to_run_a_formula() {
        assert_eq!(csv_field("=HYPERLINK(\"x\")"), "\"'=HYPERLINK(\"\"x\"\")\"");
        assert_eq!(csv_field("Payroll"), "\"Payroll\"");
    }
}
