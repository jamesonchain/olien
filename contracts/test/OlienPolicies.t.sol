// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {OlienTestBase, MockToken} from "./OlienTestBase.sol";
import {Olien} from "../src/Olien.sol";
import {SubAccount} from "../src/SubAccount.sol";
import {
    IOlien,
    Call,
    Transaction,
    SignerInput,
    Init,
    SpendingLimitInput,
    ScheduledView,
    PERM_APPROVE,
    PERM_VETO,
    PERM_RECOVER,
    PATH_THRESHOLD,
    PATH_RECOVERY
} from "../src/IOlien.sol";

contract OlienPoliciesTest is OlienTestBase {
    uint256 newDevicePk = 0xDE8;
    uint256 newDeviceX;
    uint256 newDeviceY;

    function setUp() public virtual override {
        super.setUp();
        (newDeviceX, newDeviceY) = vm.publicKeyP256(newDevicePk);
    }

    /// @dev The consumer shape: device and cloud approve and veto, the server key only recovers.
    function consumerAccount() internal returns (Olien) {
        Init memory init = Init(
            three(
                p256(deviceX, deviceY, PERM_APPROVE | PERM_VETO),
                ecdsa(alice, PERM_APPROVE | PERM_VETO),
                ecdsa(guardian, PERM_RECOVER)
            ),
            2,
            0,
            1 days,
            1 days,
            0
        );
        return deploy(init, "consumer");
    }

    function deviceId() internal view returns (bytes32) {
        return idOf(deviceX, deviceY);
    }

    function replaceDeviceCall(Olien account) internal view returns (Call memory) {
        return selfCall(
            account,
            abi.encodeCall(Olien.replaceSigner, (deviceId(), p256(newDeviceX, newDeviceY, PERM_APPROVE | PERM_VETO)))
        );
    }

    // ---------------------------------------------------------- scheduling

    function test_configChangeWaitsOutTheDelay() public {
        Olien account = deploy(initOf(two(ecdsa(alice, PERM_APPROVE | PERM_VETO), ecdsa(bob, PERM_APPROVE | PERM_VETO)), 2, 1 days), "delayed");
        Call[] memory calls = one(selfCall(account, abi.encodeCall(Olien.setThreshold, (1))));
        Transaction memory t = txn(calls);
        bytes32 hash = account.getTransactionHash(t);

        vm.expectEmit(true, false, false, true);
        emit IOlien.Scheduled(hash, uint48(block.timestamp + 1 days), PATH_THRESHOLD, bytes32(0));
        account.execute(t, aliceBob(hash));
        assertEq(account.getConfig().threshold, 2);
        assertEq(account.getNonce(0), 1);
        ScheduledView memory sc = account.getScheduled(hash);
        assertEq(sc.readyAt, block.timestamp + 1 days);
        assertEq(sc.epoch, 1);

        vm.expectRevert(abi.encodeWithSelector(IOlien.NotReady.selector, hash));
        account.executeScheduled(hash, calls);

        vm.warp(block.timestamp + 1 days);
        Call[] memory other = one(selfCall(account, abi.encodeCall(Olien.setThreshold, (2))));
        vm.expectRevert(abi.encodeWithSelector(IOlien.CallsMismatch.selector, hash));
        account.executeScheduled(hash, other);

        vm.prank(eve);
        account.executeScheduled(hash, calls);
        assertEq(account.getConfig().threshold, 1);
        assertEq(account.getConfig().epoch, 2);
        assertEq(account.getScheduled(hash).readyAt, 0);

        vm.expectRevert(abi.encodeWithSelector(IOlien.NothingScheduled.selector, hash));
        account.executeScheduled(hash, calls);
    }

    function test_scheduledChangeLapsesAfterTheWindow() public {
        Olien account = deploy(initOf(two(ecdsa(alice, PERM_APPROVE), ecdsa(bob, PERM_APPROVE)), 2, 1 days), "lapse");
        Call[] memory calls = one(selfCall(account, abi.encodeCall(Olien.setThreshold, (1))));
        Transaction memory t = txn(calls);
        bytes32 hash = account.getTransactionHash(t);
        account.execute(t, aliceBob(hash));

        vm.warp(block.timestamp + 1 days + 7 days + 1);
        vm.expectRevert(abi.encodeWithSelector(IOlien.WindowClosed.selector, hash));
        account.executeScheduled(hash, calls);
    }

    function test_scheduledChangeGoesStaleWhenRulesMove() public {
        Olien account = deploy(initOf(two(ecdsa(alice, PERM_APPROVE), ecdsa(bob, PERM_APPROVE)), 2, 1 days), "stale");
        Call[] memory first = one(selfCall(account, abi.encodeCall(Olien.setThreshold, (1))));
        Transaction memory t1 = txn(first);
        bytes32 h1 = account.getTransactionHash(t1);
        account.execute(t1, aliceBob(h1));

        Call[] memory second = one(selfCall(account, abi.encodeCall(Olien.addSigner, (ecdsa(carol, PERM_APPROVE)))));
        Transaction memory t2 = txn(second);
        bytes32 h2 = account.getTransactionHash(t2);
        account.execute(t2, aliceBob(h2));

        vm.warp(block.timestamp + 1 days);
        account.executeScheduled(h2, second);
        vm.expectRevert(abi.encodeWithSelector(IOlien.Stale.selector, h1));
        account.executeScheduled(h1, first);
    }

    function test_takingPowerAwayIsImmediate() public {
        Olien account = deploy(initOf(two(ecdsa(alice, PERM_APPROVE), ecdsa(bob, PERM_APPROVE)), 2, 1 days), "immediate");
        // A cancel of a hash nobody scheduled is a no-op that still runs at once.
        bytes32 hash = runAliceBob(account, selfCall(account, abi.encodeCall(Olien.cancel, (keccak256("x")))));
        assertTrue(account.isDead(keccak256("x")));
        assertEq(account.getScheduled(hash).readyAt, 0);
        assertEq(account.getConfig().epoch, 1);
    }

    // ---------------------------------------------------------------- veto

    function test_vetoKillsAScheduledChange() public {
        Olien account = deploy(initOf(two(ecdsa(alice, PERM_APPROVE | PERM_VETO), ecdsa(bob, PERM_APPROVE | PERM_VETO)), 2, 1 days), "veto");
        assertEq(account.getConfig().effectiveVetoThreshold, 1);
        Call[] memory calls = one(selfCall(account, abi.encodeCall(Olien.setThreshold, (1))));
        Transaction memory t = txn(calls);
        bytes32 hash = account.getTransactionHash(t);
        account.execute(t, aliceBob(hash));

        vm.prank(carol);
        vm.expectRevert(IOlien.Unauthorized.selector);
        account.veto(hash);

        vm.prank(alice);
        vm.expectEmit(true, false, false, true);
        emit IOlien.Cancelled(hash);
        account.veto(hash);
        assertTrue(account.isDead(hash));
        (bool vetoed, uint16 count) = account.getVeto(hash, idOf(alice));
        assertTrue(vetoed);
        assertEq(count, 1);

        vm.warp(block.timestamp + 1 days);
        vm.expectRevert(abi.encodeWithSelector(IOlien.NothingScheduled.selector, hash));
        account.executeScheduled(hash, calls);

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IOlien.NothingScheduled.selector, hash));
        account.veto(hash);
    }

    function test_vetoNeedsAScheduledHash() public {
        Olien account = plainAccount();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IOlien.NothingScheduled.selector, keccak256("x")));
        account.veto(keccak256("x"));
    }

    function test_automaticVetoThresholdCountsApproverVetoers() public {
        // 2-of-3 where all three approve and veto: two vetoes prove the threshold is lost.
        Olien account = deploy(
            initOf(
                three(
                    ecdsa(alice, PERM_APPROVE | PERM_VETO),
                    ecdsa(bob, PERM_APPROVE | PERM_VETO),
                    ecdsa(carol, PERM_APPROVE | PERM_VETO)
                ),
                2,
                1 days
            ),
            "2of3"
        );
        assertEq(account.getConfig().effectiveVetoThreshold, 2);
        Call[] memory calls = one(selfCall(account, abi.encodeCall(Olien.setThreshold, (3))));
        Transaction memory t = txn(calls);
        bytes32 hash = account.getTransactionHash(t);
        account.execute(t, aliceBob(hash));

        vm.prank(carol);
        account.veto(hash);
        assertFalse(account.isDead(hash));
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(IOlien.AlreadyVetoed.selector, hash, idOf(carol)));
        account.veto(hash);
        vm.prank(bob);
        account.veto(hash);
        assertTrue(account.isDead(hash));
    }

    function test_explicitVetoThresholdMustBeReachable() public {
        Init memory init = Init(two(ecdsa(alice, PERM_APPROVE | PERM_VETO), ecdsa(bob, PERM_APPROVE)), 2, 2, 0, 0, 0);
        vm.expectRevert(IOlien.BadConfig.selector);
        factory.createAccount(init, "veto2");
        init.vetoThreshold = 1;
        Olien account = Olien(payable(factory.createAccount(init, "veto1")));
        assertEq(account.getConfig().effectiveVetoThreshold, 1);
    }

    function test_aSignerCannotVetoItsOwnRemovalByTheQuorum() public {
        Olien account = deploy(
            initOf(
                three(
                    ecdsa(alice, PERM_APPROVE | PERM_VETO),
                    ecdsa(bob, PERM_APPROVE | PERM_VETO),
                    ecdsa(carol, PERM_APPROVE | PERM_VETO)
                ),
                2,
                1 days
            ),
            "rogue"
        );
        Call[] memory calls = new Call[](2);
        calls[0] = selfCall(account, abi.encodeCall(Olien.removeSigner, (idOf(carol))));
        calls[1] = selfCall(account, abi.encodeCall(Olien.setThreshold, (2)));
        Transaction memory t = txn(calls);
        bytes32 hash = account.getTransactionHash(t);
        account.execute(t, aliceBob(hash));
        assertEq(account.getScheduled(hash).excluded, idOf(carol));

        vm.prank(carol);
        vm.expectRevert(IOlien.Unauthorized.selector);
        account.veto(hash);

        vm.warp(block.timestamp + 1 days);
        account.executeScheduled(hash, calls);
        assertEq(account.getSigners().length, 2);
    }

    // ---------------------------------------------------------------- recovery

    function test_guardianAloneWaitsAndCanBeVetoed() public virtual {
        Olien account = consumerAccount();
        Call[] memory calls = one(replaceDeviceCall(account));
        Transaction memory t = txn(calls);
        bytes32 hash = account.getTransactionHash(t);

        vm.expectEmit(true, false, false, true);
        emit IOlien.Scheduled(hash, uint48(block.timestamp + 1 days), PATH_RECOVERY, bytes32(0));
        account.execute(t, pack1(idOf(guardian), signECDSA(guardianPk, hash)));

        // The device being replaced is exactly who gets to object to a guardian's recovery.
        // Its veto travels as a user operation or via the account; here the cloud key objects.
        vm.prank(alice);
        account.veto(hash);
        assertTrue(account.isDead(hash));
        vm.warp(block.timestamp + 1 days);
        vm.expectRevert(abi.encodeWithSelector(IOlien.NothingScheduled.selector, hash));
        account.executeScheduled(hash, calls);
    }

    function test_guardianAloneRecoversAfterTheDelay() public {
        Olien account = consumerAccount();
        Call[] memory calls = one(replaceDeviceCall(account));
        Transaction memory t = txn(calls);
        bytes32 hash = account.getTransactionHash(t);
        account.execute(t, pack1(idOf(guardian), signECDSA(guardianPk, hash)));

        vm.warp(block.timestamp + 1 days);
        account.executeScheduled(hash, calls);
        assertEq(account.getSigner(deviceId()).kind, 0);
        assertEq(account.getSigner(idOf(newDeviceX, newDeviceY)).permissions, PERM_APPROVE | PERM_VETO);
        assertEq(account.getConfig().epoch, 2);

        // The new device pays with the cloud key straight away.
        Transaction memory pay = txn(transferCall(dave, 4e6));
        bytes32 payHash = account.getTransactionHash(pay);
        account.execute(pay, pack2(idOf(newDeviceX, newDeviceY), signP256(newDevicePk, payHash), idOf(alice), signECDSA(alicePk, payHash)));
        assertEq(usdc.balanceOf(dave), 4e6);
    }

    function test_coSignedRecoveryIsImmediate() public {
        Olien account = consumerAccount();
        Transaction memory t = txn(replaceDeviceCall(account));
        bytes32 hash = account.getTransactionHash(t);
        account.execute(t, pack2(idOf(guardian), signECDSA(guardianPk, hash), idOf(alice), signECDSA(alicePk, hash)));
        assertEq(account.getSigner(idOf(newDeviceX, newDeviceY)).kind, 2);
        assertEq(account.getScheduled(hash).readyAt, 0);
    }

    function test_recoveryCannotChangeRoleOrDoMore() public {
        Olien account = consumerAccount();
        // Escalation: a replacement with more permissions.
        Transaction memory t = txn(
            selfCall(
                account,
                abi.encodeCall(
                    Olien.replaceSigner,
                    (deviceId(), p256(newDeviceX, newDeviceY, PERM_APPROVE | PERM_VETO | PERM_RECOVER))
                )
            )
        );
        bytes32 hash = account.getTransactionHash(t);
        vm.expectRevert(IOlien.Unauthorized.selector);
        account.execute(t, pack1(idOf(guardian), signECDSA(guardianPk, hash)));

        // Two calls: not a recovery.
        Call[] memory calls = new Call[](2);
        calls[0] = replaceDeviceCall(account);
        calls[1] = transferCall(dave, 1e6);
        t = txn(calls);
        hash = account.getTransactionHash(t);
        vm.expectRevert(IOlien.Unauthorized.selector);
        account.execute(t, pack1(idOf(guardian), signECDSA(guardianPk, hash)));

        // A non-standard encoding of replaceSigner is not a recovery either.
        bytes memory odd = abi.encodeCall(
            Olien.replaceSigner, (deviceId(), p256(newDeviceX, newDeviceY, PERM_APPROVE | PERM_VETO))
        );
        odd[35 + 32] = 0x60; // move the tuple offset
        t = txn(selfCall(account, odd));
        hash = account.getTransactionHash(t);
        vm.expectRevert(IOlien.Unauthorized.selector);
        account.execute(t, pack1(idOf(guardian), signECDSA(guardianPk, hash)));

        // The guardian is not an approver.
        t = txn(transferCall(dave, 1e6));
        hash = account.getTransactionHash(t);
        vm.expectRevert(IOlien.Unauthorized.selector);
        account.execute(t, pack2(idOf(guardian), signECDSA(guardianPk, hash), idOf(alice), signECDSA(alicePk, hash)));
    }

    function test_aRecovererWithApproveCannotCoSignItself() public {
        Init memory init = Init(
            two(ecdsa(alice, PERM_APPROVE), ecdsa(guardian, PERM_APPROVE | PERM_RECOVER)), 2, 0, 0, 1 days, 0
        );
        Olien account = deploy(init, "selfcosign");
        Transaction memory t = txn(selfCall(account, abi.encodeCall(Olien.replaceSigner, (idOf(alice), ecdsa(bob, PERM_APPROVE)))));
        bytes32 hash = account.getTransactionHash(t);
        account.execute(t, pack1(idOf(guardian), signECDSA(guardianPk, hash)));
        // Scheduled with the full delay, not run at once.
        assertEq(account.getScheduled(hash).readyAt, block.timestamp + 1 days);
        assertEq(account.getSigner(idOf(alice)).kind, 1);
    }

    // ---------------------------------------------------------- spending limits

    function limitedAccount() internal returns (Olien account) {
        account = deploy(
            initOf(three(ecdsa(alice, PERM_APPROVE), ecdsa(bob, PERM_APPROVE), ecdsa(carol, 0)), 2, 0), "limited"
        );
        Call[] memory calls = new Call[](3);
        calls[0] = selfCall(account, abi.encodeCall(Olien.setSpendingLimit, (0, SpendingLimitInput(address(usdc), 0, 100e6, 1 days, false))));
        calls[1] = selfCall(account, abi.encodeCall(Olien.allowLimitSigner, (1, idOf(carol))));
        calls[2] = selfCall(account, abi.encodeCall(Olien.allowLimitDestination, (1, dave)));
        runAliceBob(account, calls);
    }

    function test_spendUnderALimit() public virtual {
        Olien account = limitedAccount();
        assertTrue(account.isLimitSigner(1, idOf(carol)));
        assertTrue(account.isLimitDestination(1, dave));
        assertEq(account.getConfig().epoch, 1);

        vm.prank(carol);
        uint256 gasBefore = gasleft();
        account.spend(1, dave, 40e6);
        emit log_named_uint("gas: spend under a limit", gasBefore - gasleft());
        assertEq(usdc.balanceOf(dave), 40e6);
        (uint128 remaining,,,) = account.getLimitBudget(1);
        assertEq(remaining, 60e6);

        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(IOlien.LimitExceeded.selector, 1, 70e6, 60e6));
        account.spend(1, dave, 70e6);

        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(IOlien.LimitDestination.selector, eve));
        account.spend(1, eve, 1e6);

        vm.prank(alice);
        vm.expectRevert(IOlien.Unauthorized.selector);
        account.spend(1, dave, 1e6);

        // Next period, the budget is back and aligned to the period.
        vm.warp(block.timestamp + 2 days + 5);
        vm.prank(carol);
        account.spend(1, dave, 100e6);
        (, uint48 resetAt,,) = account.getLimitBudget(1);
        assertEq(resetAt, block.timestamp - 5 + 1 days);
    }

    function test_replacingALimitRetiresItsSigners() public virtual {
        Olien account = limitedAccount();
        runAliceBob(account, selfCall(account, abi.encodeCall(Olien.setSpendingLimit, (1, SpendingLimitInput(address(usdc), 0, 5e6, 0, true)))));
        assertFalse(account.isLimitSigner(1, idOf(carol)));
        vm.prank(carol);
        vm.expectRevert(IOlien.Unauthorized.selector);
        account.spend(1, eve, 1e6);

        runAliceBob(account, selfCall(account, abi.encodeCall(Olien.allowLimitSigner, (1, idOf(carol)))));
        vm.prank(carol);
        account.spend(1, eve, 5e6);
        assertEq(usdc.balanceOf(eve), 5e6);
        // A one-time budget never refills.
        vm.warp(block.timestamp + 30 days);
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(IOlien.LimitExceeded.selector, 1, 1e6, 0));
        account.spend(1, eve, 1e6);
    }

    function test_aReAddedKeyIsNotTheLimitsSigner() public virtual {
        Olien account = limitedAccount();
        Call[] memory calls = new Call[](2);
        calls[0] = selfCall(account, abi.encodeCall(Olien.removeSigner, (idOf(carol))));
        calls[1] = selfCall(account, abi.encodeCall(Olien.addSigner, (ecdsa(carol, 0))));
        runAliceBob(account, calls);
        assertTrue(account.isLimitSigner(1, idOf(carol)));
        vm.prank(carol);
        vm.expectRevert(IOlien.Unauthorized.selector);
        account.spend(1, dave, 1e6);
    }

    function test_removedLimitSpendsNothing() public virtual {
        Olien account = limitedAccount();
        runAliceBob(account, selfCall(account, abi.encodeCall(Olien.removeSpendingLimit, (1))));
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(IOlien.LimitMissing.selector, 1));
        account.spend(1, dave, 1e6);
        vm.expectRevert(abi.encodeWithSelector(IOlien.LimitMissing.selector, 1));
        account.getLimitBudget(1);
    }

    function test_limitFromASubAccount() public {
        Olien account = deploy(initOf(three(ecdsa(alice, PERM_APPROVE), ecdsa(bob, PERM_APPROVE), ecdsa(carol, 0)), 2, 0), "sublimit");
        Call[] memory calls = new Call[](2);
        calls[0] = selfCall(account, abi.encodeCall(Olien.setSpendingLimit, (0, SpendingLimitInput(address(usdc), 1, 50e6, 0, true))));
        calls[1] = selfCall(account, abi.encodeCall(Olien.allowLimitSigner, (1, idOf(carol))));
        runAliceBob(account, calls);
        address payroll = account.subAccount(0);
        assertTrue(payroll.code.length > 0);
        usdc.mint(payroll, 30e6);

        vm.prank(carol);
        account.spend(1, dave, 30e6);
        assertEq(usdc.balanceOf(dave), 30e6);
        assertEq(usdc.balanceOf(payroll), 0);
        assertEq(usdc.balanceOf(address(account)), 1_000e6);

        usdc.setReturnFalse(true);
        vm.prank(carol);
        vm.expectRevert(SubAccount.TransferFailed.selector);
        account.spend(1, dave, 1e6);
    }

    function test_transferReturningFalseIsAFailure() public {
        Olien account = limitedAccount();
        usdc.setReturnFalse(true);
        vm.prank(carol);
        vm.expectRevert(IOlien.TransferFailed.selector);
        account.spend(1, dave, 1e6);
    }

    function test_limitNeedsATokenAndKnownSigners() public {
        Olien account = plainAccount();
        Transaction memory t = txn(selfCall(account, abi.encodeCall(Olien.setSpendingLimit, (0, SpendingLimitInput(dave, 0, 1, 0, true)))));
        bytes32 hash = account.getTransactionHash(t);
        vm.expectRevert(IOlien.BadConfig.selector);
        account.execute(t, aliceBob(hash));

        Call[] memory calls = new Call[](2);
        calls[0] = selfCall(account, abi.encodeCall(Olien.setSpendingLimit, (0, SpendingLimitInput(address(usdc), 0, 1, 0, true))));
        calls[1] = selfCall(account, abi.encodeCall(Olien.allowLimitSigner, (1, idOf(carol))));
        t = txn(calls);
        hash = account.getTransactionHash(t);
        vm.expectRevert(abi.encodeWithSelector(IOlien.UnknownSigner.selector, idOf(carol)));
        account.execute(t, aliceBob(hash));
    }
}
