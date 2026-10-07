// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {P256} from "@openzeppelin/contracts/utils/cryptography/P256.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";

import {
    IOlien,
    Call,
    Transaction,
    SignerInput,
    SignerView,
    ConfigView,
    Init,
    SpendingLimitInput,
    ScheduledView,
    KIND_NONE,
    KIND_ECDSA,
    KIND_P256,
    KIND_WEBAUTHN,
    KIND_CONTRACT,
    PERM_APPROVE,
    PERM_VETO,
    PERM_RECOVER,
    FLAG_UV_REQUIRED,
    PATH_THRESHOLD,
    PATH_RECOVERY,
    PATH_SINGLE
} from "../IOlien.sol";
import {PackedUserOperation, IAccount, IAccountExecute} from "../IEntryPoint.sol";
import {OlienHash} from "../OlienHash.sol";
import {SubAccount} from "../SubAccount.sol";
import {IOlienV2, Policy, FLAG_SYNCED, FLAG_SUSPENDED} from "./IOlienV2.sol";
import {IOlienVerifierV2} from "./OlienVerifierV2.sol";
import {OlienPolicy} from "./OlienPolicy.sol";

/// @title OlienV2
/// @notice The second implementation of the account. Specification: docs/10-account-spec.md,
///         with the differences in docs/16-account-v2.md. Every rule of v1 holds. What is
///         new: money itself can be made to wait and be vetoed, one member can stop
///         everything in flight, a colleague's key can be replaced after a long silence,
///         a vetoed guardian is suspended, an upgrade names the code it was vetted as, and
///         spending limits, the transfer policy and the known addresses live in `OlienPolicy`.
///
/// One implementation, one proxy per account. Signers are secp256k1 addresses, P-256
/// keys (verified by the chain's precompile), passkeys, or other contracts. Every
/// authorization the account accepts is resolved here, inside the contract: the
/// threshold, a guardian's recovery, a spending limit, a veto. Rule changes wait out a
/// delay the account chose and can be vetoed while they wait.
contract OlienV2 is
    IOlienV2,
    IAccount,
    IAccountExecute,
    IERC1271,
    IERC721Receiver
{
    string public constant OLIEN_VERSION = "2.0.0";

    /// @dev How long a scheduled change stays executable after its delay elapses.
    uint48 private constant SCHEDULE_WINDOW = 7 days;
    /// @dev The most a signature may stay valid for, and the longest any delay may be.
    uint48 private constant MAX_VALIDITY = 30 days;
    uint48 private constant MAX_DELAY = 30 days;
    /// @dev A guardian acting alone always waits at least this long.
    uint48 private constant MIN_RECOVERY_DELAY = 1 hours;
    /// @dev One panic per signer in this span bounds what one vetoer can disrupt.
    uint48 private constant PANIC_COOLDOWN = 1 days;
    /// @dev A silence shorter than this is a holiday, not a lost key; longer than two years is never.
    uint48 private constant MIN_INACTIVITY = 7 days;
    uint48 private constant MAX_INACTIVITY = 730 days;

    // keccak256(abi.encode(uint256(keccak256("olien.account.v1")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 public constant STORAGE_LOCATION = 0x707c89748ccdf9a775a4663e968dd0c304603575b7e0f2831dc9b94440e1d800;

    address public immutable ENTRY_POINT;
    /// @notice Stateless P-256 and passkey checks (see `OlienVerifier`).
    address public immutable VERIFIER;
    /// @notice The implementation every sub-account is a minimal proxy of.
    address public immutable SUB_ACCOUNT_IMPLEMENTATION;
    /// @notice Where every account's limits, transfer policy and known addresses live.
    address public immutable POLICY;

    bytes4 private constant MAGIC_1271_HASH = 0x1626ba7e;
    bytes4 private constant NOT_VALID = 0xffffffff;
    uint256 private constant SIG_VALIDATION_FAILED = 1;

    // Transient slots: what `validateUserOp` established, read back by `executeUserOp`; the
    // signer a single-signer self call is running for; and the reentrancy latch.
    bytes32 private constant USEROP_HASH_SLOT = keccak256("olien.userop.hash");
    bytes32 private constant USEROP_META_SLOT = keccak256("olien.userop.meta");
    bytes32 private constant USEROP_SIGNER_SLOT = keccak256("olien.userop.signer");
    bytes32 private constant CURRENT_SIGNER_SLOT = keccak256("olien.current-signer");
    bytes32 private constant GUARD_SLOT = keccak256("olien.guard");

    struct Signer {
        uint8 kind;
        uint8 permissions;
        uint8 flags;
        uint64 since; // epoch the signer was added in; limits only name signers older than themselves
        uint32 index; // 1-based position in signerList
        uint256 x;
        uint256 y;
    }

    struct ScheduleEntry {
        uint48 readyAt;
        uint64 epoch;
        uint8 path;
        bool policy; // held by the transfer policy: running it makes its destinations known
        bytes32 excluded; // threshold path: the signer removed, who may not veto; recovery path: the guardian
        bytes32 callsHash;
    }

    struct Storage {
        mapping(bytes32 => Signer) signers;
        bytes32[] signerList;
        uint16 threshold;
        uint16 vetoThreshold;
        uint16 approverCount;
        uint16 vetoerCount;
        uint16 approverVetoerCount;
        uint16 recovererCount;
        uint48 configDelay;
        uint48 recoveryDelay;
        uint48 recoveryCoSignDelay;
        uint64 epoch;
        bool implementationFrozen;
        mapping(uint192 => uint64) nonces;
        mapping(bytes32 => mapping(bytes32 => bool)) approvals;
        mapping(bytes32 => ScheduleEntry) scheduled;
        mapping(bytes32 => mapping(bytes32 => bool)) vetoes;
        mapping(bytes32 => uint16) vetoCount;
        mapping(bytes32 => bool) dead;
        // v1 kept its spending limits in these slots; v2 keeps them in OlienPolicy. The slots
        // stay so that everything after them lands where v1 put it.
        uint256 __v1Limits;
        uint256 __v1LimitSigners;
        uint256 __v1LimitDestinations;
        uint256 nextLimitId; // v1's slot too: ids go on from where v1 left them
        uint48 lastActivity;
        uint48 inactivityDelay;
        uint48 lastPanic;
        bool policyOn; // the transfer policy holds something, so batches are evaluated against it
        bytes32[] scheduledLog; // every hash ever scheduled, in order; a reader keeps a cursor
    }

    /// @dev What a packed signature set established, once every entry checked out.
    struct Tally {
        uint16 count;
        uint16 approvers;
        uint16 plainApprovers; // APPROVE without RECOVER: what may co-sign a recovery
        uint16 recoverers;
        bytes32 recoverer; // the first guardian in the set, suspended if its recovery is vetoed
    }

    /// @dev What a set of calls is: rule change or not, a lone recovery or not, and the one
    ///      signer it removes if it removes exactly one.
    struct Shape {
        bool config;
        bool recoveryOnly;
        uint48 wait; // how long the transfer policy holds it; zero when it does not
        bytes32 target;
    }

    constructor(address entryPoint, address verifier, address subAccountImplementation, address policy) {
        ENTRY_POINT = entryPoint;
        VERIFIER = verifier;
        SUB_ACCOUNT_IMPLEMENTATION = subAccountImplementation;
        POLICY = policy;
        // The implementation is never an account: nobody can initialize it.
        _s().epoch = type(uint64).max;
    }

    modifier onlySelf() {
        if (msg.sender != address(this)) revert NotSelf();
        _;
    }

    modifier onlyEntryPoint() {
        if (msg.sender != ENTRY_POINT) revert NotEntryPoint();
        _;
    }

    /// @dev One execution at a time. A callee that re-enters `execute`, `executeScheduled` or
    ///      `spend` mid-batch would run under rules the batch may be changing.
    modifier guarded() {
        _enter();
        _;
        _exit();
    }

    receive() external payable {}

    // ---------------------------------------------------------------- setup

    function initialize(Init calldata init) external {
        Storage storage s = _s();
        if (s.epoch != 0) revert AlreadyInitialized();
        s.epoch = 1;
        _touch(s);
        for (uint256 i = 0; i < init.signers.length; i++) {
            _addSigner(s, init.signers[i]);
        }
        s.threshold = init.threshold;
        s.vetoThreshold = init.vetoThreshold;
        s.configDelay = init.configDelay;
        s.recoveryDelay = init.recoveryDelay;
        s.recoveryCoSignDelay = init.recoveryCoSignDelay;
        _checkConfig(s);
        emit Initialized(
            init.threshold, init.vetoThreshold, init.configDelay, init.recoveryDelay, init.recoveryCoSignDelay
        );
    }

    // ------------------------------------------------------------ execution

    /// @notice Runs, or schedules, a transaction authorized by packed signatures. Anyone
    ///         may submit; the signatures are the authority and the submitter pays gas.
    function execute(Transaction calldata txn, bytes calldata signatures) external guarded {
        Storage storage s = _s();
        _checkValidity(txn.validAfter, txn.validUntil);

        uint256 nonce = (uint256(txn.nonceKey) << 64) | s.nonces[txn.nonceKey];
        Call[] memory calls = txn.calls;
        bytes32 hash =
            IOlienVerifierV2(VERIFIER).transactionHash(_domain(), nonce, s.epoch, txn.calls, txn.validAfter, txn.validUntil);
        if (s.dead[hash]) revert Dead(hash);
        s.nonces[txn.nonceKey] += 1;

        (bool ok, Tally memory t) = _tryVerify(s, hash, signatures);
        if (!ok) revert InvalidSignatures();
        (uint8 path, uint48 delay, Shape memory shape) = _resolve(s, calls, t);
        _touch(s);
        _land(s, hash, nonce, calls, path, delay, shape);
    }

    /// @notice The execution half of a user operation `validateUserOp` accepted. The
    ///         EntryPoint hands over the whole operation, so what was validated is what runs.
    function executeUserOp(PackedUserOperation calldata op, bytes32 userOpHash) external onlyEntryPoint {
        Storage storage s = _s();
        bytes32 hash = _tload(_slot(USEROP_HASH_SLOT, userOpHash));
        uint256 meta = uint256(_tload(_slot(USEROP_META_SLOT, userOpHash)));
        bytes32 signer = _tload(_slot(USEROP_SIGNER_SLOT, userOpHash));
        if (meta == 0) revert NotValidated();
        _tstore(_slot(USEROP_HASH_SLOT, userOpHash), 0);
        _tstore(_slot(USEROP_META_SLOT, userOpHash), 0);
        _tstore(_slot(USEROP_SIGNER_SLOT, userOpHash), 0);

        // meta: epoch (64) | delay (48) | path (8) | waits (1) | config (1) | 1
        if (uint64(meta >> 65) != s.epoch) revert Stale(hash);
        if (s.dead[hash]) revert Dead(hash);
        Call[] memory calls = abi.decode(op.callData[4:], (Call[]));
        uint8 path = uint8(meta >> 9);
        if (path == PATH_SINGLE) {
            // One self call, run for the signer the validation named; the callee is guarded.
            _tstore(CURRENT_SIGNER_SLOT, signer);
            _run(calls);
            _tstore(CURRENT_SIGNER_SLOT, 0);
            emit Executed(hash, op.nonce, path);
            return;
        }
        _enter();
        Shape memory shape = Shape(meta & 2 != 0, false, meta & 4 != 0 ? 1 : 0, signer);
        _touch(s);
        _land(s, hash, op.nonce, calls, path, uint48(meta >> 17), shape);
        _exit();
    }

    /// @notice Runs a scheduled change once its delay has passed, within the window.
    function executeScheduled(bytes32 hash, Call[] calldata calls) external guarded {
        Storage storage s = _s();
        ScheduleEntry memory sc = s.scheduled[hash];
        if (sc.readyAt == 0) revert NothingScheduled(hash);
        if (block.timestamp < sc.readyAt) revert NotReady(hash);
        if (block.timestamp > uint256(sc.readyAt) + SCHEDULE_WINDOW) revert WindowClosed(hash);
        if (sc.epoch != s.epoch) revert Stale(hash);
        Call[] memory list = calls;
        if (keccak256(abi.encode(list)) != sc.callsHash) revert CallsMismatch(hash);

        delete s.scheduled[hash];
        _run(list);
        _checkConfig(s);
        // The wait was the vetting: an address paid after it is one the account knows.
        if (sc.policy) _policy(abi.encodeCall(OlienPolicy.learn, (list)));
        _touch(s);
        emit ScheduledExecuted(hash);
    }

    // ------------------------------------------------- single-signer actions
    // The signer is whoever is calling: an ECDSA or CONTRACT signer from its own address,
    // or, inside a user operation the EntryPoint validated for one signer, the account itself.

    /// @notice Records a signer's approval of a hash on-chain, for signers that cannot hand a
    ///         signature to whoever executes. Counts as an entry of length zero.
    function approve(bytes32 hash) external {
        Storage storage s = _s();
        bytes32 signerId = _caller(s);
        s.approvals[hash][signerId] = true;
        _touch(s);
        emit Approved(hash, signerId);
    }

    /// @notice A signer with VETO objects to a scheduled change. At `effectiveVetoThreshold`
    ///         the hash is dead for good.
    function veto(bytes32 hash) external {
        Storage storage s = _s();
        bytes32 signerId = _caller(s);
        if (s.signers[signerId].permissions & PERM_VETO == 0) revert Unauthorized();
        ScheduleEntry storage sc = s.scheduled[hash];
        if (sc.readyAt == 0) revert NothingScheduled(hash);
        // The quorum removing a signer is not stopped by that signer; a guardian replacing one is.
        if (sc.path == PATH_THRESHOLD && sc.excluded == signerId) revert Unauthorized();
        if (s.vetoes[hash][signerId]) revert AlreadyVetoed(hash, signerId);
        s.vetoes[hash][signerId] = true;
        uint16 count = ++s.vetoCount[hash];
        _touch(s);
        emit Vetoed(hash, signerId, count);
        if (count >= _effectiveVetoThreshold(s)) {
            // A guardian whose recovery the members refused does not get to try again until
            // the members say so; otherwise a vetoed recovery is re-proposed at the next nonce.
            if (sc.path == PATH_RECOVERY && sc.excluded != 0) _suspend(s, sc.excluded);
            s.dead[hash] = true;
            delete s.scheduled[hash];
            emit Cancelled(hash);
        }
    }

    /// @notice One vetoer stops everything in flight. The epoch moves, so every open approval,
    ///         pending operation and scheduled change dies. No rule changes, no balance moves:
    ///         the team re-proposes what it still wants. Once a day, so a griefer can only
    ///         ever delay, and a second pull within the day would find nothing left to stop.
    function panic() external {
        Storage storage s = _s();
        bytes32 signerId = _caller(s);
        if (s.signers[signerId].permissions & PERM_VETO == 0) revert Unauthorized();
        uint48 until = s.lastPanic + PANIC_COOLDOWN;
        if (block.timestamp < until) revert Cooldown(until);
        s.lastPanic = uint48(block.timestamp);
        _touch(s);
        _advanceEpoch(s);
        emit Panicked(signerId, s.epoch);
    }

    /// @notice One named signer moves tokens under a limit, with no proposal. The budget, the
    ///         signer set and the destination set are `OlienPolicy`'s; the payment is made here.
    function spend(uint256 id, address to, uint256 amount) external guarded {
        Storage storage s = _s();
        bytes32 signerId = _caller(s);
        (address token, address from) =
            abi.decode(_policy(abi.encodeCall(OlienPolicy.debit, (id, signerId, s.signers[signerId].since, to, amount))), (address, address));
        if (from == address(0)) {
            (bool ok, bytes memory answer) = token.call(abi.encodeCall(IERC20.transfer, (to, amount)));
            if (!ok || (answer.length != 0 && !abi.decode(answer, (bool)))) revert TransferFailed();
        } else {
            SubAccount(payable(from)).transfer(token, to, amount);
        }
        _touch(s);
        emit Spent(id, signerId, to, amount);
    }

    // -------------------------------------------------------- configuration
    // Every function here is reached only through a threshold, scheduled or recovery
    // execution, because only the account itself can call them.

    function addSigner(SignerInput calldata input) external onlySelf {
        Storage storage s = _s();
        _addSigner(s, input);
        _advanceEpoch(s);
    }

    function removeSigner(bytes32 id) external onlySelf {
        Storage storage s = _s();
        _removeSigner(s, id);
        _advanceEpoch(s);
    }

    function replaceSigner(bytes32 oldId, SignerInput calldata input) external onlySelf {
        Storage storage s = _s();
        _removeSigner(s, oldId);
        _addSigner(s, input);
        _advanceEpoch(s);
    }

    function setThreshold(uint16 newThreshold) external onlySelf {
        Storage storage s = _s();
        s.threshold = newThreshold;
        emit ThresholdChanged(newThreshold);
        _advanceEpoch(s);
    }

    function setVetoThreshold(uint16 newVetoThreshold) external onlySelf {
        Storage storage s = _s();
        s.vetoThreshold = newVetoThreshold;
        emit VetoThresholdChanged(newVetoThreshold);
        _advanceEpoch(s);
    }

    /// @notice The delays, now with a fourth: after `inactivityDelay` without any signer acting,
    ///         one approver alone may replace a signer's key behind `recoveryDelay`, vetoable
    ///         like a guardian's recovery. Zero turns that off.
    function setDelays(uint48 configDelay, uint48 recoveryDelay, uint48 recoveryCoSignDelay, uint48 inactivityDelay)
        external
        onlySelf
    {
        Storage storage s = _s();
        s.configDelay = configDelay;
        s.recoveryDelay = recoveryDelay;
        s.recoveryCoSignDelay = recoveryCoSignDelay;
        s.inactivityDelay = inactivityDelay;
        emit DelaysChanged(configDelay, recoveryDelay, recoveryCoSignDelay, inactivityDelay);
        _advanceEpoch(s);
    }

    /// @notice Creates (`id == 0`) or replaces a spending limit. Replacing restarts the budget
    ///         and retires the previous signer and destination sets. Limits do not move the
    ///         epoch: they change what one key may do alone, not what the threshold agreed to.
    function setSpendingLimit(uint256 id, SpendingLimitInput calldata input) external onlySelf returns (uint256) {
        if (input.token.code.length == 0) revert BadConfig();
        address from = input.subAccount == 0 ? address(0) : createSubAccount(input.subAccount - 1);
        Storage storage s = _s();
        if (id == 0) id = ++s.nextLimitId;
        _policy(abi.encodeCall(OlienPolicy.set, (id, input, from, s.epoch)));
        return id;
    }

    function allowLimitSigner(uint256 id, bytes32 signerId) external onlySelf {
        if (_s().signers[signerId].kind == KIND_NONE) revert UnknownSigner(signerId);
        _policy(abi.encodeCall(OlienPolicy.allowSigner, (id, signerId)));
    }

    function allowLimitDestination(uint256 id, address to) external onlySelf {
        _policy(abi.encodeCall(OlienPolicy.allowDestination, (id, to)));
    }

    /// @notice Immediate under the threshold: taking a power away never waits.
    function removeSpendingLimit(uint256 id) external onlySelf {
        _policy(abi.encodeCall(OlienPolicy.remove, (id)));
    }

    /// @notice The transfer policy. Tightening it runs at once under the threshold; loosening
    ///         it waits `configDelay` and can be vetoed, and is refused while the policy is
    ///         locked. Which it is, `OlienPolicy.loosens` decides from the calls.
    function setTransferPolicy(Policy calldata p) external onlySelf {
        _s().policyOn = p.tier != 0 || p.requireKnown;
        _policy(abi.encodeCall(OlienPolicy.setPolicy, (p)));
    }

    /// @notice Addresses the account may pay without waiting. Adding them is a rule change;
    ///         forgetting them is immediate under the threshold, as taking a power away is.
    function setKnown(address[] calldata list, bool known) external onlySelf {
        _policy(abi.encodeCall(OlienPolicy.setKnown, (list, known)));
    }



    /// @notice Kills a hash, scheduled or not. Immediate under the threshold.
    function cancel(bytes32 hash) external onlySelf {
        Storage storage s = _s();
        s.dead[hash] = true;
        delete s.scheduled[hash];
        emit Cancelled(hash);
    }

    /// @notice Moves to new code, named by its hash as well as its address, so what the veto
    ///         window judged is what runs.
    function setImplementation(address newImplementation, bytes32 codeHash) external onlySelf {
        Storage storage s = _s();
        if (s.implementationFrozen) revert Frozen();
        if (newImplementation.codehash != codeHash) revert CodeMismatch(newImplementation);
        // The new code must keep this storage namespace, or the account would look uninitialized to it.
        (bool ok, bytes memory answer) =
            newImplementation.staticcall(abi.encodeWithSelector(this.STORAGE_LOCATION.selector));
        if (!ok || answer.length != 32 || abi.decode(answer, (bytes32)) != STORAGE_LOCATION) {
            revert NotAnImplementation(newImplementation);
        }
        ERC1967Utils.upgradeToAndCall(newImplementation, "");
        emit ImplementationChanged(newImplementation);
        _advanceEpoch(s);
    }

    function freezeImplementation() external onlySelf {
        Storage storage s = _s();
        s.implementationFrozen = true;
        emit ImplementationFrozen();
        _advanceEpoch(s);
    }

    // -------------------------------------------------------------- ERC-4337

    function validateUserOp(PackedUserOperation calldata op, bytes32 userOpHash, uint256 missingAccountFunds)
        external
        onlyEntryPoint
        returns (uint256 validationData)
    {
        Storage storage s = _s();
        if (op.signature.length < 12) revert MalformedSignatures();
        uint48 validAfter = uint48(bytes6(op.signature[0:6]));
        uint48 validUntil = uint48(bytes6(op.signature[6:12]));
        bytes32 hash = IOlienVerifierV2(VERIFIER).userOperationHash(_domain(), msg.data, validAfter, validUntil, s.epoch, ENTRY_POINT);

        bool ok = validUntil != 0 && !s.dead[hash] && _authorizeCallData(s, op.callData, hash, userOpHash, op.signature[12:]);

        // Paid whether or not the signatures were right, so estimation with a dummy
        // signature reports a signature failure rather than an unpaid prefund.
        if (missingAccountFunds != 0) {
            (bool paid,) = payable(msg.sender).call{value: missingAccountFunds}("");
            (paid);
        }
        return (ok ? 0 : SIG_VALIDATION_FAILED) | (uint256(validUntil) << 160) | (uint256(validAfter) << 208);
    }

    // -------------------------------------------------------------- ERC-1271

    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        return _isValidMessage(hash, signature) ? MAGIC_1271_HASH : NOT_VALID;
    }

    // ---------------------------------------------------------- sub-accounts

    function createSubAccount(uint256 index) public returns (address account) {
        account = subAccount(index);
        if (account.code.length != 0) return account;
        Clones.cloneDeterministic(SUB_ACCOUNT_IMPLEMENTATION, bytes32(index));
        SubAccount(payable(account)).initialize(address(this));
        emit SubAccountCreated(index, account);
    }

    function subAccount(uint256 index) public view returns (address) {
        return Clones.predictDeterministicAddress(SUB_ACCOUNT_IMPLEMENTATION, bytes32(index), address(this));
    }

    // ----------------------------------------------------------------- views

    function domainSeparator() external view returns (bytes32) {
        return _domain();
    }

    /// @notice The hash `execute` will verify for this transaction at the current nonce and epoch.
    function getTransactionHash(Transaction calldata txn) external view returns (bytes32) {
        Storage storage s = _s();
        uint256 nonce = (uint256(txn.nonceKey) << 64) | s.nonces[txn.nonceKey];
        return IOlienVerifierV2(VERIFIER).transactionHash(_domain(), nonce, s.epoch, txn.calls, txn.validAfter, txn.validUntil);
    }

    function getMessageHash(bytes32 hash) external view returns (bytes32) {
        return OlienHash.message(_domain(), hash);
    }

    function getSigner(bytes32 id) external view returns (SignerView memory) {
        Signer storage sg = _s().signers[id];
        return SignerView(sg.kind, sg.permissions, sg.flags, sg.since, sg.x, sg.y);
    }

    function getSigners() external view returns (bytes32[] memory) {
        return _s().signerList;
    }

    function getConfig() external view returns (ConfigView memory) {
        Storage storage s = _s();
        return ConfigView(
            s.threshold,
            s.vetoThreshold,
            _effectiveVetoThreshold(s),
            uint16(s.signerList.length),
            s.approverCount,
            s.vetoerCount,
            s.approverVetoerCount,
            s.recovererCount,
            s.configDelay,
            s.recoveryDelay,
            s.recoveryCoSignDelay,
            s.epoch,
            s.nextLimitId,
            s.implementationFrozen
        );
    }

    /// @notice What v2 added to the account's own state. The policy, the known addresses and
    ///         the limits are read from `POLICY`.
    function getState() external view returns (uint48 inactivityDelay, uint48 lastActivity, bool policyOn) {
        Storage storage s = _s();
        return (s.inactivityDelay, s.lastActivity, s.policyOn);
    }

    /// @notice Every hash ever scheduled, in order, from `from`, at most `limit` of them: so a
    ///         reader needs no event log to find what is waiting, and keeps a cursor. Which are
    ///         still waiting, `getScheduled` tells.
    function getScheduledLog(uint256 from, uint256 limit) external view returns (bytes32[] memory out) {
        bytes32[] storage log = _s().scheduledLog;
        uint256 end = log.length;
        if (from >= end) return out;
        if (end - from > limit) end = from + limit;
        out = new bytes32[](end - from);
        for (uint256 i = from; i < end; i++) {
            out[i - from] = log[i];
        }
    }

    function getNonce(uint192 key) external view returns (uint256) {
        return (uint256(key) << 64) | _s().nonces[key];
    }

    function getScheduled(bytes32 hash) external view returns (ScheduledView memory) {
        ScheduleEntry storage sc = _s().scheduled[hash];
        return ScheduledView(sc.readyAt, sc.epoch, sc.path, sc.excluded, sc.callsHash);
    }


    function isDead(bytes32 hash) external view returns (bool) {
        return _s().dead[hash];
    }

    function isApproved(bytes32 hash, bytes32 signerId) external view returns (bool) {
        return _s().approvals[hash][signerId];
    }

    function getVeto(bytes32 hash, bytes32 signerId) external view returns (bool vetoed, uint16 count) {
        Storage storage s = _s();
        return (s.vetoes[hash][signerId], s.vetoCount[hash]);
    }


    function implementation() external view returns (address) {
        return ERC1967Utils.getImplementation();
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }

    // ------------------------------------------------------------- internals

    function _s() private pure returns (Storage storage s) {
        assembly {
            s.slot := STORAGE_LOCATION
        }
    }

    function _domain() private view returns (bytes32) {
        return OlienHash.domain(address(this));
    }

    function _checkValidity(uint48 validAfter, uint48 validUntil) private view {
        if (block.timestamp < validAfter) revert NotYetValid();
        if (validUntil == 0 || block.timestamp > validUntil) revert Expired();
        if (validUntil > block.timestamp + MAX_VALIDITY) revert Expired();
    }

    /// @dev Runs now or schedules for later, whichever the path decided.
    function _land(
        Storage storage s,
        bytes32 hash,
        uint256 nonce,
        Call[] memory calls,
        uint8 path,
        uint48 delay,
        Shape memory shape
    ) private {
        if (delay == 0) {
            _run(calls);
            if (shape.config) _checkConfig(s);
            emit Executed(hash, nonce, path);
        } else {
            if (s.scheduled[hash].readyAt != 0) revert AlreadyScheduled(hash);
            uint48 readyAt = uint48(block.timestamp) + delay;
            s.scheduled[hash] =
                ScheduleEntry(readyAt, s.epoch, path, shape.wait != 0, shape.target, keccak256(abi.encode(calls)));
            s.scheduledLog.push(hash);
            emit Scheduled(hash, readyAt, path, shape.target);
        }
    }

    /// @dev Which path a signature set opens for these calls, and how long it waits.
    function _resolve(Storage storage s, Call[] memory calls, Tally memory t)
        private
        view
        returns (uint8 path, uint48 delay, Shape memory shape)
    {
        shape = _classify(s, calls);
        if (t.approvers >= s.threshold) {
            return (PATH_THRESHOLD, _delayFor(s, shape), shape);
        }
        if (shape.recoveryOnly) {
            if (t.recoverers >= 1) {
                shape.target = t.recoverer;
                return (PATH_RECOVERY, t.plainApprovers >= 1 ? s.recoveryCoSignDelay : s.recoveryDelay, shape);
            }
            // After a long enough silence one member may replace a colleague's key, slowly, and
            // the colleague can veto it as they could a guardian's recovery.
            if (t.approvers >= 1 && _inactive(s)) {
                shape.target = 0;
                return (PATH_RECOVERY, s.recoveryDelay, shape);
            }
        }
        revert Unauthorized();
    }

    /// @dev The longer of the config delay a rule change owes and the wait the policy imposes.
    function _delayFor(Storage storage s, Shape memory shape) private view returns (uint48 delay) {
        delay = shape.config ? s.configDelay : 0;
        if (shape.wait > delay) delay = shape.wait;
    }

    function _inactive(Storage storage s) private view returns (bool) {
        return s.inactivityDelay != 0 && block.timestamp > uint256(s.lastActivity) + s.inactivityDelay;
    }

    /// @dev Calls to the account itself are either configuration (delayed), or the few self
    ///      calls the threshold may make at once. Anything else is refused, so a batch can
    ///      never make the account call its own entry points.
    function _classify(Storage storage s, Call[] memory calls) private view returns (Shape memory shape) {
        bytes4 selector;
        uint256 removals;
        for (uint256 i = 0; i < calls.length; i++) {
            if (calls[i].to != address(this)) continue;
            bytes memory data = calls[i].data;
            if (data.length < 4) revert SelfCallRefused(bytes4(0));
            assembly {
                selector := mload(add(data, 32))
            }
            if (selector == this.setTransferPolicy.selector) {
                // Tightening runs at once; loosening is a rule change like any other.
                if (abi.decode(_ask(abi.encodeCall(OlienPolicy.loosens, (data))), (bool))) shape.config = true;
            } else if (selector == this.setKnown.selector) {
                if (_word(data, 1) != 0) shape.config = true;
            } else if (_isConfig(selector)) {
                shape.config = true;
                if (selector == this.removeSigner.selector || selector == this.replaceSigner.selector) {
                    removals += 1;
                    shape.target = _word(data, 0);
                }
            } else if (!_isImmediateSelf(selector)) {
                revert SelfCallRefused(selector);
            }
        }
        if (removals != 1) shape.target = 0;
        if (calls.length == 1 && calls[0].to == address(this) && selector == this.replaceSigner.selector) {
            shape.recoveryOnly = _keepsRole(s, calls[0].data);
        }
        if (s.policyOn) {
            (, shape.wait) = abi.decode(_ask(abi.encodeCall(OlienPolicy.evaluate, (calls))), (bool, uint48));
        }
    }

    /// @dev A call to OlienPolicy, its revert passed through as the account's own.
    function _policy(bytes memory data) private returns (bytes memory answer) {
        bool ok;
        (ok, answer) = POLICY.call(data);
        if (!ok) {
            assembly {
                revert(add(answer, 32), mload(answer))
            }
        }
    }

    function _ask(bytes memory data) private view returns (bytes memory answer) {
        bool ok;
        (ok, answer) = POLICY.staticcall(data);
        if (!ok) {
            assembly {
                revert(add(answer, 32), mload(answer))
            }
        }
    }

    /// @dev A recovery may only swap a key for another with the same permissions. Read at the
    ///      positions standard ABI encoding puts them; any other encoding is not a recovery.
    function _keepsRole(Storage storage s, bytes memory data) private view returns (bool) {
        if (data.length < 4 + 32 * 6 || _word(data, 1) != bytes32(uint256(0x40))) return false;
        Signer storage old = s.signers[_word(data, 0)];
        return old.kind != KIND_NONE && uint256(old.permissions) == uint256(_word(data, 3));
    }

    /// @dev The `index`-th 32-byte word after the selector.
    function _word(bytes memory data, uint256 index) private pure returns (bytes32 word) {
        assembly {
            word := mload(add(add(data, 36), mul(index, 32)))
        }
    }

    function _isConfig(bytes4 selector) private pure returns (bool) {
        return selector == this.addSigner.selector || selector == this.removeSigner.selector
            || selector == this.replaceSigner.selector || selector == this.setThreshold.selector
            || selector == this.setVetoThreshold.selector || selector == this.setDelays.selector
            || selector == this.setSpendingLimit.selector || selector == this.allowLimitSigner.selector
            || selector == this.allowLimitDestination.selector || selector == this.setImplementation.selector
            || selector == this.freezeImplementation.selector;
    }

    function _isImmediateSelf(bytes4 selector) private pure returns (bool) {
        return selector == this.cancel.selector || selector == this.removeSpendingLimit.selector;
    }

    /// @dev What a user operation asks for, and whether the signatures allow it. The calldata
    ///      is always `executeUserOp(Call[])`. One self call to a single-signer function is the
    ///      single-signer path; anything else is resolved like a transaction. What was decided
    ///      is stored under the operation's hash for the execution phase, which cannot see the
    ///      signatures. The record is written even when the signatures fail, naming the path
    ///      the calls imply, so that gas estimation with a placeholder signature simulates the
    ///      real execution; the EntryPoint never executes an operation whose validation
    ///      returned a signature failure. Reverts for calldata the account does not serve.
    function _authorizeCallData(
        Storage storage s,
        bytes calldata callData,
        bytes32 hash,
        bytes32 userOpHash,
        bytes calldata signatures
    ) private returns (bool ok) {
        if (callData.length < 4 || bytes4(callData[:4]) != IAccountExecute.executeUserOp.selector) revert BadCallData();
        Call[] memory calls = abi.decode(callData[4:], (Call[]));

        Tally memory t;
        (ok, t) = _tryVerify(s, hash, signatures);
        ok = ok && t.count != 0;

        uint8 path;
        uint48 delay;
        uint256 bits = 1;
        bytes32 signer;
        bytes4 selector = _singleSelector(calls);
        if (selector != 0) {
            path = PATH_SINGLE;
            signer = signatures.length >= 32 ? bytes32(signatures[0:32]) : bytes32(0);
            if (
                selector == this.veto.selector || selector == this.approve.selector || selector == this.spend.selector
                    || selector == this.panic.selector
            ) {
                ok = ok && t.count == 1;
                if (selector == this.veto.selector || selector == this.panic.selector) {
                    ok = ok && s.signers[signer].permissions & PERM_VETO != 0;
                }
            }
        } else {
            Shape memory shape = _classify(s, calls);
            if (shape.config) bits |= 2;
            if (shape.wait != 0) bits |= 4;
            if (
                ok && shape.recoveryOnly && t.approvers < s.threshold
                    && (t.recoverers >= 1 || (t.approvers >= 1 && _inactive(s)))
            ) {
                bool coSigned = t.recoverers >= 1 && t.plainApprovers >= 1;
                (path, delay) = (PATH_RECOVERY, coSigned ? s.recoveryCoSignDelay : s.recoveryDelay);
                signer = t.recoverer;
            } else {
                ok = ok && t.approvers >= s.threshold;
                (path, delay) = (PATH_THRESHOLD, _delayFor(s, shape));
                signer = shape.target;
            }
        }
        uint256 meta = (uint256(s.epoch) << 65) | (uint256(delay) << 17) | (uint256(path) << 9) | bits;
        _tstore(_slot(USEROP_HASH_SLOT, userOpHash), hash);
        _tstore(_slot(USEROP_META_SLOT, userOpHash), bytes32(meta));
        _tstore(_slot(USEROP_SIGNER_SLOT, userOpHash), signer);
    }

    /// @dev The selector when the calls are exactly one call to the account's own single-signer
    ///      or submit-for-anyone functions; zero otherwise.
    function _singleSelector(Call[] memory calls) private view returns (bytes4 selector) {
        if (calls.length != 1 || calls[0].to != address(this) || calls[0].data.length < 4) return 0;
        bytes memory data = calls[0].data;
        assembly {
            selector := mload(add(data, 32))
        }
        if (
            selector == this.spend.selector || selector == this.veto.selector || selector == this.approve.selector
                || selector == this.panic.selector || selector == this.execute.selector
                || selector == this.executeScheduled.selector || selector == this.createSubAccount.selector
        ) return selector;
        return 0;
    }

    function _run(Call[] memory calls) private {
        for (uint256 i = 0; i < calls.length; i++) {
            (bool ok, bytes memory answer) = calls[i].to.call{value: calls[i].value}(calls[i].data);
            if (!ok) {
                assembly {
                    revert(add(answer, 32), mload(answer))
                }
            }
        }
    }

    /// @dev Who a single-signer function is running for: the EOA or contract calling, or the
    ///      signer a validated user operation named when the account calls itself.
    function _caller(Storage storage s) private view returns (bytes32 id) {
        if (msg.sender == address(this)) {
            id = _tload(CURRENT_SIGNER_SLOT);
            if (id == 0) revert Unauthorized();
            return id;
        }
        id = bytes32(uint256(uint160(msg.sender)));
        uint8 kind = s.signers[id].kind;
        if (kind != KIND_ECDSA && kind != KIND_CONTRACT) revert Unauthorized();
    }

    function _isValidMessage(bytes32 hash, bytes calldata signature) private view returns (bool) {
        Storage storage s = _s();
        bytes32 wrapped = OlienHash.message(_domain(), hash);
        if (s.dead[wrapped]) return false;
        (bool ok, Tally memory t) = _tryVerify(s, wrapped, signature);
        return ok && t.approvers >= s.threshold;
    }

    /// @dev Walks a packed signature set. Encoding errors revert; a signature that does not
    ///      verify, an unknown signer, or an entry out of order makes the whole set false.
    function _tryVerify(Storage storage s, bytes32 hash, bytes calldata signatures)
        private
        view
        returns (bool, Tally memory t)
    {
        uint256 offset;
        bytes32 last;
        while (offset < signatures.length) {
            if (signatures.length - offset < 34) revert MalformedSignatures();
            bytes32 id = bytes32(signatures[offset:offset + 32]);
            uint256 length = uint16(bytes2(signatures[offset + 32:offset + 34]));
            offset += 34;
            if (signatures.length - offset < length) revert MalformedSignatures();
            bytes calldata signature = signatures[offset:offset + length];
            offset += length;

            if (t.count != 0 && id <= last) return (false, t);
            last = id;

            Signer storage sg = s.signers[id];
            if (sg.kind == KIND_NONE) return (false, t);
            if (length == 0) {
                if (!s.approvals[hash][id]) return (false, t);
            } else if (!_check(hash, id, sg, signature)) {
                return (false, t);
            }

            t.count += 1;
            uint8 permissions = sg.permissions;
            if (permissions & PERM_APPROVE != 0) {
                t.approvers += 1;
                if (permissions & PERM_RECOVER == 0) t.plainApprovers += 1;
            }
            // A suspended guardian still approves whatever it may approve; it cannot recover.
            if (permissions & PERM_RECOVER != 0 && sg.flags & FLAG_SUSPENDED == 0) {
                if (t.recoverers == 0) t.recoverer = id;
                t.recoverers += 1;
            }
        }
        return (true, t);
    }

    function _check(bytes32 hash, bytes32 id, Signer storage sg, bytes calldata signature)
        private
        view
        returns (bool)
    {
        return IOlienVerifierV2(VERIFIER).verify(sg.kind, hash, id, sg.flags, sg.x, sg.y, signature);
    }

    function _addSigner(Storage storage s, SignerInput calldata input) private returns (bytes32 id) {
        if (input.permissions > (PERM_APPROVE | PERM_VETO | PERM_RECOVER)) revert BadPermissions();
        if (input.flags & ~(FLAG_UV_REQUIRED | FLAG_SYNCED) != 0) revert BadPermissions();
        uint256 x;
        uint256 y;
        if (input.kind == KIND_ECDSA || input.kind == KIND_CONTRACT) {
            address a = _addressKey(input.key);
            if (a == address(0) || a == address(this) || a == ENTRY_POINT) revert BadKey();
            if (input.kind == KIND_CONTRACT && a.code.length == 0) revert BadKey();
            id = bytes32(uint256(uint160(a)));
        } else if (input.kind == KIND_P256 || input.kind == KIND_WEBAUTHN) {
            if (input.key.length != 64) revert BadKey();
            (x, y) = abi.decode(input.key, (uint256, uint256));
            if (!P256.isValidPublicKey(bytes32(x), bytes32(y))) revert BadKey();
            id = keccak256(abi.encode(x, y));
        } else {
            revert BadKey();
        }
        if (s.signers[id].kind != KIND_NONE) revert SignerExists(id);

        s.signerList.push(id);
        s.signers[id] = Signer(input.kind, input.permissions, input.flags, s.epoch, uint32(s.signerList.length), x, y);
        _count(s, input.permissions, true);
        emit SignerAdded(id, input.kind, input.permissions, input.flags, x, y);
    }

    function _removeSigner(Storage storage s, bytes32 id) private {
        Signer storage sg = s.signers[id];
        if (sg.kind == KIND_NONE) revert UnknownSigner(id);
        _count(s, sg.permissions, false);

        uint256 index = sg.index;
        uint256 lastIndex = s.signerList.length;
        if (index != lastIndex) {
            bytes32 moved = s.signerList[lastIndex - 1];
            s.signerList[index - 1] = moved;
            s.signers[moved].index = uint32(index);
        }
        s.signerList.pop();
        delete s.signers[id];
        emit SignerRemoved(id);
    }

    function _count(Storage storage s, uint8 permissions, bool add) private {
        bool approves = permissions & PERM_APPROVE != 0;
        bool vetoes = permissions & PERM_VETO != 0;
        uint16 delta = add ? 1 : type(uint16).max; // adding one, or wrapping back by one
        unchecked {
            if (approves) s.approverCount += delta;
            if (vetoes) s.vetoerCount += delta;
            if (approves && vetoes) s.approverVetoerCount += delta;
            if (permissions & PERM_RECOVER != 0) s.recovererCount += delta;
        }
    }

    function _suspend(Storage storage s, bytes32 id) private {
        Signer storage sg = s.signers[id];
        if (sg.kind == KIND_NONE || sg.flags & FLAG_SUSPENDED != 0) return;
        sg.flags |= FLAG_SUSPENDED;
        emit SignerSuspended(id);
    }

    function _touch(Storage storage s) private {
        s.lastActivity = uint48(block.timestamp);
    }


    function _addressKey(bytes calldata key) private pure returns (address) {
        if (key.length != 20) revert BadKey();
        return address(bytes20(key));
    }

    /// @dev Explicit, or the smallest number of signers holding both APPROVE and VETO whose
    ///      refusal makes the threshold unreachable; never less than one.
    function _effectiveVetoThreshold(Storage storage s) private view returns (uint16) {
        if (s.vetoThreshold != 0) return s.vetoThreshold;
        if (s.approverVetoerCount < s.threshold) return 1;
        return s.approverVetoerCount - s.threshold + 1;
    }

    /// @dev After any config execution: the account can always act, and the numbers agree.
    function _checkConfig(Storage storage s) private view {
        if (s.signerList.length == 0 || s.approverCount == 0) revert BadConfig();
        if (s.threshold == 0 || s.threshold > s.approverCount) revert BadConfig();
        if (s.vetoThreshold != 0 && s.vetoThreshold > s.vetoerCount) revert BadConfig();
        if (s.configDelay > MAX_DELAY || s.recoveryDelay > MAX_DELAY || s.recoveryCoSignDelay > MAX_DELAY) {
            revert BadConfig();
        }
        if ((s.recovererCount != 0 || s.inactivityDelay != 0) && s.recoveryDelay < MIN_RECOVERY_DELAY) {
            revert BadConfig();
        }
        if (s.inactivityDelay != 0 && (s.inactivityDelay < MIN_INACTIVITY || s.inactivityDelay > MAX_INACTIVITY)) {
            revert BadConfig();
        }
    }

    function _advanceEpoch(Storage storage s) private {
        s.epoch += 1;
        emit EpochAdvanced(s.epoch);
    }

    function _slot(bytes32 base, bytes32 key) private pure returns (bytes32) {
        return keccak256(abi.encode(base, key));
    }

    function _tstore(bytes32 slot, bytes32 value) private {
        assembly {
            tstore(slot, value)
        }
    }

    function _tload(bytes32 slot) private view returns (bytes32 value) {
        assembly {
            value := tload(slot)
        }
    }

    function _enter() private {
        if (_tload(GUARD_SLOT) != 0) revert Reentered();
        _tstore(GUARD_SLOT, bytes32(uint256(1)));
    }

    function _exit() private {
        _tstore(GUARD_SLOT, 0);
    }
}
