// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {OlienTestBase} from "../OlienTestBase.sol";
import {Olien} from "../../src/Olien.sol";
import {OlienFactory} from "../../src/OlienFactory.sol";
import {OlienHash} from "../../src/OlienHash.sol";
import {
    IOlien,
    Call,
    Transaction,
    Init,
    SpendingLimitInput,
    PERM_APPROVE,
    PERM_VETO,
    PERM_RECOVER,
    PATH_THRESHOLD,
    PATH_RECOVERY
} from "../../src/IOlien.sol";
import {PackedUserOperation} from "../../src/IEntryPoint.sol";
import {OlienV2} from "../../src/v2/OlienV2.sol";
import {IOlienV2, Policy, FLAG_SYNCED, FLAG_SUSPENDED} from "../../src/v2/IOlienV2.sol";
import {OlienPolicy} from "../../src/v2/OlienPolicy.sol";
import {OlienVerifierV2} from "../../src/v2/OlienVerifierV2.sol";

/// What v2 adds. The v1 suites run against v2 in OlienV2Regression.t.sol.
contract OlienV2Test is OlienTestBase {
    Olien implV1;
    OlienFactory factoryV1;
    OlienVerifierV2 verifier2;
    OlienPolicy policy;
    OlienV2 implV2;

    function setUp() public override {
        super.setUp();
        implV1 = impl;
        factoryV1 = factory;
        verifier2 = new OlienVerifierV2();
        policy = new OlienPolicy();
        implV2 = new OlienV2(ENTRY_POINT, address(verifier2), address(subImpl), address(policy));
        impl = Olien(payable(address(implV2)));
        factory = new OlienFactory(address(impl));
    }

    function v2(Olien account) internal pure returns (OlienV2) {
        return OlienV2(payable(address(account)));
    }

    function policyOf(address token, uint128 tier, uint48 delay, bool requireKnown, bool learn, uint48 lockedUntil)
        internal
        pure
        returns (Policy memory)
    {
        return Policy(token, tier, delay, requireKnown, learn, lockedUntil);
    }

    function setPolicyCall(Olien account, Policy memory p) internal pure returns (Call memory) {
        return selfCall(account, abi.encodeCall(OlienV2.setTransferPolicy, (p)));
    }

    function knownCall(Olien account, address who, bool known) internal pure returns (Call memory) {
        address[] memory list = new address[](1);
        list[0] = who;
        return selfCall(account, abi.encodeCall(OlienV2.setKnown, (list, known)));
    }

    /// @dev Alice and Bob, 2-of-2, a day's config delay: the shape most v2 rules are shown on.
    function delayedAccount() internal returns (Olien) {
        return deploy(
            initOf(two(ecdsa(alice, PERM_APPROVE | PERM_VETO), ecdsa(bob, PERM_APPROVE | PERM_VETO)), 2, 1 days), "delayed"
        );
    }

    // ------------------------------------------------------------- the move

    function test_v2FitsTheLimitAndIsWired() public view {
        assertEq(implV2.OLIEN_VERSION(), "2.0.0");
        assertLe(address(implV2).code.length, 24_576);
        assertEq(implV2.POLICY(), address(policy));
        assertEq(implV2.VERIFIER(), address(verifier2));
        assertEq(implV2.STORAGE_LOCATION(), implV1.STORAGE_LOCATION());
    }

    function test_aV1AccountMovesToV2AndKeepsItself() public {
        Init memory init =
            initOf(two(ecdsa(alice, PERM_APPROVE | PERM_VETO), ecdsa(bob, PERM_APPROVE | PERM_VETO)), 2, 1 days);
        Olien account = Olien(payable(factoryV1.createAccount(init, "v1")));
        usdc.mint(address(account), 1_000e6);
        vm.deal(address(account), 1 ether);
        assertEq(account.implementation(), address(implV1));

        // A limit under v1, used once.
        Call[] memory limit = new Call[](2);
        limit[0] = selfCall(
            account,
            abi.encodeCall(Olien.setSpendingLimit, (0, SpendingLimitInput(address(usdc), 0, 100e6, 1 days, true)))
        );
        limit[1] = selfCall(account, abi.encodeCall(Olien.allowLimitSigner, (1, idOf(alice))));
        bytes32 h = runAliceBob(account, limit);
        vm.warp(vm.getBlockTimestamp() + 1 days);
        account.executeScheduled(h, limit);
        vm.prank(alice);
        account.spend(1, dave, 10e6);
        assertEq(account.getConfig().limitCount, 1);

        // The move waits v1's own delay and could have been vetoed; then it runs.
        Call[] memory up = one(selfCall(account, abi.encodeCall(Olien.setImplementation, (address(implV2)))));
        bytes32 hash = runAliceBob(account, up);
        assertEq(account.getScheduled(hash).readyAt, vm.getBlockTimestamp() + 1 days);
        vm.warp(vm.getBlockTimestamp() + 1 days);
        account.executeScheduled(hash, up);
        assertEq(account.implementation(), address(implV2));

        // Everything v1 held is where it was.
        assertEq(account.getConfig().threshold, 2);
        assertEq(account.getConfig().configDelay, 1 days);
        assertEq(account.getConfig().epoch, 2);
        assertEq(account.getSigners().length, 2);
        assertEq(account.getSigner(idOf(alice)).permissions, PERM_APPROVE | PERM_VETO);
        assertEq(account.getConfig().limitCount, 1);
        (uint48 inactivity, uint48 lastActivity, bool policyOn) = v2(account).getState();
        assertEq(inactivity, 0);
        assertEq(lastActivity, 0);
        assertFalse(policyOn);

        // The hash it checks is the hash it always checked, and the old signers sign it.
        Transaction memory t = txn(transferCall(dave, 1e6));
        assertEq(
            account.getTransactionHash(t),
            OlienHash.transaction(account.domainSeparator(), account.getNonce(0), 2, t.calls, t.validAfter, t.validUntil)
        );
        account.execute(t, aliceBob(account.getTransactionHash(t)));
        assertEq(usdc.balanceOf(dave), 11e6);
        (, lastActivity,) = v2(account).getState();
        assertEq(lastActivity, vm.getBlockTimestamp());

        // v1's limit did not come across. It is made again, and takes the next id.
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IOlien.LimitMissing.selector, 1));
        account.spend(1, dave, 1e6);
        limit[1] = selfCall(account, abi.encodeCall(Olien.allowLimitSigner, (2, idOf(alice))));
        h = runAliceBob(account, limit);
        vm.warp(vm.getBlockTimestamp() + 1 days);
        account.executeScheduled(h, limit);
        assertEq(account.getConfig().limitCount, 2);
        vm.prank(alice);
        account.spend(2, dave, 5e6);
        assertEq(usdc.balanceOf(dave), 16e6);

        // And what v2 added works on it.
        vm.prank(bob);
        v2(account).panic();
        assertEq(account.getConfig().epoch, 3);
    }

    // ------------------------------------------------------ transfer policy

    function test_moneyAboveTheTierWaitsAndAnyVetoerCanStopIt() public {
        Olien account = plainAccount();
        // Setting a policy where there was none tightens, so it runs at once.
        runAliceBob(account, setPolicyCall(account, policyOf(address(usdc), 50e6, 1 days, false, false, 0)));
        assertEq(policy.policyOf(address(account)).tier, 50e6);
        (,, bool on) = v2(account).getState();
        assertTrue(on);

        runAliceBob(account, transferCall(dave, 40e6));
        assertEq(usdc.balanceOf(dave), 40e6);

        Call[] memory big = one(transferCall(dave, 60e6));
        Transaction memory t = txn(big);
        bytes32 hash = account.getTransactionHash(t);
        vm.expectEmit(true, false, false, true);
        emit IOlien.Scheduled(hash, uint48(vm.getBlockTimestamp() + 1 days), PATH_THRESHOLD, bytes32(0));
        account.execute(t, aliceBob(hash));
        assertEq(usdc.balanceOf(dave), 40e6);
        bytes32[] memory log = v2(account).getScheduledLog(0, 10);
        assertEq(log.length, 1);
        assertEq(log[0], hash);

        vm.prank(bob);
        account.veto(hash);
        assertTrue(account.isDead(hash));

        // Two transfers each under the tier wait as one batch when together they exceed it.
        Call[] memory split = new Call[](2);
        split[0] = transferCall(dave, 30e6);
        split[1] = transferCall(eve, 30e6);
        bytes32 h2 = runAliceBob(account, split);
        assertEq(account.getScheduled(h2).readyAt, vm.getBlockTimestamp() + 1 days);
        vm.warp(vm.getBlockTimestamp() + 1 days);
        account.executeScheduled(h2, split);
        assertEq(usdc.balanceOf(dave), 70e6);
        assertEq(usdc.balanceOf(eve), 30e6);
    }

    function test_anUnknownAddressWaitsAndIsThenKnown() public {
        Olien account = delayedAccount();
        runAliceBob(account, setPolicyCall(account, policyOf(address(usdc), 0, 1 hours, true, true, 0)));

        // Dave is new: the payment waits an hour, and after it Dave is known.
        Call[] memory pay = one(transferCall(dave, 1e6));
        bytes32 hash = runAliceBob(account, pay);
        assertEq(account.getScheduled(hash).readyAt, vm.getBlockTimestamp() + 1 hours);
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        account.executeScheduled(hash, pay);
        assertEq(usdc.balanceOf(dave), 1e6);
        assertEq(policy.knownSince(address(account), dave), vm.getBlockTimestamp());
        runAliceBob(account, transferCall(dave, 2e6));
        assertEq(usdc.balanceOf(dave), 3e6);

        // An approval to a stranger is a payment to a stranger; so is a plain call to one.
        bytes32 h2 = runAliceBob(account, Call(address(usdc), 0, abi.encodeCall(IERC20.approve, (eve, 5e6))));
        assertEq(account.getScheduled(h2).readyAt, vm.getBlockTimestamp() + 1 hours);
        bytes32 h3 = runAliceBob(account, Call(eve, 1 ether, ""));
        assertEq(account.getScheduled(h3).readyAt, vm.getBlockTimestamp() + 1 hours);

        // Knowing an address by decision is a rule change: it waits the config delay and can
        // be vetoed. Forgetting one is immediate.
        Call[] memory know = one(knownCall(account, eve, true));
        bytes32 h4 = runAliceBob(account, know);
        assertEq(account.getScheduled(h4).readyAt, vm.getBlockTimestamp() + 1 days);
        vm.warp(vm.getBlockTimestamp() + 1 days);
        account.executeScheduled(h4, know);
        assertGt(policy.knownSince(address(account), eve), 0);
        runAliceBob(account, Call(eve, 1 ether, ""));
        assertEq(eve.balance, 1 ether);
        runAliceBob(account, knownCall(account, dave, false));
        assertEq(policy.knownSince(address(account), dave), 0);
    }

    function test_tighteningIsImmediateLooseningWaitsAndALockHolds() public {
        Olien account = delayedAccount();
        runAliceBob(account, setPolicyCall(account, policyOf(address(usdc), 100e6, 1 days, false, false, 0)));
        assertEq(policy.policyOf(address(account)).tier, 100e6);

        // A lower tier is tighter: at once.
        runAliceBob(account, setPolicyCall(account, policyOf(address(usdc), 80e6, 1 days, false, false, 0)));
        assertEq(policy.policyOf(address(account)).tier, 80e6);

        // A higher tier is looser: it waits, and can be vetoed.
        bytes32 hash = runAliceBob(account, setPolicyCall(account, policyOf(address(usdc), 200e6, 1 days, false, false, 0)));
        assertEq(account.getScheduled(hash).readyAt, vm.getBlockTimestamp() + 1 days);
        vm.prank(alice);
        account.veto(hash);
        assertEq(policy.policyOf(address(account)).tier, 80e6);

        // So are a shorter wait and a tier that goes away.
        hash = runAliceBob(account, setPolicyCall(account, policyOf(address(usdc), 80e6, 1 hours, false, false, 0)));
        assertEq(account.getScheduled(hash).readyAt, vm.getBlockTimestamp() + 1 days);
        hash = runAliceBob(account, setPolicyCall(account, policyOf(address(usdc), 0, 1 days, false, false, 0)));
        assertEq(account.getScheduled(hash).readyAt, vm.getBlockTimestamp() + 1 days);

        // Locked for a month, loosening is not even scheduled.
        uint48 until = uint48(vm.getBlockTimestamp() + 30 days);
        runAliceBob(account, setPolicyCall(account, policyOf(address(usdc), 80e6, 1 days, false, false, until)));
        Transaction memory t = txn(setPolicyCall(account, policyOf(address(usdc), 200e6, 1 days, false, false, until)));
        bytes32 h = account.getTransactionHash(t);
        vm.expectRevert(abi.encodeWithSelector(OlienPolicy.PolicyLocked.selector, until));
        account.execute(t, aliceBob(h));
        vm.warp(until);
        h = runAliceBob(account, setPolicyCall(account, policyOf(address(usdc), 200e6, 1 days, false, false, until)));
        assertEq(account.getScheduled(h).readyAt, vm.getBlockTimestamp() + 1 days);
    }

    function test_aPolicyThatHoldsNeedsAWait() public {
        Olien account = plainAccount();
        Transaction memory t = txn(setPolicyCall(account, policyOf(address(usdc), 50e6, 0, false, false, 0)));
        bytes32 hash = account.getTransactionHash(t);
        vm.expectRevert(IOlien.BadConfig.selector);
        account.execute(t, aliceBob(hash));
        t = txn(setPolicyCall(account, policyOf(address(0), 50e6, 1 days, false, false, 0)));
        hash = account.getTransactionHash(t);
        vm.expectRevert(IOlien.BadConfig.selector);
        account.execute(t, aliceBob(hash));
    }

    // ---------------------------------------------------------------- panic

    function test_panicStopsEverythingInFlightAndChangesNothingElse() public {
        Init memory init = Init(
            three(
                ecdsa(alice, PERM_APPROVE | PERM_VETO), ecdsa(bob, PERM_APPROVE | PERM_VETO), ecdsa(carol, PERM_VETO)
            ),
            2,
            0,
            1 days,
            0,
            0
        );
        Olien account = deploy(init, "panic");
        Call[] memory change = one(selfCall(account, abi.encodeCall(Olien.setThreshold, (1))));
        bytes32 scheduled = runAliceBob(account, change);
        Transaction memory t = txn(transferCall(dave, 1e6));
        bytes32 signed = account.getTransactionHash(t);
        bytes memory sigs = aliceBob(signed);

        // Carol can only veto, and that is enough to pull the brake. Dave is nobody.
        vm.prank(dave);
        vm.expectRevert(IOlien.Unauthorized.selector);
        v2(account).panic();
        vm.prank(carol);
        vm.expectEmit(true, false, false, true);
        emit IOlienV2.Panicked(idOf(carol), 2);
        v2(account).panic();
        assertEq(account.getConfig().epoch, 2);

        // Once a day.
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IOlienV2.Cooldown.selector, uint48(vm.getBlockTimestamp() + 1 days)));
        v2(account).panic();

        vm.warp(vm.getBlockTimestamp() + 1 days);
        vm.expectRevert(abi.encodeWithSelector(IOlien.Stale.selector, scheduled));
        account.executeScheduled(scheduled, change);
        vm.expectRevert(IOlien.InvalidSignatures.selector);
        account.execute(t, sigs);

        // Nothing else moved: the rules, the members and the money are as they were.
        assertEq(account.getConfig().threshold, 2);
        assertEq(account.getSigners().length, 3);
        assertEq(usdc.balanceOf(address(account)), 1_000e6);
        runAliceBob(account, transferCall(dave, 1e6));
        assertEq(usdc.balanceOf(dave), 1e6);

        vm.prank(alice);
        v2(account).panic();
        assertEq(account.getConfig().epoch, 3);
    }

    function test_aPasskeyPanicsThroughAUserOperation() public {
        Olien account = deploy(
            initOf(
                three(
                    p256(deviceX, deviceY, PERM_APPROVE | PERM_VETO),
                    p256(passkeyX, passkeyY, PERM_APPROVE),
                    ecdsa(alice, PERM_APPROVE | PERM_VETO)
                ),
                2,
                0
            ),
            "passkeys"
        );
        // Without veto, validation refuses it before anything runs.
        PackedUserOperation memory op = userOp(account, one(selfCall(account, abi.encodeCall(OlienV2.panic, ()))), 0);
        bytes32 hash = opHash(account, op, 0, type(uint48).max);
        op = withSignature(op, 0, type(uint48).max, pack1(idOf(passkeyX, passkeyY), signP256(passkeyPk, hash)));
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;
        vm.prank(bundler);
        vm.expectRevert();
        IEntryPointLike(ENTRY_POINT).handleOps(ops, payable(bundler));

        op = userOp(account, one(selfCall(account, abi.encodeCall(OlienV2.panic, ()))), 0);
        hash = opHash(account, op, 0, type(uint48).max);
        op = withSignature(op, 0, type(uint48).max, pack1(idOf(deviceX, deviceY), signP256(devicePk, hash)));
        submit(op);
        assertEq(account.getConfig().epoch, 2);
    }

    // ----------------------------------------------------------- limits

    function test_limitsRefillByTheHourNotByTheClock() public {
        Olien account = deploy(
            initOf(three(ecdsa(alice, PERM_APPROVE), ecdsa(bob, PERM_APPROVE), ecdsa(carol, 0)), 2, 0), "limited"
        );
        Call[] memory calls = new Call[](2);
        calls[0] = selfCall(
            account,
            abi.encodeCall(Olien.setSpendingLimit, (0, SpendingLimitInput(address(usdc), 0, 100e6, 1 days, true)))
        );
        calls[1] = selfCall(account, abi.encodeCall(Olien.allowLimitSigner, (1, idOf(carol))));
        runAliceBob(account, calls);

        vm.prank(carol);
        account.spend(1, dave, 100e6);
        // v1 handed over another hundred at the stroke of the next day. v2 gives back what the
        // hours since have earned, and never holds more than the amount.
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(IOlien.LimitExceeded.selector, 1, 1, 0));
        account.spend(1, dave, 1);
        vm.warp(vm.getBlockTimestamp() + 6 hours);
        (uint128 remaining,,,) = policy.budget(address(account), 1);
        assertEq(remaining, 25e6);
        vm.prank(carol);
        account.spend(1, dave, 25e6);
        vm.warp(vm.getBlockTimestamp() + 3 days);
        (remaining,,,) = policy.budget(address(account), 1);
        assertEq(remaining, 100e6);

        // Over any one day, no more than the amount leaves beyond what was already there.
        vm.prank(carol);
        account.spend(1, dave, 100e6);
        vm.warp(vm.getBlockTimestamp() + 1 days - 1);
        (remaining,,,) = policy.budget(address(account), 1);
        assertLt(remaining, 100e6);
        assertEq(usdc.balanceOf(dave), 225e6);
    }

    // ------------------------------------------------------------ inactivity

    function test_afterASilenceOneMemberMayReplaceAColleague() public {
        Olien account = plainAccount();
        runAliceBob(account, selfCall(account, abi.encodeCall(OlienV2.setDelays, (0, 1 days, 0, 30 days))));
        (uint48 inactivity,,) = v2(account).getState();
        assertEq(inactivity, 30 days);
        Call[] memory swap =
            one(selfCall(account, abi.encodeCall(Olien.replaceSigner, (idOf(bob), ecdsa(carol, PERM_APPROVE | PERM_VETO)))));

        // Not yet: Bob was here a moment ago.
        Transaction memory t = txn(swap);
        bytes32 hash = account.getTransactionHash(t);
        vm.expectRevert(IOlien.Unauthorized.selector);
        account.execute(t, pack1(idOf(alice), signECDSA(alicePk, hash)));

        // Thirty days of silence later, Alice alone opens the recovery path. It waits the
        // recovery delay as a guardian's would, and Bob, if he is there, can stop it.
        vm.warp(vm.getBlockTimestamp() + 30 days + 1);
        t = txn(swap);
        hash = account.getTransactionHash(t);
        vm.expectEmit(true, false, false, true);
        emit IOlien.Scheduled(hash, uint48(vm.getBlockTimestamp() + 1 days), PATH_RECOVERY, bytes32(0));
        account.execute(t, pack1(idOf(alice), signECDSA(alicePk, hash)));
        vm.prank(bob);
        account.veto(hash);
        assertTrue(account.isDead(hash));

        // Bob's veto was activity, so the clock starts again.
        t = txn(swap);
        hash = account.getTransactionHash(t);
        vm.expectRevert(IOlien.Unauthorized.selector);
        account.execute(t, pack1(idOf(alice), signECDSA(alicePk, hash)));
        vm.warp(vm.getBlockTimestamp() + 30 days + 1);
        t = txn(swap);
        hash = account.getTransactionHash(t);
        account.execute(t, pack1(idOf(alice), signECDSA(alicePk, hash)));
        vm.warp(vm.getBlockTimestamp() + 1 days);
        account.executeScheduled(hash, swap);
        assertEq(account.getSigner(idOf(bob)).kind, 0);
        assertEq(account.getSigner(idOf(carol)).permissions, PERM_APPROVE | PERM_VETO);

        // Silence opens recovery and nothing more: the new key keeps the old one's role.
        vm.warp(vm.getBlockTimestamp() + 30 days + 1);
        t = txn(selfCall(account, abi.encodeCall(Olien.replaceSigner, (idOf(carol), ecdsa(dave, PERM_APPROVE)))));
        hash = account.getTransactionHash(t);
        vm.expectRevert(IOlien.Unauthorized.selector);
        account.execute(t, pack1(idOf(alice), signECDSA(alicePk, hash)));
    }

    function test_theInactivityDelayIsBounded() public {
        Olien account = plainAccount();
        Transaction memory t = txn(selfCall(account, abi.encodeCall(OlienV2.setDelays, (0, 1 days, 0, 1 days))));
        bytes32 hash = account.getTransactionHash(t);
        vm.expectRevert(IOlien.BadConfig.selector);
        account.execute(t, aliceBob(hash));
        // With inactivity on, the recovery delay has the guardian's floor.
        t = txn(selfCall(account, abi.encodeCall(OlienV2.setDelays, (0, 0, 0, 30 days))));
        hash = account.getTransactionHash(t);
        vm.expectRevert(IOlien.BadConfig.selector);
        account.execute(t, aliceBob(hash));
    }

    // -------------------------------------------------------------- guardians

    function test_aVetoedGuardianIsSuspendedUntilTheMembersReplaceIt() public {
        Init memory init = Init(
            three(
                ecdsa(alice, PERM_APPROVE | PERM_VETO), ecdsa(bob, PERM_APPROVE | PERM_VETO), ecdsa(guardian, PERM_RECOVER)
            ),
            2,
            0,
            0,
            1 days,
            0
        );
        Olien account = deploy(init, "guarded");
        Call[] memory swap =
            one(selfCall(account, abi.encodeCall(Olien.replaceSigner, (idOf(bob), ecdsa(carol, PERM_APPROVE | PERM_VETO)))));
        Transaction memory t = txn(swap);
        bytes32 hash = account.getTransactionHash(t);
        vm.expectEmit(true, false, false, true);
        emit IOlien.Scheduled(hash, uint48(vm.getBlockTimestamp() + 1 days), PATH_RECOVERY, idOf(guardian));
        account.execute(t, pack1(idOf(guardian), signECDSA(guardianPk, hash)));

        vm.prank(bob);
        account.veto(hash);
        assertEq(account.getSigner(idOf(guardian)).flags & FLAG_SUSPENDED, FLAG_SUSPENDED);

        // The next nonce is no way back in.
        t = txn(swap);
        hash = account.getTransactionHash(t);
        vm.expectRevert(IOlien.Unauthorized.selector);
        account.execute(t, pack1(idOf(guardian), signECDSA(guardianPk, hash)));

        // The members put the guardian back by replacing it with itself: the flag went with
        // the old record.
        runAliceBob(
            account, selfCall(account, abi.encodeCall(Olien.replaceSigner, (idOf(guardian), ecdsa(guardian, PERM_RECOVER))))
        );
        assertEq(account.getSigner(idOf(guardian)).flags, 0);
        t = txn(swap);
        hash = account.getTransactionHash(t);
        account.execute(t, pack1(idOf(guardian), signECDSA(guardianPk, hash)));
        assertEq(account.getScheduled(hash).readyAt, vm.getBlockTimestamp() + 1 days);
    }

    // ------------------------------------------------------------ bookkeeping

    function test_theScheduledLogKeepsEveryHashInOrder() public {
        Olien account = delayedAccount();
        bytes32 a = runAliceBob(account, selfCall(account, abi.encodeCall(Olien.setThreshold, (1))));
        bytes32 b = runAliceBob(account, selfCall(account, abi.encodeCall(Olien.setVetoThreshold, (1))));
        bytes32[] memory log = v2(account).getScheduledLog(0, 10);
        assertEq(log.length, 2);
        assertEq(log[0], a);
        assertEq(log[1], b);
        assertEq(v2(account).getScheduledLog(1, 10).length, 1);
        assertEq(v2(account).getScheduledLog(0, 1)[0], a);
        assertEq(v2(account).getScheduledLog(2, 10).length, 0);
        // A reader tells the dead from the waiting by asking after each.
        vm.prank(alice);
        account.veto(a);
        assertEq(account.getScheduled(a).readyAt, 0);
        assertGt(account.getScheduled(b).readyAt, 0);
    }

    function test_aSyncedPasskeyIsRecordedAsOne() public {
        Olien account = deploy(
            initOf(two(webauthn(passkeyX, passkeyY, PERM_APPROVE | PERM_VETO, FLAG_SYNCED), ecdsa(alice, PERM_APPROVE)), 2, 0),
            "synced"
        );
        assertEq(account.getSigner(idOf(passkeyX, passkeyY)).flags, FLAG_SYNCED);
        // Only the account sets the suspended flag.
        Init memory bad =
            initOf(two(webauthn(passkeyX, passkeyY, PERM_APPROVE, FLAG_SUSPENDED), ecdsa(alice, PERM_APPROVE)), 2, 0);
        vm.expectRevert(IOlien.BadPermissions.selector);
        factory.createAccount(bad, "bad");
    }

    function test_gasWithAndWithoutThePolicy() public {
        Olien account = plainAccount();
        Transaction memory t = txn(transferCall(dave, 1e6));
        bytes memory sigs = aliceBob(account.getTransactionHash(t));
        uint256 before = gasleft();
        account.execute(t, sigs);
        emit log_named_uint("gas: execute, one transfer, 2 ECDSA, v2, no policy", before - gasleft());

        runAliceBob(account, setPolicyCall(account, policyOf(address(usdc), 1_000e6, 1 days, true, true, 0)));
        runAliceBob(account, knownCall(account, dave, true));
        t = txn(transferCall(dave, 1e6));
        sigs = aliceBob(account.getTransactionHash(t));
        before = gasleft();
        account.execute(t, sigs);
        emit log_named_uint("gas: execute, one transfer, 2 ECDSA, v2, policy on", before - gasleft());
    }
}

interface IEntryPointLike {
    function handleOps(PackedUserOperation[] calldata ops, address payable beneficiary) external;
}
