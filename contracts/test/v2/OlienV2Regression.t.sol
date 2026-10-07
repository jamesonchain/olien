// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {OlienAccountTest} from "../OlienAccount.t.sol";
import {OlienPoliciesTest} from "../OlienPolicies.t.sol";
import {Olien4337Test} from "../Olien4337.t.sol";
import {Olien} from "../../src/Olien.sol";
import {OlienFactory} from "../../src/OlienFactory.sol";
import {IOlien, Call, Transaction, SpendingLimitInput, PATH_RECOVERY, PERM_APPROVE} from "../../src/IOlien.sol";
import {PackedUserOperation} from "../../src/IEntryPoint.sol";
import {OlienV2} from "../../src/v2/OlienV2.sol";
import {IOlienV2, FLAG_SUSPENDED} from "../../src/v2/IOlienV2.sol";
import {OlienPolicy} from "../../src/v2/OlienPolicy.sol";
import {OlienVerifierV2} from "../../src/v2/OlienVerifierV2.sol";

// v1's three suites, run against v2 unchanged: every rule of v1 is a rule of v2. The few
// tests overridden here are the places v2 changed on purpose, and each says what changed.

contract OlienAccountV2Test is OlienAccountTest {
    OlienPolicy policy;
    OlienVerifierV2 verifier2;

    function setUp() public override {
        super.setUp();
        policy = new OlienPolicy();
        verifier2 = new OlienVerifierV2();
        impl = Olien(payable(address(new OlienV2(ENTRY_POINT, address(verifier2), address(subImpl), address(policy)))));
        factory = new OlienFactory(address(impl));
    }

    /// v2 answers the hash-shaped EIP-1271 call only; the bytes-shaped one went for room.
    function test_isValidSignature() public override {
        Olien account = plainAccount();
        bytes32 digest = keccak256("a cheque");
        bytes32 wrapped = account.getMessageHash(digest);
        bytes memory sigs = aliceBob(wrapped);
        assertEq(account.isValidSignature(digest, sigs), bytes4(0x1626ba7e));
        assertEq(account.isValidSignature(keccak256("other"), sigs), bytes4(0xffffffff));
        Transaction memory t = txn(transferCall(dave, 1e6));
        bytes32 hash = account.getTransactionHash(t);
        assertEq(account.isValidSignature(hash, aliceBob(hash)), bytes4(0xffffffff));
        runAliceBob(account, selfCall(account, abi.encodeCall(Olien.cancel, (wrapped))));
        assertEq(account.isValidSignature(digest, sigs), bytes4(0xffffffff));
    }

    /// v2 names the code as well as the address, so what the veto window judged is what runs.
    function test_implementationChangeAndFreeze() public override {
        Olien account = plainAccount();
        OlienV2 next = new OlienV2(ENTRY_POINT, address(verifier2), address(subImpl), address(policy));

        Transaction memory t =
            txn(selfCall(account, abi.encodeCall(OlienV2.setImplementation, (address(usdc), address(usdc).codehash))));
        bytes32 hash = account.getTransactionHash(t);
        vm.expectRevert(abi.encodeWithSelector(IOlien.NotAnImplementation.selector, address(usdc)));
        account.execute(t, aliceBob(hash));

        t = txn(selfCall(account, abi.encodeCall(OlienV2.setImplementation, (address(next), bytes32(0)))));
        hash = account.getTransactionHash(t);
        vm.expectRevert(abi.encodeWithSelector(IOlienV2.CodeMismatch.selector, address(next)));
        account.execute(t, aliceBob(hash));

        runAliceBob(
            account, selfCall(account, abi.encodeCall(OlienV2.setImplementation, (address(next), address(next).codehash)))
        );
        assertEq(account.implementation(), address(next));
        assertEq(account.getConfig().threshold, 2);

        runAliceBob(account, selfCall(account, abi.encodeCall(Olien.freezeImplementation, ())));
        assertTrue(account.getConfig().implementationFrozen);
        t = txn(selfCall(account, abi.encodeCall(OlienV2.setImplementation, (address(impl), address(impl).codehash))));
        hash = account.getTransactionHash(t);
        vm.expectRevert(IOlien.Frozen.selector);
        account.execute(t, aliceBob(hash));
    }
}

contract OlienPoliciesV2Test is OlienPoliciesTest {
    OlienPolicy policy;

    function setUp() public override {
        super.setUp();
        policy = new OlienPolicy();
        impl = Olien(
            payable(address(new OlienV2(ENTRY_POINT, address(new OlienVerifierV2()), address(subImpl), address(policy))))
        );
        factory = new OlienFactory(address(impl));
    }

    /// The budget refills continuously now, and the limit's state is read from OlienPolicy.
    function test_spendUnderALimit() public override {
        Olien account = limitedAccount();
        assertTrue(policy.isSigner(address(account), 1, idOf(carol)));
        assertTrue(policy.isDestination(address(account), 1, dave));
        assertEq(account.getConfig().limitCount, 1);

        vm.prank(carol);
        uint256 gasBefore = gasleft();
        account.spend(1, dave, 40e6);
        emit log_named_uint("gas: spend under a limit, v2", gasBefore - gasleft());
        assertEq(usdc.balanceOf(dave), 40e6);
        (uint128 remaining,,,) = policy.budget(address(account), 1);
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

        // Half a day on, half the amount has come back, and the budget never exceeds the amount.
        vm.warp(block.timestamp + 12 hours);
        (remaining,,,) = policy.budget(address(account), 1);
        assertEq(remaining, 100e6);
    }

    function test_replacingALimitRetiresItsSigners() public override {
        Olien account = limitedAccount();
        runAliceBob(
            account,
            selfCall(
                account, abi.encodeCall(Olien.setSpendingLimit, (1, SpendingLimitInput(address(usdc), 0, 5e6, 0, true)))
            )
        );
        assertFalse(policy.isSigner(address(account), 1, idOf(carol)));
        vm.prank(carol);
        vm.expectRevert(IOlien.Unauthorized.selector);
        account.spend(1, eve, 1e6);

        runAliceBob(account, selfCall(account, abi.encodeCall(Olien.allowLimitSigner, (1, idOf(carol)))));
        vm.prank(carol);
        account.spend(1, eve, 5e6);
        assertEq(usdc.balanceOf(eve), 5e6);
    }

    function test_aReAddedKeyIsNotTheLimitsSigner() public override {
        Olien account = limitedAccount();
        Call[] memory calls = new Call[](2);
        calls[0] = selfCall(account, abi.encodeCall(Olien.removeSigner, (idOf(carol))));
        calls[1] = selfCall(account, abi.encodeCall(Olien.addSigner, (ecdsa(carol, 0))));
        runAliceBob(account, calls);
        assertTrue(policy.isSigner(address(account), 1, idOf(carol)));
        vm.prank(carol);
        vm.expectRevert(IOlien.Unauthorized.selector);
        account.spend(1, dave, 1e6);
    }

    function test_removedLimitSpendsNothing() public override {
        Olien account = limitedAccount();
        runAliceBob(account, selfCall(account, abi.encodeCall(Olien.removeSpendingLimit, (1))));
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(IOlien.LimitMissing.selector, 1));
        account.spend(1, dave, 1e6);
        vm.expectRevert(abi.encodeWithSelector(IOlien.LimitMissing.selector, 1));
        policy.budget(address(account), 1);
    }

    /// A recovery entry now names its guardian, and a vetoed guardian is suspended.
    function test_guardianAloneWaitsAndCanBeVetoed() public override {
        Olien account = consumerAccount();
        Call[] memory calls = one(replaceDeviceCall(account));
        Transaction memory t = txn(calls);
        bytes32 hash = account.getTransactionHash(t);

        vm.expectEmit(true, false, false, true);
        emit IOlien.Scheduled(hash, uint48(block.timestamp + 1 days), PATH_RECOVERY, idOf(guardian));
        account.execute(t, pack1(idOf(guardian), signECDSA(guardianPk, hash)));

        vm.prank(alice);
        vm.expectEmit(true, false, false, false);
        emit IOlienV2.SignerSuspended(idOf(guardian));
        account.veto(hash);
        assertTrue(account.isDead(hash));
        assertEq(account.getSigner(idOf(guardian)).flags & FLAG_SUSPENDED, FLAG_SUSPENDED);
        vm.warp(block.timestamp + 1 days);
        vm.expectRevert(abi.encodeWithSelector(IOlien.NothingScheduled.selector, hash));
        account.executeScheduled(hash, calls);
    }
}

contract Olien4337V2Test is Olien4337Test {
    event UserOperationRevertReason(bytes32 indexed userOpHash, address indexed sender, uint256 nonce, bytes revertReason);

    OlienPolicy policy;

    function setUp() public override {
        super.setUp();
        policy = new OlienPolicy();
        impl = Olien(
            payable(address(new OlienV2(ENTRY_POINT, address(new OlienVerifierV2()), address(subImpl), address(policy))))
        );
        factory = new OlienFactory(address(impl));
    }

    /// v2 no longer asks the limit during validation: a signer the limit does not name is
    /// refused when the spend runs, and the EntryPoint records the refusal.
    function test_singleSignerSpendAsUserOperation() public override {
        Olien account = deploy(
            initOf(three(ecdsa(alice, PERM_APPROVE), ecdsa(bob, PERM_APPROVE), p256(deviceX, deviceY, 0)), 2, 0), "payroll"
        );
        Call[] memory setup = new Call[](2);
        setup[0] = selfCall(
            account,
            abi.encodeCall(Olien.setSpendingLimit, (0, SpendingLimitInput(address(usdc), 0, 100e6, 1 days, true)))
        );
        setup[1] = selfCall(account, abi.encodeCall(Olien.allowLimitSigner, (1, idOf(deviceX, deviceY))));
        runAliceBob(account, setup);

        PackedUserOperation memory op =
            userOp(account, one(selfCall(account, abi.encodeCall(Olien.spend, (1, dave, 30e6)))), 0);
        bytes32 hash = opHash(account, op, 0, UNTIL);
        op = withSignature(op, 0, UNTIL, pack1(idOf(deviceX, deviceY), signP256(devicePk, hash)));
        submit(op);
        assertEq(usdc.balanceOf(dave), 30e6);

        op = userOp(account, one(selfCall(account, abi.encodeCall(Olien.spend, (1, dave, 1e6)))), 0);
        hash = opHash(account, op, 0, UNTIL);
        op = withSignature(op, 0, UNTIL, pack1(idOf(alice), signECDSA(alicePk, hash)));
        vm.expectEmit(false, true, false, false);
        emit UserOperationRevertReason(bytes32(0), address(account), 0, "");
        submit(op);
        assertEq(usdc.balanceOf(dave), 30e6);
    }
}
