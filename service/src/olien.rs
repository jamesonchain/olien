// The Olien account on chain, seen from the service: the ABI, the EIP-712 hashes the
// contract checks, the packed signature format, the per-kind signature checks the
// contract makes (so a bad confirmation is refused before it is stored), and the
// relayer that pays for `createAccount`, `execute` and `executeScheduled`.
// docs/treasury/10-account-spec.md is the rule book; 06-algorithms.md the procedures.

use alloy::contract::Error as ContractError;
use alloy::network::EthereumWallet;
use alloy::primitives::{keccak256, Address, Bytes, B256, U256};
use alloy::providers::fillers::{ChainIdFiller, GasFiller, NonceFiller, SimpleNonceManager};
use alloy::providers::{DynProvider, Provider, ProviderBuilder};
use alloy::rpc::types::{Filter, Log, TransactionRequest};
use alloy::signers::local::PrivateKeySigner;
use alloy::sol;
use alloy::sol_types::{SolCall, SolEvent, SolInterface, SolValue};
use anyhow::{anyhow, bail, Context, Result};
use base64::Engine;
use p256::ecdsa::signature::hazmat::PrehashVerifier;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::sync::Arc;

sol! {
    #[derive(Debug)]
    struct Call {
        address to;
        uint256 value;
        bytes data;
    }

    #[derive(Debug)]
    struct Transaction {
        uint192 nonceKey;
        Call[] calls;
        uint48 validAfter;
        uint48 validUntil;
    }

    /// EntryPoint v0.7's operation, the packed shape.
    #[derive(Debug)]
    struct PackedUserOperation {
        address sender;
        uint256 nonce;
        bytes initCode;
        bytes callData;
        bytes32 accountGasLimits;
        uint256 preVerificationGas;
        bytes32 gasFees;
        bytes paymasterAndData;
        bytes signature;
    }

    /// The account's own callData shape: the EntryPoint hands the whole operation
    /// back to `executeUserOp` when callData starts with this selector.
    interface IAccountExecute {
        function executeUserOp(PackedUserOperation op, bytes32 userOpHash) external;
    }

    #[derive(Debug)]
    struct SignerInput {
        uint8 kind;
        uint8 permissions;
        uint8 flags;
        bytes key;
    }

    #[derive(Debug)]
    struct SignerView {
        uint8 kind;
        uint8 permissions;
        uint8 flags;
        uint64 since;
        uint256 x;
        uint256 y;
    }

    #[derive(Debug)]
    struct ConfigView {
        uint16 threshold;
        uint16 vetoThreshold;
        uint16 effectiveVetoThreshold;
        uint16 signerCount;
        uint16 approverCount;
        uint16 vetoerCount;
        uint16 approverVetoerCount;
        uint16 recovererCount;
        uint48 configDelay;
        uint48 recoveryDelay;
        uint48 recoveryCoSignDelay;
        uint64 epoch;
        uint256 limitCount;
        bool implementationFrozen;
    }

    #[derive(Debug)]
    struct Init {
        SignerInput[] signers;
        uint16 threshold;
        uint16 vetoThreshold;
        uint48 configDelay;
        uint48 recoveryDelay;
        uint48 recoveryCoSignDelay;
    }

    #[derive(Debug)]
    struct SpendingLimitInput {
        address token;
        uint256 subAccount;
        uint128 amount;
        uint48 period;
        bool anyDestination;
    }

    #[derive(Debug)]
    struct ScheduledView {
        uint48 readyAt;
        uint64 epoch;
        uint8 path;
        bytes32 excluded;
        bytes32 callsHash;
    }

    #[derive(Debug)]
    #[sol(rpc)]
    interface IOlien {
        event Initialized(uint16 threshold, uint16 vetoThreshold, uint48 configDelay, uint48 recoveryDelay, uint48 recoveryCoSignDelay);
        event SignerAdded(bytes32 indexed id, uint8 kind, uint8 permissions, uint8 flags, uint256 x, uint256 y);
        event SignerRemoved(bytes32 indexed id);
        event ThresholdChanged(uint16 threshold);
        event VetoThresholdChanged(uint16 vetoThreshold);
        event DelaysChanged(uint48 configDelay, uint48 recoveryDelay, uint48 recoveryCoSignDelay);
        event EpochAdvanced(uint64 epoch);
        event Executed(bytes32 indexed hash, uint256 nonce, uint8 path);
        event Scheduled(bytes32 indexed hash, uint48 readyAt, uint8 path, bytes32 excluded);
        event ScheduledExecuted(bytes32 indexed hash);
        event Approved(bytes32 indexed hash, bytes32 indexed signerId);
        event Vetoed(bytes32 indexed hash, bytes32 indexed signerId, uint16 count);
        event Cancelled(bytes32 indexed hash);
        event SpendingLimitSet(uint256 indexed id, uint32 generation, address token, address from, uint128 amount, uint48 period, bool anyDestination);
        event LimitSignerAllowed(uint256 indexed id, uint32 generation, bytes32 indexed signerId);
        event LimitDestinationAllowed(uint256 indexed id, uint32 generation, address indexed to);
        event SpendingLimitRemoved(uint256 indexed id);
        event Spent(uint256 indexed id, bytes32 indexed signerId, address to, uint256 amount);
        event ImplementationChanged(address implementation);
        event ImplementationFrozen();
        event SubAccountCreated(uint256 indexed index, address subAccount);

        error NotEntryPoint();
        error NotSelf();
        error Unauthorized();
        error InvalidSignatures();
        error MalformedSignatures();
        error BadCallData();
        error AlreadyInitialized();
        error UnknownSigner(bytes32 id);
        error SignerExists(bytes32 id);
        error BadKey();
        error BadPermissions();
        error BadConfig();
        error NotYetValid();
        error Expired();
        error Dead(bytes32 hash);
        error AlreadyScheduled(bytes32 hash);
        error NothingScheduled(bytes32 hash);
        error NotReady(bytes32 hash);
        error WindowClosed(bytes32 hash);
        error Stale(bytes32 hash);
        error CallsMismatch(bytes32 hash);
        error SelfCallRefused(bytes4 selector);
        error AlreadyVetoed(bytes32 hash, bytes32 signerId);
        error LimitMissing(uint256 id);
        error LimitDestination(address to);
        error LimitExceeded(uint256 id, uint256 amount, uint256 remaining);
        error Frozen();
        error NotAnImplementation(address implementation);
        error TransferFailed();
        error NotValidated();
        error Reentered();

        function execute(Transaction txn, bytes signatures) external;
        function executeScheduled(bytes32 hash, Call[] calls) external;
        function approve(bytes32 hash) external;
        function veto(bytes32 hash) external;
        function createSubAccount(uint256 index) external returns (address);
        function spend(uint256 id, address to, uint256 amount) external;
        function addSigner(SignerInput input) external;
        function removeSigner(bytes32 id) external;
        function replaceSigner(bytes32 oldId, SignerInput input) external;
        function setThreshold(uint16 newThreshold) external;
        function setVetoThreshold(uint16 newVetoThreshold) external;
        function setDelays(uint48 configDelay, uint48 recoveryDelay, uint48 recoveryCoSignDelay) external;
        function setSpendingLimit(uint256 id, SpendingLimitInput input) external returns (uint256);
        function allowLimitSigner(uint256 id, bytes32 signerId) external;
        function allowLimitDestination(uint256 id, address to) external;
        function removeSpendingLimit(uint256 id) external;
        function cancel(bytes32 hash) external;
        function setImplementation(address newImplementation) external;
        function freezeImplementation() external;
        function isValidSignature(bytes32 hash, bytes signature) external view returns (bytes4);
        function domainSeparator() external view returns (bytes32);
        function getTransactionHash(Transaction txn) external view returns (bytes32);
        function getMessageHash(bytes32 hash) external view returns (bytes32);
        function getSigner(bytes32 id) external view returns (SignerView);
        function getSigners() external view returns (bytes32[]);
        function getConfig() external view returns (ConfigView);
        function getNonce(uint192 key) external view returns (uint256);
        function getScheduled(bytes32 hash) external view returns (ScheduledView);
        function isDead(bytes32 hash) external view returns (bool);
        function isApproved(bytes32 hash, bytes32 signerId) external view returns (bool);
        function getVeto(bytes32 hash, bytes32 signerId) external view returns (bool vetoed, uint16 count);
        function getLimitBudget(uint256 id) external view returns (uint128 remaining, uint48 resetAt, uint32 generation, uint64 epoch);
        function implementation() external view returns (address);
        function subAccount(uint256 index) external view returns (address);
    }

    #[sol(rpc)]
    interface IOlienFactory {
        event AccountCreated(address indexed account, bytes32 salt);
        function createAccount(Init init, bytes32 salt) external returns (address account);
        function getAddress(Init init, bytes32 salt) external view returns (address);
    }

    /// The transfer policy of docs/16-account-v2.md, as the account takes it.
    #[derive(Debug)]
    struct Policy {
        address token;
        uint128 tier;
        uint48 delay;
        bool requireKnown;
        bool learn;
        uint48 lockedUntil;
    }

    /// What v2 added to the account (docs/16). v1's selectors stay in IOlien above and
    /// a v1 account answers only those; a v2 account answers both sets but these two.
    #[derive(Debug)]
    #[sol(rpc)]
    interface IOlienV2 {
        event Panicked(bytes32 indexed signerId, uint64 epoch);
        event DelaysChanged(uint48 configDelay, uint48 recoveryDelay, uint48 recoveryCoSignDelay, uint48 inactivityDelay);
        event SignerSuspended(bytes32 indexed id);

        error Cooldown(uint48 until);
        error CodeMismatch(address implementation);

        function setDelays(uint48 configDelay, uint48 recoveryDelay, uint48 recoveryCoSignDelay, uint48 inactivityDelay) external;
        function setImplementation(address newImplementation, bytes32 codeHash) external;
        function setTransferPolicy(Policy p) external;
        function setKnown(address[] list, bool known) external;
        function panic() external;
        function getState() external view returns (uint48 inactivityDelay, uint48 lastActivity, bool policyOn);
        function getScheduledLog(uint256 from, uint256 limit) external view returns (bytes32[]);
        function POLICY() external view returns (address);
        function OLIEN_VERSION() external view returns (string);
    }

    /// Every account's limits, policy and known addresses, keyed by the account.
    #[derive(Debug)]
    #[sol(rpc)]
    interface IOlienPolicy {
        event SpendingLimitSet(address indexed account, uint256 indexed id, uint32 generation, address token, address from, uint128 amount, uint48 period, bool anyDestination);
        event LimitSignerAllowed(address indexed account, uint256 indexed id, uint32 generation, bytes32 signerId);
        event LimitDestinationAllowed(address indexed account, uint256 indexed id, uint32 generation, address to);
        event SpendingLimitRemoved(address indexed account, uint256 indexed id);
        event TransferPolicySet(address indexed account, address token, uint128 tier, uint48 delay, bool requireKnown, bool learn, uint48 lockedUntil);
        event DestinationKnown(address indexed account, address indexed to, uint48 since);
        event DestinationForgotten(address indexed account, address indexed to);

        error PolicyLocked(uint48 until);

        function policyOf(address account) external view returns (Policy);
        function knownSince(address account, address to) external view returns (uint48);
        function budget(address account, uint256 id) external view returns (uint128 remaining, uint48 refilledAt, uint32 generation, uint64 epoch);
        function isSigner(address account, uint256 id, bytes32 signerId) external view returns (bool);
        function isDestination(address account, uint256 id, address to) external view returns (bool);
    }

    #[sol(rpc)]
    interface IERC20 {
        event Transfer(address indexed from, address indexed to, uint256 value);
        function transfer(address to, uint256 amount) external returns (bool);
        function balanceOf(address owner) external view returns (uint256);
        /// EIP-3009: true once an authorization's nonce is used or cancelled.
        function authorizationState(address authorizer, bytes32 nonce) external view returns (bool);
    }

    #[sol(rpc)]
    interface IEntryPointView {
        function balanceOf(address account) external view returns (uint256);
        function getNonce(address sender, uint192 key) external view returns (uint256 nonce);
        function handleOps(PackedUserOperation[] ops, address beneficiary) external;

        /// EntryPoint v0.7: one per operation, success or not; gas came off the deposit either way.
        event UserOperationEvent(
            bytes32 indexed userOpHash,
            address indexed sender,
            address indexed paymaster,
            uint256 nonce,
            bool success,
            uint256 actualGasCost,
            uint256 actualGasUsed
        );
    }
}

pub const KIND_ECDSA: u8 = 1;
pub const KIND_P256: u8 = 2;
pub const KIND_WEBAUTHN: u8 = 3;
pub const KIND_CONTRACT: u8 = 4;

pub const PERM_APPROVE: u8 = 1;
pub const PERM_VETO: u8 = 2;
pub const PERM_RECOVER: u8 = 4;
pub const FLAG_UV_REQUIRED: u8 = 1;

pub const PATH_RECOVERY: u8 = 2;
pub const PATH_SINGLE: u8 = 3;

/// Seven days: how long a scheduled change stays executable after `readyAt` (spec §8.2).
pub const SCHEDULE_WINDOW: u64 = 7 * 86_400;
/// Thirty days: the contract refuses a longer validity (spec §6.1).
pub const MAX_VALIDITY: u64 = 30 * 86_400;

pub const EIP1271_MAGIC: [u8; 4] = [0x16, 0x26, 0xba, 0x7e];

/// The four contracts from deployments/<chain>.json under `olien`.
#[derive(Debug, Clone, Deserialize)]
pub struct OlienDeployment {
    pub verifier: Address,
    #[serde(rename = "subAccountImplementation")]
    pub sub_account_implementation: Address,
    pub implementation: Address,
    #[serde(rename = "entryPoint")]
    pub entry_point: Address,
    pub factory: Address,
}

/// v2's four contracts from deployments/<chain>.json under `olienV2`: a verifier that
/// checks every kind of signer, the policy contract every account's limits live in, the
/// implementation, and a factory that makes accounts on it (docs/16-account-v2.md).
#[derive(Debug, Clone, Deserialize)]
pub struct OlienV2Deployment {
    pub verifier: Address,
    pub policy: Address,
    pub implementation: Address,
    pub factory: Address,
}

// ---------------------------------------------------------------------------
// Hashing (spec §4). Computed here rather than through alloy's EIP-712 derive so the
// bytes are exactly the contract's; the once-per-account self-check against
// `getTransactionHash` guards the arithmetic (06-algorithms.md §1).

// EIP-712 appends the definition of every struct a type refers to, so the
// Transaction type string ends with Call's; the contract's constant is the source.
fn typehash(s: &str) -> B256 {
    keccak256(s.as_bytes())
}

pub fn domain_separator(chain_id: u64, account: Address) -> B256 {
    let encoded = (
        typehash("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
        typehash("Olien"),
        typehash("1"),
        U256::from(chain_id),
        account,
    )
        .abi_encode();
    keccak256(encoded)
}

fn call_hash(call: &Call) -> B256 {
    let encoded = (
        typehash("Call(address to,uint256 value,bytes data)"),
        call.to,
        call.value,
        keccak256(&call.data),
    )
        .abi_encode();
    keccak256(encoded)
}

pub fn calls_hash(calls: &[Call]) -> B256 {
    let mut joined = Vec::with_capacity(calls.len() * 32);
    for call in calls {
        joined.extend_from_slice(call_hash(call).as_slice());
    }
    keccak256(joined)
}

pub fn nonce_of(nonce_key: U256, sequence: u64) -> U256 {
    (nonce_key << 64) | U256::from(sequence)
}

pub fn transaction_hash(
    chain_id: u64,
    account: Address,
    nonce: U256,
    epoch: u64,
    calls: &[Call],
    valid_after: u64,
    valid_until: u64,
) -> B256 {
    let struct_hash = keccak256(
        (
            typehash("Transaction(uint256 nonce,uint64 epoch,Call[] calls,uint48 validAfter,uint48 validUntil)Call(address to,uint256 value,bytes data)"),
            nonce,
            U256::from(epoch),
            calls_hash(calls),
            U256::from(valid_after),
            U256::from(valid_until),
        )
            .abi_encode(),
    );
    typed(domain_separator(chain_id, account), struct_hash)
}

/// The hash the account checks for a user operation (spec §10): its own EIP-712 hash
/// over the operation's fields plus the validity window, the epoch and the EntryPoint,
/// so a signature is good for exactly this operation on exactly this account. Mirrors
/// `OlienHash.userOperation`; pinned by a vector the contract's test printed.
pub fn user_operation_hash(
    chain_id: u64,
    account: Address,
    op: &PackedUserOperation,
    valid_after: u64,
    valid_until: u64,
    epoch: u64,
    entry_point: Address,
) -> B256 {
    let limits = U256::from_be_bytes(op.accountGasLimits.0);
    let fees = U256::from_be_bytes(op.gasFees.0);
    let low = U256::from(u128::MAX);
    // Two encodes joined, exactly as the contract does it (one call with fifteen
    // arguments runs out of stack there; the bytes are the same either way).
    let head = (
        typehash(USER_OPERATION_TYPE),
        op.sender,
        op.nonce,
        keccak256(&op.initCode),
        keccak256(&op.callData),
        limits >> 128,
        limits & low,
        op.preVerificationGas,
    )
        .abi_encode();
    let tail = (
        fees >> 128,
        fees & low,
        keccak256(&op.paymasterAndData),
        U256::from(valid_after),
        U256::from(valid_until),
        U256::from(epoch),
        entry_point,
    )
        .abi_encode();
    let mut joined = head;
    joined.extend_from_slice(&tail);
    typed(domain_separator(chain_id, account), keccak256(joined))
}

const USER_OPERATION_TYPE: &str = "UserOperation(address sender,uint256 nonce,bytes initCode,bytes callData,uint128 verificationGasLimit,uint128 callGasLimit,uint256 preVerificationGas,uint128 maxPriorityFeePerGas,uint128 maxFeePerGas,bytes paymasterAndData,uint48 validAfter,uint48 validUntil,uint64 epoch,address entryPoint)";

/// `executeUserOp.selector ‖ abi.encode(Call[])`: the only callData the account serves.
pub fn user_operation_calldata(calls: &[Call]) -> Bytes {
    let mut out = IAccountExecute::executeUserOpCall::SELECTOR.to_vec();
    out.extend_from_slice(&calls.to_vec().abi_encode());
    out.into()
}

/// The calls back out of `user_operation_calldata`, or None for any other shape.
pub fn user_operation_calls(call_data: &[u8]) -> Option<Vec<Call>> {
    let body = call_data.strip_prefix(IAccountExecute::executeUserOpCall::SELECTOR.as_slice())?;
    <Vec<Call>>::abi_decode(body).ok()
}

/// verificationGasLimit ‖ callGasLimit, and maxPriorityFeePerGas ‖ maxFeePerGas,
/// each two uint128 in one word, high half first.
pub fn packed_pair(high: u128, low: u128) -> B256 {
    let mut out = [0u8; 32];
    out[..16].copy_from_slice(&high.to_be_bytes());
    out[16..].copy_from_slice(&low.to_be_bytes());
    B256::from(out)
}

/// `op.signature = validAfter (6 bytes) ‖ validUntil (6 bytes) ‖ packed signatures`.
pub fn user_operation_signature(valid_after: u64, valid_until: u64, packed: &[u8]) -> Bytes {
    let mut out = Vec::with_capacity(12 + packed.len());
    out.extend_from_slice(&valid_after.to_be_bytes()[2..]);
    out.extend_from_slice(&valid_until.to_be_bytes()[2..]);
    out.extend_from_slice(packed);
    out.into()
}

// What a member account signs to confirm another account's transaction, and what the
// account's members sign for a cheque (spec §9): Message(hash) in the account's domain.
pub fn message_hash(chain_id: u64, account: Address, hash: B256) -> B256 {
    let struct_hash = keccak256((typehash("Message(bytes32 hash)"), hash).abi_encode());
    typed(domain_separator(chain_id, account), struct_hash)
}

/// What a member signs to put an address in the book: the address, what it is called,
/// and when. It is a struct of its own in the account's domain, which the account never
/// verifies, so the signature is worth nothing on the chain and cannot be replayed as an
/// approval of anything. The time is inside the signature so that nobody holding the
/// database can make an entry look older than it is.
pub fn address_book_hash(chain_id: u64, account: Address, entry: Address, label: &str, category: &str, added_at: u64) -> B256 {
    let struct_hash = keccak256(
        (
            typehash("AddressBookEntry(address entry,string label,string category,uint48 addedAt)"),
            entry,
            keccak256(label.as_bytes()),
            keccak256(category.as_bytes()),
            U256::from(added_at),
        )
            .abi_encode(),
    );
    typed(domain_separator(chain_id, account), struct_hash)
}

fn typed(domain: B256, struct_hash: B256) -> B256 {
    let mut out = Vec::with_capacity(66);
    out.extend_from_slice(&[0x19, 0x01]);
    out.extend_from_slice(domain.as_slice());
    out.extend_from_slice(struct_hash.as_slice());
    keccak256(out)
}

/// `bytes32(uint256(uint160(address)))`: the signer id of an ECDSA or CONTRACT signer.
pub fn signer_id_of_address(address: Address) -> B256 {
    B256::left_padding_from(address.as_slice())
}

/// `keccak256(abi.encode(x, y))`: the signer id of a P256 or WEBAUTHN signer.
#[allow(dead_code)]
pub fn signer_id_of_key(x: U256, y: U256) -> B256 {
    keccak256((x, y).abi_encode())
}

pub fn address_of_signer_id(id: B256) -> Option<Address> {
    if id.as_slice()[..12].iter().any(|b| *b != 0) {
        return None;
    }
    Some(Address::from_slice(&id.as_slice()[12..]))
}

// ---------------------------------------------------------------------------
// Signature packing (spec §5.1): `signerId ‖ len(2) ‖ sig`, ids strictly ascending.

pub fn pack(entries: &[(B256, Vec<u8>)]) -> Result<Bytes> {
    let mut sorted: Vec<&(B256, Vec<u8>)> = entries.iter().collect();
    sorted.sort_by_key(|entry| entry.0);
    let mut out = Vec::new();
    let mut last: Option<B256> = None;
    for (id, sig) in sorted {
        if last == Some(*id) {
            bail!("duplicate signer {id:#x} in the packed signatures");
        }
        if sig.len() > u16::MAX as usize {
            bail!("a signature entry is longer than 65535 bytes");
        }
        out.extend_from_slice(id.as_slice());
        out.extend_from_slice(&(sig.len() as u16).to_be_bytes());
        out.extend_from_slice(sig);
        last = Some(*id);
    }
    Ok(out.into())
}

// ---------------------------------------------------------------------------
// Per-kind checks, exactly the contract's (spec §5.2), so a confirmation that would
// fail on chain is refused with a reason now.

const SECP256K1_HALF_N: U256 =
    U256::from_limbs([0xdfe92f46681b20a0, 0x5d576e7357a4501d, 0xffffffffffffffff, 0x7fffffffffffffff]);
const P256_HALF_N: U256 =
    U256::from_limbs([0x79dce5617e3192a8, 0xde737d56d38bcf42, 0x7fffffffffffffff, 0x7fffffff80000000]);

pub fn eth_signed_message_hash(hash: B256) -> B256 {
    let mut prefixed = b"\x19Ethereum Signed Message:\n32".to_vec();
    prefixed.extend_from_slice(hash.as_slice());
    keccak256(prefixed)
}

/// A 65-byte `r ‖ s ‖ v` signature over `hash`, or over the EIP-191 wrapping of it when
/// `v` is 31 or 32. Low `s` only; `v` of 0 or 1 is lifted to 27 or 28.
pub fn verify_ecdsa(hash: B256, sig: &[u8], expected: Address) -> Result<()> {
    if sig.len() != 65 {
        bail!("an ECDSA signature is 65 bytes, got {}", sig.len());
    }
    let mut v = sig[64];
    let mut digest = hash;
    if v == 31 || v == 32 {
        digest = eth_signed_message_hash(hash);
        v -= 4;
    }
    if v == 0 || v == 1 {
        v += 27;
    }
    if v != 27 && v != 28 {
        bail!("invalid v byte {v}");
    }
    let s = U256::from_be_slice(&sig[32..64]);
    if s > SECP256K1_HALF_N {
        bail!("high-s signature; normalise s before sending");
    }
    let signature = alloy::primitives::Signature::from_scalars_and_parity(
        B256::from_slice(&sig[..32]),
        B256::from_slice(&sig[32..64]),
        v == 28,
    );
    let recovered = signature
        .recover_address_from_prehash(&digest)
        .context("recovering the signer")?;
    if recovered != expected {
        bail!("signed by {recovered:#x}, not by {expected:#x}");
    }
    Ok(())
}

/// A 64-byte `r ‖ s` P-256 signature over `hash`, low `s` only.
pub fn verify_p256(hash: B256, r: U256, s: U256, x: U256, y: U256) -> Result<()> {
    if s > P256_HALF_N {
        bail!("high-s P-256 signature; normalise s before sending");
    }
    let x_bytes: [u8; 32] = x.to_be_bytes();
    let y_bytes: [u8; 32] = y.to_be_bytes();
    let point = p256::EncodedPoint::from_affine_coordinates(
        &p256::FieldBytes::from(x_bytes),
        &p256::FieldBytes::from(y_bytes),
        false,
    );
    let key = p256::ecdsa::VerifyingKey::from_encoded_point(&point).context("the signer's key is not on the curve")?;
    let r_bytes: [u8; 32] = r.to_be_bytes();
    let s_bytes: [u8; 32] = s.to_be_bytes();
    let signature = p256::ecdsa::Signature::from_scalars(r_bytes, s_bytes).context("malformed P-256 scalars")?;
    key.verify_prehash(hash.as_slice(), &signature)
        .map_err(|_| anyhow!("P-256 signature does not verify"))
}

pub fn verify_p256_raw(hash: B256, sig: &[u8], x: U256, y: U256) -> Result<()> {
    if sig.len() != 64 {
        bail!("a P-256 signature is 64 bytes, got {}", sig.len());
    }
    verify_p256(hash, U256::from_be_slice(&sig[..32]), U256::from_be_slice(&sig[32..]), x, y)
}

/// `abi.encode(authenticatorData, clientDataFields, r, s)` over the WebAuthn challenge
/// `hash`, rebuilt around the challenge exactly as the contract does (spec §5.2).
pub fn verify_webauthn(hash: B256, sig: &[u8], x: U256, y: U256, require_uv: bool) -> Result<()> {
    // Encoded the way Solidity's abi.decode(signature, (bytes, string, uint256, uint256))
    // reads it: a parameter list, with no outer offset word around the tuple.
    let (auth_data, client_data_fields, r, s) =
        <(Bytes, String, U256, U256)>::abi_decode_params(sig).context("decoding the WebAuthn envelope")?;
    if auth_data.len() < 37 {
        bail!("authenticator data shorter than 37 bytes");
    }
    let flags = auth_data[32];
    if flags & 0x01 == 0 {
        bail!("user presence flag not set");
    }
    if require_uv && flags & 0x04 == 0 {
        bail!("user verification required and not set");
    }
    let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(hash.as_slice());
    let client_data = format!("{{\"type\":\"webauthn.get\",\"challenge\":\"{challenge}\",{client_data_fields}}}");
    let client_hash = Sha256::digest(client_data.as_bytes());
    let mut message = auth_data.to_vec();
    message.extend_from_slice(&client_hash);
    let digest = B256::from_slice(&Sha256::digest(&message));
    verify_p256(digest, r, s, x, y)
}

// ---------------------------------------------------------------------------
// Decoding the account's own selectors for people and for the schedule rule.

pub struct SelectorInfo {
    pub name: &'static str,
    /// True for the selectors the account schedules behind `configDelay` (spec §6.2).
    pub config: bool,
}

pub fn account_selector(selector: [u8; 4]) -> Option<SelectorInfo> {
    let config = |name| Some(SelectorInfo { name, config: true });
    let immediate = |name| Some(SelectorInfo { name, config: false });
    match selector {
        s if s == IOlien::addSignerCall::SELECTOR => config("addSigner"),
        s if s == IOlien::removeSignerCall::SELECTOR => config("removeSigner"),
        s if s == IOlien::replaceSignerCall::SELECTOR => config("replaceSigner"),
        s if s == IOlien::setThresholdCall::SELECTOR => config("setThreshold"),
        s if s == IOlien::setVetoThresholdCall::SELECTOR => config("setVetoThreshold"),
        s if s == IOlien::setDelaysCall::SELECTOR => config("setDelays"),
        s if s == IOlien::setSpendingLimitCall::SELECTOR => config("setSpendingLimit"),
        s if s == IOlien::allowLimitSignerCall::SELECTOR => config("allowLimitSigner"),
        s if s == IOlien::allowLimitDestinationCall::SELECTOR => config("allowLimitDestination"),
        s if s == IOlien::setImplementationCall::SELECTOR => config("setImplementation"),
        s if s == IOlien::freezeImplementationCall::SELECTOR => config("freezeImplementation"),
        s if s == IOlien::removeSpendingLimitCall::SELECTOR => immediate("removeSpendingLimit"),
        s if s == IOlien::cancelCall::SELECTOR => immediate("cancel"),
        // v2 (docs/16). Whether a policy change or a new known address waits depends on the
        // policy in force, which only the chain knows; "config" is the slow answer, so the
        // prediction errs toward a wait that may not happen rather than the reverse.
        s if s == IOlienV2::setDelaysCall::SELECTOR => config("setDelays"),
        s if s == IOlienV2::setImplementationCall::SELECTOR => config("setImplementation"),
        s if s == IOlienV2::setTransferPolicyCall::SELECTOR => config("setTransferPolicy"),
        s if s == IOlienV2::setKnownCall::SELECTOR => config("setKnown"),
        _ => None,
    }
}

/// The name of the account's error behind a revert, when it is one of them.
pub fn decode_revert(data: &[u8]) -> Option<String> {
    if data.len() < 4 {
        return None;
    }
    let decoded = IOlien::IOlienErrors::abi_decode(data).ok()?;
    let debug = format!("{decoded:?}");
    Some(debug.split('(').next().unwrap_or(&debug).to_string())
}

fn describe(error: ContractError) -> anyhow::Error {
    if let Some(data) = error.as_revert_data() {
        if let Some(name) = decode_revert(&data) {
            return anyhow!("{name}");
        }
    }
    anyhow!("{error}")
}

/// A public RPC is load balanced, so the node that takes a send may not have seen the
/// relayer's previous transaction yet and answers "nonce too low"; one short wait and a
/// second attempt reads a fresh pending nonce. Reverts are not retried.
pub(crate) async fn retry_nonce<T, F, Fut>(mut send: F) -> Result<T>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T>>,
{
    match send().await {
        Err(error) if error.to_string().contains("nonce too low") => {
            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
            send().await
        }
        other => other,
    }
}

// ---------------------------------------------------------------------------
// The client: reads through the RPC, writes from the relayer key.

pub struct Created {
    pub tx_hash: B256,
    pub block: u64,
}

pub struct Sent {
    pub tx_hash: B256,
    pub block: u64,
    pub gas_used: u64,
}

/// What decides whether a proposal may run: the account's epoch and threshold, who its
/// signers are, and where each lane stands.
#[derive(Debug, PartialEq, Eq)]
pub struct Gate {
    pub epoch: u64,
    pub threshold: u16,
    pub signers: Vec<B256>,
    pub sequences: Vec<u64>,
}

async fn gate_from(provider: &DynProvider, account: Address, lanes: &[U256]) -> Result<Gate> {
    let contract = IOlien::new(account, provider);
    let config = contract.getConfig().call().await.map_err(describe)?;
    let mut signers = contract.getSigners().call().await.map_err(describe)?;
    signers.sort();
    let mut sequences = Vec::with_capacity(lanes.len());
    for lane in lanes {
        let nonce = contract.getNonce(alloy::primitives::Uint::<192, 3>::from(*lane)).call().await.map_err(describe)?;
        sequences.push((nonce & U256::from(u64::MAX)).to::<u64>());
    }
    Ok(Gate { epoch: config.epoch, threshold: config.threshold, signers, sequences })
}

#[derive(Clone)]
pub struct OlienClient {
    provider: DynProvider,
    /// A second endpoint, read only, that the first is checked against.
    witness: Option<DynProvider>,
    relayer: Address,
    pub deployment: OlienDeployment,
    /// Present only when v2's code is on the chain. New accounts are then made on v2.
    pub v2: Option<OlienV2Deployment>,
    pub usdc: Address,
    /// EURC where the chain has it. A treasury that converted into euros should be
    /// able to see them, and Convert on the phone means some will.
    pub eurc: Option<Address>,
    // The relayer's nonce is filled by the provider per transaction, so two sends in
    // flight at once would collide; every send takes this lock first.
    send_lock: Arc<tokio::sync::Mutex<()>>,
}

impl OlienClient {
    pub fn new(
        rpc_url: &str,
        private_key: &str,
        deployment: OlienDeployment,
        v2: Option<OlienV2Deployment>,
        usdc: Address,
        eurc: Option<Address>,
        witness_url: Option<&str>,
    ) -> Result<Self> {
        let witness = match witness_url {
            Some(url) => Some(ProviderBuilder::new().connect_http(url.parse().context("parsing RPC_URL_SECONDARY")?).erased()),
            None => None,
        };
        let signer: PrivateKeySigner = private_key.trim().parse().context("parsing the relayer key")?;
        let relayer = signer.address();
        let url = rpc_url.parse().context("parsing the RPC URL for the relayer")?;
        // The relayer key is shared with the Safe deployer and the attestor in this
        // process, and with operators' scripts on testnet, so the nonce is read from the
        // node's pending count at every send rather than cached across sends.
        let provider = ProviderBuilder::new()
            .disable_recommended_fillers()
            .filler(GasFiller)
            .filler(ChainIdFiller::default())
            .filler(NonceFiller::new(SimpleNonceManager::default()))
            .wallet(EthereumWallet::from(signer))
            .connect_http(url)
            .erased();
        Ok(Self {
            provider,
            witness,
            relayer,
            deployment,
            v2,
            usdc,
            eurc,
            send_lock: Arc::new(tokio::sync::Mutex::new(())),
        })
    }

    pub fn relayer(&self) -> Address {
        self.relayer
    }

    pub fn has_witness(&self) -> bool {
        self.witness.is_some()
    }

    /// Whether the two endpoints tell different stories about what gates execution,
    /// and what the difference is. None when they agree, and when there is only one.
    ///
    /// An RPC provider can lie about an epoch, a nonce or a signer set, and a service
    /// that reads one endpoint believes it. Two endpoints run by different people have
    /// to both lie, the same way. They can also simply be a block apart, so a first
    /// difference is asked about again after a moment before it counts. A witness that
    /// cannot be reached says nothing either way and is not a disagreement.
    pub async fn disagreement(&self, account: Address, lanes: &[U256]) -> Result<Option<String>> {
        let Some(witness) = &self.witness else { return Ok(None) };
        for attempt in 0..2 {
            let ours = gate_from(&self.provider, account, lanes).await?;
            let theirs = match gate_from(witness, account, lanes).await {
                Ok(gate) => gate,
                Err(error) => {
                    tracing::warn!("the second RPC could not be read for {account:#x}: {error:#}");
                    return Ok(None);
                }
            };
            if ours == theirs {
                return Ok(None);
            }
            if attempt == 0 {
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                continue;
            }
            let what = if ours.epoch != theirs.epoch {
                format!("the epoch ({} and {})", ours.epoch, theirs.epoch)
            } else if ours.threshold != theirs.threshold {
                format!("the threshold ({} and {})", ours.threshold, theirs.threshold)
            } else if ours.signers != theirs.signers {
                "who the signers are".to_string()
            } else {
                "where a lane stands".to_string()
            };
            return Ok(Some(what));
        }
        Ok(None)
    }

    /// Where new accounts are made: v2's factory when v2 is served, else v1's.
    pub fn new_account_factory(&self) -> Address {
        self.v2.as_ref().map(|v| v.factory).unwrap_or(self.deployment.factory)
    }

    /// Whether an account runs v2, read from its implementation slot.
    pub async fn is_v2(&self, account: Address) -> Result<bool> {
        let Some(v2) = &self.v2 else { return Ok(false) };
        Ok(self.implementation(account).await? == v2.implementation)
    }

    pub async fn predict_address(&self, init: &Init, salt: B256) -> Result<Address> {
        let factory = IOlienFactory::new(self.new_account_factory(), &self.provider);
        factory
            .getAddress(init.clone(), salt)
            .call()
            .await
            .map_err(describe)
            .context("predicting the account address")
    }

    pub async fn create_account(&self, init: &Init, salt: B256) -> Result<Created> {
        let _guard = self.send_lock.lock().await;
        let factory = IOlienFactory::new(self.new_account_factory(), &self.provider);
        let receipt = retry_nonce(|| async {
            factory.createAccount(init.clone(), salt).send().await.map_err(describe)
        })
        .await
        .context("sending createAccount")?
        .get_receipt()
        .await
        .context("waiting for createAccount")?;
        if !receipt.status() {
            bail!("createAccount reverted in {:#x}", receipt.transaction_hash);
        }
        Ok(Created {
            tx_hash: receipt.transaction_hash,
            block: receipt.block_number.unwrap_or_default(),
        })
    }

    pub async fn block_number(&self) -> Result<u64> {
        Ok(self.provider.get_block_number().await?)
    }

    /// Whether there is code at this address.
    ///
    /// Decides whether a signer is KIND_CONTRACT, verified through EIP-1271, or
    /// KIND_ECDSA, verified by recovery. Getting it wrong makes every signature from
    /// that member fail on chain, so it is read from the chain rather than inferred
    /// from whatever directory named the member.
    pub async fn is_contract(&self, address: Address) -> Result<bool> {
        let code = self
            .provider
            .get_code_at(address)
            .await
            .context("reading code at a signer's address")?;
        Ok(!code.is_empty())
    }

    /// The hash of the code at an address, the way the chain's EXTCODEHASH gives it
    /// for an address that has code.
    pub async fn code_hash(&self, address: Address) -> Result<B256> {
        let code = self.provider.get_code_at(address).await.context("reading code")?;
        Ok(keccak256(&code))
    }

    pub async fn block_timestamp(&self, number: u64) -> Result<u64> {
        let block = self
            .provider
            .get_block_by_number(number.into())
            .await?
            .ok_or_else(|| anyhow!("block {number} not found"))?;
        Ok(block.header.timestamp)
    }

    pub async fn config(&self, account: Address) -> Result<ConfigView> {
        IOlien::new(account, &self.provider).getConfig().call().await.map_err(describe)
    }

    pub async fn signers(&self, account: Address) -> Result<Vec<(B256, SignerView)>> {
        let contract = IOlien::new(account, &self.provider);
        let ids = contract.getSigners().call().await.map_err(describe)?;
        let mut out = Vec::with_capacity(ids.len());
        for id in ids {
            let view = contract.getSigner(id).call().await.map_err(describe)?;
            out.push((id, view));
        }
        Ok(out)
    }

    /// The lane's next sequence. `getNonce` answers the whole two-dimensional nonce,
    /// `key << 64 | sequence`, so the low 64 bits are the sequence.
    pub async fn nonce(&self, account: Address, key: U256) -> Result<u64> {
        let key = alloy::primitives::Uint::<192, 3>::from(key);
        let nonce = IOlien::new(account, &self.provider).getNonce(key).call().await.map_err(describe)?;
        Ok((nonce & U256::from(u64::MAX)).to::<u64>())
    }

    pub async fn transaction_hash_onchain(&self, account: Address, txn: &Transaction) -> Result<B256> {
        IOlien::new(account, &self.provider)
            .getTransactionHash(txn.clone())
            .call()
            .await
            .map_err(describe)
    }

    pub async fn implementation(&self, account: Address) -> Result<Address> {
        IOlien::new(account, &self.provider).implementation().call().await.map_err(describe)
    }

    pub async fn is_approved(&self, account: Address, hash: B256, signer: B256) -> Result<bool> {
        IOlien::new(account, &self.provider).isApproved(hash, signer).call().await.map_err(describe)
    }

    pub async fn scheduled(&self, account: Address, hash: B256) -> Result<ScheduledView> {
        IOlien::new(account, &self.provider).getScheduled(hash).call().await.map_err(describe)
    }

    pub async fn limit_budget(&self, account: Address, id: u64) -> Result<(u128, u64, u32, u64)> {
        let out = IOlien::new(account, &self.provider)
            .getLimitBudget(U256::from(id))
            .call()
            .await
            .map_err(describe)?;
        Ok((out.remaining, out.resetAt.to::<u64>(), out.generation, out.epoch))
    }

    /// Every token this treasury can hold, so a caller loops rather than naming coins.
    /// A limit's live budget whichever version the account runs: v1 answers from the
    /// account, v2 from the policy contract. A v2 account has no `getLimitBudget`, so
    /// the account is asked first and the policy contract on its refusal.
    pub async fn limit_budget_any(&self, account: Address, id: u64) -> Result<(u128, u64, u32, u64)> {
        match self.limit_budget(account, id).await {
            Ok(budget) => Ok(budget),
            Err(error) => match &self.v2 {
                Some(v2) => {
                    let b = IOlienPolicy::new(v2.policy, &self.provider).budget(account, U256::from(id)).call().await.map_err(describe)?;
                    Ok((b.remaining, b.refilledAt.to::<u64>(), b.generation, b.epoch))
                }
                None => Err(error),
            },
        }
    }

    pub fn tokens(&self) -> Vec<Address> {
        match self.eurc {
            Some(eurc) => vec![self.usdc, eurc],
            None => vec![self.usdc],
        }
    }

    pub async fn eurc_balance(&self, account: Address) -> Result<U256> {
        match self.eurc {
            Some(eurc) => self.token_balance(eurc, account).await,
            None => Ok(U256::ZERO),
        }
    }

    /// What the address holds of the chain's own gas token: USDC on Arc, MON on Monad.
    pub async fn native_balance(&self, account: Address) -> Result<U256> {
        self.provider.get_balance(account).await.context("reading the native balance")
    }

    pub async fn usdc_balance(&self, account: Address) -> Result<U256> {
        self.token_balance(self.usdc, account).await
    }

    async fn token_balance(&self, token: Address, account: Address) -> Result<U256> {
        IERC20::new(token, &self.provider).balanceOf(account).call().await.map_err(describe)
    }

    /// Whether a USDC authorization from `authorizer` with this nonce has been used.
    pub async fn authorization_used(&self, authorizer: Address, nonce: B256) -> Result<bool> {
        IERC20::new(self.usdc, &self.provider).authorizationState(authorizer, nonce).call().await.map_err(describe)
    }

    /// The EntryPoint's nonce for the account in a key, the whole `key << 64 | seq`.
    pub async fn entry_point_nonce(&self, account: Address, key: u64) -> Result<U256> {
        IEntryPointView::new(self.deployment.entry_point, &self.provider)
            .getNonce(account, alloy::primitives::Uint::<192, 3>::from(key))
            .call()
            .await
            .map_err(describe)
    }

    /// The RPC's view of a fair fee, as the two halves of `gasFees`.
    pub async fn fee_estimate(&self) -> Result<(u128, u128)> {
        let fees = self.provider.estimate_eip1559_fees().await.context("estimating fees")?;
        Ok((fees.max_priority_fee_per_gas, fees.max_fee_per_gas))
    }

    /// The project's own bundler: the relayer calls `handleOps` with one operation and
    /// is the beneficiary, so the account's deposit repays it for the gas (spec §9).
    pub async fn handle_ops(&self, op: PackedUserOperation) -> Result<Sent> {
        let _guard = self.send_lock.lock().await;
        let entry = IEntryPointView::new(self.deployment.entry_point, &self.provider);
        let beneficiary = self.relayer();
        let receipt = retry_nonce(|| async { entry.handleOps(vec![op.clone()], beneficiary).send().await.map_err(describe) })
            .await
            .context("sending handleOps")?
            .get_receipt()
            .await
            .context("waiting for handleOps")?;
        if !receipt.status() {
            bail!("handleOps reverted in {:#x}", receipt.transaction_hash);
        }
        Ok(Sent {
            tx_hash: receipt.transaction_hash,
            block: receipt.block_number.unwrap_or_default(),
            gas_used: receipt.gas_used,
        })
    }

    pub async fn entry_point_deposit(&self, account: Address) -> Result<U256> {
        IEntryPointView::new(self.deployment.entry_point, &self.provider)
            .balanceOf(account)
            .call()
            .await
            .map_err(describe)
    }

    /// EIP-1271 as the chain will ask it: the answer for a CONTRACT signer's entry.
    pub async fn is_valid_signature(&self, signer: Address, hash: B256, signature: &[u8]) -> Result<bool> {
        let answer = IOlien::new(signer, &self.provider)
            .isValidSignature(hash, Bytes::copy_from_slice(signature))
            .call()
            .await
            .map_err(describe)?;
        Ok(answer.as_slice() == EIP1271_MAGIC)
    }

    /// Run each call as the account would, without signatures, so a member is not asked
    /// to sign something that reverts (06-algorithms.md §11). Config calls to the account
    /// itself are skipped: they would run as `msg.sender == account` only after the delay.
    pub async fn simulate(&self, account: Address, calls: &[Call]) -> Result<()> {
        for call in calls {
            if call.to == account {
                continue;
            }
            let request = TransactionRequest::default()
                .from(account)
                .to(call.to)
                .value(call.value)
                .input(call.data.clone().into());
            if let Err(error) = self.provider.call(request).await {
                let text = error.to_string();
                bail!("call to {:#x} reverts: {}", call.to, text.chars().take(200).collect::<String>());
            }
        }
        Ok(())
    }

    /// Deploy one of this account's sub-accounts. Permissionless on the contract: the
    /// address is a deterministic clone this Olien alone can operate, so bringing it
    /// into being takes nobody's approval, only somebody's gas.
    pub async fn create_sub_account(&self, account: Address, index: U256) -> Result<Sent> {
        let _guard = self.send_lock.lock().await;
        let contract = IOlien::new(account, &self.provider);
        let receipt = retry_nonce(|| async { contract.createSubAccount(index).send().await.map_err(describe) })
            .await
            .context("sending createSubAccount")?
            .get_receipt()
            .await
            .context("waiting for createSubAccount")?;
        if !receipt.status() {
            bail!("createSubAccount reverted in {:#x}", receipt.transaction_hash);
        }
        Ok(Sent {
            tx_hash: receipt.transaction_hash,
            block: receipt.block_number.unwrap_or_default(),
            gas_used: receipt.gas_used,
        })
    }

    pub async fn sub_account_address(&self, account: Address, index: U256) -> Result<Address> {
        IOlien::new(account, &self.provider).subAccount(index).call().await.map_err(describe)
    }

    pub async fn execute(&self, account: Address, txn: &Transaction, signatures: Bytes) -> Result<Sent> {
        let _guard = self.send_lock.lock().await;
        let contract = IOlien::new(account, &self.provider);
        let receipt = retry_nonce(|| async {
            contract.execute(txn.clone(), signatures.clone()).send().await.map_err(describe)
        })
        .await
        .context("sending execute")?
        .get_receipt()
        .await
        .context("waiting for execute")?;
        if !receipt.status() {
            bail!("execute reverted in {:#x}", receipt.transaction_hash);
        }
        Ok(Sent {
            tx_hash: receipt.transaction_hash,
            block: receipt.block_number.unwrap_or_default(),
            gas_used: receipt.gas_used,
        })
    }

    pub async fn execute_scheduled(&self, account: Address, hash: B256, calls: Vec<Call>) -> Result<Sent> {
        let _guard = self.send_lock.lock().await;
        let contract = IOlien::new(account, &self.provider);
        let receipt = retry_nonce(|| async {
            contract.executeScheduled(hash, calls.clone()).send().await.map_err(describe)
        })
        .await
        .context("sending executeScheduled")?
        .get_receipt()
        .await
        .context("waiting for executeScheduled")?;
        if !receipt.status() {
            bail!("executeScheduled reverted in {:#x}", receipt.transaction_hash);
        }
        Ok(Sent {
            tx_hash: receipt.transaction_hash,
            block: receipt.block_number.unwrap_or_default(),
            gas_used: receipt.gas_used,
        })
    }

    /// The account's own logs plus USDC transfers touching it, in one block range.
    /// Every USDC transfer into any of the given addresses in the block range, one
    /// query: the recipient topic takes a list, so a hundred Safes cost one call.
    // Part of the client's surface rather than of any job here: an app watching for
    // money arriving into its own accounts is the caller, and this service is not it.
    #[allow(dead_code)]
    pub async fn usdc_received(&self, recipients: &[Address], from_block: u64, to_block: u64) -> Result<Vec<Log>> {
        let topics: Vec<B256> = recipients.iter().map(|a| signer_id_of_address(*a)).collect();
        let filter = Filter::new()
            .address(self.usdc)
            .event_signature(IERC20::Transfer::SIGNATURE_HASH)
            .topic2(topics)
            .from_block(from_block)
            .to_block(to_block);
        self.provider.get_logs(&filter).await.context("reading incoming transfers")
    }

    pub async fn account_logs(&self, account: Address, from_block: u64, to_block: u64) -> Result<Vec<Log>> {
        let own = Filter::new().address(account).from_block(from_block).to_block(to_block);
        let mut logs = self.provider.get_logs(&own).await.context("reading account logs")?;
        let topic: B256 = signer_id_of_address(account);
        let tokens = self.tokens();
        let incoming = Filter::new()
            .address(tokens.clone())
            .event_signature(IERC20::Transfer::SIGNATURE_HASH)
            .topic2(topic)
            .from_block(from_block)
            .to_block(to_block);
        logs.extend(self.provider.get_logs(&incoming).await.context("reading incoming transfers")?);
        let outgoing = Filter::new()
            .address(tokens)
            .event_signature(IERC20::Transfer::SIGNATURE_HASH)
            .topic1(topic)
            .from_block(from_block)
            .to_block(to_block);
        logs.extend(self.provider.get_logs(&outgoing).await.context("reading outgoing transfers")?);
        // Operations the account sent through the EntryPoint: the only record of gas
        // leaving its deposit, and of an operation that ran but reverted.
        let operations = Filter::new()
            .address(self.deployment.entry_point)
            .event_signature(IEntryPointView::UserOperationEvent::SIGNATURE_HASH)
            .topic2(topic)
            .from_block(from_block)
            .to_block(to_block);
        logs.extend(self.provider.get_logs(&operations).await.context("reading user operations")?);
        // A v2 account's limits, policy and known addresses are events of the policy
        // contract, with the account as their first topic.
        if let Some(v2) = &self.v2 {
            let policy = Filter::new().address(v2.policy).topic1(topic).from_block(from_block).to_block(to_block);
            logs.extend(self.provider.get_logs(&policy).await.context("reading policy logs")?);
        }
        logs.sort_by_key(|log| (log.block_number.unwrap_or_default(), log.log_index.unwrap_or_default()));
        logs.dedup_by_key(|log| (log.transaction_hash, log.log_index));
        Ok(logs)
    }
}

/// Calldata builders for the calls a proposal carries.
pub mod calldata {
    use super::*;

    pub fn usdc_transfer(to: Address, amount: U256) -> Bytes {
        IERC20::transferCall { to, amount }.abi_encode().into()
    }
    pub fn add_signer(input: SignerInput) -> Bytes {
        IOlien::addSignerCall { input }.abi_encode().into()
    }
    pub fn remove_signer(id: B256) -> Bytes {
        IOlien::removeSignerCall { id }.abi_encode().into()
    }
    pub fn replace_signer(old_id: B256, input: SignerInput) -> Bytes {
        IOlien::replaceSignerCall { oldId: old_id, input }.abi_encode().into()
    }
    pub fn set_threshold(threshold: u16) -> Bytes {
        IOlien::setThresholdCall { newThreshold: threshold }.abi_encode().into()
    }
    pub fn set_veto_threshold(threshold: u16) -> Bytes {
        IOlien::setVetoThresholdCall { newVetoThreshold: threshold }.abi_encode().into()
    }
    pub fn set_delays(config: u64, recovery: u64, cosign: u64) -> Bytes {
        IOlien::setDelaysCall {
            configDelay: u48(config),
            recoveryDelay: u48(recovery),
            recoveryCoSignDelay: u48(cosign),
        }
        .abi_encode()
        .into()
    }
    pub fn set_spending_limit(id: u64, input: SpendingLimitInput) -> Bytes {
        IOlien::setSpendingLimitCall { id: U256::from(id), input }.abi_encode().into()
    }
    pub fn allow_limit_signer(id: u64, signer: B256) -> Bytes {
        IOlien::allowLimitSignerCall { id: U256::from(id), signerId: signer }.abi_encode().into()
    }
    pub fn allow_limit_destination(id: u64, to: Address) -> Bytes {
        IOlien::allowLimitDestinationCall { id: U256::from(id), to }.abi_encode().into()
    }
    pub fn remove_spending_limit(id: u64) -> Bytes {
        IOlien::removeSpendingLimitCall { id: U256::from(id) }.abi_encode().into()
    }
    pub fn cancel(hash: B256) -> Bytes {
        IOlien::cancelCall { hash }.abi_encode().into()
    }
    pub fn panic() -> Bytes {
        IOlienV2::panicCall {}.abi_encode().into()
    }

    pub fn veto(hash: B256) -> Bytes {
        IOlien::vetoCall { hash }.abi_encode().into()
    }
    pub fn spend(id: u64, to: Address, amount: U256) -> Bytes {
        IOlien::spendCall { id: U256::from(id), to, amount }.abi_encode().into()
    }
}

pub fn u48(value: u64) -> alloy::primitives::Uint<48, 1> {
    alloy::primitives::Uint::<48, 1>::from(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy::primitives::address;
    use alloy::sol_types::SolEvent;

    /// The vector `contracts/test/olien/OlienVectors.t.sol` printed from the contract's
    /// own library: the same inputs must hash the same here, or a signature the console
    /// produces is over something the account will not accept.
    #[test]
    fn a_user_operation_hashes_as_the_contract_hashes_it() {
        let account = address!("00000000000000000000000000000000000000AB");
        let entry_point = address!("0000000071727De22E5E9d8BAf0edAc6f37da032");
        let hash = keccak256(b"proposal");
        let calls = vec![Call { to: account, value: U256::ZERO, data: calldata::veto(hash) }];
        let call_data = user_operation_calldata(&calls);
        assert_eq!(
            format!("0x{}", alloy::hex::encode(&call_data)),
            "0x8dd7712f00000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000ab000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000024fb6f93f9b6d2dc83590271a7c0a5ab5fbf6a2dad418bbfd533c253e3d69a6772712809c700000000000000000000000000000000000000000000000000000000"
        );
        assert_eq!(user_operation_calls(&call_data).unwrap().len(), 1, "and it decodes back");
        assert!(user_operation_calls(&call_data[1..]).is_none(), "a different selector is not served");

        assert_eq!(
            format!("{:#x}", domain_separator(5042002, account)),
            "0x47a50668a7d7f3f8c0be30000cae4046cbe6855b1b64611edfc868173063bee5"
        );
        let op = PackedUserOperation {
            sender: account,
            nonce: U256::from(7),
            initCode: Bytes::new(),
            callData: call_data,
            accountGasLimits: packed_pair(500_000, 300_000),
            preVerificationGas: U256::from(60_000),
            gasFees: packed_pair(1_000_000_000, 2_000_000_000),
            paymasterAndData: Bytes::new(),
            signature: Bytes::new(),
        };
        assert_eq!(
            format!("{:#x}", user_operation_hash(5042002, account, &op, 0, 1_800_000_000, 3, entry_point)),
            "0xdc99dbfd7bb1e9bda0d7b9bb8c2175acc00edc39f4a0fadf106a08a11526d994"
        );
    }

    #[test]
    fn a_user_operation_signature_starts_with_its_window() {
        let sig = user_operation_signature(0, 1_800_000_000, &[0xaa, 0xbb]);
        assert_eq!(sig.len(), 14);
        assert_eq!(&sig[..6], &[0, 0, 0, 0, 0, 0]);
        assert_eq!(u64::from_be_bytes([0, 0, sig[6], sig[7], sig[8], sig[9], sig[10], sig[11]]), 1_800_000_000);
        assert_eq!(&sig[12..], &[0xaa, 0xbb]);
    }

    /// The topic the indexer filters on is EntryPoint v0.7's, not a retyped one.
    #[test]
    fn the_user_operation_event_is_the_entry_points_own() {
        assert_eq!(
            format!("{:#x}", IEntryPointView::UserOperationEvent::SIGNATURE_HASH),
            "0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f"
        );
    }

    // Pinned against the live testnet account of the proofs (spec §18):
    // `cast call 0x12808a601475b87ce7b343A18f11062cc74Eae81 "domainSeparator()(bytes32)"`.
    #[test]
    fn domain_matches_the_chain() {
        let account = address!("12808a601475b87ce7b343A18f11062cc74Eae81");
        assert_eq!(
            format!("{:#x}", domain_separator(5_042_002, account)),
            "0x65e190017ae0f50cfa1e3f47d7252c6d2360ac12f03202583dfb0e9daefa1ddd"
        );
    }

    // `cast call <account> "getTransactionHash((uint192,(address,uint256,bytes)[],uint48,uint48))(bytes32)"
    // "(7,[(<account>,1,0x0102)],1,2)"` on the proof account, whose lane 7 is at 0 and epoch is 1.
    #[test]
    fn transaction_hash_matches_the_chain() {
        let account = address!("12808a601475b87ce7b343A18f11062cc74Eae81");
        let calls = vec![Call { to: account, value: U256::from(1u64), data: Bytes::from_static(b"\x01\x02") }];
        let hash = transaction_hash(5_042_002, account, nonce_of(U256::from(7u64), 0), 1, &calls, 1, 2);
        assert_eq!(format!("{hash:#x}"), "0x62a39124dcbdb23686e7f79b68aee371ef5b372da9fceedc57382b0657bc4609");
    }

    // `cast call <account> "getMessageHash(bytes32)(bytes32)" 0x11..11` on the same account.
    #[test]
    fn message_hash_matches_the_chain() {
        let account = address!("12808a601475b87ce7b343A18f11062cc74Eae81");
        let hash = message_hash(5_042_002, account, B256::repeat_byte(0x11));
        assert_eq!(format!("{hash:#x}"), "0x752e2d6bbdfbb51bb7255ac18e5bac6b5ac1fbc662cd3db5b86c1eee9fd703f4");
    }

    // Computed independently by viem's hashTypedData, which is what a wallet and the
    // console use: if the two ever differ, every entry a member signs is refused here.
    #[test]
    fn an_address_book_entry_hashes_as_a_wallet_hashes_it() {
        let account = address!("00000000000000000000000000000000000000AB");
        let entry = address!("3C44CdDdB6a900fa2b585dd299e03d12FA4293BC");
        let hash = address_book_hash(10143, account, entry, "Acme Ltd", "Supplier", 1_791_201_600);
        assert_eq!(format!("{hash:#x}"), "0xbba321448f5927f73078c7d1ffa63d1b3c3612d586cf19665eeb2fca7c7c1cb3");
        assert_ne!(address_book_hash(10143, account, entry, "Acme Ltd", "Supplier", 1_791_201_601), hash, "the time is part of what is signed");
        assert_ne!(address_book_hash(10143, account, entry, "Acme Inc", "Supplier", 1_791_201_600), hash, "and so is the label");
    }

    // The proof account's device key and the id `getSigners()` lists for it.
    #[test]
    fn p256_signer_id_matches_the_chain() {
        let x = U256::from_str_radix("f299ff7835b561210fb5fd3cd59c45500b84d05ba8579b8ce2687ecf8429f876", 16).unwrap();
        let y = U256::from_str_radix("029e61bc9fe4f56c2e7638c3b49a21f83d859f0e59efd13ebdd68dcf773397c2", 16).unwrap();
        assert_eq!(
            format!("{:#x}", signer_id_of_key(x, y)),
            "0xf4702e5cd615da49f599641b3616968ea416eedb48a045ab9222094d6f9d77e8"
        );
    }

    #[test]
    fn pack_sorts_and_prefixes() {
        let a = B256::from(U256::from(2u64));
        let b = B256::from(U256::from(1u64));
        let packed = pack(&[(a, vec![0xaa; 65]), (b, vec![])]).unwrap();
        assert_eq!(packed.len(), 32 + 2 + 32 + 2 + 65);
        assert_eq!(&packed[..32], b.as_slice());
        assert_eq!(&packed[32..34], &[0, 0]);
        assert_eq!(&packed[34..66], a.as_slice());
        assert_eq!(&packed[66..68], &[0, 65]);
        assert!(pack(&[(a, vec![]), (a, vec![])]).is_err());
    }

    #[test]
    fn ecdsa_round_trip() {
        let signer = PrivateKeySigner::random();
        let hash = keccak256(b"hello");
        let sig = alloy::signers::SignerSync::sign_hash_sync(&signer, &hash).unwrap();
        let bytes = sig.as_bytes();
        verify_ecdsa(hash, &bytes, signer.address()).unwrap();
        assert!(verify_ecdsa(hash, &bytes, Address::ZERO).is_err());
        let wrapped = alloy::signers::SignerSync::sign_hash_sync(&signer, &eth_signed_message_hash(hash)).unwrap();
        let mut wrapped_bytes = wrapped.as_bytes();
        wrapped_bytes[64] += 4;
        verify_ecdsa(hash, &wrapped_bytes, signer.address()).unwrap();
    }

    #[test]
    fn webauthn_envelope_round_trip() {
        use p256::ecdsa::signature::hazmat::PrehashSigner;
        let key = p256::ecdsa::SigningKey::random(&mut rand::rngs::OsRng);
        let point = key.verifying_key().to_encoded_point(false);
        let x = U256::from_be_slice(point.x().unwrap());
        let y = U256::from_be_slice(point.y().unwrap());
        let hash = keccak256(b"a transaction");
        // authenticatorData: rpIdHash, flags with UP and UV set, a counter.
        let mut auth_data = vec![0u8; 37];
        auth_data[32] = 0x05;
        let fields = "\"origin\":\"http://localhost:3099\",\"crossOrigin\":false".to_string();
        let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(hash.as_slice());
        let client_data = format!("{{\"type\":\"webauthn.get\",\"challenge\":\"{challenge}\",{fields}}}");
        let mut message = auth_data.clone();
        message.extend_from_slice(&Sha256::digest(client_data.as_bytes()));
        let digest = Sha256::digest(&message);
        let sig: p256::ecdsa::Signature = key.sign_prehash(&digest).unwrap();
        let sig = sig.normalize_s().unwrap_or(sig);
        let r = U256::from_be_slice(&sig.r().to_bytes());
        let s = U256::from_be_slice(&sig.s().to_bytes());
        // The envelope as viem's encodeAbiParameters and Solidity's abi.encode produce it.
        let envelope = (Bytes::from(auth_data.clone()), fields.clone(), r, s).abi_encode_params();
        verify_webauthn(hash, &envelope, x, y, true).unwrap();
        // With UV required, an assertion without the flag is refused.
        let mut without_uv = auth_data.clone();
        without_uv[32] = 0x01;
        let bad = (Bytes::from(without_uv), fields.clone(), r, s).abi_encode_params();
        assert!(verify_webauthn(hash, &bad, x, y, true).is_err());
        // A tuple wrapped in an outer offset word is not the contract's layout.
        let wrapped = (Bytes::from(auth_data), fields, r, s).abi_encode();
        assert!(verify_webauthn(hash, &wrapped, x, y, true).is_err());
    }

    #[test]
    fn p256_round_trip() {
        use p256::ecdsa::signature::hazmat::PrehashSigner;
        let key = p256::ecdsa::SigningKey::random(&mut rand::rngs::OsRng);
        let hash = keccak256(b"hello");
        let sig: p256::ecdsa::Signature = key.sign_prehash(hash.as_slice()).unwrap();
        let sig = sig.normalize_s().unwrap_or(sig);
        let point = key.verifying_key().to_encoded_point(false);
        let x = U256::from_be_slice(point.x().unwrap());
        let y = U256::from_be_slice(point.y().unwrap());
        verify_p256_raw(hash, &sig.to_bytes(), x, y).unwrap();
        assert!(verify_p256_raw(keccak256(b"other"), &sig.to_bytes(), x, y).is_err());
    }
}
