// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {OlienTestBase} from "./OlienTestBase.sol";
import {Olien} from "../src/Olien.sol";
import {OlienFactory} from "../src/OlienFactory.sol";
import {PackedUserOperation, IEntryPoint, IAccountExecute} from "../src/IEntryPoint.sol";
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
    PATH_SINGLE
} from "../src/IOlien.sol";

interface IEntryPointErrors {
    error FailedOp(uint256 opIndex, string reason);
    error FailedOpWithRevert(uint256 opIndex, string reason, bytes inner);
}

contract Olien4337Test is OlienTestBase {
    uint48 constant UNTIL = type(uint48).max;

    function consumer() internal returns (Olien) {
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
        return deploy(init, "consumer-4337");
    }

    function deviceAlice(Olien account, PackedUserOperation memory op) internal view returns (PackedUserOperation memory) {
        bytes32 hash = opHash(account, op, 0, UNTIL);
        return withSignature(op, 0, UNTIL, pack2(idOf(deviceX, deviceY), signP256(devicePk, hash), idOf(alice), signECDSA(alicePk, hash)));
    }

    function test_thresholdTransferAsUserOperation() public {
        Olien account = plainAccount();
        PackedUserOperation memory op = userOp(account, one(transferCall(dave, 12e6)), 0);
        bytes32 hash = opHash(account, op, 0, UNTIL);
        op = withSignature(op, 0, UNTIL, aliceBob(hash));

        vm.expectEmit(true, false, false, true);
        emit IOlien.Executed(hash, op.nonce, PATH_THRESHOLD);
        submit(op);
        assertEq(usdc.balanceOf(dave), 12e6);
        assertTrue(bundler.balance > 0);
    }

    function test_consumerPaysWithDeviceAndCloud() public {
        Olien account = consumer();
        PackedUserOperation memory op = deviceAlice(account, userOp(account, one(transferCall(dave, 5e6)), 0));
        uint256 before = gasleft();
        submit(op);
        emit log_named_uint("gas: handleOps, P256 + ECDSA transfer (whole bundle)", before - gasleft());
        assertEq(usdc.balanceOf(dave), 5e6);
    }

    function test_wrongSignatureIsAA24() public {
        Olien account = plainAccount();
        PackedUserOperation memory op = userOp(account, one(transferCall(dave, 1e6)), 0);
        bytes32 hash = opHash(account, op, 0, UNTIL);
        op = withSignature(op, 0, UNTIL, pack2(idOf(alice), signECDSA(alicePk, hash), idOf(bob), signECDSA(bobPk, keccak256("x"))));
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;
        vm.prank(bundler);
        vm.expectRevert(abi.encodeWithSelector(IEntryPointErrors.FailedOp.selector, 0, "AA24 signature error"));
        IEntryPoint(ENTRY_POINT).handleOps(ops, payable(bundler));
    }

    function test_validityWindowIsEnforcedByTheEntryPoint() public {
        Olien account = plainAccount();
        PackedUserOperation memory op = userOp(account, one(transferCall(dave, 1e6)), 0);
        uint48 until = uint48(block.timestamp - 1);
        bytes32 hash = opHash(account, op, 0, until);
        op = withSignature(op, 0, until, aliceBob(hash));
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;
        vm.prank(bundler);
        vm.expectRevert(abi.encodeWithSelector(IEntryPointErrors.FailedOp.selector, 0, "AA22 expired or not due"));
        IEntryPoint(ENTRY_POINT).handleOps(ops, payable(bundler));

        // validUntil of zero is never accepted.
        op = userOp(account, one(transferCall(dave, 1e6)), 0);
        hash = opHash(account, op, 0, 0);
        op = withSignature(op, 0, 0, aliceBob(hash));
        ops[0] = op;
        vm.prank(bundler);
        vm.expectRevert(abi.encodeWithSelector(IEntryPointErrors.FailedOp.selector, 0, "AA24 signature error"));
        IEntryPoint(ENTRY_POINT).handleOps(ops, payable(bundler));
    }

    function test_onlyExecuteUserOpCallDataIsServed() public {
        Olien account = plainAccount();
        PackedUserOperation memory op = userOp(account, one(transferCall(dave, 1e6)), 0);
        op.callData = abi.encodeCall(Olien.approve, (keccak256("h")));
        bytes32 hash = opHash(account, op, 0, UNTIL);
        op = withSignature(op, 0, UNTIL, aliceBob(hash));
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;
        vm.prank(bundler);
        vm.expectRevert(
            abi.encodeWithSelector(
                IEntryPointErrors.FailedOpWithRevert.selector, 0, "AA23 reverted", abi.encodeWithSelector(IOlien.BadCallData.selector)
            )
        );
        IEntryPoint(ENTRY_POINT).handleOps(ops, payable(bundler));
    }

    function test_singleSignerSpendAsUserOperation() public virtual {
        Olien account = deploy(
            initOf(three(ecdsa(alice, PERM_APPROVE), ecdsa(bob, PERM_APPROVE), p256(deviceX, deviceY, 0)), 2, 0), "payroll"
        );
        Call[] memory setup = new Call[](2);
        setup[0] = selfCall(account, abi.encodeCall(Olien.setSpendingLimit, (0, SpendingLimitInput(address(usdc), 0, 100e6, 1 days, true))));
        setup[1] = selfCall(account, abi.encodeCall(Olien.allowLimitSigner, (1, idOf(deviceX, deviceY))));
        runAliceBob(account, setup);

        PackedUserOperation memory op = userOp(account, one(selfCall(account, abi.encodeCall(Olien.spend, (1, dave, 30e6)))), 0);
        bytes32 hash = opHash(account, op, 0, UNTIL);
        op = withSignature(op, 0, UNTIL, pack1(idOf(deviceX, deviceY), signP256(devicePk, hash)));
        vm.expectEmit(true, false, false, true);
        emit IOlien.Executed(hash, op.nonce, PATH_SINGLE);
        submit(op);
        assertEq(usdc.balanceOf(dave), 30e6);

        // A signer not on the limit is refused at validation.
        op = userOp(account, one(selfCall(account, abi.encodeCall(Olien.spend, (1, dave, 1e6)))), 0);
        hash = opHash(account, op, 0, UNTIL);
        op = withSignature(op, 0, UNTIL, pack1(idOf(alice), signECDSA(alicePk, hash)));
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;
        vm.prank(bundler);
        vm.expectRevert(abi.encodeWithSelector(IEntryPointErrors.FailedOp.selector, 0, "AA24 signature error"));
        IEntryPoint(ENTRY_POINT).handleOps(ops, payable(bundler));
    }

    function test_deviceVetoesARecoveryAsUserOperation() public {
        Olien account = consumer();
        (uint256 newX, uint256 newY) = vm.publicKeyP256(0xDE8);
        Call[] memory calls = one(selfCall(account, abi.encodeCall(Olien.replaceSigner, (idOf(deviceX, deviceY), p256(newX, newY, PERM_APPROVE | PERM_VETO)))));
        Transaction memory t = txn(calls);
        bytes32 hash = account.getTransactionHash(t);
        account.execute(t, pack1(idOf(guardian), signECDSA(guardianPk, hash)));
        assertEq(account.getScheduled(hash).readyAt, block.timestamp + 1 days);

        PackedUserOperation memory op = userOp(account, one(selfCall(account, abi.encodeCall(Olien.veto, (hash)))), 0);
        bytes32 h = opHash(account, op, 0, UNTIL);
        op = withSignature(op, 0, UNTIL, pack1(idOf(deviceX, deviceY), signP256(devicePk, h)));
        submit(op);
        assertTrue(account.isDead(hash));
        assertEq(account.getSigner(idOf(deviceX, deviceY)).kind, 2);
    }

    function test_configThroughAUserOperationIsScheduledAndVetoable() public {
        Olien account = consumer();
        PackedUserOperation memory op = deviceAlice(account, userOp(account, one(selfCall(account, abi.encodeCall(Olien.setThreshold, (1)))), 0));
        bytes32 hash = opHash(account, op, 0, UNTIL);
        submit(op);
        assertEq(account.getConfig().threshold, 2);
        assertEq(account.getScheduled(hash).readyAt, block.timestamp + 1 days);
        assertEq(account.getScheduled(hash).path, PATH_THRESHOLD);

        vm.warp(block.timestamp + 1 days);
        account.executeScheduled(hash, one(selfCall(account, abi.encodeCall(Olien.setThreshold, (1)))));
        assertEq(account.getConfig().threshold, 1);
    }

    function test_aCancelledOperationDoesNotValidate() public {
        Olien account = plainAccount();
        PackedUserOperation memory op = userOp(account, one(transferCall(dave, 1e6)), 0);
        bytes32 hash = opHash(account, op, 0, UNTIL);
        op = withSignature(op, 0, UNTIL, aliceBob(hash));
        runAliceBob(account, selfCall(account, abi.encodeCall(Olien.cancel, (hash))));

        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;
        vm.prank(bundler);
        vm.expectRevert(abi.encodeWithSelector(IEntryPointErrors.FailedOp.selector, 0, "AA24 signature error"));
        IEntryPoint(ENTRY_POINT).handleOps(ops, payable(bundler));
    }

    function test_executeUserOpNeedsTheEntryPointAndAValidation() public {
        Olien account = plainAccount();
        PackedUserOperation memory op = userOp(account, one(transferCall(dave, 1e6)), 0);
        vm.expectRevert(IOlien.NotEntryPoint.selector);
        account.executeUserOp(op, keccak256("x"));
        vm.prank(ENTRY_POINT);
        vm.expectRevert(IOlien.NotValidated.selector);
        account.executeUserOp(op, keccak256("x"));
    }

    function test_counterfactualAccountDeploysFromInitCode() public {
        Init memory init = initOf(two(ecdsa(alice, PERM_APPROVE), ecdsa(bob, PERM_APPROVE)), 2, 0);
        address predicted = factory.getAddress(init, "cf");
        usdc.mint(predicted, 100e6);
        vm.deal(predicted, 1 ether);
        Olien account = Olien(payable(predicted));

        PackedUserOperation memory op;
        op.sender = predicted;
        op.nonce = 0;
        op.initCode = abi.encodePacked(address(factory), abi.encodeCall(OlienFactory.createAccount, (init, "cf")));
        op.callData = abi.encodeWithSelector(IAccountExecute.executeUserOp.selector, one(transferCall(dave, 40e6)));
        op.accountGasLimits = bytes32((uint256(3_000_000) << 128) | 2_000_000);
        op.preVerificationGas = 60_000;
        op.gasFees = bytes32((uint256(1 gwei) << 128) | 2 gwei);
        // The domain names the address, and the epoch after initialize is 1.
        bytes32 hash = hasher.userOp(
            keccak256(abi.encode(keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"), keccak256("Olien"), keccak256("1"), block.chainid, predicted)),
            op, 0, UNTIL, 1, ENTRY_POINT
        );
        op = withSignature(op, 0, UNTIL, aliceBob(hash));
        submit(op);
        assertTrue(predicted.code.length > 0);
        assertEq(usdc.balanceOf(dave), 40e6);
        assertEq(account.getConfig().threshold, 2);
    }

    function test_twoOperationsInOneBundleKeepTheirOwnPaths() public {
        Olien account = consumer();
        PackedUserOperation memory pay = deviceAlice(account, userOp(account, one(transferCall(dave, 1e6)), 0));
        PackedUserOperation memory change = deviceAlice(account, userOp(account, one(selfCall(account, abi.encodeCall(Olien.setThreshold, (1)))), 1));
        bytes32 changeHash = opHash(account, change, 0, UNTIL);
        PackedUserOperation[] memory ops = new PackedUserOperation[](2);
        ops[0] = change;
        ops[1] = pay;
        vm.prank(bundler);
        IEntryPoint(ENTRY_POINT).handleOps(ops, payable(bundler));
        assertEq(usdc.balanceOf(dave), 1e6);
        assertEq(account.getConfig().threshold, 2);
        assertEq(account.getScheduled(changeHash).readyAt, block.timestamp + 1 days);
    }
}
