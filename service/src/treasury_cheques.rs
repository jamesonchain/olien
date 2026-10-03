// Cheques written by a treasury (docs/treasury/11-service-api.md, "Cheques").
//
// The consumer app's cheque with an Olien as the writer. A cheque is USDC's
// TransferWithAuthorization, signed offline and cashed by whoever holds it; for an
// account the token asks isValidSignature, which the Olien answers with threshold
// approvers over Message(digest) in its own domain (spec §9). So writing one is a
// signing round like a proposal's, except nothing lands on chain: when enough
// members have signed, the packed set is stored where the recipient's app looks.

use alloy::primitives::{keccak256, Address, B256, U256};
use alloy::sol_types::SolValue;
use chrono::{DateTime, Utc};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::PgPool;

use crate::olien::{self, calldata, Call, OlienClient};
use crate::audit;
use crate::policy::SoftRule;
use crate::treasury::{
    self, bad, check_signature, context_for, parse_address, parse_amount, AccountContext, AccountRow, ConfirmationJson, Res, SignerRow, SoftContext, Treasury,
    TreasuryError,
};
use crate::treasury_keys::member_name;

/// A cheque is good for ninety days unless the writer says otherwise.
const DEFAULT_VALIDITY: u64 = 90 * 86_400;
const MAX_VALIDITY: u64 = 365 * 86_400;
const MAX_MEMO_CHARS: usize = 140;

// ---------------------------------------------------------------------------
// The token's digest, computed here so it can be pinned to the vector the phone's
// tests carry. The domain is USDC's: name "USDC", version "2", read from the live
// contract on Arc testnet.

const AUTHORIZATION_TYPE: &str = "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)";
const DOMAIN_TYPE: &str = "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)";

pub fn usdc_domain(chain_id: u64, token: Address) -> B256 {
    keccak256((keccak256(DOMAIN_TYPE), keccak256("USDC"), keccak256("2"), U256::from(chain_id), token).abi_encode())
}

pub fn authorization_digest(chain_id: u64, token: Address, from: Address, to: Address, value: U256, valid_after: u64, valid_before: u64, nonce: B256) -> B256 {
    let struct_hash = keccak256(
        (keccak256(AUTHORIZATION_TYPE), from, to, value, U256::from(valid_after), U256::from(valid_before), nonce).abi_encode(),
    );
    let mut out = Vec::with_capacity(66);
    out.extend_from_slice(&[0x19, 0x01]);
    out.extend_from_slice(usdc_domain(chain_id, token).as_slice());
    out.extend_from_slice(struct_hash.as_slice());
    keccak256(out)
}

// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewChequeBody {
    pub to: String,
    pub amount: String,
    pub memo: Option<String>,
    /// Seconds from now; the default is ninety days.
    pub valid_for: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChequeSignatureBody {
    pub signer_id: String,
    pub signature: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChequeView {
    pub id: i64,
    pub to: String,
    pub to_label: Option<String>,
    pub amount: String,
    pub valid_after: i64,
    pub valid_before: i64,
    pub nonce: String,
    pub digest: String,
    /// What a member signs: Message(digest) in the account's domain.
    pub message_hash: String,
    pub typed_data: Value,
    pub memo: Option<String>,
    pub status: String,
    pub signatures: Vec<ConfirmationJson>,
    pub required: i64,
    /// The treasury's policy still holding an open cheque back from being issued.
    pub soft_rules: Vec<SoftRule>,
    pub void_proposal_tx_hash: Option<String>,
    pub proposer: Option<String>,
    pub created_at: i64,
    pub issued_at: Option<i64>,
    pub cashed_at: Option<i64>,
}

#[derive(sqlx::FromRow)]
struct Row {
    id: i64,
    to_address: String,
    amount: String,
    valid_after: i64,
    valid_before: i64,
    nonce: String,
    digest: String,
    message_hash: String,
    memo: Option<String>,
    status: String,
    void_tx_hash: Option<String>,
    proposer: Option<i64>,
    created_at: DateTime<Utc>,
    issued_at: Option<DateTime<Utc>>,
    cashed_at: Option<DateTime<Utc>>,
}

const SELECT: &str = "SELECT c.id, c.to_address, c.amount, c.valid_after, c.valid_before, c.nonce, c.digest, c.message_hash, c.memo, c.status,
    p.tx_hash AS void_tx_hash, c.proposer, c.created_at, c.issued_at, c.cashed_at
    FROM olien_cheques c LEFT JOIN olien_proposals p ON p.id = c.void_proposal_id";

fn hex(bytes: &[u8]) -> String {
    format!("0x{}", alloy::hex::encode(bytes))
}

/// The EIP-712 a wallet shows for a cheque: Message(bytes32 hash) in the account's
/// domain, the same thing a member account signs to confirm another's transaction.
fn message_typed_data(chain_id: u64, account: Address, digest: &str) -> Value {
    json!({
        "domain": { "name": "Olien", "version": "1", "chainId": chain_id, "verifyingContract": format!("{account:#x}") },
        "types": {
            "EIP712Domain": [
                { "name": "name", "type": "string" }, { "name": "version", "type": "string" },
                { "name": "chainId", "type": "uint256" }, { "name": "verifyingContract", "type": "address" }
            ],
            "Message": [ { "name": "hash", "type": "bytes32" } ]
        },
        "primaryType": "Message",
        "message": { "hash": digest }
    })
}

async fn view_of(pool: &PgPool, treasury: &Treasury, ctx: &AccountContext, row: Row) -> Res<ChequeView> {
    let signatures: Vec<(String, DateTime<Utc>)> =
        sqlx::query_as("SELECT signer_id, signed_at FROM olien_cheque_signatures WHERE cheque_id = $1 ORDER BY signed_at").bind(row.id).fetch_all(pool).await?;
    let signatures = signatures
        .into_iter()
        .map(|(signer_id, at)| {
            let signer = ctx.signers.iter().find(|s| s.signer_id == signer_id);
            ConfirmationJson {
                signer_id: signer_id.clone(),
                address: signer.and_then(|s| s.address.clone()),
                label: signer.map(|s| s.label.clone()).unwrap_or_default(),
                kind: "offchain".into(),
                signed_at: at.timestamp(),
            }
        })
        .collect();
    let proposer = match row.proposer {
        Some(id) => Some(member_name(pool, id).await?),
        None => None,
    };
    let book = treasury::address_book_map(pool, ctx.row.id).await?;
    let (soft_rules, required) = match row.status.as_str() {
        "open" => held(pool, &ctx.row, &ctx.signers, &row).await?,
        _ => (Vec::new(), ctx.row.threshold as i64),
    };
    Ok(ChequeView {
        id: row.id,
        to_label: book.get(&row.to_address).cloned(),
        to: row.to_address,
        amount: row.amount,
        valid_after: row.valid_after,
        valid_before: row.valid_before,
        nonce: row.nonce,
        typed_data: message_typed_data(treasury.chain_id, ctx.row.address(), &row.digest),
        digest: row.digest,
        message_hash: row.message_hash,
        memo: row.memo,
        status: row.status,
        signatures,
        required,
        soft_rules,
        void_proposal_tx_hash: row.void_tx_hash,
        proposer,
        created_at: row.created_at.timestamp(),
        issued_at: row.issued_at.map(|t| t.timestamp()),
        cashed_at: row.cashed_at.map(|t| t.timestamp()),
    })
}

async fn load(pool: &PgPool, olien_id: i64, id: i64) -> Res<Row> {
    sqlx::query_as(&format!("{SELECT} WHERE c.id = $1 AND c.olien_id = $2"))
        .bind(id)
        .bind(olien_id)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| TreasuryError::NotFound("no such cheque".into()))
}

pub async fn list(pool: &PgPool, treasury: &Treasury, user: i64, address: &str) -> Res<Vec<ChequeView>> {
    let ctx = context_for(pool, user, address).await?;
    let rows: Vec<Row> = sqlx::query_as(&format!("{SELECT} WHERE c.olien_id = $1 ORDER BY c.created_at DESC LIMIT 200")).bind(ctx.row.id).fetch_all(pool).await?;
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        out.push(view_of(pool, treasury, &ctx, row).await?);
    }
    Ok(out)
}

pub async fn get(pool: &PgPool, treasury: &Treasury, user: i64, address: &str, id: i64) -> Res<ChequeView> {
    let ctx = context_for(pool, user, address).await?;
    let row = load(pool, ctx.row.id, id).await?;
    view_of(pool, treasury, &ctx, row).await
}

/// Open a cheque: fix the terms and the nonce, compute what the members sign.
pub async fn write(pool: &PgPool, treasury: &Treasury, user: i64, address: &str, body: NewChequeBody) -> Res<ChequeView> {
    let client = treasury.client.as_ref().ok_or(TreasuryError::Off)?;
    let ctx = context_for(pool, user, address).await?;
    treasury::require_live(&ctx.row)?;
    let account = ctx.row.address();
    let to = parse_address(&body.to)?;
    if to == account {
        return Err(bad("a cheque cannot be written to the account itself"));
    }
    let amount = parse_amount(&body.amount)?;
    if amount.is_zero() {
        return Err(bad("a cheque needs an amount above zero"));
    }
    let memo = match body.memo.as_deref().map(str::trim) {
        Some(m) if m.chars().count() > MAX_MEMO_CHARS => return Err(bad(format!("a memo can be at most {MAX_MEMO_CHARS} characters"))),
        Some(m) if !m.is_empty() => Some(m.to_string()),
        _ => None,
    };
    let valid_for = body.valid_for.unwrap_or(DEFAULT_VALIDITY);
    if valid_for == 0 || valid_for > MAX_VALIDITY {
        return Err(bad("a cheque is valid for between a second and a year"));
    }
    let now = treasury::now();
    let valid_before = now + valid_for;
    let mut nonce = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut nonce);
    let nonce = B256::from(nonce);
    let digest = authorization_digest(treasury.chain_id, client.usdc, account, to, amount, 0, valid_before, nonce);
    let message_hash = olien::message_hash(treasury.chain_id, account, digest);
    let (id,): (i64,) = sqlx::query_as(
        "INSERT INTO olien_cheques (olien_id, to_address, amount, valid_after, valid_before, nonce, digest, message_hash, memo, proposer)
         VALUES ($1, $2, $3, 0, $4, $5, $6, $7, $8, $9) RETURNING id",
    )
    .bind(ctx.row.id)
    .bind(format!("{to:#x}"))
    .bind(amount.to_string())
    .bind(valid_before as i64)
    .bind(hex(nonce.as_slice()))
    .bind(hex(digest.as_slice()))
    .bind(hex(message_hash.as_slice()))
    .bind(&memo)
    .bind(user)
    .fetch_one(pool)
    .await?;
    audit::record(pool, ctx.row.id, &ctx.row.address, Some(user), None, "cheque.written", Some(&id.to_string()), json!({ "to": format!("{to:#x}"), "amount": amount.to_string() })).await;
    let row = load(pool, ctx.row.id, id).await?;
    view_of(pool, treasury, &ctx, row).await
}

/// A member's signature over Message(digest). The same checks as a confirmation, and
/// once the threshold is met the cheque is issued: packed and stored for the recipient.
pub async fn sign(pool: &PgPool, treasury: &Treasury, user: i64, address: &str, id: i64, body: ChequeSignatureBody) -> Res<ChequeView> {
    let client = treasury.client.as_ref().ok_or(TreasuryError::Off)?;
    let ctx = context_for(pool, user, address).await?;
    let row = load(pool, ctx.row.id, id).await?;
    if row.status != "open" {
        return Err(TreasuryError::Conflict(format!("a {} cheque takes no more signatures", row.status)));
    }
    let signer_id = hex(treasury::parse_hash(&body.signer_id)?.as_slice());
    let signer: &SignerRow = ctx
        .signers
        .iter()
        .find(|s| s.signer_id == signer_id && s.status == "active")
        .ok_or_else(|| bad("not a signer of this account"))?;
    if !signer.approves() {
        return Err(bad("this signer does not hold approve"));
    }
    let hash = treasury::parse_hash(&row.message_hash)?;
    let signature = treasury::parse_hex_bytes(&body.signature)?;
    if signature.is_empty() {
        return Err(bad("a cheque needs a signature; there is no on-chain approval for one"));
    }
    check_signature(client, &ctx, signer, hash, &signature).await?;
    sqlx::query(
        "INSERT INTO olien_cheque_signatures (cheque_id, signer_id, signature) VALUES ($1, $2, $3)
         ON CONFLICT (cheque_id, signer_id) DO UPDATE SET signature = EXCLUDED.signature, signed_at = now()",
    )
    .bind(id)
    .bind(&signer_id)
    .bind(&signature)
    .execute(pool)
    .await?;
    audit::record(pool, ctx.row.id, &ctx.row.address, Some(user), None, "cheque.signed", Some(&id.to_string()), json!({ "signerId": signer_id })).await;
    issue_if_ready(pool, &ctx.row, &ctx.signers, &row).await?;
    let row = load(pool, ctx.row.id, id).await?;
    view_of(pool, treasury, &ctx, row).await
}

/// The signatures on a cheque that count: from signers who are active and may approve.
async fn counted(pool: &PgPool, signers: &[SignerRow], cheque_id: i64) -> Res<Vec<(String, Vec<u8>)>> {
    let signed: Vec<(String, Vec<u8>)> =
        sqlx::query_as("SELECT signer_id, signature FROM olien_cheque_signatures WHERE cheque_id = $1").bind(cheque_id).fetch_all(pool).await?;
    Ok(signed.into_iter().filter(|(id, _)| signers.iter().any(|s| &s.signer_id == id && s.status == "active" && s.approves())).collect())
}

/// What the treasury's policy still has against issuing this cheque, and the approvals
/// it needs. A cheque is a payment by another route, so it answers to the same rules as
/// a proposal: its amount to the tiers, its recipient to the address book, the moment
/// to the hours.
async fn held(pool: &PgPool, account: &AccountRow, signers: &[SignerRow], row: &Row) -> Res<(Vec<SoftRule>, i64)> {
    let approvals = counted(pool, signers, row.id).await?.len() as i64;
    let payment = (parse_address(&row.to_address)?, parse_amount(&row.amount)?);
    Ok(SoftContext::load(pool, account, signers).await?.rules_for(&[payment], &[], approvals, treasury::now()))
}

/// Enough approvers have signed: pack the set the way the account verifies it and
/// keep it on the cheque, which is the issued cheque.
///
/// This used to insert a row into the consumer app's `cheques` table, so the treasury
/// service wrote into a schema it does not own and could not be deployed without. The
/// packed signature is the entire cheque: USDC verifies it against the account through
/// EIP-1271 and needs nothing else. Keeping it here and serving it over
/// `GET /api/treasury/cheques/issued` says the same thing with the dependency pointing
/// the other way, so an app that wants an inbox reads this service rather than the
/// service writing into the app.
async fn issue_if_ready(pool: &PgPool, account: &AccountRow, signers: &[SignerRow], row: &Row) -> Res<()> {
    let counted = counted(pool, signers, row.id).await?;
    if (counted.len() as i64) < account.threshold as i64 {
        return Ok(());
    }
    // Enough for the account is not always enough for the treasury. A held cheque
    // stays open, and the indexer tries again each cycle, since two of the things that
    // hold one, the hours and a new destination's wait, pass by themselves.
    if !held(pool, account, signers, row).await?.0.is_empty() {
        return Ok(());
    }
    let entries: Vec<(B256, Vec<u8>)> = counted.iter().map(|(id, sig)| Ok((treasury::parse_hash(id)?, sig.clone()))).collect::<Res<_>>()?;
    let packed = olien::pack(&entries)?;
    let done = sqlx::query("UPDATE olien_cheques SET status = 'issued', signature = $2, issued_at = now(), updated_at = now() WHERE id = $1 AND status = 'open'")
        .bind(row.id)
        .bind(hex(&packed))
        .execute(pool)
        .await?;
    if done.rows_affected() == 1 {
        audit::record(pool, account.id, &account.address, None, None, "cheque.issued", Some(&row.id.to_string()), json!({ "to": row.to_address, "amount": row.amount })).await;
    }
    Ok(())
}

/// Called by the indexer: open cheques with enough signatures that the policy was
/// holding are issued once it lets go.
pub async fn issue_waiting(pool: &PgPool, account: &AccountRow) -> Res<()> {
    let rows: Vec<Row> = sqlx::query_as(&format!("{SELECT} WHERE c.olien_id = $1 AND c.status = 'open'")).bind(account.id).fetch_all(pool).await?;
    if rows.is_empty() {
        return Ok(());
    }
    let signers = treasury::signers_of(pool, account.id).await?;
    for row in &rows {
        issue_if_ready(pool, account, &signers, row).await?;
    }
    Ok(())
}

/// Every cheque this treasury has issued to one recipient, newest first.
///
/// The replacement for writing into the consumer app's inbox table. A recipient's app
/// polls this with its own address and gets back everything it needs to cash: the
/// authorization's fields and the packed signature USDC will verify. Public on purpose,
/// the way a cheque in a drawer is: the signature authorises a transfer to `to` and to
/// nobody else, so learning it grants no one anything they did not already have.
pub async fn issued_to(pool: &PgPool, to: &str) -> Res<Vec<IssuedCheque>> {
    let to = treasury::parse_address(to)?;
    let rows: Vec<IssuedRow> = sqlx::query_as(
        "SELECT a.address AS from_address, c.to_address, c.amount, c.valid_after, c.valid_before,
                c.nonce, c.signature, c.memo, c.status, c.issued_at
         FROM olien_cheques c JOIN olien_accounts a ON a.id = c.olien_id
         WHERE c.to_address = $1 AND c.status IN ('issued', 'cashed') AND c.signature IS NOT NULL
         ORDER BY c.issued_at DESC LIMIT 200",
    )
    .bind(format!("{to:#x}"))
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| IssuedCheque {
            from_address: r.from_address,
            to_address: r.to_address,
            amount: r.amount,
            valid_after: r.valid_after,
            valid_before: r.valid_before,
            nonce: r.nonce,
            signature: r.signature,
            memo: r.memo,
            status: r.status,
            // Seconds, like every other time this API hands out, rather than the
            // timestamp's own format.
            issued_at: r.issued_at.map(|t| t.timestamp()),
        })
        .collect())
}

#[derive(sqlx::FromRow)]
struct IssuedRow {
    from_address: String,
    to_address: String,
    amount: String,
    valid_after: i64,
    valid_before: i64,
    nonce: String,
    signature: Option<String>,
    memo: Option<String>,
    status: String,
    issued_at: Option<DateTime<Utc>>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IssuedCheque {
    pub from_address: String,
    pub to_address: String,
    pub amount: String,
    pub valid_after: i64,
    pub valid_before: i64,
    pub nonce: String,
    pub signature: Option<String>,
    pub memo: Option<String>,
    pub status: String,
    pub issued_at: Option<i64>,
}

/// Void an issued cheque: a proposal to `cancel` the message hash on the account,
/// after which the token's isValidSignature call answers false. Threshold, no delay.
pub async fn void(pool: &PgPool, treasury: &Treasury, user: i64, address: &str, id: i64) -> Res<ChequeView> {
    let ctx = context_for(pool, user, address).await?;
    let row = load(pool, ctx.row.id, id).await?;
    match row.status.as_str() {
        "open" => {
            // Nothing has left the building; the draft simply goes.
            sqlx::query("DELETE FROM olien_cheques WHERE id = $1").bind(id).execute(pool).await?;
            audit::record(pool, ctx.row.id, &ctx.row.address, Some(user), None, "cheque.deleted", Some(&id.to_string()), json!({})).await;
            return Err(TreasuryError::NotFound("the draft cheque was deleted".into()));
        }
        "issued" => {}
        other => return Err(TreasuryError::Conflict(format!("a {other} cheque cannot be voided"))),
    }
    let call = Call { to: ctx.row.address(), value: U256::ZERO, data: calldata::cancel(treasury::parse_hash(&row.message_hash)?) };
    let intent = json!({ "voidsCheque": row.id, "to": row.to_address, "amount": row.amount, "memo": row.memo });
    let view = treasury::propose_calls(pool, treasury, user, address, "cancel".into(), intent, vec![call]).await?;
    sqlx::query(
        "UPDATE olien_cheques SET status = 'voiding', updated_at = now(), void_proposal_id = (SELECT id FROM olien_proposals WHERE tx_hash = $2) WHERE id = $1",
    )
    .bind(id)
    .bind(&view.tx_hash)
    .execute(pool)
    .await?;
    audit::record(pool, ctx.row.id, &ctx.row.address, Some(user), None, "cheque.voiding", Some(&id.to_string()), json!({ "proposal": view.tx_hash })).await;
    let row = load(pool, ctx.row.id, id).await?;
    view_of(pool, treasury, &ctx, row).await
}

/// Called by the indexer: an issued cheque is cashed when the token says its nonce is
/// used, expired when its window has passed. Voided arrives as a Cancelled event.
pub async fn refresh(pool: &PgPool, client: &OlienClient, olien_id: i64, account: Address) -> anyhow::Result<()> {
    let open: Vec<(i64, String, i64)> =
        sqlx::query_as("SELECT id, nonce, valid_before FROM olien_cheques WHERE olien_id = $1 AND status IN ('issued', 'voiding')").bind(olien_id).fetch_all(pool).await?;
    let now = treasury::now() as i64;
    for (id, nonce, valid_before) in open {
        let nonce: B256 = nonce.parse()?;
        if client.authorization_used(account, nonce).await? {
            sqlx::query("UPDATE olien_cheques SET status = 'cashed', cashed_at = now(), updated_at = now() WHERE id = $1").bind(id).execute(pool).await?;
        } else if valid_before < now {
            sqlx::query("UPDATE olien_cheques SET status = 'expired', updated_at = now() WHERE id = $1").bind(id).execute(pool).await?;
        }
    }
    Ok(())
}

/// The account cancelled a hash: if it was a cheque's, the cheque is void.
pub async fn on_cancelled(pool: &PgPool, olien_id: i64, hash: B256) -> anyhow::Result<()> {
    sqlx::query("UPDATE olien_cheques SET status = 'voided', updated_at = now() WHERE olien_id = $1 AND message_hash = $2 AND status IN ('issued', 'voiding')")
        .bind(olien_id)
        .bind(hex(hash.as_slice()))
        .execute(pool)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy::primitives::address;

    /// The phone's golden cheque (mobile/RecourseTests/ChequeTests.swift), computed
    /// independently with cast: the one number that decides whether a cheque cashes.
    #[test]
    fn the_digest_is_the_phones_digest() {
        let usdc = address!("3600000000000000000000000000000000000000");
        assert_eq!(format!("{:#x}", usdc_domain(5042002, usdc)), "0x361191522483d32a83e70ae7183b4b9629442c13a78bc9921d6f707911c8c6b0");
        let digest = authorization_digest(
            5042002,
            usdc,
            address!("D6c574461d96Ee708f58Fe553049aD4f48BB983A"),
            address!("9965507D1a55bcC2695C58ba16FB37d819B0A4dc"),
            U256::from(1_500_000u64),
            0,
            2_000_000_000,
            B256::from([0x11u8; 32]),
        );
        assert_eq!(format!("{digest:#x}"), "0x6cce28229ed8f091ce5d706f78c015497cf66db524fdd86919cfb877f4fa59b4");
    }

    #[test]
    fn the_typehash_is_the_standard_one() {
        assert_eq!(format!("{:#x}", keccak256(AUTHORIZATION_TYPE)), "0x7c7c6cdb67a18743f49ec6fa9b35f50d52ed05cbed4cc592e13b44501c1a2267");
    }
}
