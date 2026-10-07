// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IOlien, Call, SpendingLimitInput} from "../IOlien.sol";
import {Policy} from "./IOlienV2.sol";

/// @title OlienPolicy
/// @notice Every account's spending limits, transfer policy and known addresses, in one
///         contract, so the account itself fits the code size limit with room for its rules.
///         An account is the only writer of its own rows: each is keyed by `msg.sender`, and
///         the account reaches here only from functions that only it can call. Nothing here
///         moves money or decides who may. A debit answers which token and which sub-account
///         to pay from, and the account pays; an evaluation answers whether a batch waits,
///         and the account schedules it. The account holds this address as an immutable.
///
/// A spending budget refills continuously, at `amount` per `period`, up to `amount`. Over
/// any span of one period a signer can move at most `amount` plus what was already there,
/// which is the bound a treasurer means by "so much per day". A fixed window would allow
/// twice that across its reset.
contract OlienPolicy {
    uint48 private constant MAX_DELAY = 30 days;

    struct Limit {
        address token;
        address from;
        uint128 amount;
        uint128 remaining;
        uint48 period;
        uint48 refilledAt;
        bool anyDestination;
        bool exists;
        uint32 generation; // bumps on every change, so old signer and destination sets stop applying
        uint64 epoch; // the account's epoch when set; a signer added later is not this limit's signer
    }

    event SpendingLimitSet(
        address indexed account,
        uint256 indexed id,
        uint32 generation,
        address token,
        address from,
        uint128 amount,
        uint48 period,
        bool anyDestination
    );
    event LimitSignerAllowed(address indexed account, uint256 indexed id, uint32 generation, bytes32 signerId);
    event LimitDestinationAllowed(address indexed account, uint256 indexed id, uint32 generation, address to);
    event SpendingLimitRemoved(address indexed account, uint256 indexed id);
    event TransferPolicySet(
        address indexed account,
        address token,
        uint128 tier,
        uint48 delay,
        bool requireKnown,
        bool learn,
        uint48 lockedUntil
    );
    event DestinationKnown(address indexed account, address indexed to, uint48 since);
    event DestinationForgotten(address indexed account, address indexed to);

    error PolicyLocked(uint48 until);

    mapping(address => mapping(uint256 => Limit)) private _limits;
    mapping(address => mapping(uint256 => mapping(uint32 => mapping(bytes32 => bool)))) private _signers;
    mapping(address => mapping(uint256 => mapping(uint32 => mapping(address => bool)))) private _destinations;
    mapping(address => Policy) private _policy;
    mapping(address => mapping(address => uint48)) private _known;

    // ---------------------------------------------------------------- limits

    /// @notice Creates or replaces a limit of the calling account, which numbers them. Replacing
    ///         restarts the budget and retires the previous signer and destination sets.
    function set(uint256 id, SpendingLimitInput calldata input, address from, uint64 epoch) external {
        Limit storage l = _limits[msg.sender][id];
        l.token = input.token;
        l.from = from;
        l.amount = input.amount;
        l.remaining = input.amount;
        l.period = input.period;
        l.refilledAt = uint48(block.timestamp);
        l.anyDestination = input.anyDestination;
        l.exists = true;
        l.generation += 1;
        l.epoch = epoch;
        emit SpendingLimitSet(msg.sender, id, l.generation, input.token, from, input.amount, input.period, input.anyDestination);
    }

    function allowSigner(uint256 id, bytes32 signerId) external {
        Limit storage l = _limits[msg.sender][id];
        if (!l.exists) revert IOlien.LimitMissing(id);
        _signers[msg.sender][id][l.generation][signerId] = true;
        emit LimitSignerAllowed(msg.sender, id, l.generation, signerId);
    }

    function allowDestination(uint256 id, address to) external {
        Limit storage l = _limits[msg.sender][id];
        if (!l.exists) revert IOlien.LimitMissing(id);
        _destinations[msg.sender][id][l.generation][to] = true;
        emit LimitDestinationAllowed(msg.sender, id, l.generation, to);
    }

    function remove(uint256 id) external {
        if (!_limits[msg.sender][id].exists) revert IOlien.LimitMissing(id);
        delete _limits[msg.sender][id];
        emit SpendingLimitRemoved(msg.sender, id);
    }

    /// @notice Takes `amount` out of the calling account's budget for `signerId`, or reverts
    ///         with the reason the account would have given. Returns what to pay with.
    function debit(uint256 id, bytes32 signerId, uint64 signerSince, address to, uint256 amount)
        external
        returns (address token, address from)
    {
        Limit storage l = _limits[msg.sender][id];
        if (!l.exists) revert IOlien.LimitMissing(id);
        if (signerSince > l.epoch || !_signers[msg.sender][id][l.generation][signerId]) revert IOlien.Unauthorized();
        if (!l.anyDestination && !_destinations[msg.sender][id][l.generation][to]) revert IOlien.LimitDestination(to);

        uint128 available = _available(l);
        if (amount > available) revert IOlien.LimitExceeded(id, amount, available);
        l.remaining = available - uint128(amount);
        l.refilledAt = uint48(block.timestamp);
        return (l.token, l.from);
    }

    /// @notice The live part of a limit. `remaining` is what a spend right now could take, and
    ///         `refilledAt` when the budget was last brought up to date.
    function budget(address account, uint256 id)
        external
        view
        returns (uint128 remaining, uint48 refilledAt, uint32 generation, uint64 epoch)
    {
        Limit storage l = _limits[account][id];
        if (!l.exists) revert IOlien.LimitMissing(id);
        return (_available(l), l.refilledAt, l.generation, l.epoch);
    }

    function isSigner(address account, uint256 id, bytes32 signerId) external view returns (bool) {
        return _signers[account][id][_limits[account][id].generation][signerId];
    }

    function isDestination(address account, uint256 id, address to) external view returns (bool) {
        return _destinations[account][id][_limits[account][id].generation][to];
    }

    /// @notice Whether a signer may spend under a limit at all, which is what an account checks
    ///         before it lets a user operation through to `spend`.
    function canSpend(address account, uint256 id, bytes32 signerId, uint64 signerSince) external view returns (bool) {
        Limit storage l = _limits[account][id];
        return l.exists && signerSince <= l.epoch && _signers[account][id][l.generation][signerId];
    }

    /// @dev The budget as of now: what was left, plus what has refilled since, capped at the amount.
    function _available(Limit storage l) private view returns (uint128) {
        if (l.period == 0 || block.timestamp <= l.refilledAt) return l.remaining;
        uint256 refilled = uint256(l.remaining) + (uint256(l.amount) * (block.timestamp - l.refilledAt)) / l.period;
        return refilled > l.amount ? l.amount : uint128(refilled);
    }

    // ------------------------------------------------------- transfer policy

    /// @notice The calling account's transfer policy. A policy that holds anything needs a
    ///         wait, bounded as every delay is; a tier needs the token it is counted in.
    function setPolicy(Policy calldata p) external {
        if ((p.tier != 0 || p.requireKnown) && (p.delay == 0 || p.delay > MAX_DELAY)) revert IOlien.BadConfig();
        if (p.tier != 0 && p.token == address(0)) revert IOlien.BadConfig();
        _policy[msg.sender] = p;
        emit TransferPolicySet(msg.sender, p.token, p.tier, p.delay, p.requireKnown, p.learn, p.lockedUntil);
    }

    /// @notice Addresses the calling account knows, or no longer does.
    function setKnown(address[] calldata list, bool known) external {
        for (uint256 i = 0; i < list.length; i++) {
            if (known) {
                _know(msg.sender, list[i]);
            } else {
                delete _known[msg.sender][list[i]];
                emit DestinationForgotten(msg.sender, list[i]);
            }
        }
    }

    function policyOf(address account) external view returns (Policy memory) {
        return _policy[account];
    }

    /// @notice When an account came to know an address; zero if it never did.
    function knownSince(address account, address to) external view returns (uint48) {
        return _known[account][to];
    }

    /// @notice Whether a `setTransferPolicy` call, given as the account's own calldata, weakens
    ///         the calling account's policy in force. Refused outright while that policy is
    ///         locked, so a locked rule cannot even be scheduled away. A policy that holds
    ///         nothing and is not locked has nothing to loosen: the first one always runs at once.
    function loosens(bytes calldata data) external view returns (bool loosening) {
        if (data.length < 4 + 32 * 6) revert IOlien.BadConfig();
        Policy memory next = abi.decode(data[4:], (Policy));
        Policy storage p = _policy[msg.sender];
        if (p.tier == 0 && !p.requireKnown && p.lockedUntil <= block.timestamp) return false;
        loosening = (p.tier != 0 && (next.tier == 0 || next.tier > p.tier || next.token != p.token))
            || next.delay < p.delay || (p.requireKnown && !next.requireKnown) || (!p.learn && next.learn)
            || next.lockedUntil < p.lockedUntil;
        if (loosening && block.timestamp < p.lockedUntil) revert PolicyLocked(p.lockedUntil);
    }

    /// @notice Whether a batch of the calling account's waits under its policy, and how long.
    ///         Calls to the account itself are rules, not payments, and are not counted.
    function evaluate(Call[] calldata calls) external view returns (bool waits, uint48 delay) {
        Policy storage p = _policy[msg.sender];
        uint256 outgoing;
        bool unknown;
        for (uint256 i = 0; i < calls.length; i++) {
            if (calls[i].to == msg.sender) continue;
            (address to, uint256 amount) = _destination(p.token, calls[i]);
            outgoing += amount;
            if (_known[msg.sender][to] == 0) unknown = true;
        }
        waits = (p.requireKnown && unknown) || (p.tier != 0 && outgoing > p.tier);
        delay = waits ? p.delay : 0;
    }

    /// @notice A batch that waited and ran: its destinations are ones the calling account knows,
    ///         if its policy learns. The wait was the vetting.
    function learn(Call[] calldata calls) external {
        Policy storage p = _policy[msg.sender];
        if (!p.learn) return;
        for (uint256 i = 0; i < calls.length; i++) {
            if (calls[i].to == msg.sender) continue;
            (address to,) = _destination(p.token, calls[i]);
            if (_known[msg.sender][to] == 0) _know(msg.sender, to);
        }
    }

    function _know(address account, address to) private {
        _known[account][to] = uint48(block.timestamp);
        emit DestinationKnown(account, to, uint48(block.timestamp));
    }

    /// @dev Where a call sends value, and how much of the policy's token: the recipient of a
    ///      transfer, the spender of an approval, the recipient of a transferFrom, else the
    ///      callee itself. Native value is not tiered; the callee still has to be known.
    function _destination(address token, Call calldata c) private pure returns (address to, uint256 amount) {
        bytes calldata data = c.data;
        if (data.length >= 68) {
            bytes4 selector = bytes4(data[:4]);
            if (selector == IERC20.transfer.selector || selector == IERC20.approve.selector) {
                to = address(uint160(uint256(bytes32(data[4:36]))));
                if (c.to == token) amount = uint256(bytes32(data[36:68]));
                return (to, amount);
            }
            if (selector == IERC20.transferFrom.selector && data.length >= 100) {
                to = address(uint160(uint256(bytes32(data[36:68]))));
                if (c.to == token) amount = uint256(bytes32(data[68:100]));
                return (to, amount);
            }
        }
        return (c.to, 0);
    }
}
