// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IOlien} from "../IOlien.sol";

/// @dev The transfer policy: what makes money wait. `tier` is in `token`'s units, and a batch
///      sending more than it in one go waits `delay`. With `requireKnown`, so does a batch that
///      touches any address the account does not know. With `learn`, a batch that waited and
///      then ran makes its addresses known. Loosening any of it is refused before `lockedUntil`.
struct Policy {
    address token;
    uint128 tier;
    uint48 delay;
    bool requireKnown;
    bool learn;
    uint48 lockedUntil;
}

/// @dev The key lives in a cloud account rather than one device. Set when the signer is added.
uint8 constant FLAG_SYNCED = 2;
/// @dev A guardian whose recovery the members vetoed. Only the account sets and clears it.
uint8 constant FLAG_SUSPENDED = 4;

interface IOlienV2 is IOlien {
    event Panicked(bytes32 indexed signerId, uint64 epoch);
    event DelaysChanged(uint48 configDelay, uint48 recoveryDelay, uint48 recoveryCoSignDelay, uint48 inactivityDelay);
    event SignerSuspended(bytes32 indexed id);

    error Cooldown(uint48 until);
    error CodeMismatch(address implementation);
}
