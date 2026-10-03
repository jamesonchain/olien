// API keys for a treasury (docs/treasury/11-service-api.md, "API keys").
//
// A key is a bearer token like a session's, told apart by its prefix, scoped to one
// Olien and to one of two things: reading, or reading plus opening proposals. It acts
// as the member who minted it, which is what makes it safe to hand to a payroll
// system: the proposals it opens still need the threshold's signatures, and it dies
// with its minter's membership rather than outliving them.

use alloy::primitives::keccak256;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use chrono::{DateTime, Utc};
use rand::RngCore;
use serde::Serialize;
use sqlx::PgPool;

use crate::audit;
use crate::treasury::{bad, context_for, parse_address, Res, TreasuryError};

/// What the key starts with. A session token is base64url and never contains an
/// underscore, so the handler can route on this without a database read.
pub const PREFIX: &str = "olk_";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Scope {
    Read,
    Propose,
}

impl Scope {
    pub fn parse(value: &str) -> Res<Scope> {
        match value.trim() {
            "read" => Ok(Scope::Read),
            "propose" => Ok(Scope::Propose),
            other => Err(bad(format!("scope must be read or propose, not {other}"))),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Scope::Read => "read",
            Scope::Propose => "propose",
        }
    }
}

/// What a key is allowed to stand in for. `Person` is everything a key may never do:
/// signing, executing, changing who the members are, minting more keys.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Need {
    Read,
    Propose,
    Person,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiKeyView {
    pub id: i64,
    pub name: String,
    pub scope: Scope,
    pub hint: String,
    pub created_by: String,
    pub created_at: i64,
    pub last_used_at: Option<i64>,
    /// The last moment the key works. A key past it stays listed, so whoever comes
    /// looking for why the payroll job stopped finds the reason beside the name.
    pub expires_at: Option<i64>,
}

/// A key lives ninety days unless its minter says otherwise, and never more than a year.
pub const DEFAULT_LIFETIME_DAYS: i32 = 90;
pub const MAX_LIFETIME_DAYS: i32 = 365;

pub fn lifetime_days(requested: Option<u32>) -> Res<i32> {
    match requested {
        None => Ok(DEFAULT_LIFETIME_DAYS),
        Some(days) if (1..=MAX_LIFETIME_DAYS as u32).contains(&days) => Ok(days as i32),
        Some(_) => Err(bad(format!("a key lasts between 1 and {MAX_LIFETIME_DAYS} days"))),
    }
}

/// The one response that carries the key itself.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MintedKey {
    pub key: String,
    #[serde(flatten)]
    pub view: ApiKeyView,
}

/// A resolved key: who it acts as, which account it is for, what it may do.
#[derive(Debug, Clone)]
pub struct KeyGrant {
    pub key_id: i64,
    pub user: i64,
    pub olien_address: String,
    pub scope: Scope,
}

pub fn looks_like_key(token: &str) -> bool {
    token.starts_with(PREFIX)
}

/// Whether a grant covers a request, before any membership check. Pure so the table
/// of what a key may do is a thing the tests pin down.
pub fn permit(grant: &KeyGrant, need: Need, address: Option<&str>) -> Result<(), (u16, &'static str)> {
    let allowed = match need {
        Need::Read => true,
        Need::Propose => grant.scope == Scope::Propose,
        Need::Person => false,
    };
    if !allowed {
        return Err((403, "this API key cannot do that"));
    }
    match address {
        Some(given) if given.trim().to_lowercase() == grant.olien_address => Ok(()),
        _ => Err((403, "this API key belongs to a different account")),
    }
}

fn mint() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    format!("{PREFIX}{}", URL_SAFE_NO_PAD.encode(bytes))
}

fn hash_of(key: &str) -> Vec<u8> {
    keccak256(key.as_bytes()).to_vec()
}

fn hint_of(key: &str) -> String {
    key.chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect()
}

#[derive(sqlx::FromRow)]
struct KeyRow {
    id: i64,
    name: String,
    scope: String,
    hint: String,
    created_by: i64,
    created_at: DateTime<Utc>,
    last_used_at: Option<DateTime<Utc>>,
    expires_at: Option<DateTime<Utc>>,
}

async fn view_of(pool: &PgPool, row: KeyRow) -> Res<ApiKeyView> {
    let scope = Scope::parse(&row.scope)?;
    Ok(ApiKeyView {
        id: row.id,
        name: row.name,
        scope,
        hint: row.hint,
        created_by: member_name(pool, row.created_by).await?,
        created_at: row.created_at.timestamp(),
        last_used_at: row.last_used_at.map(|t| t.timestamp()),
        expires_at: row.expires_at.map(|t| t.timestamp()),
    })
}

// The same naming the proposer gets: a wallet account is known by its address.
pub(crate) async fn member_name(pool: &PgPool, id: i64) -> Res<String> {
    let row: Option<(Option<String>, Option<String>, String, String)> =
        sqlx::query_as("SELECT given_name, email, provider, provider_subject FROM accounts WHERE account_id = $1")
            .bind(id)
            .fetch_optional(pool)
            .await?;
    Ok(row
        .and_then(|(given, email, provider, subject)| given.or(email).or_else(|| (provider == "wallet").then_some(subject)))
        .unwrap_or_else(|| format!("member {id}")))
}

pub async fn list_keys(pool: &PgPool, user: i64, address: &str) -> Res<Vec<ApiKeyView>> {
    let ctx = context_for(pool, user, address).await?;
    let rows: Vec<KeyRow> = sqlx::query_as(
        "SELECT id, name, scope, hint, created_by, created_at, last_used_at, expires_at FROM olien_api_keys
         WHERE olien_id = $1 AND revoked_at IS NULL ORDER BY created_at",
    )
    .bind(ctx.row.id)
    .fetch_all(pool)
    .await?;
    let mut views = Vec::with_capacity(rows.len());
    for row in rows {
        views.push(view_of(pool, row).await?);
    }
    Ok(views)
}

pub async fn mint_key(pool: &PgPool, user: i64, address: &str, name: &str, scope: &str, expires_in_days: Option<u32>) -> Res<MintedKey> {
    let ctx = context_for(pool, user, address).await?;
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 80 {
        return Err(bad("a key needs a name of up to 80 characters"));
    }
    let scope = Scope::parse(scope)?;
    let days = lifetime_days(expires_in_days)?;
    let key = mint();
    let row: KeyRow = sqlx::query_as(
        "INSERT INTO olien_api_keys (olien_id, name, scope, key_hash, hint, created_by, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(days => $7))
         RETURNING id, name, scope, hint, created_by, created_at, last_used_at, expires_at",
    )
    .bind(ctx.row.id)
    .bind(name)
    .bind(scope.as_str())
    .bind(hash_of(&key))
    .bind(hint_of(&key))
    .bind(user)
    .bind(days)
    .fetch_one(pool)
    .await?;
    audit::record(pool, ctx.row.id, &ctx.row.address, Some(user), None, "key.minted", Some(&row.id.to_string()), serde_json::json!({ "name": name, "scope": scope.as_str(), "days": days })).await;
    Ok(MintedKey { key, view: view_of(pool, row).await? })
}

/// Any member may revoke any key on the account: a leaked key is everyone's problem.
pub async fn revoke_key(pool: &PgPool, user: i64, address: &str, id: i64) -> Res<()> {
    let ctx = context_for(pool, user, address).await?;
    let done = sqlx::query("UPDATE olien_api_keys SET revoked_at = now() WHERE id = $1 AND olien_id = $2 AND revoked_at IS NULL")
        .bind(id)
        .bind(ctx.row.id)
        .execute(pool)
        .await?;
    if done.rows_affected() == 0 {
        return Err(TreasuryError::NotFound("no such key".into()));
    }
    audit::record(pool, ctx.row.id, &ctx.row.address, Some(user), None, "key.revoked", Some(&id.to_string()), serde_json::json!({})).await;
    Ok(())
}

/// The bearer token to the grant behind it, or None for a key that does not exist, was
/// revoked or has passed its last day. The account's address is returned lowercased so the handler can hold
/// it against the path.
pub async fn resolve(pool: &PgPool, token: &str) -> Res<Option<KeyGrant>> {
    let found: Option<(i64, i64, String, String)> = sqlx::query_as(
        "UPDATE olien_api_keys k SET last_used_at = now()
         FROM olien_accounts a
         WHERE k.key_hash = $1 AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > now()) AND a.id = k.olien_id
         RETURNING k.id, k.created_by, a.address, k.scope",
    )
    .bind(hash_of(token))
    .fetch_optional(pool)
    .await?;
    let Some((key_id, user, address, scope)) = found else {
        return Ok(None);
    };
    Ok(Some(KeyGrant {
        key_id,
        user,
        olien_address: parse_address(&address).map(|a| format!("{a:#x}"))?,
        scope: Scope::parse(&scope)?,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grant(scope: Scope) -> KeyGrant {
        KeyGrant { key_id: 1, user: 7, olien_address: "0x00000000000000000000000000000000000000ab".into(), scope }
    }

    #[test]
    fn a_minted_key_is_recognisable_and_its_hint_is_its_tail() {
        let key = mint();
        assert!(looks_like_key(&key));
        assert_eq!(key.len(), PREFIX.len() + 43, "32 random bytes, base64url, no padding");
        assert_eq!(hint_of(&key), &key[key.len() - 4..]);
        assert_ne!(mint(), key);
    }

    #[test]
    fn a_session_token_is_not_taken_for_a_key() {
        assert!(!looks_like_key("q7Zt3-abcdefghijklmnopqrstuvwxyz0123456789AB"));
        assert!(!looks_like_key(""));
    }

    #[test]
    fn a_read_key_reads_and_nothing_else() {
        let g = grant(Scope::Read);
        let here = Some("0x00000000000000000000000000000000000000AB");
        assert!(permit(&g, Need::Read, here).is_ok());
        assert_eq!(permit(&g, Need::Propose, here).unwrap_err().0, 403);
        assert_eq!(permit(&g, Need::Person, here).unwrap_err().0, 403);
    }

    #[test]
    fn a_propose_key_opens_proposals_but_never_stands_for_a_person() {
        let g = grant(Scope::Propose);
        let here = Some("0x00000000000000000000000000000000000000ab");
        assert!(permit(&g, Need::Read, here).is_ok());
        assert!(permit(&g, Need::Propose, here).is_ok());
        assert_eq!(permit(&g, Need::Person, here).unwrap_err().1, "this API key cannot do that");
    }

    #[test]
    fn a_key_is_held_to_its_own_account() {
        let g = grant(Scope::Propose);
        let elsewhere = Some("0x00000000000000000000000000000000000000cd");
        assert_eq!(permit(&g, Need::Read, elsewhere).unwrap_err().1, "this API key belongs to a different account");
        assert!(permit(&g, Need::Read, None).is_err(), "a route with no account in it is a person's route");
    }

    #[test]
    fn a_key_lasts_ninety_days_unless_told_and_never_more_than_a_year() {
        assert_eq!(lifetime_days(None).unwrap(), 90);
        assert_eq!(lifetime_days(Some(7)).unwrap(), 7);
        assert_eq!(lifetime_days(Some(365)).unwrap(), 365);
        assert!(lifetime_days(Some(0)).is_err(), "a key that is already over");
        assert!(lifetime_days(Some(366)).is_err(), "a key that outlives the year");
    }

    #[test]
    fn scope_words_are_the_two_the_doc_names() {
        assert_eq!(Scope::parse(" read ").unwrap(), Scope::Read);
        assert_eq!(Scope::parse("propose").unwrap(), Scope::Propose);
        assert!(Scope::parse("admin").is_err());
    }
}
