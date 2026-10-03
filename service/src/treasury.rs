// The transaction service for Olien accounts: who may see an account, proposals and
// their hashes, confirmations checked as the chain will check them, the queue's
// states, and the relayer calls. docs/treasury/11-service-api.md is the contract this
// implements; 06-algorithms.md the procedures. Everything the chain decides is only
// mirrored here; the indexer (jobs/olien_indexer.rs) overwrites it from events.

use alloy::primitives::{Address, Bytes, B256, U256};
use alloy::sol_types::{SolCall, SolValue};
use anyhow::{anyhow, Context};
use chrono::{DateTime, Utc};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::PgPool;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::audit;
use crate::canonical;
use crate::members::Members;
use crate::policy::{self, Policy, SoftRule};
use crate::olien::{
    self, address_of_signer_id, calldata, signer_id_of_address, signer_id_of_key, Call, IOlien, Init, OlienClient, PackedUserOperation,
    SignerInput, SpendingLimitInput, Transaction, FLAG_UV_REQUIRED, KIND_CONTRACT, KIND_ECDSA, KIND_P256, KIND_WEBAUTHN,
    MAX_VALIDITY, PERM_APPROVE, PERM_RECOVER, PERM_VETO, SCHEDULE_WINDOW,
};

pub const DEFAULT_VALIDITY: u64 = 7 * 86_400;
/// Payroll runs queue in their own lane, so a run waiting on signatures never holds
/// up an ordinary payment and an ordinary payment never holds up payday.
pub const PAYROLL_LANE: &str = "1";

#[derive(Clone)]
pub struct Treasury {
    pub client: Option<OlienClient>,
    pub chain_id: u64,
    pub chain: ChainInfo,
    // The indexer keeps this current; /health reports it, so an emptying relayer key is
    // seen by whoever watches the service rather than by the first failed execute.
    pub relayer: Arc<Mutex<Option<RelayerStatus>>>,
    /// Names members by @handle where a directory is configured. `Members::None` on a
    /// chain without one, where members are named by address.
    pub members: Members,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayerStatus {
    pub address: String,
    /// In the chain's gas token, raw units; `symbol` and `decimals` say which.
    pub balance: String,
    pub symbol: String,
    pub decimals: u8,
    pub low: bool,
    pub checked_at: i64,
}

/// The chain this service runs against, for a console that must not assume Arc:
/// which token pays gas, where links go, which contracts are the protocol.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChainInfo {
    pub chain_id: u64,
    pub name: String,
    pub native: crate::config::NativeToken,
    pub explorer_url: String,
    pub usdc: String,
    pub eurc: Option<String>,
    pub entry_point: Option<String>,
    pub factory: Option<String>,
    pub implementation: Option<String>,
    /// What this service does beyond the first version of its API. A console offers a
    /// thing only when the service it is talking to names it here, so one console build
    /// tells the truth against an older service and a newer one.
    pub features: &'static [&'static str],
}

pub const FEATURES: &[&str] = &["import", "key-expiry", "synced", "signed-book", "policy", "audit"];

#[derive(Debug)]
pub enum TreasuryError {
    Bad(String),
    Forbidden,
    NotFound(String),
    Conflict(String),
    Chain(String),
    Off,
    Internal(anyhow::Error),
}

impl TreasuryError {
    pub fn parts(&self) -> (u16, String) {
        match self {
            TreasuryError::Bad(m) => (400, m.clone()),
            TreasuryError::Forbidden => (403, "not a member of this account".into()),
            TreasuryError::NotFound(m) => (404, m.clone()),
            TreasuryError::Conflict(m) => (409, m.clone()),
            TreasuryError::Chain(m) => (502, m.clone()),
            TreasuryError::Off => (503, "the treasury service is not switched on".into()),
            TreasuryError::Internal(e) => (500, format!("{e:#}")),
        }
    }
}

impl From<sqlx::Error> for TreasuryError {
    fn from(error: sqlx::Error) -> Self {
        TreasuryError::Internal(error.into())
    }
}

impl From<anyhow::Error> for TreasuryError {
    fn from(error: anyhow::Error) -> Self {
        TreasuryError::Internal(error)
    }
}

pub(crate) type Res<T> = Result<T, TreasuryError>;

pub(crate) fn bad(message: impl Into<String>) -> TreasuryError {
    TreasuryError::Bad(message.into())
}

pub(crate) fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn hex(bytes: &[u8]) -> String {
    format!("0x{}", alloy::hex::encode(bytes))
}

fn addr(address: Address) -> String {
    format!("{address:#x}")
}

pub fn parse_address(value: &str) -> Res<Address> {
    value.trim().parse().map_err(|_| bad(format!("{value} is not an address")))
}

pub(crate) fn parse_hash(value: &str) -> Res<B256> {
    value.trim().parse().map_err(|_| bad(format!("{value} is not a 32-byte hash")))
}

pub(crate) fn parse_amount(value: &str) -> Res<U256> {
    U256::from_str_radix(value.trim(), 10).map_err(|_| bad(format!("{value} is not an amount")))
}

pub(crate) fn parse_hex_bytes(value: &str) -> Res<Vec<u8>> {
    alloy::hex::decode(value.trim()).map_err(|_| bad(format!("{value} is not hex")))
}

// ---------------------------------------------------------------------------
// Rows

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct AccountRow {
    pub id: i64,
    pub address: String,
    pub name: String,
    pub created_by: Option<i64>,
    pub implementation: Option<String>,
    pub implementation_frozen: bool,
    pub epoch: i64,
    pub threshold: i32,
    pub veto_threshold: i32,
    pub effective_veto_threshold: i32,
    pub config_delay: i64,
    pub recovery_delay: i64,
    pub recovery_cosign_delay: i64,
    pub status: String,
    pub create_tx: Option<String>,
    pub indexed_block: i64,
    pub usdc_balance: String,
    pub eurc_balance: String,
    pub entry_point_deposit: String,
    pub created_at: DateTime<Utc>,
}

impl AccountRow {
    pub fn address(&self) -> Address {
        self.address.parse().unwrap_or(Address::ZERO)
    }
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct SignerRow {
    pub signer_id: String,
    pub kind: String,
    pub permissions: i32,
    pub flags: i32,
    pub address: Option<String>,
    pub x: Option<String>,
    pub y: Option<String>,
    pub label: String,
    pub since: i64,
    pub status: String,
    pub synced: Option<bool>,
}

impl SignerRow {
    pub(crate) fn approves(&self) -> bool {
        self.permissions & PERM_APPROVE as i32 != 0
    }
    fn vetoes(&self) -> bool {
        self.permissions & PERM_VETO as i32 != 0
    }
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct ProposalRow {
    pub id: i64,
    pub tx_hash: String,
    pub nonce_key: String,
    pub sequence: i64,
    pub epoch: i64,
    pub calls: Value,
    pub valid_after: i64,
    pub valid_until: i64,
    pub kind: String,
    pub intent: Value,
    pub path: String,
    pub status: String,
    pub proposer: Option<i64>,
    pub scheduled_ready_at: Option<i64>,
    pub scheduled_window_ends: Option<i64>,
    pub scheduled_excluded: Option<String>,
    pub executed_tx: Option<String>,
    pub executed_at: Option<i64>,
    pub failure: Option<String>,
    pub simulation_ok: Option<bool>,
    pub simulation_error: Option<String>,
    pub simulated_at: Option<i64>,
    pub api_key_id: Option<i64>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct ConfirmationRow {
    pub signer_id: String,
    pub signature: Vec<u8>,
    pub kind: String,
    pub signed_at: DateTime<Utc>,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct VetoRow {
    pub signer_id: String,
    pub tx: String,
    pub block_time: i64,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct LimitRow {
    pub limit_id: i64,
    pub generation: i64,
    pub token: String,
    pub from_address: String,
    pub amount: String,
    pub remaining: String,
    pub period: i64,
    pub reset_at: i64,
    pub any_destination: bool,
    pub signers: Value,
    pub destinations: Value,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct SubAccountRow {
    pub index: i64,
    pub address: String,
    pub label: String,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct LaneRow {
    pub nonce_key: String,
    pub chain_sequence: i64,
}

// ---------------------------------------------------------------------------
// Views (11-service-api.md)

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkedAddress {
    pub address: String,
    pub linked_at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountSummary {
    pub address: String,
    pub name: String,
    pub status: String,
    pub threshold: i32,
    pub signer_count: i64,
    pub usdc_balance: String,
    pub eurc_balance: String,
    pub open_proposals: i64,
    pub scheduled_changes: i64,
    pub created_at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignerJson {
    pub signer_id: String,
    pub kind: String,
    pub address: Option<String>,
    // P-256 and passkey signers: the coordinates as decimal strings, so a client can
    // tell which of several passkeys answered an assertion.
    pub x: Option<String>,
    pub y: Option<String>,
    pub label: String,
    pub permissions: Vec<&'static str>,
    pub since: i64,
    pub mine: bool,
    /// Passkeys only: true when its authenticator said it syncs across a cloud
    /// account, false when it said it does not, absent when nobody recorded it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub synced: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LimitJson {
    pub id: i64,
    pub generation: i64,
    pub token: String,
    pub from: String,
    pub amount: String,
    pub remaining: String,
    pub period: i64,
    pub reset_at: i64,
    pub any_destination: bool,
    pub signers: Value,
    pub destinations: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubAccountJson {
    pub index: i64,
    pub address: String,
    pub label: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaneJson {
    pub nonce_key: String,
    pub chain_sequence: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Membership {
    pub creator: bool,
    pub signer_ids: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountView {
    pub address: String,
    pub name: String,
    pub status: String,
    pub chain_id: i64,
    pub implementation: Option<String>,
    pub implementation_frozen: bool,
    pub epoch: i64,
    pub threshold: i32,
    pub veto_threshold: i32,
    pub effective_veto_threshold: i32,
    pub config_delay: i64,
    pub recovery_delay: i64,
    pub recovery_co_sign_delay: i64,
    pub signers: Vec<SignerJson>,
    pub usdc_balance: String,
    pub eurc_balance: String,
    pub entry_point_deposit: String,
    pub lanes: Vec<LaneJson>,
    pub limits: Vec<LimitJson>,
    pub sub_accounts: Vec<SubAccountJson>,
    pub create_tx: Option<String>,
    pub created_at: i64,
    pub membership: Membership,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmationJson {
    pub signer_id: String,
    pub address: Option<String>,
    pub label: String,
    pub kind: String,
    pub signed_at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MissingJson {
    pub signer_id: String,
    pub label: String,
    pub mine: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HardRule {
    pub rule: &'static str,
    pub seconds: u64,
    pub text: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Simulation {
    pub ok: bool,
    pub error: Option<String>,
    pub checked_at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VetoJson {
    pub signer_id: String,
    pub label: String,
    pub tx: String,
    pub at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DecodedCall {
    pub to: String,
    pub label: String,
    pub summary: String,
    pub selector: String,
    pub readable: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Proposer {
    pub account_id: i64,
    pub name: String,
    /// The API key that opened it, by name, when one did.
    pub via: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposalView {
    pub tx_hash: String,
    pub account: String,
    pub nonce_key: String,
    pub sequence: i64,
    pub nonce: String,
    pub epoch: i64,
    pub kind: String,
    pub intent: Value,
    pub calls: Value,
    pub decoded: Vec<DecodedCall>,
    pub valid_after: i64,
    pub valid_until: i64,
    pub path: String,
    pub status: String,
    pub confirmations: Vec<ConfirmationJson>,
    pub required: i32,
    pub approvals: i64,
    pub missing: Vec<MissingJson>,
    pub blocked_by: Option<i64>,
    pub hard_rules: Vec<HardRule>,
    /// The treasury's own policy still holding this back. Never the chain's rules: a
    /// member with the threshold's signatures can run it without this service.
    pub soft_rules: Vec<SoftRule>,
    pub simulation: Option<Simulation>,
    pub scheduled_ready_at: Option<i64>,
    pub scheduled_window_ends_at: Option<i64>,
    pub scheduled_excluded: Option<String>,
    pub vetoes: Vec<VetoJson>,
    pub effective_veto_threshold: i32,
    pub executed_tx: Option<String>,
    pub executed_at: Option<i64>,
    pub failure: Option<String>,
    pub proposer: Option<Proposer>,
    pub created_at: i64,
    pub typed_data: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerEntry {
    pub id: i64,
    pub tx: String,
    pub log_index: i32,
    pub token: String,
    pub symbol: String,
    /// 6 for USDC and EURC, 18 for gas; the console formats by this, not by symbol.
    pub decimals: u8,
    pub direction: String,
    pub counterparty: String,
    pub counterparty_label: Option<String>,
    pub amount: String,
    pub block_number: i64,
    pub block_time: i64,
    pub proposal_tx_hash: Option<String>,
    pub limit_id: Option<i64>,
    pub sub_account: Option<String>,
    pub memo: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddressBookEntry {
    pub address: String,
    pub label: String,
    pub category: String,
    pub created_at: i64,
    /// The member who vouched for it, their signature over the address, the label, the
    /// category and `added_at`, and that time. A client checks the signature itself
    /// before it shows the label or treats the address as known. Absent on a row from
    /// before entries were signed, which counts for nothing.
    pub signer_id: Option<String>,
    pub signature: Option<String>,
    pub added_at: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VetoCall {
    pub to: String,
    pub data: String,
    pub signer_ids: Vec<String>,
    /// Passkey and P-256 signers that may veto: they cannot send a transaction of
    /// their own, so they sign a user operation the relayer submits instead.
    pub operation_signer_ids: Vec<String>,
}

/// A user operation the service prepared and the member signs. Every field comes
/// back in `submit` and the hash is recomputed there, so nothing is held between.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationJson {
    pub sender: String,
    pub nonce: String,
    pub call_data: String,
    pub account_gas_limits: String,
    pub pre_verification_gas: String,
    pub gas_fees: String,
    pub valid_after: u64,
    pub valid_until: u64,
    pub epoch: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedOperation {
    pub operation: OperationJson,
    /// What the signer signs: the account's own hash of the operation (spec §10).
    pub hash: String,
    pub signer_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmitOperationBody {
    pub operation: OperationJson,
    pub signer_id: String,
    pub signature: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationReceipt {
    pub tx_hash: String,
    pub hash: String,
}

// ---------------------------------------------------------------------------
// Request bodies

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignerBody {
    pub kind: Option<String>,
    pub address: Option<String>,
    pub label: Option<String>,
    pub permissions: Option<Vec<String>>,
    // P-256 and passkey signers: the public key's coordinates, 32-byte hex each.
    pub x: Option<String>,
    pub y: Option<String>,
    // Passkeys only; defaults to true, which is what the console creates.
    pub uv_required: Option<bool>,
    // Passkeys only: whether the authenticator said the key syncs across a cloud account.
    pub synced: Option<bool>,
    // A Recourse account by name; resolved to its address and kind before anything else.
    pub handle: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateAccountBody {
    pub name: String,
    pub signers: Vec<SignerBody>,
    pub threshold: u16,
    pub veto_threshold: Option<u16>,
    pub config_delay: Option<u64>,
    pub recovery_delay: Option<u64>,
    pub recovery_co_sign_delay: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CallBody {
    pub to: String,
    pub value: Option<String>,
    pub data: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewProposalBody {
    pub kind: String,
    pub intent: Option<Value>,
    pub calls: Vec<CallBody>,
    pub nonce_key: Option<String>,
    pub sequence: Option<i64>,
    pub valid_after: Option<u64>,
    pub valid_until: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecipientBody {
    pub to: String,
    pub amount: String,
    pub label: Option<String>,
    pub memo: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferBody {
    pub recipients: Vec<RecipientBody>,
    pub token: Option<String>,
    pub nonce_key: Option<String>,
    pub valid_until: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceBody {
    pub signer_id: String,
    pub with: SignerBody,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DelaysBody {
    pub config_delay: u64,
    pub recovery_delay: u64,
    pub recovery_co_sign_delay: u64,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SignersProposalBody {
    #[serde(default)]
    pub add: Vec<SignerBody>,
    #[serde(default)]
    pub remove: Vec<String>,
    #[serde(default)]
    pub replace: Vec<ReplaceBody>,
    pub threshold: Option<u16>,
    pub veto_threshold: Option<u16>,
    pub delays: Option<DelaysBody>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LimitProposalBody {
    pub id: Option<u64>,
    pub token: Option<String>,
    pub amount: String,
    pub period: u64,
    pub any_destination: Option<bool>,
    #[serde(default)]
    pub signers: Vec<String>,
    #[serde(default)]
    pub destinations: Vec<String>,
    pub sub_account: Option<u64>,
}

#[derive(Debug, Deserialize)]
pub struct RemoveLimitBody {
    pub id: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmationBody {
    pub signer_id: String,
    pub signature: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddressBookBody {
    pub address: String,
    pub label: String,
    pub category: Option<String>,
    pub signer_id: Option<String>,
    pub signature: Option<String>,
    pub added_at: Option<u64>,
}

// ---------------------------------------------------------------------------
// Linked addresses and membership

pub fn link_message(address: Address, account_id: i64) -> String {
    format!("Recourse treasury link\naddress: {}\naccount: {}", addr(address), account_id)
}

pub async fn link_address(pool: &PgPool, account_id: i64, address: &str, signature: &str) -> Res<LinkedAddress> {
    let address = parse_address(address)?;
    let sig = parse_hex_bytes(signature)?;
    let digest = alloy::primitives::eip191_hash_message(link_message(address, account_id));
    olien::verify_ecdsa(digest, &sig, address).map_err(|e| bad(format!("signature does not prove the address: {e}")))?;
    sqlx::query(
        "INSERT INTO treasury_linked_addresses (account_id, address) VALUES ($1, $2)
         ON CONFLICT (account_id, address) DO NOTHING",
    )
    .bind(account_id)
    .bind(addr(address))
    .execute(pool)
    .await?;
    Ok(LinkedAddress { address: addr(address), linked_at: now() as i64 })
}

pub async fn linked_addresses(pool: &PgPool, account_id: i64) -> Res<Vec<LinkedAddress>> {
    let rows: Vec<(String, DateTime<Utc>)> =
        sqlx::query_as("SELECT address, created_at FROM treasury_linked_addresses WHERE account_id = $1 ORDER BY created_at")
            .bind(account_id)
            .fetch_all(pool)
            .await?;
    Ok(rows
        .into_iter()
        .map(|(address, at)| LinkedAddress { address, linked_at: at.timestamp() })
        .collect())
}

async fn linked_set(pool: &PgPool, account_id: i64) -> Res<HashSet<String>> {
    // Every address a person signs with is one they linked. There is no directory of
    // other accounts to consult, which is the point: an Olien knows its signers and
    // nothing about who the people behind them are elsewhere.
    Ok(linked_addresses(pool, account_id).await?.into_iter().map(|l| l.address).collect())
}

// A member named by @handle. The handle's address is the person's account on Arc: a
// Safe once the app has provisioned one (a contract signer), a plain key before that.
async fn resolve_handles(treasury: &Treasury, signers: &mut [SignerBody]) -> Res<()> {
    for signer in signers.iter_mut() {
        let Some(handle) = signer.handle.as_deref().map(str::trim).filter(|h| !h.is_empty()) else {
            continue;
        };
        let resolved = treasury
            .members
            .resolve(handle)
            .await
            .map_err(|e| bad(format!("@{}: {e}", handle.trim_start_matches('@'))))?;
        let address = resolved.address.to_lowercase();
        // Whether this signer is a contract decides which branch the verifier takes, so
        // it is read off the chain rather than from a directory that could be wrong or
        // out of date. A Safe is code at an address; a plain key is not.
        let contract = match treasury.client.as_ref() {
            Some(client) => client
                .is_contract(parse_address(&address)?)
                .await
                .map_err(|e| TreasuryError::Internal(anyhow!("reading code at {address}: {e}")))?,
            None => false,
        };
        signer.kind = Some(if contract { "contract" } else { "ecdsa" }.into());
        signer.address = Some(address);
        if signer.label.as_deref().map(str::trim).unwrap_or("").is_empty() {
            signer.label = Some(format!("@{}", resolved.handle));
        }
    }
    Ok(())
}

pub async fn load_account(pool: &PgPool, address: &str) -> Res<AccountRow> {
    let address = parse_address(address)?;
    sqlx::query_as::<_, AccountRow>("SELECT * FROM olien_accounts WHERE address = $1")
        .bind(addr(address))
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| TreasuryError::NotFound("no such account".into()))
}

pub async fn load_account_by_id(pool: &PgPool, id: i64) -> Res<AccountRow> {
    sqlx::query_as::<_, AccountRow>("SELECT * FROM olien_accounts WHERE id = $1")
        .bind(id)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| TreasuryError::NotFound("no such account".into()))
}

pub async fn signers_of(pool: &PgPool, olien_id: i64) -> Res<Vec<SignerRow>> {
    Ok(sqlx::query_as::<_, SignerRow>(
        "SELECT signer_id, kind, permissions, flags, address, x, y, label, since, status, synced
         FROM olien_signers WHERE olien_id = $1 ORDER BY since, signer_id",
    )
    .bind(olien_id)
    .fetch_all(pool)
    .await?)
}

/// The caller's standing on an account, or Forbidden. A creator stays a member so an
/// account with a mistyped signer list can still be seen and fixed.
async fn require_member(pool: &PgPool, user: i64, account: &AccountRow, signers: &[SignerRow]) -> Res<Membership> {
    let linked = linked_set(pool, user).await?;
    let signer_ids: Vec<String> = signers
        .iter()
        .filter(|s| s.status == "active")
        .filter(|s| s.address.as_ref().is_some_and(|a| linked.contains(a)))
        .map(|s| s.signer_id.clone())
        .collect();
    let creator = account.created_by == Some(user);
    if !creator && signer_ids.is_empty() {
        return Err(TreasuryError::Forbidden);
    }
    Ok(Membership { creator, signer_ids })
}

// ---------------------------------------------------------------------------
// Accounts

pub async fn list_accounts(pool: &PgPool, user: i64) -> Res<Vec<AccountSummary>> {
    let rows: Vec<AccountRow> = sqlx::query_as(
        "SELECT DISTINCT a.* FROM olien_accounts a
         LEFT JOIN olien_signers s ON s.olien_id = a.id AND s.status = 'active'
         LEFT JOIN treasury_linked_addresses l ON l.address = s.address AND l.account_id = $1
         WHERE a.created_by = $1 OR l.account_id IS NOT NULL
         ORDER BY a.created_at DESC",
    )
    .bind(user)
    .fetch_all(pool)
    .await?;
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let (signer_count,): (i64,) =
            sqlx::query_as("SELECT count(*) FROM olien_signers WHERE olien_id = $1 AND status = 'active'")
                .bind(row.id)
                .fetch_one(pool)
                .await?;
        let (open,): (i64,) = sqlx::query_as(
            "SELECT count(*) FROM olien_proposals WHERE olien_id = $1 AND status IN ('open','ready','blocked','executing','failed')",
        )
        .bind(row.id)
        .fetch_one(pool)
        .await?;
        let (scheduled,): (i64,) =
            sqlx::query_as("SELECT count(*) FROM olien_proposals WHERE olien_id = $1 AND status = 'scheduled'")
                .bind(row.id)
                .fetch_one(pool)
                .await?;
        out.push(AccountSummary {
            address: row.address.clone(),
            name: row.name.clone(),
            status: row.status.clone(),
            threshold: row.threshold,
            signer_count,
            usdc_balance: row.usdc_balance.clone(),
            eurc_balance: row.eurc_balance.clone(),
            open_proposals: open,
            scheduled_changes: scheduled,
            created_at: row.created_at.timestamp(),
        });
    }
    Ok(out)
}

fn permission_bits(names: Option<&[String]>) -> Res<u8> {
    let Some(names) = names else { return Ok(PERM_APPROVE | PERM_VETO) };
    let mut bits = 0u8;
    for name in names {
        bits |= match name.as_str() {
            "approve" => PERM_APPROVE,
            "veto" => PERM_VETO,
            "recover" => PERM_RECOVER,
            other => return Err(bad(format!("unknown permission {other}"))),
        };
    }
    Ok(bits)
}

fn permission_names(bits: i32) -> Vec<&'static str> {
    let mut out = Vec::new();
    if bits & PERM_APPROVE as i32 != 0 {
        out.push("approve");
    }
    if bits & PERM_VETO as i32 != 0 {
        out.push("veto");
    }
    if bits & PERM_RECOVER as i32 != 0 {
        out.push("recover");
    }
    out
}

fn kind_code(name: Option<&str>) -> Res<u8> {
    match name.unwrap_or("ecdsa") {
        "ecdsa" => Ok(KIND_ECDSA),
        "contract" => Ok(KIND_CONTRACT),
        "p256" => Ok(KIND_P256),
        "webauthn" => Ok(KIND_WEBAUTHN),
        other => Err(bad(format!("unknown signer kind {other}"))),
    }
}

fn kind_name(code: u8) -> &'static str {
    match code {
        KIND_ECDSA => "ecdsa",
        KIND_P256 => "p256",
        KIND_WEBAUTHN => "webauthn",
        KIND_CONTRACT => "contract",
        _ => "unknown",
    }
}

/// How the service refers to a signer once the contract has it: by id always, by
/// address for the 20-byte kinds, by coordinates for the P-256 kinds.
pub struct SignerKey {
    pub id: B256,
    pub address: Option<Address>,
    pub x: Option<U256>,
    pub y: Option<U256>,
}

impl SignerKey {
    /// The string labels and intents are keyed by: the address where there is one, the id otherwise.
    fn handle(&self) -> String {
        self.address.map(addr).unwrap_or_else(|| hex(self.id.as_slice()))
    }
}

fn parse_coordinate(value: Option<&str>, name: &str) -> Res<U256> {
    let raw = value.ok_or_else(|| bad(format!("a P-256 signer needs {name}")))?;
    let bytes = parse_hex_bytes(raw)?;
    if bytes.len() != 32 {
        return Err(bad(format!("{name} must be 32 bytes")));
    }
    Ok(U256::from_be_slice(&bytes))
}

/// A signer as the contract takes it: a 20-byte address for ECDSA and CONTRACT, the
/// 64-byte point for P-256 and passkeys (spec §4, key encoding and signer ids).
fn signer_input(body: &SignerBody) -> Res<(SignerInput, SignerKey)> {
    let kind = kind_code(body.kind.as_deref())?;
    let permissions = permission_bits(body.permissions.as_deref())?;
    if kind == KIND_P256 || kind == KIND_WEBAUTHN {
        let x = parse_coordinate(body.x.as_deref(), "x")?;
        let y = parse_coordinate(body.y.as_deref(), "y")?;
        let flags = if kind == KIND_WEBAUTHN && body.uv_required.unwrap_or(true) { FLAG_UV_REQUIRED } else { 0 };
        let key = SignerKey { id: signer_id_of_key(x, y), address: None, x: Some(x), y: Some(y) };
        return Ok((SignerInput { kind, permissions, flags, key: Bytes::from((x, y).abi_encode()) }, key));
    }
    let raw = body.address.as_deref().ok_or_else(|| bad("this signer kind needs an address"))?;
    let address = parse_address(raw)?;
    Ok((
        SignerInput { kind, permissions, flags: 0, key: Bytes::copy_from_slice(address.as_slice()) },
        SignerKey { id: signer_id_of_address(address), address: Some(address), x: None, y: None },
    ))
}

pub async fn create_account(pool: &PgPool, treasury: &Treasury, user: i64, body: CreateAccountBody) -> Res<AccountView> {
    let mut body = body;
    resolve_handles(treasury, &mut body.signers).await?;
    let client = treasury.client.as_ref().ok_or(TreasuryError::Off)?;
    let name = body.name.trim().to_string();
    if name.is_empty() || name.len() > 80 {
        return Err(bad("name must be 1 to 80 characters"));
    }
    if body.signers.is_empty() || body.signers.len() > 32 {
        return Err(bad("1 to 32 signers"));
    }
    let mut inputs = Vec::with_capacity(body.signers.len());
    let mut keys = Vec::with_capacity(body.signers.len());
    let mut labels = HashMap::new();
    let mut seen = HashSet::new();
    for signer in &body.signers {
        let (input, key) = signer_input(signer)?;
        if !seen.insert(key.id) {
            return Err(bad(format!("{} is listed twice", key.handle())));
        }
        labels.insert(key.handle(), signer.label.clone().unwrap_or_default());
        inputs.push(input);
        keys.push(key);
    }
    let approvers = inputs.iter().filter(|s| s.permissions & PERM_APPROVE != 0).count();
    if body.threshold == 0 || body.threshold as usize > approvers {
        return Err(bad(format!("threshold must be between 1 and the {approvers} approving signers")));
    }
    let init = Init {
        signers: inputs,
        threshold: body.threshold,
        vetoThreshold: body.veto_threshold.unwrap_or(0),
        configDelay: olien::u48(body.config_delay.unwrap_or(86_400)),
        recoveryDelay: olien::u48(body.recovery_delay.unwrap_or(86_400)),
        recoveryCoSignDelay: olien::u48(body.recovery_co_sign_delay.unwrap_or(0)),
    };
    let mut salt_bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut salt_bytes);
    let salt = B256::from(salt_bytes);
    let predicted = client.predict_address(&init, salt).await.map_err(|e| TreasuryError::Chain(format!("{e:#}")))?;

    let init_json = json!({
        "signers": body.signers.iter().map(|s| json!({
            "kind": s.kind.clone().unwrap_or_else(|| "ecdsa".into()),
            "address": s.address.as_deref().unwrap_or("").to_lowercase(),
            "x": s.x,
            "y": s.y,
            "label": s.label.clone().unwrap_or_default(),
            "permissions": s.permissions.clone().unwrap_or_else(|| vec!["approve".into(), "veto".into()]),
        })).collect::<Vec<_>>(),
        "threshold": body.threshold,
        "vetoThreshold": body.veto_threshold.unwrap_or(0),
        "configDelay": body.config_delay.unwrap_or(86_400),
        "recoveryDelay": body.recovery_delay.unwrap_or(86_400),
        "recoveryCoSignDelay": body.recovery_co_sign_delay.unwrap_or(0),
    });
    let (id,): (i64,) = sqlx::query_as(
        "INSERT INTO olien_accounts (address, chain_id, name, created_by, threshold, veto_threshold, config_delay,
            recovery_delay, recovery_cosign_delay, init, salt, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'deploying') RETURNING id",
    )
    .bind(addr(predicted))
    .bind(treasury.chain_id as i64)
    .bind(&name)
    .bind(user)
    .bind(body.threshold as i32)
    .bind(body.veto_threshold.unwrap_or(0) as i32)
    .bind(body.config_delay.unwrap_or(86_400) as i64)
    .bind(body.recovery_delay.unwrap_or(86_400) as i64)
    .bind(body.recovery_co_sign_delay.unwrap_or(0) as i64)
    .bind(&init_json)
    .bind(hex(salt.as_slice()))
    .fetch_one(pool)
    .await?;
    for ((signer, key), given) in init.signers.iter().zip(&keys).zip(&body.signers) {
        sqlx::query(
            "INSERT INTO olien_signers (olien_id, signer_id, kind, permissions, flags, address, x, y, label, synced)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT DO NOTHING",
        )
        .bind(id)
        .bind(hex(key.id.as_slice()))
        .bind(kind_name(signer.kind))
        .bind(signer.permissions as i32)
        .bind(signer.flags as i32)
        .bind(key.address.map(addr))
        .bind(key.x.map(|v| v.to_string()))
        .bind(key.y.map(|v| v.to_string()))
        .bind(labels.get(&key.handle()).cloned().unwrap_or_default())
        .bind(given.synced.filter(|_| signer.kind == KIND_WEBAUTHN))
        .execute(pool)
        .await?;
    }

    let created = match client.create_account(&init, salt).await {
        Ok(created) => created,
        Err(error) => {
            sqlx::query("DELETE FROM olien_accounts WHERE id = $1 AND status = 'deploying'")
                .bind(id)
                .execute(pool)
                .await?;
            return Err(TreasuryError::Chain(format!("account creation failed: {error:#}")));
        }
    };
    sqlx::query(
        "UPDATE olien_accounts SET status = 'live', create_tx = $2, created_block = $3, indexed_block = $3 - 1, updated_at = now()
         WHERE id = $1",
    )
    .bind(id)
    .bind(hex(created.tx_hash.as_slice()))
    .bind(created.block as i64)
    .execute(pool)
    .await?;

    if !hashes_as_the_account_does(client, treasury.chain_id, predicted).await? {
        sqlx::query("UPDATE olien_accounts SET status = 'disabled', updated_at = now() WHERE id = $1")
            .bind(id)
            .execute(pool)
            .await?;
        return Err(TreasuryError::Chain(
            "the account's transaction hash does not match the service's; the account is disabled".into(),
        ));
    }

    let row = load_account_by_id(pool, id).await?;
    refresh_account_from_chain(pool, client, &row).await?;
    audit::record(pool, row.id, &row.address, Some(user), None, "account.created", None, json!({ "name": row.name, "threshold": body.threshold, "signers": body.signers.len() })).await;
    account_view(pool, treasury, user, &row.address).await
}

/// The once-per-account guard of 06-algorithms.md §1: the hash the service will ask
/// people to sign must be the contract's own, or nothing is signed against it. The
/// contract hashes with its own epoch and the lane's sequence, so both are read rather
/// than assumed.
async fn hashes_as_the_account_does(client: &OlienClient, chain_id: u64, account: Address) -> Res<bool> {
    let chain = |e: anyhow::Error| TreasuryError::Chain(format!("{e:#}"));
    let sample = Transaction {
        nonceKey: alloy::primitives::Uint::<192, 3>::from(7u64),
        calls: vec![Call { to: account, value: U256::from(1u64), data: Bytes::from_static(b"\x01\x02") }],
        validAfter: olien::u48(1),
        validUntil: olien::u48(2),
    };
    let onchain = client.transaction_hash_onchain(account, &sample).await.map_err(chain)?;
    let config = client.config(account).await.map_err(chain)?;
    let sequence = client.nonce(account, U256::from(7u64)).await.map_err(chain)?;
    let local = olien::transaction_hash(chain_id, account, olien::nonce_of(U256::from(7u64), sequence), config.epoch, &sample.calls, 1, 2);
    Ok(onchain == local)
}

#[derive(Debug, Deserialize)]
pub struct ImportBody {
    pub address: String,
    pub name: Option<String>,
}

/// Bring an Olien that already exists on the chain into this service.
///
/// Everything the chain decides is only mirrored here, and until this existed that was
/// true of everything except the account itself: a row came only from creating the
/// account through this service, so a lost database, or a team moving to a service of
/// its own, left an account on the chain that no console could open. This rebuilds the
/// row from the chain. It carries no authority: who the signers are, and what they may
/// do, is read from the account, and the caller has to be one of them.
///
/// What cannot be rebuilt is what was never on the chain: labels, the name, and
/// proposals still collecting signatures. History before the import is not indexed.
pub async fn import_account(pool: &PgPool, treasury: &Treasury, user: i64, body: ImportBody) -> Res<AccountView> {
    let client = treasury.client.as_ref().ok_or(TreasuryError::Off)?;
    let account = parse_address(&body.address)?;
    let name = body.name.as_deref().map(str::trim).filter(|n| !n.is_empty()).unwrap_or("Imported Olien").to_string();
    if name.chars().count() > 80 {
        return Err(bad("name must be 1 to 80 characters"));
    }
    let known: Option<(String,)> = sqlx::query_as("SELECT address FROM olien_accounts WHERE address = $1").bind(addr(account)).fetch_optional(pool).await?;
    if let Some((address,)) = known {
        // Already here: a member sees it, and anyone else is told what anyone else is.
        return account_view(pool, treasury, user, &address).await;
    }
    let chain = |e: anyhow::Error| TreasuryError::Chain(format!("{e:#}"));
    // Every account the factory makes is the same proxy, so its code has one hash.
    if client.code_hash(account).await.map_err(chain)? != canonical::account_code_hash() {
        return Err(bad("there is no Olien at this address on this chain"));
    }
    if client.implementation(account).await.map_err(chain)? != client.deployment.implementation {
        return Err(bad("this Olien runs an implementation this service does not serve"));
    }
    let signers = client.signers(account).await.map_err(chain)?;
    let linked = linked_set(pool, user).await?;
    let member = signers
        .iter()
        .filter(|(_, view)| view.kind == KIND_ECDSA || view.kind == KIND_CONTRACT)
        .filter_map(|(id, _)| address_of_signer_id(*id))
        .any(|address| linked.contains(&addr(address)));
    if !member {
        return Err(TreasuryError::Forbidden);
    }
    if !hashes_as_the_account_does(client, treasury.chain_id, account).await? {
        return Err(TreasuryError::Chain("the account's transaction hash does not match the service's; it was not added".into()));
    }
    let config = client.config(account).await.map_err(chain)?;
    let block = client.block_number().await.map_err(chain)? as i64;
    // created_by stays empty: the importer's standing is the chain's, as a signer, and
    // being the one who typed the address in gives nothing beyond that.
    sqlx::query(
        "INSERT INTO olien_accounts (address, chain_id, name, threshold, veto_threshold, config_delay, recovery_delay,
            recovery_cosign_delay, init, salt, status, created_block, indexed_block)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '{}'::jsonb, '', 'live', $9, $9) ON CONFLICT (address) DO NOTHING",
    )
    .bind(addr(account))
    .bind(treasury.chain_id as i64)
    .bind(&name)
    .bind(config.threshold as i32)
    .bind(config.vetoThreshold as i32)
    .bind(config.configDelay.to::<u64>() as i64)
    .bind(config.recoveryDelay.to::<u64>() as i64)
    .bind(config.recoveryCoSignDelay.to::<u64>() as i64)
    .bind(block)
    .execute(pool)
    .await?;
    let row = load_account(pool, &addr(account)).await?;
    refresh_account_from_chain(pool, client, &row).await?;
    audit::record(pool, row.id, &row.address, Some(user), None, "account.imported", None, json!({ "name": row.name, "fromBlock": block })).await;
    account_view(pool, treasury, user, &row.address).await
}

/// Config, signers, balances and lanes from the chain into the row. The indexer calls
/// this on every tick; the write routes call it after their own transaction lands.
pub async fn refresh_account_from_chain(pool: &PgPool, client: &OlienClient, row: &AccountRow) -> anyhow::Result<()> {
    let account = row.address();
    let config = client.config(account).await.context("reading config")?;
    let implementation = client.implementation(account).await.context("reading implementation")?;
    sqlx::query(
        "UPDATE olien_accounts SET epoch = $2, threshold = $3, veto_threshold = $4, effective_veto_threshold = $5,
            config_delay = $6, recovery_delay = $7, recovery_cosign_delay = $8, implementation = $9,
            implementation_frozen = $10, updated_at = now() WHERE id = $1",
    )
    .bind(row.id)
    .bind(config.epoch as i64)
    .bind(config.threshold as i32)
    .bind(config.vetoThreshold as i32)
    .bind(config.effectiveVetoThreshold as i32)
    .bind(config.configDelay.to::<u64>() as i64)
    .bind(config.recoveryDelay.to::<u64>() as i64)
    .bind(config.recoveryCoSignDelay.to::<u64>() as i64)
    .bind(addr(implementation))
    .bind(config.implementationFrozen)
    .execute(pool)
    .await?;

    let signers = client.signers(account).await.context("reading signers")?;
    let mut live = HashSet::new();
    for (id, view) in &signers {
        live.insert(hex(id.as_slice()));
        let address = address_of_signer_id(*id).filter(|_| view.kind == KIND_ECDSA || view.kind == KIND_CONTRACT);
        sqlx::query(
            "INSERT INTO olien_signers (olien_id, signer_id, kind, permissions, flags, address, x, y, since, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'active')
             ON CONFLICT (olien_id, signer_id) DO UPDATE SET kind = EXCLUDED.kind, permissions = EXCLUDED.permissions,
                flags = EXCLUDED.flags, address = EXCLUDED.address, x = EXCLUDED.x, y = EXCLUDED.y,
                since = EXCLUDED.since, status = 'active'",
        )
        .bind(row.id)
        .bind(hex(id.as_slice()))
        .bind(kind_name(view.kind))
        .bind(view.permissions as i32)
        .bind(view.flags as i32)
        .bind(address.map(addr))
        .bind(if view.kind == KIND_P256 || view.kind == KIND_WEBAUTHN { Some(view.x.to_string()) } else { None })
        .bind(if view.kind == KIND_P256 || view.kind == KIND_WEBAUTHN { Some(view.y.to_string()) } else { None })
        .bind(view.since as i64)
        .execute(pool)
        .await?;
    }
    let rows: Vec<(String,)> =
        sqlx::query_as("SELECT signer_id FROM olien_signers WHERE olien_id = $1 AND status = 'active'")
            .bind(row.id)
            .fetch_all(pool)
            .await?;
    for (signer_id,) in rows {
        if !live.contains(&signer_id) {
            sqlx::query("UPDATE olien_signers SET status = 'removed' WHERE olien_id = $1 AND signer_id = $2")
                .bind(row.id)
                .bind(&signer_id)
                .execute(pool)
                .await?;
        }
    }
    // A signer that arrived through a proposal takes the label its proposer gave it,
    // once the chain shows it; the intent keeps labels by address or by signer id.
    let intents: Vec<(serde_json::Value,)> =
        sqlx::query_as("SELECT intent FROM olien_proposals WHERE olien_id = $1 AND kind = 'signer_change'")
            .bind(row.id)
            .fetch_all(pool)
            .await?;
    for (intent,) in intents {
        for entry in intent.get("labels").and_then(|v| v.as_array()).into_iter().flatten() {
            let Some(handle) = entry.get("address").and_then(|v| v.as_str()) else {
                continue;
            };
            if let Some(label) = entry.get("label").and_then(|v| v.as_str()).filter(|l| !l.is_empty()) {
                sqlx::query("UPDATE olien_signers SET label = $3 WHERE olien_id = $1 AND label = '' AND (address = $2 OR signer_id = $2)")
                    .bind(row.id)
                    .bind(handle)
                    .bind(label)
                    .execute(pool)
                    .await?;
            }
            if let Some(synced) = entry.get("synced").and_then(|v| v.as_bool()) {
                sqlx::query("UPDATE olien_signers SET synced = $3 WHERE olien_id = $1 AND synced IS NULL AND kind = 'webauthn' AND signer_id = $2")
                    .bind(row.id)
                    .bind(handle)
                    .bind(synced)
                    .execute(pool)
                    .await?;
            }
        }
    }

    let balance = client.usdc_balance(account).await.context("reading the USDC balance")?;
    let euros = client.eurc_balance(account).await.context("reading the EURC balance")?;
    let deposit = client.entry_point_deposit(account).await.context("reading the EntryPoint deposit")?;
    sqlx::query("UPDATE olien_accounts SET usdc_balance = $2, entry_point_deposit = $3, eurc_balance = $4 WHERE id = $1")
        .bind(row.id)
        .bind(balance.to_string())
        .bind(deposit.to_string())
        .bind(euros.to_string())
        .execute(pool)
        .await?;

    let mut keys: BTreeSet<String> = BTreeSet::new();
    keys.insert("0".into());
    let in_use: Vec<(String,)> = sqlx::query_as(
        "SELECT DISTINCT nonce_key FROM olien_proposals WHERE olien_id = $1
         AND status IN ('open','ready','blocked','executing','failed')",
    )
    .bind(row.id)
    .fetch_all(pool)
    .await?;
    keys.extend(in_use.into_iter().map(|(k,)| k));
    for key in keys {
        let key_value = U256::from_str_radix(&key, 10).unwrap_or(U256::ZERO);
        let sequence = client.nonce(account, key_value).await.context("reading a lane")?;
        sqlx::query(
            "INSERT INTO olien_lanes (olien_id, nonce_key, chain_sequence) VALUES ($1, $2, $3)
             ON CONFLICT (olien_id, nonce_key) DO UPDATE SET chain_sequence = EXCLUDED.chain_sequence",
        )
        .bind(row.id)
        .bind(&key)
        .bind(sequence as i64)
        .execute(pool)
        .await?;
    }
    Ok(())
}

async fn lanes_of(pool: &PgPool, olien_id: i64) -> Res<Vec<LaneRow>> {
    Ok(sqlx::query_as::<_, LaneRow>("SELECT nonce_key, chain_sequence FROM olien_lanes WHERE olien_id = $1 ORDER BY nonce_key")
        .bind(olien_id)
        .fetch_all(pool)
        .await?)
}

pub async fn account_view(pool: &PgPool, treasury: &Treasury, user: i64, address: &str) -> Res<AccountView> {
    let row = load_account(pool, address).await?;
    let signers = signers_of(pool, row.id).await?;
    let membership = require_member(pool, user, &row, &signers).await?;
    let mine: HashSet<&String> = membership.signer_ids.iter().collect();
    let limits: Vec<LimitRow> = sqlx::query_as(
        "SELECT limit_id, generation, token, from_address, amount, remaining, period, reset_at, any_destination,
            signers, destinations FROM olien_spending_limits WHERE olien_id = $1 AND status = 'active' ORDER BY limit_id",
    )
    .bind(row.id)
    .fetch_all(pool)
    .await?;
    let subs: Vec<SubAccountRow> =
        sqlx::query_as("SELECT index, address, label FROM olien_sub_accounts WHERE olien_id = $1 ORDER BY index")
            .bind(row.id)
            .fetch_all(pool)
            .await?;
    let lanes = lanes_of(pool, row.id).await?;
    Ok(AccountView {
        address: row.address.clone(),
        name: row.name.clone(),
        status: row.status.clone(),
        chain_id: treasury.chain_id as i64,
        implementation: row.implementation.clone(),
        implementation_frozen: row.implementation_frozen,
        epoch: row.epoch,
        threshold: row.threshold,
        veto_threshold: row.veto_threshold,
        effective_veto_threshold: row.effective_veto_threshold,
        config_delay: row.config_delay,
        recovery_delay: row.recovery_delay,
        recovery_co_sign_delay: row.recovery_cosign_delay,
        signers: signers
            .iter()
            .filter(|s| s.status == "active")
            .map(|s| SignerJson {
                signer_id: s.signer_id.clone(),
                kind: s.kind.clone(),
                address: s.address.clone(),
                x: s.x.clone(),
                y: s.y.clone(),
                label: s.label.clone(),
                permissions: permission_names(s.permissions),
                since: s.since,
                mine: mine.contains(&s.signer_id),
                synced: s.synced,
            })
            .collect(),
        usdc_balance: row.usdc_balance.clone(),
        eurc_balance: row.eurc_balance.clone(),
        entry_point_deposit: row.entry_point_deposit.clone(),
        lanes: lanes.into_iter().map(|l| LaneJson { nonce_key: l.nonce_key, chain_sequence: l.chain_sequence }).collect(),
        limits: limits
            .into_iter()
            .map(|l| LimitJson {
                id: l.limit_id,
                generation: l.generation,
                token: l.token,
                from: l.from_address,
                amount: l.amount,
                remaining: l.remaining,
                period: l.period,
                reset_at: l.reset_at,
                any_destination: l.any_destination,
                signers: l.signers,
                destinations: l.destinations,
            })
            .collect(),
        sub_accounts: subs.into_iter().map(|s| SubAccountJson { index: s.index, address: s.address, label: s.label }).collect(),
        create_tx: row.create_tx.clone(),
        created_at: row.created_at.timestamp(),
        membership,
    })
}

// ---------------------------------------------------------------------------
// Proposals

fn calls_from_json(value: &Value) -> Res<Vec<Call>> {
    let items = value.as_array().ok_or_else(|| bad("calls must be a list"))?;
    items
        .iter()
        .map(|item| {
            let to = parse_address(item.get("to").and_then(Value::as_str).unwrap_or(""))?;
            let value = parse_amount(item.get("value").and_then(Value::as_str).unwrap_or("0"))?;
            let data = parse_hex_bytes(item.get("data").and_then(Value::as_str).unwrap_or("0x"))?;
            Ok(Call { to, value, data: data.into() })
        })
        .collect()
}

fn calls_to_json(calls: &[Call]) -> Value {
    Value::Array(
        calls
            .iter()
            .map(|c| json!({ "to": addr(c.to), "value": c.value.to_string(), "data": hex(&c.data) }))
            .collect(),
    )
}

fn format_usdc(amount: U256) -> String {
    let whole = amount / U256::from(1_000_000u64);
    let frac = (amount % U256::from(1_000_000u64)).to::<u64>();
    format!("{whole}.{:02}", frac / 10_000)
}

fn short(address: Address) -> String {
    let s = addr(address);
    format!("{}…{}", &s[..6], &s[s.len() - 4..])
}

/// Calldata for people (06-algorithms.md §12): the token's transfer, the account's own
/// selectors, then raw. A call to the account with an unknown selector is refused at
/// proposal time, so decoded rows never carry one.
fn decode_call(call: &Call, account: Address, usdc: Address, signers: &[SignerRow], book: &HashMap<String, String>) -> DecodedCall {
    let selector: [u8; 4] = call.data.get(..4).and_then(|s| s.try_into().ok()).unwrap_or([0; 4]);
    let selector_hex = hex(&selector);
    let label_of = |address: Address| book.get(&addr(address)).cloned().unwrap_or_else(|| short(address));
    let signer_label = |id: B256| {
        signers
            .iter()
            .find(|s| s.signer_id == hex(id.as_slice()))
            .map(|s| if s.label.is_empty() { s.signer_id[..10].to_string() } else { s.label.clone() })
            .unwrap_or_else(|| hex(&id.as_slice()[..4]))
    };
    if call.to == usdc {
        if let Ok(t) = olien::IERC20::transferCall::abi_decode(&call.data) {
            return DecodedCall {
                to: addr(call.to),
                label: "USDC".into(),
                summary: format!("Send {} USDC to {}", format_usdc(t.amount), label_of(t.to)),
                selector: selector_hex,
                readable: true,
            };
        }
    }
    if call.to == account {
        let summary = match olien::account_selector(selector).map(|s| s.name) {
            Some("addSigner") => IOlien::addSignerCall::abi_decode(&call.data).ok().map(|c| {
                let who = if c.input.key.len() == 20 { addr(Address::from_slice(&c.input.key)) } else { "a P-256 key".into() };
                format!("add signer {who} ({}, {})", kind_name(c.input.kind), permission_names(c.input.permissions as i32).join("+"))
            }),
            Some("removeSigner") => IOlien::removeSignerCall::abi_decode(&call.data).ok().map(|c| format!("remove signer {}", signer_label(c.id))),
            Some("replaceSigner") => IOlien::replaceSignerCall::abi_decode(&call.data).ok().map(|c| {
                let who = if c.input.key.len() == 20 { addr(Address::from_slice(&c.input.key)) } else { "a P-256 key".into() };
                format!("replace signer {} with {who}", signer_label(c.oldId))
            }),
            Some("setThreshold") => IOlien::setThresholdCall::abi_decode(&call.data).ok().map(|c| format!("set threshold to {}", c.newThreshold)),
            Some("setVetoThreshold") => IOlien::setVetoThresholdCall::abi_decode(&call.data).ok().map(|c| {
                if c.newVetoThreshold == 0 { "set veto threshold to automatic".to_string() } else { format!("set veto threshold to {}", c.newVetoThreshold) }
            }),
            Some("setDelays") => IOlien::setDelaysCall::abi_decode(&call.data).ok().map(|c| {
                format!("set delays: rule changes {}, recovery {}, co-signed recovery {}", human(c.configDelay.to::<u64>()), human(c.recoveryDelay.to::<u64>()), human(c.recoveryCoSignDelay.to::<u64>()))
            }),
            Some("setSpendingLimit") => IOlien::setSpendingLimitCall::abi_decode(&call.data).ok().map(|c| {
                format!("set spending limit {}: {} USDC per {}{}", if c.id.is_zero() { "(new)".to_string() } else { c.id.to_string() }, format_usdc(U256::from(c.input.amount)), human(c.input.period.to::<u64>()), if c.input.anyDestination { ", any destination" } else { ", listed destinations only" })
            }),
            Some("allowLimitSigner") => IOlien::allowLimitSignerCall::abi_decode(&call.data).ok().map(|c| format!("allow {} to spend under limit {}", signer_label(c.signerId), c.id)),
            Some("allowLimitDestination") => IOlien::allowLimitDestinationCall::abi_decode(&call.data).ok().map(|c| format!("allow limit {} to pay {}", c.id, addr(c.to))),
            Some("removeSpendingLimit") => IOlien::removeSpendingLimitCall::abi_decode(&call.data).ok().map(|c| format!("remove spending limit {}", c.id)),
            Some("cancel") => IOlien::cancelCall::abi_decode(&call.data).ok().map(|c| format!("cancel proposal {}", hex(c.hash.as_slice()))),
            Some("setImplementation") => IOlien::setImplementationCall::abi_decode(&call.data).ok().map(|c| format!("move to implementation {}", addr(c.newImplementation))),
            Some("freezeImplementation") => Some("freeze the implementation forever".to_string()),
            _ => None,
        };
        if let Some(summary) = summary {
            return DecodedCall { to: addr(call.to), label: "this account".into(), summary, selector: selector_hex, readable: true };
        }
    }
    DecodedCall {
        to: addr(call.to),
        label: label_of(call.to),
        summary: format!("call {} with {} bytes of data{}", addr(call.to), call.data.len(), if call.value.is_zero() { String::new() } else { format!(" and {} wei", call.value) }),
        selector: selector_hex,
        readable: false,
    }
}

pub fn human(seconds: u64) -> String {
    if seconds == 0 {
        "no delay".into()
    } else if seconds.is_multiple_of(86_400) {
        let d = seconds / 86_400;
        format!("{d} day{}", if d == 1 { "" } else { "s" })
    } else if seconds.is_multiple_of(3_600) {
        let h = seconds / 3_600;
        format!("{h} hour{}", if h == 1 { "" } else { "s" })
    } else if seconds.is_multiple_of(60) {
        format!("{} minutes", seconds / 60)
    } else {
        format!("{seconds} seconds")
    }
}

fn touches_config(calls: &[Call], account: Address) -> bool {
    calls.iter().any(|c| {
        c.to == account
            && c.data.get(..4).and_then(|s| s.try_into().ok()).and_then(|s: [u8; 4]| olien::account_selector(s)).is_some_and(|s| s.config)
    })
}

fn typed_data(chain_id: u64, account: Address, nonce: U256, epoch: u64, calls: &[Call], valid_after: u64, valid_until: u64) -> Value {
    json!({
        "domain": { "name": "Olien", "version": "1", "chainId": chain_id, "verifyingContract": addr(account) },
        "types": {
            "EIP712Domain": [
                { "name": "name", "type": "string" }, { "name": "version", "type": "string" },
                { "name": "chainId", "type": "uint256" }, { "name": "verifyingContract", "type": "address" }
            ],
            "Call": [ { "name": "to", "type": "address" }, { "name": "value", "type": "uint256" }, { "name": "data", "type": "bytes" } ],
            "Transaction": [
                { "name": "nonce", "type": "uint256" }, { "name": "epoch", "type": "uint64" }, { "name": "calls", "type": "Call[]" },
                { "name": "validAfter", "type": "uint48" }, { "name": "validUntil", "type": "uint48" }
            ]
        },
        "primaryType": "Transaction",
        "message": {
            "nonce": nonce.to_string(), "epoch": epoch, "calls": calls_to_json(calls),
            "validAfter": valid_after, "validUntil": valid_until
        }
    })
}

pub(crate) struct AccountContext {
    pub(crate) row: AccountRow,
    pub(crate) signers: Vec<SignerRow>,
    pub(crate) membership: Membership,
}

pub(crate) async fn context_for(pool: &PgPool, user: i64, address: &str) -> Res<AccountContext> {
    let row = load_account(pool, address).await?;
    let signers = signers_of(pool, row.id).await?;
    let membership = require_member(pool, user, &row, &signers).await?;
    Ok(AccountContext { row, signers, membership })
}

pub(crate) fn require_live(row: &AccountRow) -> Res<()> {
    match row.status.as_str() {
        "live" => Ok(()),
        "deploying" => Err(TreasuryError::Conflict("the account is still being created".into())),
        _ => Err(TreasuryError::Conflict("this account is disabled".into())),
    }
}

pub async fn create_proposal(pool: &PgPool, treasury: &Treasury, user: i64, address: &str, body: NewProposalBody, via_key: Option<i64>) -> Res<ProposalView> {
    let client = treasury.client.as_ref().ok_or(TreasuryError::Off)?;
    let ctx = context_for(pool, user, address).await?;
    require_live(&ctx.row)?;
    let account = ctx.row.address();
    let calls: Vec<Call> = body
        .calls
        .iter()
        .map(|c| {
            Ok(Call {
                to: parse_address(&c.to)?,
                value: parse_amount(c.value.as_deref().unwrap_or("0"))?,
                data: parse_hex_bytes(&c.data)?.into(),
            })
        })
        .collect::<Res<_>>()?;
    for call in &calls {
        if call.to == account {
            let selector: Option<[u8; 4]> = call.data.get(..4).and_then(|s| s.try_into().ok());
            if selector.and_then(olien::account_selector).is_none() {
                return Err(bad("a call to the account itself must use one of its configuration functions, cancel or removeSpendingLimit"));
            }
        }
    }
    let kind = match body.kind.as_str() {
        "transfer" | "batch" | "signer_change" | "rule_change" | "limit_change" | "cancel" | "contract_call" => body.kind.clone(),
        other => return Err(bad(format!("unknown kind {other}"))),
    };
    let intent = body.intent.unwrap_or_else(|| json!({}));
    describes(&kind, &intent, &calls, account, &client.tokens()).map_err(bad)?;
    insert_proposal(pool, client, treasury.chain_id, &ctx, user, kind, intent, calls, body.nonce_key, body.sequence, body.valid_after, body.valid_until, via_key).await
}

/// A call as the payment it is, when it is one: a canonical `transfer(to, amount)` on
/// one of the treasury's tokens, carrying no value.
fn payment_of(call: &Call, tokens: &[Address]) -> Option<(Address, U256)> {
    if !tokens.contains(&call.to) || !call.value.is_zero() {
        return None;
    }
    let transfer = olien::IERC20::transferCall::abi_decode(&call.data).ok()?;
    // Decoding tolerates trailing bytes and dirty padding; only the bytes that encode
    // back to themselves are the payment they look like.
    (transfer.abi_encode() == call.data.as_ref()).then_some((transfer.to, transfer.amount))
}

/// Whether a proposal's kind and intent say what its calls do.
///
/// The kind and the intent are the proposer's words, kept beside the calls so the queue
/// can read "September payroll" instead of twelve transfers. Anything that renders them
/// is trusting them, and the generic route took any words with any calls, from any
/// member and from any API key that may propose. So words that contradict the calls
/// are refused here. A client still must not rely on this: the console reads the
/// calldata itself, because a service that has been compromised checks nothing.
pub(crate) fn describes(kind: &str, intent: &Value, calls: &[Call], account: Address, tokens: &[Address]) -> Result<(), String> {
    let payments: Vec<Option<(Address, U256)>> = calls.iter().map(|call| payment_of(call, tokens)).collect();
    let all_payments = !calls.is_empty() && payments.iter().all(Option::is_some);
    let all_own = !calls.is_empty() && calls.iter().all(|call| call.to == account);
    let honest = match kind {
        "transfer" => all_payments && calls.len() == 1,
        "batch" | "payroll" => all_payments,
        "signer_change" | "rule_change" | "limit_change" | "cancel" => all_own,
        _ => true,
    };
    if !honest {
        return Err(format!("a {kind} proposal's calls must be what the kind says; file anything else as contract_call"));
    }
    let Some(recipients) = intent.get("recipients") else { return Ok(()) };
    let recipients = recipients.as_array().ok_or("intent.recipients must be a list")?;
    if recipients.len() != calls.len() {
        return Err(format!("the intent describes {} payments and there are {} calls", recipients.len(), calls.len()));
    }
    for (index, (claimed, actual)) in recipients.iter().zip(&payments).enumerate() {
        let to = claimed.get("to").and_then(Value::as_str).and_then(|t| t.trim().parse::<Address>().ok());
        let amount = claimed.get("amount").and_then(Value::as_str).and_then(|a| U256::from_str_radix(a.trim(), 10).ok());
        match (actual, to, amount) {
            (Some((paid_to, paid)), Some(to), Some(amount)) if *paid_to == to && *paid == amount => {}
            _ => return Err(format!("the intent's recipient {} is not what call {} pays", index + 1, index + 1)),
        }
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn insert_proposal(
    pool: &PgPool,
    client: &OlienClient,
    chain_id: u64,
    ctx: &AccountContext,
    user: i64,
    kind: String,
    intent: Value,
    calls: Vec<Call>,
    nonce_key: Option<String>,
    sequence: Option<i64>,
    valid_after: Option<u64>,
    valid_until: Option<u64>,
    via_key: Option<i64>,
) -> Res<ProposalView> {
    let account = ctx.row.address();
    let key_text = nonce_key.unwrap_or_else(|| "0".into());
    let key = U256::from_str_radix(key_text.trim(), 10).map_err(|_| bad("nonceKey must be a decimal number"))?;
    if key.bit_len() > 192 {
        return Err(bad("nonceKey must fit in 192 bits"));
    }
    let key_text = key.to_string();
    let valid_after = valid_after.unwrap_or(0);
    let valid_until = valid_until.unwrap_or_else(|| now() + DEFAULT_VALIDITY);
    if valid_until <= now() {
        return Err(bad("validUntil is in the past"));
    }
    if valid_until > now() + MAX_VALIDITY {
        return Err(bad("validUntil may be at most 30 days out"));
    }
    if valid_after >= valid_until {
        return Err(bad("validAfter must be before validUntil"));
    }

    let chain_sequence = client.nonce(account, key).await.map_err(|e| TreasuryError::Chain(format!("{e:#}")))? as i64;
    sqlx::query(
        "INSERT INTO olien_lanes (olien_id, nonce_key, chain_sequence) VALUES ($1, $2, $3)
         ON CONFLICT (olien_id, nonce_key) DO UPDATE SET chain_sequence = EXCLUDED.chain_sequence",
    )
    .bind(ctx.row.id)
    .bind(&key_text)
    .bind(chain_sequence)
    .execute(pool)
    .await?;
    let sequence = match sequence {
        Some(s) if s < chain_sequence => return Err(TreasuryError::Conflict(format!("sequence {s} is already spent; the lane is at {chain_sequence}"))),
        Some(s) => s,
        None => {
            let (highest,): (Option<i64>,) = sqlx::query_as(
                "SELECT max(sequence) FROM olien_proposals WHERE olien_id = $1 AND nonce_key = $2
                 AND status IN ('open','ready','blocked','executing','failed')",
            )
            .bind(ctx.row.id)
            .bind(&key_text)
            .fetch_one(pool)
            .await?;
            highest.map(|h| h + 1).unwrap_or(chain_sequence).max(chain_sequence)
        }
    };
    let epoch = ctx.row.epoch as u64;
    let nonce = olien::nonce_of(key, sequence as u64);
    let hash = olien::transaction_hash(chain_id, account, nonce, epoch, &calls, valid_after, valid_until);
    let hash_text = hex(hash.as_slice());
    let path = "threshold";

    let simulation = client.simulate(account, &calls).await;
    let (sim_ok, sim_error) = match &simulation {
        Ok(()) => (true, None),
        Err(e) => (false, Some(format!("{e:#}"))),
    };

    let inserted = sqlx::query(
        "INSERT INTO olien_proposals (olien_id, tx_hash, nonce_key, sequence, epoch, calls, valid_after, valid_until, kind, intent,
            path, status, proposer, simulation_ok, simulation_error, simulated_at, api_key_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'open', $12, $13, $14, $15, $16)
         ON CONFLICT (tx_hash) DO NOTHING",
    )
    .bind(ctx.row.id)
    .bind(&hash_text)
    .bind(&key_text)
    .bind(sequence)
    .bind(epoch as i64)
    .bind(calls_to_json(&calls))
    .bind(valid_after as i64)
    .bind(valid_until as i64)
    .bind(&kind)
    .bind(&intent)
    .bind(path)
    .bind(user)
    .bind(sim_ok)
    .bind(sim_error)
    .bind(now() as i64)
    .bind(via_key)
    .execute(pool)
    .await?;
    if inserted.rows_affected() == 0 {
        return Err(TreasuryError::Conflict("this exact transaction is already proposed".into()));
    }
    refresh_statuses(pool, &ctx.row).await?;
    audit::record(pool, ctx.row.id, &ctx.row.address, Some(user), via_key, "proposal.opened", Some(&hash_text), json!({ "kind": kind, "calls": calls.len() })).await;
    let view = proposal_view(pool, chain_id, user, &ctx.row, &hash_text).await?;
    // The other members learn about this through a webhook on the proposals topic,
    // which reads olien_proposals.updated_at and so covers every proposal rather than
    // only the ones a notifier was wired for.
    Ok(view)
}

/// The calls and the intent for paying a list of people, shared by a one-off transfer
/// and a payroll run. Returns the calls, the intent rows, the total and the token.
pub(crate) fn transfer_batch(client: &OlienClient, recipients: &[RecipientBody], token: Option<&str>) -> Res<(Vec<Call>, Vec<Value>, U256, Address)> {
    if recipients.is_empty() || recipients.len() > 200 {
        return Err(bad("1 to 200 recipients"));
    }
    let token = match token {
        Some(t) => parse_address(t)?,
        None => client.usdc,
    };
    let mut calls = Vec::with_capacity(recipients.len());
    let mut intent_rows = Vec::new();
    let mut total = U256::ZERO;
    for r in recipients {
        let to = parse_address(&r.to)?;
        let amount = parse_amount(&r.amount)?;
        if amount.is_zero() {
            return Err(bad("an amount must be positive"));
        }
        total += amount;
        calls.push(Call { to: token, value: U256::ZERO, data: calldata::usdc_transfer(to, amount) });
        intent_rows.push(json!({ "to": addr(to), "amount": amount.to_string(), "label": r.label, "memo": r.memo }));
    }
    Ok((calls, intent_rows, total, token))
}

pub async fn propose_transfer(pool: &PgPool, treasury: &Treasury, user: i64, address: &str, body: TransferBody, via_key: Option<i64>) -> Res<ProposalView> {
    let client = treasury.client.as_ref().ok_or(TreasuryError::Off)?;
    let ctx = context_for(pool, user, address).await?;
    require_live(&ctx.row)?;
    let (calls, intent_rows, total, token) = transfer_batch(client, &body.recipients, body.token.as_deref())?;
    let intent = json!({ "recipients": intent_rows, "token": addr(token), "total": total.to_string() });
    let kind = if body.recipients.len() == 1 { "transfer" } else { "batch" };
    insert_proposal(pool, client, treasury.chain_id, &ctx, user, kind.into(), intent, calls, body.nonce_key, None, None, body.valid_until, via_key).await
}

/// A payroll run as a proposal: the template's recipients as one batch, kind
/// `payroll`, in the payroll lane, named after the run so the queue reads "September
/// payroll" rather than "12 calls". Needs the same signatures as anything else.
pub async fn propose_payroll(
    pool: &PgPool,
    treasury: &Treasury,
    user: i64,
    address: &str,
    payroll_id: i64,
    name: &str,
    recipients: &[RecipientBody],
    token: Option<&str>,
    via_key: Option<i64>,
) -> Res<ProposalView> {
    let client = treasury.client.as_ref().ok_or(TreasuryError::Off)?;
    let ctx = context_for(pool, user, address).await?;
    require_live(&ctx.row)?;
    let (calls, intent_rows, total, token) = transfer_batch(client, recipients, token)?;
    let intent = json!({
        "recipients": intent_rows,
        "token": addr(token),
        "total": total.to_string(),
        "payroll": { "id": payroll_id, "name": name },
    });
    insert_proposal(pool, client, treasury.chain_id, &ctx, user, "payroll".into(), intent, calls, Some(PAYROLL_LANE.into()), None, None, None, via_key).await
}

pub async fn propose_signers(pool: &PgPool, treasury: &Treasury, user: i64, address: &str, body: SignersProposalBody) -> Res<ProposalView> {
    let mut body = body;
    resolve_handles(treasury, &mut body.add).await?;
    for replacement in body.replace.iter_mut() {
        resolve_handles(treasury, std::slice::from_mut(&mut replacement.with)).await?;
    }
    let client = treasury.client.as_ref().ok_or(TreasuryError::Off)?;
    let ctx = context_for(pool, user, address).await?;
    require_live(&ctx.row)?;
    let account = ctx.row.address();
    let mut calls = Vec::new();
    let mut labels: Vec<(String, String, Option<bool>)> = Vec::new();
    for s in &body.add {
        let (input, key) = signer_input(s)?;
        labels.push((key.handle(), s.label.clone().unwrap_or_default(), s.synced.filter(|_| input.kind == KIND_WEBAUTHN)));
        calls.push(Call { to: account, value: U256::ZERO, data: calldata::add_signer(input) });
    }
    for id in &body.remove {
        calls.push(Call { to: account, value: U256::ZERO, data: calldata::remove_signer(parse_hash(id)?) });
    }
    for r in &body.replace {
        let (input, key) = signer_input(&r.with)?;
        labels.push((key.handle(), r.with.label.clone().unwrap_or_default(), r.with.synced.filter(|_| input.kind == KIND_WEBAUTHN)));
        calls.push(Call { to: account, value: U256::ZERO, data: calldata::replace_signer(parse_hash(&r.signer_id)?, input) });
    }
    if let Some(t) = body.threshold {
        calls.push(Call { to: account, value: U256::ZERO, data: calldata::set_threshold(t) });
    }
    if let Some(v) = body.veto_threshold {
        calls.push(Call { to: account, value: U256::ZERO, data: calldata::set_veto_threshold(v) });
    }
    if let Some(d) = &body.delays {
        calls.push(Call { to: account, value: U256::ZERO, data: calldata::set_delays(d.config_delay, d.recovery_delay, d.recovery_co_sign_delay) });
    }
    if calls.is_empty() {
        return Err(bad("nothing to change"));
    }
    let intent = json!({ "labels": labels.iter().map(|(a, l, s)| json!({ "address": a, "label": l, "synced": s })).collect::<Vec<_>>() });
    let kind = if body.add.is_empty() && body.remove.is_empty() && body.replace.is_empty() { "rule_change" } else { "signer_change" };
    insert_proposal(pool, client, treasury.chain_id, &ctx, user, kind.into(), intent, calls, None, None, None, None, None).await
}

pub async fn propose_limit(pool: &PgPool, treasury: &Treasury, user: i64, address: &str, body: LimitProposalBody) -> Res<ProposalView> {
    let client = treasury.client.as_ref().ok_or(TreasuryError::Off)?;
    let ctx = context_for(pool, user, address).await?;
    require_live(&ctx.row)?;
    let account = ctx.row.address();
    let token = match &body.token {
        Some(t) => parse_address(t)?,
        None => client.usdc,
    };
    let amount = parse_amount(&body.amount)?;
    if amount.is_zero() || amount.bit_len() > 128 {
        return Err(bad("amount must be positive and fit in 128 bits"));
    }
    if body.period == 0 {
        return Err(bad("period must be positive"));
    }
    // A new limit takes the next id; the account assigns it as limitCount + 1, and the
    // follow-up calls in the same batch must name it (spec §7.6).
    let id = match body.id {
        Some(id) => id,
        None => {
            let config = client.config(account).await.map_err(|e| TreasuryError::Chain(format!("{e:#}")))?;
            config.limitCount.to::<u64>() + 1
        }
    };
    let input = SpendingLimitInput {
        token,
        subAccount: U256::from(body.sub_account.map(|i| i + 1).unwrap_or(0)),
        amount: amount.to::<u128>(),
        period: olien::u48(body.period),
        anyDestination: body.any_destination.unwrap_or(body.destinations.is_empty()),
    };
    let mut calls = vec![Call { to: account, value: U256::ZERO, data: calldata::set_spending_limit(body.id.unwrap_or(0), input) }];
    for s in &body.signers {
        calls.push(Call { to: account, value: U256::ZERO, data: calldata::allow_limit_signer(id, parse_hash(s)?) });
    }
    for d in &body.destinations {
        calls.push(Call { to: account, value: U256::ZERO, data: calldata::allow_limit_destination(id, parse_address(d)?) });
    }
    let intent = json!({ "limitId": id, "token": addr(token), "amount": amount.to_string(), "period": body.period, "signers": body.signers, "destinations": body.destinations });
    insert_proposal(pool, client, treasury.chain_id, &ctx, user, "limit_change".into(), intent, calls, None, None, None, None, None).await
}

pub async fn propose_remove_limit(pool: &PgPool, treasury: &Treasury, user: i64, address: &str, body: RemoveLimitBody) -> Res<ProposalView> {
    let client = treasury.client.as_ref().ok_or(TreasuryError::Off)?;
    let ctx = context_for(pool, user, address).await?;
    require_live(&ctx.row)?;
    let account = ctx.row.address();
    let calls = vec![Call { to: account, value: U256::ZERO, data: calldata::remove_spending_limit(body.id) }];
    insert_proposal(pool, client, treasury.chain_id, &ctx, user, "limit_change".into(), json!({ "removeLimitId": body.id }), calls, None, None, None, None, None).await
}

/// A proposal from calls the service built itself, in the default lane.
pub(crate) async fn propose_calls(pool: &PgPool, treasury: &Treasury, user: i64, address: &str, kind: String, intent: Value, calls: Vec<Call>) -> Res<ProposalView> {
    let client = treasury.client.as_ref().ok_or(TreasuryError::Off)?;
    let ctx = context_for(pool, user, address).await?;
    require_live(&ctx.row)?;
    insert_proposal(pool, client, treasury.chain_id, &ctx, user, kind, intent, calls, None, None, None, None, None).await
}

pub async fn propose_cancel(pool: &PgPool, treasury: &Treasury, user: i64, address: &str, tx_hash: &str) -> Res<ProposalView> {
    let client = treasury.client.as_ref().ok_or(TreasuryError::Off)?;
    let ctx = context_for(pool, user, address).await?;
    require_live(&ctx.row)?;
    let target = load_proposal(pool, ctx.row.id, tx_hash).await?;
    if !matches!(target.status.as_str(), "open" | "ready" | "blocked" | "failed") {
        return Err(TreasuryError::Conflict(format!("a {} proposal cannot be cancelled this way", target.status)));
    }
    let account = ctx.row.address();
    let calls = vec![Call { to: account, value: U256::ZERO, data: calldata::cancel(parse_hash(tx_hash)?) }];
    insert_proposal(pool, client, treasury.chain_id, &ctx, user, "cancel".into(), json!({ "cancels": target.tx_hash }), calls, None, None, None, None, None).await
}

async fn load_proposal(pool: &PgPool, olien_id: i64, tx_hash: &str) -> Res<ProposalRow> {
    let hash = parse_hash(tx_hash)?;
    sqlx::query_as::<_, ProposalRow>("SELECT * FROM olien_proposals WHERE olien_id = $1 AND tx_hash = $2")
        .bind(olien_id)
        .bind(hex(hash.as_slice()))
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| TreasuryError::NotFound("no such proposal".into()))
}

async fn confirmations_of(pool: &PgPool, proposal_id: i64) -> Res<Vec<ConfirmationRow>> {
    Ok(sqlx::query_as::<_, ConfirmationRow>(
        "SELECT signer_id, signature, kind, signed_at FROM olien_confirmations WHERE proposal_id = $1 ORDER BY signed_at",
    )
    .bind(proposal_id)
    .fetch_all(pool)
    .await?)
}

/// The entries a current approver has signed, each with the time inside its signature.
/// An entry vouched for by someone who is no longer a signer is nobody's word any more.
async fn known_destinations(pool: &PgPool, olien_id: i64) -> Res<HashMap<Address, u64>> {
    let rows: Vec<(String, i64)> = sqlx::query_as(
        "SELECT b.address, b.added_at FROM olien_address_book b
         JOIN olien_signers s ON s.olien_id = b.olien_id AND s.signer_id = b.signer_id
         WHERE b.olien_id = $1 AND b.signature IS NOT NULL AND b.added_at IS NOT NULL AND s.status = 'active' AND s.permissions & 1 <> 0",
    )
    .bind(olien_id)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().filter_map(|(address, at)| Some((address.parse().ok()?, at.max(0) as u64))).collect())
}

/// The account's own addresses: itself and its sub-accounts. Moving money between them
/// is not paying anyone.
async fn own_addresses(pool: &PgPool, account: &AccountRow) -> Res<HashSet<Address>> {
    let subs: Vec<(String,)> = sqlx::query_as("SELECT address FROM olien_sub_accounts WHERE olien_id = $1").bind(account.id).fetch_all(pool).await?;
    Ok(subs.into_iter().filter_map(|(address,)| address.parse().ok()).chain(std::iter::once(account.address())).collect())
}

/// What the treasury's policy needs to know about an account, read once and held
/// against as many proposals as a request touches.
pub(crate) struct SoftContext {
    policy: Policy,
    known: HashMap<Address, u64>,
    internal: HashSet<Address>,
    approvers: i64,
    threshold: i64,
    account: Address,
    disputed: bool,
}

impl SoftContext {
    pub(crate) async fn load(pool: &PgPool, account: &AccountRow, signers: &[SignerRow]) -> Res<SoftContext> {
        let policy = policy_of(pool, account).await?;
        let (known, internal) = match policy.require_known_destination {
            true => (known_destinations(pool, account.id).await?, own_addresses(pool, account).await?),
            false => (HashMap::new(), HashSet::new()),
        };
        Ok(SoftContext {
            policy,
            known,
            internal,
            approvers: signers.iter().filter(|s| s.status == "active" && s.approves()).count() as i64,
            threshold: account.threshold as i64,
            account: account.address(),
            disputed: is_disputed(account.id),
        })
    }

    /// The rules holding these calls back, and the approvals they need.
    pub(crate) fn rules(&self, calls: &[Call], approvals: i64, now: u64) -> (Vec<SoftRule>, i64) {
        let tokens = chain_tokens();
        let mut payments = Vec::new();
        let mut unreadable = Vec::new();
        for call in calls.iter().filter(|call| call.to != self.account) {
            match payment_of(call, &tokens) {
                Some(payment) => payments.push(payment),
                None => unreadable.push(call.to),
            }
        }
        self.rules_for(&payments, &unreadable, approvals, now)
    }

    pub(crate) fn rules_for(&self, payments: &[(Address, U256)], unreadable: &[Address], approvals: i64, now: u64) -> (Vec<SoftRule>, i64) {
        let facts = policy::Facts { payments, unreadable, approvals, approvers: self.approvers, threshold: self.threshold, now, known: &self.known, internal: &self.internal };
        let mut rules = policy::evaluate(&self.policy, &facts);
        if self.disputed {
            rules.push(SoftRule {
                rule: "rpc",
                text: "The service's two views of the chain disagree about this account. Nothing is marked ready until they agree.".into(),
                until: None,
            });
        }
        (rules, policy::required_approvals(&self.policy, &facts))
    }
}

/// Approvals that count: distinct confirmations from active signers holding APPROVE.
fn count_approvals(confirmations: &[ConfirmationRow], signers: &[SignerRow]) -> i64 {
    confirmations
        .iter()
        .filter(|c| signers.iter().any(|s| s.signer_id == c.signer_id && s.status == "active" && s.approves()))
        .count() as i64
}

/// The queue's derived states (06-algorithms.md §5) for every proposal still in play.
pub async fn refresh_statuses(pool: &PgPool, account: &AccountRow) -> Res<()> {
    let signers = signers_of(pool, account.id).await?;
    let lanes: HashMap<String, i64> = lanes_of(pool, account.id).await?.into_iter().map(|l| (l.nonce_key, l.chain_sequence)).collect();
    let open: Vec<ProposalRow> = sqlx::query_as(
        "SELECT * FROM olien_proposals WHERE olien_id = $1 AND status IN ('open','ready','blocked') ORDER BY nonce_key, sequence",
    )
    .bind(account.id)
    .fetch_all(pool)
    .await?;
    let ts = now() as i64;
    let soft = match open.is_empty() {
        true => None,
        false => Some(SoftContext::load(pool, account, &signers).await?),
    };
    for p in &open {
        let next = match p.status.as_str() {
            _ if p.epoch != account.epoch => "stale",
            _ if p.valid_until < ts => "expired",
            _ => {
                let chain_sequence = lanes.get(&p.nonce_key).copied().unwrap_or(0);
                if p.sequence < chain_sequence {
                    "replaced"
                } else {
                    let confirmations = confirmations_of(pool, p.id).await?;
                    let approvals = count_approvals(&confirmations, &signers);
                    // The chain's floor first, then the treasury's own rules: enough
                    // signatures for the account is not always enough for the policy,
                    // and a proposal it holds stays open until it lets go.
                    let held = match &soft {
                        Some(soft) if approvals >= account.threshold as i64 => !soft.rules(&calls_from_json(&p.calls)?, approvals, ts as u64).0.is_empty(),
                        _ => false,
                    };
                    if approvals >= account.threshold as i64 && !held {
                        if p.sequence == chain_sequence { "ready" } else { "blocked" }
                    } else {
                        "open"
                    }
                }
            }
        };
        if next != p.status {
            sqlx::query("UPDATE olien_proposals SET status = $2, updated_at = now() WHERE id = $1")
                .bind(p.id)
                .bind(next)
                .execute(pool)
                .await?;
        }
    }
    Ok(())
}

pub(crate) async fn proposal_view(pool: &PgPool, chain_id: u64, user: i64, account: &AccountRow, tx_hash: &str) -> Res<ProposalView> {
    let row = load_proposal(pool, account.id, tx_hash).await?;
    let signers = signers_of(pool, account.id).await?;
    let linked = linked_set(pool, user).await?;
    let book = address_book_map(pool, account.id).await?;
    let soft = SoftContext::load(pool, account, &signers).await?;
    build_view(pool, chain_id, account, &row, &signers, &linked, &book, &soft).await
}

/// Labels for the addresses a current approver has signed into the book. An unsigned
/// row, or one whose signer has left, labels nothing.
pub(crate) async fn address_book_map(pool: &PgPool, olien_id: i64) -> Res<HashMap<String, String>> {
    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT b.address, b.label FROM olien_address_book b
         JOIN olien_signers s ON s.olien_id = b.olien_id AND s.signer_id = b.signer_id
         WHERE b.olien_id = $1 AND b.signature IS NOT NULL AND s.status = 'active' AND s.permissions & 1 <> 0",
    )
    .bind(olien_id)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().collect())
}

#[allow(clippy::too_many_arguments)]
async fn build_view(
    pool: &PgPool,
    chain_id: u64,
    account: &AccountRow,
    row: &ProposalRow,
    signers: &[SignerRow],
    linked: &HashSet<String>,
    book: &HashMap<String, String>,
    soft: &SoftContext,
) -> Res<ProposalView> {
    let account_address = account.address();
    let calls = calls_from_json(&row.calls)?;
    let usdc = book_usdc();
    let confirmations = confirmations_of(pool, row.id).await?;
    let vetoes: Vec<VetoRow> = sqlx::query_as("SELECT signer_id, tx, block_time FROM olien_vetoes WHERE proposal_id = $1 ORDER BY block_time")
        .bind(row.id)
        .fetch_all(pool)
        .await?;
    let label_of = |id: &str| signers.iter().find(|s| s.signer_id == id).map(|s| s.label.clone()).unwrap_or_default();
    let is_mine = |id: &str| signers.iter().any(|s| s.signer_id == id && s.address.as_ref().is_some_and(|a| linked.contains(a)));
    let approvals = count_approvals(&confirmations, signers);
    // Only a proposal still in play is held to the policy; one that has run is history.
    let (soft_rules, required) = match row.status.as_str() {
        "open" | "ready" | "blocked" | "failed" => soft.rules(&calls, approvals, now()),
        _ => (Vec::new(), account.threshold as i64),
    };
    let missing: Vec<MissingJson> = signers
        .iter()
        .filter(|s| s.status == "active" && s.approves() && !confirmations.iter().any(|c| c.signer_id == s.signer_id))
        .map(|s| MissingJson { signer_id: s.signer_id.clone(), label: s.label.clone(), mine: is_mine(&s.signer_id) })
        .collect();
    let blocked_by = if row.status == "blocked" {
        let (lower,): (Option<i64>,) = sqlx::query_as(
            "SELECT min(sequence) FROM olien_proposals WHERE olien_id = $1 AND nonce_key = $2 AND sequence < $3
             AND status IN ('open','ready','blocked','executing','failed')",
        )
        .bind(account.id)
        .bind(&row.nonce_key)
        .bind(row.sequence)
        .fetch_one(pool)
        .await?;
        lower
    } else {
        None
    };
    let mut hard_rules = Vec::new();
    if touches_config(&calls, account_address) {
        let vetoes_needed = account.effective_veto_threshold;
        hard_rules.push(HardRule {
            rule: "delay",
            seconds: account.config_delay as u64,
            text: format!(
                "Executing schedules this change for {}; {} veto{} stop{} it.",
                human(account.config_delay as u64),
                vetoes_needed,
                if vetoes_needed == 1 { "" } else { "es" },
                if vetoes_needed == 1 { "s" } else { "" }
            ),
        });
    }
    // A proposal a key opened says so beside the member it acted as, since "Payroll
    // opened this" is the thing the other signers need to know before they sign.
    let via: Option<String> = match row.api_key_id {
        Some(key_id) => sqlx::query_scalar("SELECT name FROM olien_api_keys WHERE id = $1")
            .bind(key_id)
            .fetch_optional(pool)
            .await?,
        None => None,
    };
    let proposer = match row.proposer {
        Some(id) => {
            // A wallet account has no name or email; its address is how the team knows it.
            let name: Option<(Option<String>, Option<String>, String, String)> = sqlx::query_as(
                "SELECT given_name, email, provider, provider_subject FROM accounts WHERE account_id = $1",
            )
            .bind(id)
            .fetch_optional(pool)
            .await?;
            name.map(|(given, email, provider, subject)| Proposer {
                account_id: id,
                name: given
                    .or(email)
                    .or_else(|| (provider == "wallet").then_some(subject))
                    .unwrap_or_else(|| format!("member {id}")),
                via: via.clone(),
            })
        }
        None => None,
    };
    let nonce_key = U256::from_str_radix(&row.nonce_key, 10).unwrap_or(U256::ZERO);
    let nonce = olien::nonce_of(nonce_key, row.sequence as u64);
    Ok(ProposalView {
        tx_hash: row.tx_hash.clone(),
        account: account.address.clone(),
        nonce_key: row.nonce_key.clone(),
        sequence: row.sequence,
        nonce: nonce.to_string(),
        epoch: row.epoch,
        kind: row.kind.clone(),
        intent: row.intent.clone(),
        calls: row.calls.clone(),
        decoded: calls.iter().map(|c| decode_call(c, account_address, usdc, signers, book)).collect(),
        valid_after: row.valid_after,
        valid_until: row.valid_until,
        path: row.path.clone(),
        status: row.status.clone(),
        confirmations: confirmations
            .iter()
            .map(|c| ConfirmationJson {
                signer_id: c.signer_id.clone(),
                address: signers.iter().find(|s| s.signer_id == c.signer_id).and_then(|s| s.address.clone()),
                label: label_of(&c.signer_id),
                kind: c.kind.clone(),
                signed_at: c.signed_at.timestamp(),
            })
            .collect(),
        required: required as i32,
        approvals,
        missing,
        blocked_by,
        hard_rules,
        soft_rules,
        simulation: row.simulation_ok.map(|ok| Simulation { ok, error: row.simulation_error.clone(), checked_at: row.simulated_at.unwrap_or(0) }),
        scheduled_ready_at: row.scheduled_ready_at,
        scheduled_window_ends_at: row.scheduled_window_ends,
        scheduled_excluded: row.scheduled_excluded.clone(),
        vetoes: vetoes
            .iter()
            .map(|v| VetoJson { signer_id: v.signer_id.clone(), label: label_of(&v.signer_id), tx: v.tx.clone(), at: v.block_time })
            .collect(),
        effective_veto_threshold: account.effective_veto_threshold,
        executed_tx: row.executed_tx.clone(),
        executed_at: row.executed_at,
        failure: row.failure.clone(),
        proposer,
        created_at: row.created_at.timestamp(),
        typed_data: typed_data(chain_id, account_address, nonce, row.epoch as u64, &calls, row.valid_after as u64, row.valid_until as u64),
    })
}

// The decoder and the ledger run where no client is at hand, so the chain's USDC is
// set once at boot. One process serves one chain, which is what makes a process-wide
// value honest here. Before this it was Arc's address alone, so on Monad a payment
// decoded as a raw call and a ledger row named its token "token".
static CHAIN_TOKENS: std::sync::OnceLock<Vec<Address>> = std::sync::OnceLock::new();

pub fn set_chain_tokens(usdc: Address, eurc: Option<Address>) {
    let _ = CHAIN_TOKENS.set(std::iter::once(usdc).chain(eurc).collect());
}

/// The tokens a treasury on this chain holds, dollars first.
fn chain_tokens() -> Vec<Address> {
    CHAIN_TOKENS.get().cloned().unwrap_or_else(|| vec!["0x3600000000000000000000000000000000000000".parse().unwrap_or(Address::ZERO)])
}

fn book_usdc() -> Address {
    chain_tokens().first().copied().unwrap_or(Address::ZERO)
}

// The accounts the two RPCs last told different stories about. Kept in the process and
// not in the database because it is a statement about right now: a restart asks again.
static DISPUTED: std::sync::OnceLock<Mutex<HashSet<i64>>> = std::sync::OnceLock::new();

pub fn mark_disputed(olien_id: i64, disputed: bool) {
    let mut set = DISPUTED.get_or_init(Default::default).lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if disputed { set.insert(olien_id) } else { set.remove(&olien_id) };
}

fn is_disputed(olien_id: i64) -> bool {
    DISPUTED.get().is_some_and(|set| set.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).contains(&olien_id))
}

/// The ledger stores the token that moved, so a row can name itself. Anything we do
/// not know is called a token rather than guessed at.
/// What a ledger row holds when it is gas rather than a token: on Arc that is USDC
/// too, but with 18 decimals and paid from the EntryPoint deposit, so it is kept
/// apart from the dollars the balance counts.
pub const GAS_TOKEN: &str = "gas";

fn symbol_for(token: &str) -> String {
    if token == addr(book_usdc()) {
        "USDC".into()
    } else if token.eq_ignore_ascii_case("0x89b50855aa3be2f677cd6303cec089b5f319d72a") {
        "EURC".into()
    } else if token == GAS_TOKEN {
        "gas".into()
    } else {
        "token".into()
    }
}

/// The decimals a ledger amount is in, by the symbol the row was given.
fn decimals_for(symbol: &str) -> u8 {
    if symbol == "gas" { 18 } else { 6 }
}

pub async fn list_proposals(pool: &PgPool, treasury: &Treasury, user: i64, address: &str, statuses: Option<&str>) -> Res<Vec<ProposalView>> {
    let ctx = context_for(pool, user, address).await?;
    refresh_statuses(pool, &ctx.row).await?;
    let wanted: Vec<String> = statuses
        .map(|s| s.split(',').map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect())
        .unwrap_or_default();
    let rows: Vec<ProposalRow> = if wanted.is_empty() {
        sqlx::query_as("SELECT * FROM olien_proposals WHERE olien_id = $1 ORDER BY created_at DESC LIMIT 200")
            .bind(ctx.row.id)
            .fetch_all(pool)
            .await?
    } else {
        sqlx::query_as("SELECT * FROM olien_proposals WHERE olien_id = $1 AND status = ANY($2) ORDER BY created_at DESC LIMIT 200")
            .bind(ctx.row.id)
            .bind(&wanted)
            .fetch_all(pool)
            .await?
    };
    let linked = linked_set(pool, user).await?;
    let book = address_book_map(pool, ctx.row.id).await?;
    let soft = SoftContext::load(pool, &ctx.row, &ctx.signers).await?;
    let mut out = Vec::with_capacity(rows.len());
    for row in &rows {
        out.push(build_view(pool, treasury.chain_id, &ctx.row, row, &ctx.signers, &linked, &book, &soft).await?);
    }
    Ok(out)
}

pub async fn get_proposal(pool: &PgPool, treasury: &Treasury, user: i64, address: &str, tx_hash: &str) -> Res<ProposalView> {
    let ctx = context_for(pool, user, address).await?;
    refresh_statuses(pool, &ctx.row).await?;
    proposal_view(pool, treasury.chain_id, user, &ctx.row, tx_hash).await
}

pub async fn delete_proposal(pool: &PgPool, user: i64, address: &str, tx_hash: &str) -> Res<()> {
    let ctx = context_for(pool, user, address).await?;
    let row = load_proposal(pool, ctx.row.id, tx_hash).await?;
    if !matches!(row.status.as_str(), "open" | "stale" | "expired" | "failed") {
        return Err(TreasuryError::Conflict(format!("a {} proposal cannot be deleted", row.status)));
    }
    let confirmations = confirmations_of(pool, row.id).await?;
    if !confirmations.is_empty() && row.status == "open" {
        return Err(TreasuryError::Conflict("a proposal with confirmations is cancelled on chain, not deleted".into()));
    }
    sqlx::query("DELETE FROM olien_proposals WHERE id = $1").bind(row.id).execute(pool).await?;
    audit::record(pool, ctx.row.id, &ctx.row.address, Some(user), None, "proposal.deleted", Some(&row.tx_hash), json!({ "kind": row.kind })).await;
    Ok(())
}

pub async fn confirm(pool: &PgPool, treasury: &Treasury, user: i64, address: &str, tx_hash: &str, body: ConfirmationBody) -> Res<ProposalView> {
    let client = treasury.client.as_ref().ok_or(TreasuryError::Off)?;
    let ctx = context_for(pool, user, address).await?;
    require_live(&ctx.row)?;
    refresh_statuses(pool, &ctx.row).await?;
    let row = load_proposal(pool, ctx.row.id, tx_hash).await?;
    if !matches!(row.status.as_str(), "open" | "ready" | "blocked" | "failed") {
        return Err(TreasuryError::Conflict(format!("a {} proposal takes no more confirmations", row.status)));
    }
    let signer_id = hex(parse_hash(&body.signer_id)?.as_slice());
    let signer = ctx
        .signers
        .iter()
        .find(|s| s.signer_id == signer_id && s.status == "active")
        .ok_or_else(|| bad("not a signer of this account"))?;
    let hash = parse_hash(&row.tx_hash)?;
    let signature = parse_hex_bytes(&body.signature)?;
    let kind = if signature.is_empty() {
        let approved = client
            .is_approved(ctx.row.address(), hash, parse_hash(&signer_id)?)
            .await
            .map_err(|e| TreasuryError::Chain(format!("{e:#}")))?;
        if !approved {
            return Err(bad("no on-chain approval from this signer for this hash"));
        }
        "onchain"
    } else {
        check_signature(client, &ctx, signer, hash, &signature).await?;
        "offchain"
    };
    sqlx::query(
        "INSERT INTO olien_confirmations (proposal_id, signer_id, signature, kind) VALUES ($1, $2, $3, $4)
         ON CONFLICT (proposal_id, signer_id) DO UPDATE SET signature = EXCLUDED.signature, kind = EXCLUDED.kind, signed_at = now()",
    )
    .bind(row.id)
    .bind(&signer_id)
    .bind(&signature)
    .bind(kind)
    .execute(pool)
    .await?;
    audit::record(pool, ctx.row.id, &ctx.row.address, Some(user), None, "proposal.approved", Some(&row.tx_hash), json!({ "signerId": signer_id, "how": kind })).await;
    refresh_statuses(pool, &ctx.row).await?;
    proposal_view(pool, treasury.chain_id, user, &ctx.row, tx_hash).await
}

/// An off-chain signature from a member, checked exactly as the contract will check
/// it (spec §5.2), so a refusal comes now and with a reason. Accepted only from a
/// signer the caller controls: a linked address for ECDSA and contract signers, while
/// a P-256 or passkey signature over this very hash is its own proof of control.
pub(crate) async fn check_signature(client: &OlienClient, ctx: &AccountContext, signer: &SignerRow, hash: B256, signature: &[u8]) -> Res<()> {
    let key_based = matches!(signer.kind.as_str(), "p256" | "webauthn");
    if !key_based && !ctx.membership.signer_ids.contains(&signer.signer_id) {
        return Err(TreasuryError::Forbidden);
    }
    let check = match signer.kind.as_str() {
        "ecdsa" => {
            let expected = parse_address(signer.address.as_deref().unwrap_or(""))?;
            olien::verify_ecdsa(hash, signature, expected)
        }
        "p256" => olien::verify_p256_raw(hash, signature, key_part(signer.x.as_deref())?, key_part(signer.y.as_deref())?),
        "webauthn" => olien::verify_webauthn(
            hash,
            signature,
            key_part(signer.x.as_deref())?,
            key_part(signer.y.as_deref())?,
            signer.flags & FLAG_UV_REQUIRED as i32 != 0,
        ),
        "contract" => {
            let member = parse_address(signer.address.as_deref().unwrap_or(""))?;
            match client.is_valid_signature(member, hash, signature).await {
                Ok(true) => Ok(()),
                Ok(false) => Err(anyhow!("the member account does not accept this signature")),
                Err(e) => Err(e),
            }
        }
        other => Err(anyhow!("unsupported signer kind {other}")),
    };
    check.map_err(|e| bad(format!("signature refused: {e:#}")))
}

fn key_part(value: Option<&str>) -> Res<U256> {
    U256::from_str_radix(value.unwrap_or(""), 10).map_err(|_| TreasuryError::Internal(anyhow!("a P-256 signer without key coordinates")))
}

// The name lives in the service, not on chain, so any member may change it at once.
pub async fn rename_account(pool: &PgPool, treasury: &Treasury, user: i64, address: &str, name: &str) -> Res<AccountView> {
    let ctx = context_for(pool, user, address).await?;
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 80 {
        return Err(bad("name must be 1 to 80 characters"));
    }
    sqlx::query("UPDATE olien_accounts SET name = $2 WHERE id = $1").bind(ctx.row.id).bind(name).execute(pool).await?;
    audit::record(pool, ctx.row.id, &ctx.row.address, Some(user), None, "account.renamed", None, json!({ "from": ctx.row.name, "to": name })).await;
    account_view(pool, treasury, user, address).await
}

/// Bring one of this Olien's sub-accounts into being, and name it.
///
/// The contract lets anyone deploy it, because the address is a deterministic clone
/// only this Olien can operate: creating it grants nothing. What it does cost is gas,
/// so the relayer pays and the caller has to be a signer, which is also the only way
/// we know whose treasury it is. The index is chosen here rather than asked for, so
/// two people pressing the button do not fight over the same one.
pub async fn create_sub_account(
    pool: &PgPool,
    treasury: &Treasury,
    user: i64,
    address: &str,
    label: &str,
) -> Res<AccountView> {
    let client = treasury.client.as_ref().ok_or(TreasuryError::Off)?;
    let ctx = context_for(pool, user, address).await?;
    require_live(&ctx.row)?;
    let label = label.trim();
    if label.chars().count() > 80 {
        return Err(bad("a label is at most 80 characters"));
    }

    let next: Option<(i64,)> = sqlx::query_as("SELECT MAX(index) FROM olien_sub_accounts WHERE olien_id = $1")
        .bind(ctx.row.id)
        .fetch_optional(pool)
        .await?;
    let index = next.map(|(max,)| max + 1).unwrap_or(0);
    let account = parse_address(address)?;
    let index_u = U256::from(index as u64);

    // Ask the chain where it will land before deploying, so the row we write is the
    // address the contract will actually use rather than one we worked out ourselves.
    let predicted = client
        .sub_account_address(account, index_u)
        .await
        .map_err(|e| TreasuryError::Chain(format!("{e:#}")))?;
    let sent = client
        .create_sub_account(account, index_u)
        .await
        .map_err(|e| TreasuryError::Chain(format!("{e:#}")))?;

    sqlx::query(
        "INSERT INTO olien_sub_accounts (olien_id, index, address, label, created_tx) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (olien_id, index) DO UPDATE SET label = EXCLUDED.label, created_tx = EXCLUDED.created_tx",
    )
    .bind(ctx.row.id)
    .bind(index)
    .bind(addr(predicted))
    .bind(label)
    .bind(format!("{:#x}", sent.tx_hash))
    .execute(pool)
    .await?;

    account_view(pool, treasury, user, address).await
}

pub async fn execute(pool: &PgPool, treasury: &Treasury, user: i64, address: &str, tx_hash: &str) -> Res<ProposalView> {
    let client = treasury.client.as_ref().ok_or(TreasuryError::Off)?;
    let ctx = context_for(pool, user, address).await?;
    require_live(&ctx.row)?;
    refresh_statuses(pool, &ctx.row).await?;
    let row = load_proposal(pool, ctx.row.id, tx_hash).await?;
    let confirmations = confirmations_of(pool, row.id).await?;
    let approvals = count_approvals(&confirmations, &ctx.signers);
    let account = ctx.row.address();
    let calls = calls_from_json(&row.calls)?;
    // The policy is asked here, at the moment of sending, and before the queue's state
    // is: a retry of a failed proposal skips those states, hours and a new
    // destination's wait are about now, and a proposal the policy is holding is "open",
    // which by itself would tell the member nothing about why.
    if approvals >= ctx.row.threshold as i64 && matches!(row.status.as_str(), "open" | "ready" | "failed") {
        let (held, _) = SoftContext::load(pool, &ctx.row, &ctx.signers).await?.rules(&calls, approvals, now());
        if let Some(rule) = held.first() {
            return Err(TreasuryError::Conflict(format!("held by treasury policy: {}", rule.text)));
        }
    }
    if !(row.status == "ready" || (row.status == "failed" && approvals >= ctx.row.threshold as i64)) {
        return Err(TreasuryError::Conflict(format!("the proposal is {}, not ready", row.status)));
    }
    let lane = U256::from_str_radix(&row.nonce_key, 10).unwrap_or(U256::ZERO);
    if let Some(what) = client.disagreement(account, &[lane]).await.map_err(|e| TreasuryError::Chain(format!("{e:#}")))? {
        mark_disputed(ctx.row.id, true);
        return Err(TreasuryError::Conflict(format!("the service's two views of the chain disagree about {what}; nothing is sent until they agree")));
    }
    let mut entries: Vec<(B256, Vec<u8>)> = Vec::new();
    for c in &confirmations {
        let signer = ctx.signers.iter().find(|s| s.signer_id == c.signer_id && s.status == "active");
        if signer.is_some_and(|s| s.approves()) {
            entries.push((parse_hash(&c.signer_id)?, c.signature.clone()));
        }
    }
    let packed = olien::pack(&entries)?;
    let txn = Transaction {
        nonceKey: alloy::primitives::Uint::<192, 3>::from(U256::from_str_radix(&row.nonce_key, 10).unwrap_or(U256::ZERO)),
        calls: calls.clone(),
        validAfter: olien::u48(row.valid_after as u64),
        validUntil: olien::u48(row.valid_until as u64),
    };
    let claimed = sqlx::query("UPDATE olien_proposals SET status = 'executing', failure = NULL, updated_at = now() WHERE id = $1 AND status IN ('ready','failed')")
        .bind(row.id)
        .execute(pool)
        .await?;
    if claimed.rows_affected() == 0 {
        return Err(TreasuryError::Conflict("someone else is executing this proposal".into()));
    }
    match client.execute(account, &txn, packed).await {
        Ok(sent) => {
            tracing::info!("executed {} for {} in {:#x} (block {}, {} gas)", row.tx_hash, ctx.row.address, sent.tx_hash, sent.block, sent.gas_used);
            let scheduled = touches_config(&calls, account);
            if scheduled {
                let entry = client.scheduled(account, parse_hash(&row.tx_hash)?).await.map_err(|e| TreasuryError::Chain(format!("{e:#}")))?;
                let ready_at = entry.readyAt.to::<u64>() as i64;
                sqlx::query(
                    "UPDATE olien_proposals SET status = 'scheduled', executed_tx = $2, scheduled_ready_at = $3, scheduled_window_ends = $4,
                        scheduled_excluded = $5, updated_at = now() WHERE id = $1",
                )
                .bind(row.id)
                .bind(hex(sent.tx_hash.as_slice()))
                .bind(ready_at)
                .bind(ready_at + SCHEDULE_WINDOW as i64)
                .bind(if entry.excluded.is_zero() { None } else { Some(hex(entry.excluded.as_slice())) })
                .execute(pool)
                .await?;
            } else {
                sqlx::query("UPDATE olien_proposals SET status = 'executed', executed_tx = $2, executed_at = $3, updated_at = now() WHERE id = $1")
                    .bind(row.id)
                    .bind(hex(sent.tx_hash.as_slice()))
                    .bind(now() as i64)
                    .execute(pool)
                    .await?;
            }
            mark_replaced(pool, ctx.row.id, &row.nonce_key, row.sequence, row.id).await?;
            audit::record(pool, ctx.row.id, &ctx.row.address, Some(user), None, "proposal.executed", Some(&row.tx_hash), json!({ "tx": hex(sent.tx_hash.as_slice()), "scheduled": scheduled })).await;
            if let Err(e) = refresh_account_from_chain(pool, client, &ctx.row).await {
                tracing::warn!("refresh after execute failed: {e:#}");
            }
            let fresh = load_account_by_id(pool, ctx.row.id).await?;
            refresh_statuses(pool, &fresh).await?;
            proposal_view(pool, treasury.chain_id, user, &fresh, tx_hash).await
        }
        Err(error) => {
            let text = format!("{error:#}");
            sqlx::query("UPDATE olien_proposals SET status = 'failed', failure = $2, updated_at = now() WHERE id = $1")
                .bind(row.id)
                .bind(&text)
                .execute(pool)
                .await?;
            audit::record(pool, ctx.row.id, &ctx.row.address, Some(user), None, "proposal.failed", Some(&row.tx_hash), json!({ "error": text })).await;
            Err(TreasuryError::Chain(format!("execute failed: {text}")))
        }
    }
}

/// Every other proposal at a consumed slot loses (06-algorithms.md §5).
pub async fn mark_replaced(pool: &PgPool, olien_id: i64, nonce_key: &str, sequence: i64, winner: i64) -> Res<()> {
    sqlx::query(
        "UPDATE olien_proposals SET status = 'replaced', updated_at = now() WHERE olien_id = $1 AND nonce_key = $2 AND sequence = $3
         AND id <> $4 AND status IN ('open','ready','blocked','executing','failed')",
    )
    .bind(olien_id)
    .bind(nonce_key)
    .bind(sequence)
    .bind(winner)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn list_scheduled(pool: &PgPool, treasury: &Treasury, user: i64, address: &str) -> Res<Vec<ProposalView>> {
    list_proposals(pool, treasury, user, address, Some("scheduled")).await
}

pub async fn veto_call(pool: &PgPool, user: i64, address: &str, tx_hash: &str) -> Res<VetoCall> {
    let ctx = context_for(pool, user, address).await?;
    let row = load_proposal(pool, ctx.row.id, tx_hash).await?;
    if row.status != "scheduled" {
        return Err(TreasuryError::Conflict("only a scheduled change can be vetoed".into()));
    }
    let vetoed: Vec<(String,)> = sqlx::query_as("SELECT signer_id FROM olien_vetoes WHERE proposal_id = $1").bind(row.id).fetch_all(pool).await?;
    let signer_ids = ctx
        .membership
        .signer_ids
        .iter()
        .filter(|id| ctx.signers.iter().any(|s| &s.signer_id == *id && s.status == "active" && s.vetoes()))
        .filter(|id| row.scheduled_excluded.as_ref() != Some(*id) || row.path == "recovery")
        .filter(|id| !vetoed.iter().any(|(v,)| v == *id))
        .cloned()
        .collect();
    let operation_signer_ids = ctx
        .signers
        .iter()
        .filter(|s| s.status == "active" && s.vetoes() && matches!(s.kind.as_str(), "p256" | "webauthn"))
        .filter(|s| row.scheduled_excluded.as_ref() != Some(&s.signer_id) || row.path == "recovery")
        .filter(|s| !vetoed.iter().any(|(v,)| v == &s.signer_id))
        .map(|s| s.signer_id.clone())
        .collect();
    Ok(VetoCall { to: ctx.row.address.clone(), data: hex(&calldata::veto(parse_hash(tx_hash)?)), signer_ids, operation_signer_ids })
}

/// Gas a veto operation may use. The measured device veto was 250k for the whole
/// bundle; the unused part of these limits is refunded to the account's deposit.
const OP_VERIFICATION_GAS: u128 = 500_000;
const OP_CALL_GAS: u128 = 300_000;
const OP_PRE_VERIFICATION_GAS: u64 = 60_000;
/// An operation is signed and sent within minutes; an hour leaves room and no more.
const OP_VALIDITY: u64 = 3_600;

fn operation_from_json(json: &OperationJson) -> Res<PackedUserOperation> {
    Ok(PackedUserOperation {
        sender: parse_address(&json.sender)?,
        nonce: parse_amount(&json.nonce)?,
        initCode: Bytes::new(),
        callData: parse_hex_bytes(&json.call_data)?.into(),
        accountGasLimits: parse_hash(&json.account_gas_limits)?,
        preVerificationGas: parse_amount(&json.pre_verification_gas)?,
        gasFees: parse_hash(&json.gas_fees)?,
        paymasterAndData: Bytes::new(),
        signature: Bytes::new(),
    })
}

/// One self call as a user operation for a key-based signer (spec §11): the EntryPoint
/// nonce in key 0, fixed gas limits, the RPC's fee, an hour of validity, and the
/// account's own hash of it for the signer to sign.
async fn single_operation(treasury: &Treasury, client: &OlienClient, ctx: &AccountContext, call: Call, signer_id: String) -> Res<PreparedOperation> {
    let account = ctx.row.address();
    let nonce = client.entry_point_nonce(account, 0).await.map_err(|e| TreasuryError::Chain(format!("{e:#}")))?;
    let (priority, max_fee) = client.fee_estimate().await.map_err(|e| TreasuryError::Chain(format!("{e:#}")))?;
    let valid_until = now() + OP_VALIDITY;
    let op = PackedUserOperation {
        sender: account,
        nonce,
        initCode: Bytes::new(),
        callData: olien::user_operation_calldata(&[call]),
        accountGasLimits: olien::packed_pair(OP_VERIFICATION_GAS, OP_CALL_GAS),
        preVerificationGas: U256::from(OP_PRE_VERIFICATION_GAS),
        gasFees: olien::packed_pair(priority, max_fee),
        paymasterAndData: Bytes::new(),
        signature: Bytes::new(),
    };
    let epoch = ctx.row.epoch as u64;
    let hash = olien::user_operation_hash(treasury.chain_id, account, &op, 0, valid_until, epoch, client.deployment.entry_point);
    Ok(PreparedOperation {
        operation: OperationJson {
            sender: addr(account),
            nonce: nonce.to_string(),
            call_data: hex(&op.callData),
            account_gas_limits: hex(op.accountGasLimits.as_slice()),
            pre_verification_gas: op.preVerificationGas.to_string(),
            gas_fees: hex(op.gasFees.as_slice()),
            valid_after: 0,
            valid_until,
            epoch,
        },
        hash: hex(hash.as_slice()),
        signer_id,
    })
}

fn key_based(signer: &SignerRow) -> bool {
    matches!(signer.kind.as_str(), "p256" | "webauthn")
}

/// A veto as a user operation for a passkey or P-256 signer: one self call to
/// `veto(hash)`, validated for that signer, paid from the account's deposit.
pub async fn veto_operation(pool: &PgPool, treasury: &Treasury, user: i64, address: &str, tx_hash: &str, signer_id: &str) -> Res<PreparedOperation> {
    let client = treasury.client.as_ref().ok_or(TreasuryError::Off)?;
    let ctx = context_for(pool, user, address).await?;
    let row = load_proposal(pool, ctx.row.id, tx_hash).await?;
    if row.status != "scheduled" {
        return Err(TreasuryError::Conflict("only a scheduled change can be vetoed".into()));
    }
    let signer_id = hex(parse_hash(signer_id)?.as_slice());
    let signer = ctx.signers.iter().find(|s| s.signer_id == signer_id && s.status == "active").ok_or_else(|| bad("no such signer"))?;
    if !key_based(signer) {
        return Err(bad("this signer vetoes from its own wallet, not through an operation"));
    }
    if !signer.vetoes() {
        return Err(bad("this signer does not hold veto"));
    }
    let call = Call { to: ctx.row.address(), value: U256::ZERO, data: calldata::veto(parse_hash(tx_hash)?) };
    single_operation(treasury, client, &ctx, call, signer_id).await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpendBody {
    pub to: String,
    pub amount: String,
    pub signer_id: String,
}

/// How a named spender pays from a limit: a wallet signer sends `call` itself; a
/// passkey or P-256 signer signs `operation` and the relayer submits it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpendPlan {
    pub call: CallJson,
    pub operation: Option<PreparedOperation>,
}

#[derive(Debug, Serialize)]
pub struct CallJson {
    pub to: String,
    pub data: String,
}

async fn load_limit(pool: &PgPool, olien_id: i64, limit_id: i64) -> Res<LimitRow> {
    sqlx::query_as::<_, LimitRow>(
        "SELECT limit_id, generation, token, from_address, amount, remaining, period, reset_at, any_destination,
            signers, destinations FROM olien_spending_limits WHERE olien_id = $1 AND limit_id = $2 AND status = 'active'",
    )
    .bind(olien_id)
    .bind(limit_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| TreasuryError::NotFound("no such spending limit".into()))
}

fn names(value: &Value, wanted: &str) -> bool {
    value.as_array().is_some_and(|list| list.iter().any(|v| v.as_str().is_some_and(|s| s.eq_ignore_ascii_case(wanted))))
}

/// Everything the contract's `spend` will check, checked here first so a refusal
/// costs no gas and comes with a reason: the limit exists, the signer is named on
/// its current generation, the destination is allowed, and the amount is within
/// what is left right now on chain.
pub async fn spend_plan(pool: &PgPool, treasury: &Treasury, user: i64, address: &str, limit_id: i64, body: SpendBody) -> Res<SpendPlan> {
    let client = treasury.client.as_ref().ok_or(TreasuryError::Off)?;
    let ctx = context_for(pool, user, address).await?;
    require_live(&ctx.row)?;
    let limit = load_limit(pool, ctx.row.id, limit_id).await?;
    let signer_id = hex(parse_hash(&body.signer_id)?.as_slice());
    let signer = ctx.signers.iter().find(|s| s.signer_id == signer_id && s.status == "active").ok_or_else(|| bad("no such signer"))?;
    if !names(&limit.signers, &signer_id) {
        return Err(bad("this signer is not named on the limit"));
    }
    // A wallet signer must be one the caller has linked; a key-based one proves itself
    // when it signs the operation.
    if !key_based(signer) && !ctx.membership.signer_ids.contains(&signer_id) {
        return Err(TreasuryError::Forbidden);
    }
    let to = parse_address(&body.to)?;
    if !limit.any_destination && !names(&limit.destinations, &addr(to)) {
        return Err(bad("the limit does not allow that destination"));
    }
    let amount = parse_amount(&body.amount)?;
    if amount.is_zero() {
        return Err(bad("an amount must be positive"));
    }
    let (remaining, _, _, _) = client.limit_budget(ctx.row.address(), limit_id as u64).await.map_err(|e| TreasuryError::Chain(format!("{e:#}")))?;
    if amount > U256::from(remaining) {
        return Err(TreasuryError::Conflict(format!("only {remaining} is left on this limit until it resets")));
    }
    let data = calldata::spend(limit_id as u64, to, amount);
    let call = Call { to: ctx.row.address(), value: U256::ZERO, data: data.clone() };
    let operation = if key_based(signer) { Some(single_operation(treasury, client, &ctx, call, signer_id).await?) } else { None };
    Ok(SpendPlan { call: CallJson { to: ctx.row.address.clone(), data: hex(&data) }, operation })
}

/// Submit a signed operation through the relayer. The hash is recomputed from the
/// fields sent back and the signature checked against the signer's key before any
/// gas is spent, and the calls are held to the one shape this route serves: a single
/// self call to `veto`. Anything else is refused rather than sent.
pub async fn submit_operation(pool: &PgPool, treasury: &Treasury, user: i64, address: &str, body: SubmitOperationBody) -> Res<OperationReceipt> {
    let client = treasury.client.as_ref().ok_or(TreasuryError::Off)?;
    let ctx = context_for(pool, user, address).await?;
    require_live(&ctx.row)?;
    let account = ctx.row.address();
    let json = &body.operation;
    let mut op = operation_from_json(json)?;
    if op.sender != account {
        return Err(bad("the operation is for another account"));
    }
    if json.epoch != ctx.row.epoch as u64 {
        return Err(TreasuryError::Conflict("the account's rules changed since this was prepared; prepare it again".into()));
    }
    if json.valid_until <= now() {
        return Err(TreasuryError::Conflict("this operation has expired; prepare it again".into()));
    }
    let calls = olien::user_operation_calls(&op.callData).ok_or_else(|| bad("the operation's callData is not an executeUserOp batch"))?;
    let self_call = calls.len() == 1 && calls[0].to == account && calls[0].value.is_zero();
    let selector = calls.first().and_then(|c| c.data.get(..4));
    let is_veto = self_call && selector == Some(&calldata::veto(B256::ZERO)[..4]);
    let is_spend = self_call && selector == Some(&calldata::spend(0, Address::ZERO, U256::ZERO)[..4]);
    if !is_veto && !is_spend {
        return Err(bad("only a veto or a spend may be submitted this way"));
    }
    let signer_id = hex(parse_hash(&body.signer_id)?.as_slice());
    let signer = ctx.signers.iter().find(|s| s.signer_id == signer_id && s.status == "active").ok_or_else(|| bad("no such signer"))?;
    if is_veto && !signer.vetoes() {
        return Err(bad("this signer does not hold veto"));
    }
    if is_spend {
        let limit_id = calls[0].data.get(4..36).map(U256::from_be_slice).ok_or_else(|| bad("a spend names its limit"))?;
        let limit = load_limit(pool, ctx.row.id, limit_id.to::<u64>() as i64).await?;
        if !names(&limit.signers, &signer_id) {
            return Err(bad("this signer is not named on the limit"));
        }
    }
    let hash = olien::user_operation_hash(treasury.chain_id, account, &op, json.valid_after, json.valid_until, json.epoch, client.deployment.entry_point);
    let signature = parse_hex_bytes(&body.signature)?;
    // A P-256 or passkey signature over this very hash is its own proof of control.
    let check = match signer.kind.as_str() {
        "p256" => olien::verify_p256_raw(hash, &signature, key_part(signer.x.as_deref())?, key_part(signer.y.as_deref())?),
        "webauthn" => olien::verify_webauthn(hash, &signature, key_part(signer.x.as_deref())?, key_part(signer.y.as_deref())?, signer.flags & FLAG_UV_REQUIRED as i32 != 0),
        other => Err(anyhow!("a {other} signer does not act through an operation")),
    };
    check.map_err(|e| bad(format!("signature refused: {e:#}")))?;
    let packed = olien::pack(&[(parse_hash(&signer_id)?, signature)])?;
    op.signature = olien::user_operation_signature(json.valid_after, json.valid_until, &packed);
    let sent = client.handle_ops(op).await.map_err(|e| TreasuryError::Chain(format!("{e:#}")))?;
    Ok(OperationReceipt { tx_hash: hex(sent.tx_hash.as_slice()), hash: hex(hash.as_slice()) })
}

pub async fn execute_scheduled(pool: &PgPool, treasury: &Treasury, user: i64, address: &str, tx_hash: &str) -> Res<ProposalView> {
    let client = treasury.client.as_ref().ok_or(TreasuryError::Off)?;
    let ctx = context_for(pool, user, address).await?;
    require_live(&ctx.row)?;
    let row = load_proposal(pool, ctx.row.id, tx_hash).await?;
    if row.status != "scheduled" {
        return Err(TreasuryError::Conflict(format!("the proposal is {}, not scheduled", row.status)));
    }
    let ready_at = row.scheduled_ready_at.unwrap_or(0);
    if (now() as i64) < ready_at {
        return Err(TreasuryError::Conflict(format!("not ready until {ready_at}")));
    }
    let account = ctx.row.address();
    let calls = calls_from_json(&row.calls)?;
    match client.execute_scheduled(account, parse_hash(&row.tx_hash)?, calls).await {
        Ok(sent) => {
            tracing::info!("executed scheduled {} for {} in {:#x} (block {}, {} gas)", row.tx_hash, ctx.row.address, sent.tx_hash, sent.block, sent.gas_used);
            sqlx::query("UPDATE olien_proposals SET status = 'executed', executed_tx = $2, executed_at = $3, updated_at = now() WHERE id = $1")
                .bind(row.id)
                .bind(hex(sent.tx_hash.as_slice()))
                .bind(now() as i64)
                .execute(pool)
                .await?;
            if let Err(e) = refresh_account_from_chain(pool, client, &ctx.row).await {
                tracing::warn!("refresh after executeScheduled failed: {e:#}");
            }
            let fresh = load_account_by_id(pool, ctx.row.id).await?;
            refresh_statuses(pool, &fresh).await?;
            proposal_view(pool, treasury.chain_id, user, &fresh, tx_hash).await
        }
        Err(error) => Err(TreasuryError::Chain(format!("executeScheduled failed: {error:#}"))),
    }
}

// ---------------------------------------------------------------------------
// Ledger and address book

pub async fn ledger(pool: &PgPool, user: i64, address: &str, limit: i64, before: Option<i64>) -> Res<Vec<LedgerEntry>> {
    let ctx = context_for(pool, user, address).await?;
    ledger_entries(pool, ctx.row.id, before, None, limit).await
}

/// A page of the ledger, newest first: rows below `before` and above `after`.
pub(crate) async fn ledger_entries(pool: &PgPool, olien_id: i64, before: Option<i64>, after: Option<i64>, limit: i64) -> Res<Vec<LedgerEntry>> {
    let book = address_book_map(pool, olien_id).await?;
    let limit = limit.clamp(1, 500);
    #[derive(sqlx::FromRow)]
    struct Row {
        id: i64,
        tx: String,
        log_index: i32,
        token: String,
        direction: String,
        counterparty: String,
        amount: String,
        block_number: i64,
        block_time: i64,
        proposal_tx: Option<String>,
        intent: Option<Value>,
        limit_id: Option<i64>,
        sub_account: Option<String>,
        note: Option<String>,
    }
    let rows: Vec<Row> = sqlx::query_as(
        "SELECT l.id, l.tx, l.log_index, l.token, l.direction, l.counterparty, l.amount, l.block_number, l.block_time,
            p.tx_hash AS proposal_tx, p.intent, l.limit_id, l.sub_account, l.note
         FROM olien_ledger l LEFT JOIN olien_proposals p ON p.id = l.proposal_id
         WHERE l.olien_id = $1 AND ($2::bigint IS NULL OR l.id < $2) AND ($4::bigint IS NULL OR l.id > $4) ORDER BY l.id DESC LIMIT $3",
    )
    .bind(olien_id)
    .bind(before)
    .bind(limit)
    .bind(after)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| {
            // A transfer's memo is the proposal's; a row with no transfer behind it
            // carries its own note.
            let memo = r
                .intent
                .as_ref()
                .and_then(|i| {
                    i.get("recipients")?.as_array()?.iter().find(|x| x.get("to").and_then(Value::as_str) == Some(r.counterparty.as_str()))?.get("memo")?.as_str().map(String::from)
                })
                .or(r.note);
            let symbol = symbol_for(&r.token);
            LedgerEntry {
                id: r.id,
                tx: r.tx,
                log_index: r.log_index,
                decimals: decimals_for(&symbol),
                symbol,
                token: r.token,
                direction: r.direction,
                counterparty_label: book.get(&r.counterparty).cloned(),
                counterparty: r.counterparty,
                amount: r.amount,
                block_number: r.block_number,
                block_time: r.block_time,
                proposal_tx_hash: r.proposal_tx,
                limit_id: r.limit_id,
                sub_account: r.sub_account,
                memo,
            }
        })
        .collect())
}

pub async fn address_book(pool: &PgPool, user: i64, address: &str) -> Res<Vec<AddressBookEntry>> {
    let ctx = context_for(pool, user, address).await?;
    let rows: Vec<(String, String, String, DateTime<Utc>, Option<String>, Option<Vec<u8>>, Option<i64>)> = sqlx::query_as(
        "SELECT address, label, category, created_at, signer_id, signature, added_at FROM olien_address_book WHERE olien_id = $1 ORDER BY label",
    )
    .bind(ctx.row.id)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(address, label, category, at, signer_id, signature, added_at)| AddressBookEntry {
            address,
            label,
            category,
            created_at: at.timestamp(),
            signer_id,
            signature: signature.map(|bytes| hex(&bytes)),
            added_at,
        })
        .collect())
}

/// How far the time inside an entry's signature may be from this service's clock. The
/// time is what a new destination's wait is counted from, so a member must not be able
/// to sign one that is already old.
const ENTRY_CLOCK_SKEW: u64 = 600;

/// Adds an address to the book, or signs one that is there.
///
/// An entry is what makes an address known, and the policy pays known addresses, so it
/// has to be something this service cannot write by itself. The member signs the
/// address, the label, the category and the time, in the account's own domain; the
/// signature is checked here as a confirmation is, kept beside the row, and handed to
/// every client, which checks it again before believing the label.
pub async fn add_address(pool: &PgPool, treasury: &Treasury, user: i64, address: &str, body: AddressBookBody) -> Res<AddressBookEntry> {
    let client = treasury.client.as_ref().ok_or(TreasuryError::Off)?;
    let ctx = context_for(pool, user, address).await?;
    let entry = parse_address(&body.address)?;
    let label = body.label.trim().to_string();
    if label.is_empty() || label.chars().count() > 80 {
        return Err(bad("label must be 1 to 80 characters"));
    }
    let category = body.category.as_deref().map(str::trim).unwrap_or("").to_string();
    if category.chars().count() > 40 {
        return Err(bad("a category is at most 40 characters"));
    }
    let (Some(signer_id), Some(signature), Some(added_at)) = (body.signer_id.as_deref(), body.signature.as_deref(), body.added_at) else {
        return Err(bad("an address book entry is signed by a member: send signerId, signature and addedAt"));
    };
    if added_at.abs_diff(now()) > ENTRY_CLOCK_SKEW {
        return Err(bad("the time signed into the entry is not now; sign it again"));
    }
    let signer_id = hex(parse_hash(signer_id)?.as_slice());
    let signer = ctx.signers.iter().find(|s| s.signer_id == signer_id && s.status == "active").ok_or_else(|| bad("not a signer of this account"))?;
    if !signer.approves() {
        return Err(bad("only a member who can approve payments can vouch for a destination"));
    }
    let signature = parse_hex_bytes(signature)?;
    let hash = olien::address_book_hash(treasury.chain_id, ctx.row.address(), entry, &label, &category, added_at);
    check_signature(client, &ctx, signer, hash, &signature).await?;
    sqlx::query(
        "INSERT INTO olien_address_book (olien_id, address, label, category, added_by, signer_id, signature, added_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (olien_id, address) DO UPDATE SET label = EXCLUDED.label, category = EXCLUDED.category, added_by = EXCLUDED.added_by,
            signer_id = EXCLUDED.signer_id, signature = EXCLUDED.signature, added_at = EXCLUDED.added_at",
    )
    .bind(ctx.row.id)
    .bind(addr(entry))
    .bind(&label)
    .bind(&category)
    .bind(user)
    .bind(&signer_id)
    .bind(&signature)
    .bind(added_at as i64)
    .execute(pool)
    .await?;
    audit::record(pool, ctx.row.id, &ctx.row.address, Some(user), None, "book.added", Some(&addr(entry)), json!({ "label": label, "category": category, "signerId": signer_id })).await;
    // A destination that just became known can let a waiting payment through later.
    refresh_statuses(pool, &ctx.row).await?;
    Ok(AddressBookEntry { address: addr(entry), label, category, created_at: now() as i64, signer_id: Some(signer_id), signature: Some(hex(&signature)), added_at: Some(added_at as i64) })
}

/// Takes an address out of the book. Any member may, at once: when a destination
/// nobody recognises appears, removing it is how one person stops the payment to it.
pub async fn remove_address(pool: &PgPool, user: i64, address: &str, entry: &str) -> Res<()> {
    let ctx = context_for(pool, user, address).await?;
    let entry = parse_address(entry)?;
    let done = sqlx::query("DELETE FROM olien_address_book WHERE olien_id = $1 AND address = $2").bind(ctx.row.id).bind(addr(entry)).execute(pool).await?;
    if done.rows_affected() == 0 {
        return Err(TreasuryError::NotFound("no such address in the book".into()));
    }
    audit::record(pool, ctx.row.id, &ctx.row.address, Some(user), None, "book.removed", Some(&addr(entry)), json!({})).await;
    refresh_statuses(pool, &ctx.row).await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// The treasury's policy (policy.rs has the rules; this is where they are kept)

#[derive(sqlx::FromRow)]
struct PolicyRow {
    policy: Value,
    pending: Option<Value>,
    pending_effective_at: Option<i64>,
    pending_by: Option<i64>,
}

// A stored policy that cannot be read is an error and not an empty policy: dropping a
// treasury's rules because a row is damaged would be the service loosening them itself.
fn parse_policy(value: &Value) -> Res<Policy> {
    serde_json::from_value(value.clone()).map_err(|e| TreasuryError::Internal(anyhow!("the stored treasury policy cannot be read: {e}")))
}

/// The policy row, with a waiting change applied if its time has come. Nothing runs on
/// a timer for this: whoever next asks finds the change due and it takes effect then,
/// which is the same moment as far as anyone can tell.
async fn policy_row(pool: &PgPool, account: &AccountRow) -> Res<Option<PolicyRow>> {
    let row: Option<PolicyRow> = sqlx::query_as("SELECT policy, pending, pending_effective_at, pending_by FROM olien_policies WHERE olien_id = $1")
        .bind(account.id)
        .fetch_optional(pool)
        .await?;
    let Some(row) = row else { return Ok(None) };
    if let (Some(pending), Some(at)) = (row.pending.clone(), row.pending_effective_at) {
        if at <= now() as i64 {
            let done = sqlx::query(
                "UPDATE olien_policies SET policy = pending, pending = NULL, pending_effective_at = NULL, pending_by = NULL, updated_at = now()
                 WHERE olien_id = $1 AND pending_effective_at = $2",
            )
            .bind(account.id)
            .bind(at)
            .execute(pool)
            .await?;
            // Only the reader whose update landed records it, so it is recorded once.
            if done.rows_affected() == 1 {
                audit::record(pool, account.id, &account.address, row.pending_by, None, "policy.applied", None, pending.clone()).await;
            }
            return Ok(Some(PolicyRow { policy: pending, pending: None, pending_effective_at: None, pending_by: None }));
        }
    }
    Ok(Some(row))
}

pub(crate) async fn policy_of(pool: &PgPool, account: &AccountRow) -> Res<Policy> {
    match policy_row(pool, account).await? {
        Some(row) => parse_policy(&row.policy),
        None => Ok(Policy::default()),
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingPolicy {
    pub policy: Policy,
    pub effective_at: i64,
    pub proposed_by: Option<String>,
    /// What it lets through that the current policy holds, which is why it waits.
    pub loosens: Vec<&'static str>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyView {
    pub policy: Policy,
    pub pending: Option<PendingPolicy>,
    /// How long a change that loosens the policy waits: the account's own config delay.
    pub change_delay: i64,
}

async fn policy_view(pool: &PgPool, account: &AccountRow) -> Res<PolicyView> {
    let row = policy_row(pool, account).await?;
    let current = match &row {
        Some(row) => parse_policy(&row.policy)?,
        None => Policy::default(),
    };
    let pending = match row {
        Some(PolicyRow { pending: Some(pending), pending_effective_at: Some(at), pending_by, .. }) => {
            let proposed = parse_policy(&pending)?;
            let proposed_by = match pending_by {
                Some(id) => Some(crate::treasury_keys::member_name(pool, id).await?),
                None => None,
            };
            Some(PendingPolicy { loosens: policy::loosens(&current, &proposed), policy: proposed, effective_at: at, proposed_by })
        }
        _ => None,
    };
    Ok(PolicyView { policy: current, pending, change_delay: account.config_delay })
}

pub async fn get_policy(pool: &PgPool, user: i64, address: &str) -> Res<PolicyView> {
    let ctx = context_for(pool, user, address).await?;
    policy_view(pool, &ctx.row).await
}

/// Changes the treasury's policy the way the account changes its own rules: a change
/// that only tightens takes effect at once, and one that loosens anything waits the
/// account's config delay, during which any member can cancel it. A policy that one
/// member could switch off in the moment before a payment would be no policy.
pub async fn set_policy(pool: &PgPool, user: i64, address: &str, body: Policy) -> Res<PolicyView> {
    let ctx = context_for(pool, user, address).await?;
    require_live(&ctx.row)?;
    if ctx.membership.signer_ids.is_empty() {
        return Err(bad("only a signer of this account changes its policy"));
    }
    let wanted = body.checked().map_err(bad)?;
    let row = policy_row(pool, &ctx.row).await?;
    let current = match &row {
        Some(row) => parse_policy(&row.policy)?,
        None => Policy::default(),
    };
    if wanted == current {
        return policy_view(pool, &ctx.row).await;
    }
    let loosened = policy::loosens(&current, &wanted);
    let stored = serde_json::to_value(&wanted).map_err(|e| TreasuryError::Internal(e.into()))?;
    if loosened.is_empty() || ctx.row.config_delay == 0 {
        // Applying a change now also drops one that was waiting: the waiting change was
        // written against the old policy and would undo this one when it landed.
        sqlx::query(
            "INSERT INTO olien_policies (olien_id, policy) VALUES ($1, $2)
             ON CONFLICT (olien_id) DO UPDATE SET policy = EXCLUDED.policy, pending = NULL, pending_effective_at = NULL, pending_by = NULL, updated_at = now()",
        )
        .bind(ctx.row.id)
        .bind(&stored)
        .execute(pool)
        .await?;
        audit::record(pool, ctx.row.id, &ctx.row.address, Some(user), None, "policy.changed", None, json!({ "policy": stored, "loosens": loosened })).await;
    } else {
        if row.as_ref().is_some_and(|row| row.pending.is_some()) {
            return Err(TreasuryError::Conflict("a change to the policy is already waiting; cancel it before proposing another".into()));
        }
        let effective_at = now() as i64 + ctx.row.config_delay;
        sqlx::query(
            "INSERT INTO olien_policies (olien_id, policy, pending, pending_effective_at, pending_by) VALUES ($1, '{}'::jsonb, $2, $3, $4)
             ON CONFLICT (olien_id) DO UPDATE SET pending = EXCLUDED.pending, pending_effective_at = EXCLUDED.pending_effective_at,
                pending_by = EXCLUDED.pending_by, updated_at = now()",
        )
        .bind(ctx.row.id)
        .bind(&stored)
        .bind(effective_at)
        .bind(user)
        .execute(pool)
        .await?;
        audit::record(pool, ctx.row.id, &ctx.row.address, Some(user), None, "policy.proposed", None, json!({ "policy": stored, "loosens": loosened, "effectiveAt": effective_at })).await;
    }
    refresh_statuses(pool, &ctx.row).await?;
    policy_view(pool, &ctx.row).await
}

/// Any member stops a waiting change. It never took effect, so nothing is undone.
pub async fn cancel_policy_change(pool: &PgPool, user: i64, address: &str) -> Res<PolicyView> {
    let ctx = context_for(pool, user, address).await?;
    let done = sqlx::query(
        "UPDATE olien_policies SET pending = NULL, pending_effective_at = NULL, pending_by = NULL, updated_at = now()
         WHERE olien_id = $1 AND pending IS NOT NULL AND pending_effective_at > $2",
    )
    .bind(ctx.row.id)
    .bind(now() as i64)
    .execute(pool)
    .await?;
    if done.rows_affected() == 0 {
        return Err(TreasuryError::NotFound("no change to the policy is waiting".into()));
    }
    audit::record(pool, ctx.row.id, &ctx.row.address, Some(user), None, "policy.cancelled", None, json!({})).await;
    policy_view(pool, &ctx.row).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn passkey_signer_input_matches_the_contract() {
        let x = "0xf299ff78aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let y = "0x029e61bcbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        let body = SignerBody {
            kind: Some("webauthn".into()),
            address: None,
            label: Some("Laptop".into()),
            permissions: Some(vec!["approve".into()]),
            x: Some(x.into()),
            y: Some(y.into()),
            uv_required: None,
            synced: None,
            handle: None,
        };
        let (input, key) = signer_input(&body).unwrap();
        assert_eq!(input.kind, KIND_WEBAUTHN);
        assert_eq!(input.flags, FLAG_UV_REQUIRED);
        assert_eq!(input.key.len(), 64);
        assert_eq!(key.id, signer_id_of_key(key.x.unwrap(), key.y.unwrap()));
        assert!(key.address.is_none());
        assert_eq!(key.handle(), hex(key.id.as_slice()));

        let plain = SignerBody { kind: Some("p256".into()), uv_required: Some(true), ..body };
        let (input, _) = signer_input(&plain).unwrap();
        assert_eq!(input.flags, 0, "only passkeys carry the user-verification flag");

        let missing = SignerBody { kind: Some("webauthn".into()), address: None, label: None, permissions: None, x: None, y: None, uv_required: None, synced: None, handle: None };
        assert!(signer_input(&missing).is_err());
        let ecdsa = SignerBody { kind: None, address: Some("0x12808a601475b87ce7b343A18f11062cc74Eae81".into()), label: None, permissions: None, x: None, y: None, uv_required: None, synced: None, handle: None };
        let (input, key) = signer_input(&ecdsa).unwrap();
        assert_eq!(input.key.len(), 20);
        assert_eq!(key.handle(), "0x12808a601475b87ce7b343a18f11062cc74eae81");
    }
}

#[cfg(test)]
mod description_tests {
    use super::*;
    use alloy::primitives::address;

    const USDC: Address = address!("534b2f3A21130d7a60830c2Df862319e593943A3");
    const ACCOUNT: Address = address!("00000000000000000000000000000000000000AB");
    const ACME: Address = address!("3C44CdDdB6a900fa2b585dd299e03d12FA4293BC");
    const OTHER: Address = address!("90F79bf6EB2c4f870365E785982E1f101E93b906");

    fn pay(to: Address, amount: u64) -> Call {
        Call { to: USDC, value: U256::ZERO, data: calldata::usdc_transfer(to, U256::from(amount)) }
    }

    fn says(to: Address, amount: &str) -> Value {
        json!({ "recipients": [{ "to": format!("{to:#x}"), "amount": amount, "label": "Acme Ltd" }] })
    }

    #[test]
    fn a_description_that_matches_its_calls_is_kept() {
        assert!(describes("transfer", &says(ACME, "250000000"), &[pay(ACME, 250_000_000)], ACCOUNT, &[USDC]).is_ok());
        assert!(describes("contract_call", &json!({}), &[pay(ACME, 1)], ACCOUNT, &[USDC]).is_ok(), "no description claims nothing");
    }

    // The proposal that reads "250 USDC to Acme" and pays someone else a thousand times
    // that. This is the one the console used to show as written.
    #[test]
    fn a_description_naming_another_recipient_or_amount_is_refused() {
        let calls = [pay(OTHER, 250_000_000_000)];
        assert!(describes("transfer", &says(ACME, "250000000"), &calls, ACCOUNT, &[USDC]).is_err());
        assert!(describes("contract_call", &says(ACME, "250000000"), &calls, ACCOUNT, &[USDC]).is_err(), "whatever kind it is filed under");
        assert!(describes("transfer", &says(OTHER, "250000000"), &calls, ACCOUNT, &[USDC]).is_err(), "the right recipient with the wrong amount");
        assert!(describes("batch", &json!({ "recipients": [] }), &calls, ACCOUNT, &[USDC]).is_err(), "a different number of payments");
    }

    #[test]
    fn a_kind_is_held_to_what_its_calls_do() {
        let rule = Call { to: ACCOUNT, value: U256::ZERO, data: calldata::set_threshold(1) };
        assert!(describes("rule_change", &json!({}), std::slice::from_ref(&rule), ACCOUNT, &[USDC]).is_ok());
        assert!(describes("transfer", &json!({}), std::slice::from_ref(&rule), ACCOUNT, &[USDC]).is_err(), "a rule change filed as a payment");
        assert!(describes("rule_change", &json!({}), &[pay(ACME, 1)], ACCOUNT, &[USDC]).is_err(), "a payment filed as a rule change");
        assert!(describes("transfer", &json!({}), &[pay(ACME, 1), pay(ACME, 1)], ACCOUNT, &[USDC]).is_err(), "two payments are a batch");
    }

    #[test]
    fn only_a_canonical_transfer_on_a_known_token_is_a_payment() {
        let mut padded = pay(ACME, 1);
        padded.data = [padded.data.as_ref(), &[0u8]].concat().into();
        assert!(payment_of(&padded, &[USDC]).is_none(), "a trailing byte");
        let mut carrying = pay(ACME, 1);
        carrying.value = U256::from(1u64);
        assert!(payment_of(&carrying, &[USDC]).is_none(), "money riding along");
        assert!(payment_of(&pay(ACME, 1), &[ACCOUNT]).is_none(), "a token this treasury does not hold");
        assert_eq!(payment_of(&pay(ACME, 7), &[USDC]), Some((ACME, U256::from(7u64))));
    }
}

#[cfg(test)]
mod token_symbol_tests {
    use super::*;

    #[test]
    fn a_ledger_row_names_its_own_token() {
        assert_eq!(symbol_for(&addr(book_usdc())), "USDC");
        assert_eq!(symbol_for("0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a"), "EURC");
        assert_eq!(symbol_for("0x89b50855aa3be2f677cd6303cec089b5f319d72a"), "EURC");
    }

    #[test]
    fn an_unknown_token_is_called_a_token_rather_than_guessed_at() {
        assert_eq!(symbol_for("0x0000000000000000000000000000000000000001"), "token");
    }

    #[test]
    fn gas_is_its_own_symbol_with_the_chains_decimals() {
        assert_eq!(symbol_for(GAS_TOKEN), "gas");
        assert_eq!(decimals_for("gas"), 18);
        assert_eq!(decimals_for("USDC"), 6);
        assert_eq!(decimals_for("EURC"), 6);
    }
}
