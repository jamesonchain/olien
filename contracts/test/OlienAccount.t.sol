// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {OlienTestBase, MockToken, Reenterer} from "./OlienTestBase.sol";
import {Olien} from "../src/Olien.sol";
import {OlienProxy} from "../src/OlienProxy.sol";
import {SubAccount} from "../src/SubAccount.sol";
import {
    IOlien,
    Call,
    Transaction,
    SignerInput,
    Init,
    KIND_ECDSA,
    KIND_P256,
    PERM_APPROVE,
    PERM_VETO,
    PERM_RECOVER,
    FLAG_UV_REQUIRED,
    PATH_THRESHOLD
} from "../src/IOlien.sol";

contract OlienAccountTest is OlienTestBase {
    // ---------------------------------------------------------------- factory

    function test_factoryAddressIsPredictableAndIdempotent() public {
        Init memory init = initOf(two(ecdsa(alice, PERM_APPROVE), ecdsa(bob, PERM_APPROVE)), 2, 0);
        address predicted = factory.getAddress(init, "x");
        address created = factory.createAccount(init, "x");
        assertEq(created, predicted);
        assertEq(factory.createAccount(init, "x"), created);
        Olien account = Olien(payable(created));
        assertEq(account.getConfig().threshold, 2);
        assertEq(account.getConfig().epoch, 1);
        assertEq(account.implementation(), address(impl));
    }

    function test_differentSignersDifferentAddress() public view {
        Init memory a = initOf(two(ecdsa(alice, PERM_APPROVE), ecdsa(bob, PERM_APPROVE)), 2, 0);
        Init memory b = initOf(two(ecdsa(alice, PERM_APPROVE), ecdsa(carol, PERM_APPROVE)), 2, 0);
        assertTrue(factory.getAddress(a, "x") != factory.getAddress(b, "x"));
    }

    function test_initializeOnlyOnce() public {
        Olien account = plainAccount();
        Init memory init = initOf(two(ecdsa(carol, PERM_APPROVE), ecdsa(dave, PERM_APPROVE)), 1, 0);
        vm.expectRevert(IOlien.AlreadyInitialized.selector);
        account.initialize(init);
        vm.expectRevert(IOlien.AlreadyInitialized.selector);
        impl.initialize(init);
    }

    function test_configIsCheckedAtInitialize() public {
        Init memory init = initOf(two(ecdsa(alice, PERM_APPROVE), ecdsa(bob, PERM_APPROVE)), 0, 0);
        vm.expectRevert(IOlien.BadConfig.selector);
        factory.createAccount(init, "t0");

        init.threshold = 3;
        vm.expectRevert(IOlien.BadConfig.selector);
        factory.createAccount(init, "t3");

        init = initOf(two(ecdsa(alice, PERM_APPROVE), ecdsa(guardian, PERM_RECOVER)), 1, 0);
        vm.expectRevert(IOlien.BadConfig.selector);
        factory.createAccount(init, "guardian-no-delay");
        init.recoveryDelay = 1 hours;
        factory.createAccount(init, "guardian-no-delay");

        init = initOf(two(ecdsa(alice, PERM_VETO), ecdsa(bob, PERM_VETO)), 1, 0);
        vm.expectRevert(IOlien.BadConfig.selector);
        factory.createAccount(init, "no-approver");

        init = initOf(two(ecdsa(alice, PERM_APPROVE), ecdsa(bob, PERM_APPROVE)), 1, 31 days);
        vm.expectRevert(IOlien.BadConfig.selector);
        factory.createAccount(init, "long-delay");
    }

    function test_badKeysAreRefused() public {
        vm.expectRevert(IOlien.SignerExists.selector == bytes4(0) ? bytes("") : abi.encodeWithSelector(IOlien.SignerExists.selector, idOf(alice)));
        factory.createAccount(initOf(two(ecdsa(alice, PERM_APPROVE), ecdsa(alice, PERM_APPROVE)), 1, 0), "dup");

        vm.expectRevert(IOlien.BadKey.selector);
        factory.createAccount(initOf(two(ecdsa(address(0), PERM_APPROVE), ecdsa(bob, PERM_APPROVE)), 1, 0), "zero");

        vm.expectRevert(IOlien.BadKey.selector);
        factory.createAccount(initOf(two(ecdsa(ENTRY_POINT, PERM_APPROVE), ecdsa(bob, PERM_APPROVE)), 1, 0), "ep");

        vm.expectRevert(IOlien.BadKey.selector);
        factory.createAccount(initOf(two(contractSigner(dave, PERM_APPROVE), ecdsa(bob, PERM_APPROVE)), 1, 0), "nocode");

        vm.expectRevert(IOlien.BadKey.selector);
        factory.createAccount(initOf(two(p256(1, 2, PERM_APPROVE), ecdsa(bob, PERM_APPROVE)), 1, 0), "offcurve");

        SignerInput memory shortKey = SignerInput(KIND_ECDSA, PERM_APPROVE, 0, hex"1234");
        vm.expectRevert(IOlien.BadKey.selector);
        factory.createAccount(initOf(two(shortKey, ecdsa(bob, PERM_APPROVE)), 1, 0), "short");

        SignerInput memory badPerms = SignerInput(KIND_ECDSA, 8, 0, abi.encodePacked(alice));
        vm.expectRevert(IOlien.BadPermissions.selector);
        factory.createAccount(initOf(two(badPerms, ecdsa(bob, PERM_APPROVE)), 1, 0), "perms");
    }

    // -------------------------------------------------------------- execution

    function test_executeTransferWithTwoECDSASignatures() public {
        Olien account = plainAccount();
        Transaction memory t = txn(transferCall(dave, 25e6));
        bytes32 hash = account.getTransactionHash(t);

        vm.expectEmit(true, false, false, true);
        emit IOlien.Executed(hash, 0, PATH_THRESHOLD);
        account.execute(t, aliceBob(hash));

        assertEq(usdc.balanceOf(dave), 25e6);
        assertEq(account.getNonce(0), 1);
        // The same signatures cannot run twice: the nonce moved and the hash with it.
        vm.expectRevert(IOlien.InvalidSignatures.selector);
        account.execute(t, aliceBob(hash));
    }

    function test_executeBatchAndNativeValue() public {
        Olien account = plainAccount();
        Call[] memory calls = new Call[](2);
        calls[0] = transferCall(dave, 1e6);
        calls[1] = Call(eve, 0.5 ether, "");
        runAliceBob(account, calls);
        assertEq(usdc.balanceOf(dave), 1e6);
        assertEq(eve.balance, 0.5 ether);
    }

    function test_executeRevertsBubbleUp() public {
        Olien account = plainAccount();
        Transaction memory t = txn(transferCall(dave, 5_000e6));
        bytes32 hash = account.getTransactionHash(t);
        vm.expectRevert(bytes("balance"));
        account.execute(t, aliceBob(hash));
        // A failed execution leaves the slot free for a retry.
        assertEq(account.getNonce(0), 0);
    }

    function test_executeWithP256Signer() public {
        Olien account = deploy(initOf(two(p256(deviceX, deviceY, PERM_APPROVE), ecdsa(alice, PERM_APPROVE)), 2, 0), "p256");
        Transaction memory t = txn(transferCall(dave, 3e6));
        bytes32 hash = account.getTransactionHash(t);
        bytes memory sigs = pack2(idOf(deviceX, deviceY), signP256(devicePk, hash), idOf(alice), signECDSA(alicePk, hash));
        uint256 gasBefore = gasleft();
        account.execute(t, sigs);
        emit log_named_uint("gas: execute, P256 + ECDSA, one transfer", gasBefore - gasleft());
        assertEq(usdc.balanceOf(dave), 3e6);
    }

    function test_p256HighSIsRefused() public {
        Olien account = deploy(initOf(two(p256(deviceX, deviceY, PERM_APPROVE), ecdsa(alice, PERM_APPROVE)), 2, 0), "p256s");
        Transaction memory t = txn(transferCall(dave, 3e6));
        bytes32 hash = account.getTransactionHash(t);
        (bytes32 r, bytes32 s) = vm.signP256(devicePk, hash);
        if (uint256(s) <= P256_N / 2) s = bytes32(P256_N - uint256(s));
        bytes memory sigs =
            pack2(idOf(deviceX, deviceY), abi.encodePacked(r, s), idOf(alice), signECDSA(alicePk, hash));
        vm.expectRevert(IOlien.InvalidSignatures.selector);
        account.execute(t, sigs);
    }

    function test_p256WithoutPrecompileUsesSolidityVerifier() public {
        vm.etch(PRECOMPILE, "");
        Olien account = deploy(initOf(two(p256(deviceX, deviceY, PERM_APPROVE), ecdsa(alice, PERM_APPROVE)), 2, 0), "nopre");
        Transaction memory t = txn(transferCall(dave, 3e6));
        bytes32 hash = account.getTransactionHash(t);
        account.execute(t, pack2(idOf(deviceX, deviceY), signP256(devicePk, hash), idOf(alice), signECDSA(alicePk, hash)));
        assertEq(usdc.balanceOf(dave), 3e6);

        t = txn(transferCall(dave, 1e6));
        hash = account.getTransactionHash(t);
        bytes memory wrong = signP256(devicePk, keccak256("other"));
        vm.expectRevert(IOlien.InvalidSignatures.selector);
        account.execute(t, pack2(idOf(deviceX, deviceY), wrong, idOf(alice), signECDSA(alicePk, hash)));
    }

    function test_executeWithWebAuthnSigner() public {
        Olien account = deploy(
            initOf(two(webauthn(passkeyX, passkeyY, PERM_APPROVE, FLAG_UV_REQUIRED), ecdsa(alice, PERM_APPROVE)), 2, 0),
            "passkey"
        );
        Transaction memory t = txn(transferCall(dave, 7e6));
        bytes32 hash = account.getTransactionHash(t);
        bytes32 id = idOf(passkeyX, passkeyY);
        account.execute(t, pack2(id, signWebAuthn(passkeyPk, hash, 0x05), idOf(alice), signECDSA(alicePk, hash)));
        assertEq(usdc.balanceOf(dave), 7e6);

        // User present but not verified: refused for a signer that requires verification.
        t = txn(transferCall(dave, 1e6));
        hash = account.getTransactionHash(t);
        bytes memory upOnly = pack2(id, signWebAuthn(passkeyPk, hash, 0x01), idOf(alice), signECDSA(alicePk, hash));
        vm.expectRevert(IOlien.InvalidSignatures.selector);
        account.execute(t, upOnly);
    }

    function test_ethSignVariantIsAccepted() public {
        Olien account = plainAccount();
        Transaction memory t = txn(transferCall(dave, 1e6));
        bytes32 hash = account.getTransactionHash(t);
        bytes32 prefixed = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", hash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(alicePk, prefixed);
        bytes memory aliceSig = abi.encodePacked(r, s, v + 4);
        account.execute(t, pack2(idOf(alice), aliceSig, idOf(bob), signECDSA(bobPk, hash)));
        assertEq(usdc.balanceOf(dave), 1e6);
    }

    // ------------------------------------------------------------- signatures

    function test_signatureSetRules() public {
        Olien account = plainAccount();
        Transaction memory t = txn(transferCall(dave, 1e6));
        bytes32 hash = account.getTransactionHash(t);
        bytes memory a = signECDSA(alicePk, hash);
        bytes memory b = signECDSA(bobPk, hash);
        (bytes32 lo, bytes32 hi) = idOf(alice) < idOf(bob) ? (idOf(alice), idOf(bob)) : (idOf(bob), idOf(alice));
        (bytes memory loSig, bytes memory hiSig) = lo == idOf(alice) ? (a, b) : (b, a);

        // Descending order.
        vm.expectRevert(IOlien.InvalidSignatures.selector);
        account.execute(t, bytes.concat(entry(hi, hiSig), entry(lo, loSig)));
        // Duplicate.
        vm.expectRevert(IOlien.InvalidSignatures.selector);
        account.execute(t, bytes.concat(entry(lo, loSig), entry(lo, loSig)));
        // Unknown signer.
        vm.expectRevert(IOlien.InvalidSignatures.selector);
        account.execute(t, pack2(idOf(alice), a, idOf(carol), signECDSA(carolPk, hash)));
        // One short of the threshold.
        vm.expectRevert(IOlien.Unauthorized.selector);
        account.execute(t, pack1(idOf(alice), a));
        // Wrong hash.
        vm.expectRevert(IOlien.InvalidSignatures.selector);
        account.execute(t, pack2(idOf(alice), signECDSA(alicePk, keccak256("x")), idOf(bob), b));
        // Truncated encoding.
        vm.expectRevert(IOlien.MalformedSignatures.selector);
        account.execute(t, hex"0011");
        bytes memory claimsMore = abi.encodePacked(idOf(alice), uint16(65), hex"00");
        vm.expectRevert(IOlien.MalformedSignatures.selector);
        account.execute(t, claimsMore);
        // Empty set.
        vm.expectRevert(IOlien.Unauthorized.selector);
        account.execute(t, "");
    }

    function test_onChainApprovalCountsAsAnEntry() public {
        Olien account = plainAccount();
        Transaction memory t = txn(transferCall(dave, 2e6));
        bytes32 hash = account.getTransactionHash(t);

        vm.prank(alice);
        account.approve(hash);
        assertTrue(account.isApproved(hash, idOf(alice)));

        account.execute(t, pack2(idOf(alice), "", idOf(bob), signECDSA(bobPk, hash)));
        assertEq(usdc.balanceOf(dave), 2e6);
    }

    function test_approveRequiresASignerAddress() public {
        Olien account = plainAccount();
        vm.prank(carol);
        vm.expectRevert(IOlien.Unauthorized.selector);
        account.approve(keccak256("h"));
    }

    // ---------------------------------------------------------------- validity

    function test_validityWindow() public {
        Olien account = plainAccount();
        Transaction memory t = Transaction(0, one(transferCall(dave, 1e6)), uint48(block.timestamp + 10), uint48(block.timestamp + 100));
        vm.expectRevert(IOlien.NotYetValid.selector);
        account.execute(t, "");

        t.validAfter = 0;
        t.validUntil = 0;
        vm.expectRevert(IOlien.Expired.selector);
        account.execute(t, "");

        t.validUntil = uint48(block.timestamp + 31 days);
        vm.expectRevert(IOlien.Expired.selector);
        account.execute(t, "");

        t.validUntil = uint48(block.timestamp - 1);
        vm.expectRevert(IOlien.Expired.selector);
        account.execute(t, "");
    }

    function test_nonceLanesAreIndependent() public {
        Olien account = plainAccount();
        Transaction memory lane7 = Transaction(7, one(transferCall(dave, 1e6)), 0, uint48(block.timestamp + 1 days));
        bytes32 hash = account.getTransactionHash(lane7);
        account.execute(lane7, aliceBob(hash));
        assertEq(account.getNonce(7), (uint256(7) << 64) | 1);
        assertEq(account.getNonce(0), 0);
    }

    // ------------------------------------------------------------------ epoch

    function test_configChangeInvalidatesEverythingSigned() public {
        Olien account = plainAccount();
        Transaction memory pending = txn(transferCall(dave, 1e6));
        bytes32 pendingHash = account.getTransactionHash(pending);
        bytes memory pendingSigs = aliceBob(pendingHash);

        runAliceBob(account, selfCall(account, abi.encodeCall(Olien.setThreshold, (1))));
        assertEq(account.getConfig().epoch, 2);
        assertEq(account.getConfig().threshold, 1);

        // Same nonce is still free, but the hash now carries epoch 2.
        vm.expectRevert(IOlien.InvalidSignatures.selector);
        account.execute(pending, pendingSigs);
    }

    function test_signerChanges() public {
        Olien account = plainAccount();
        Call[] memory calls = new Call[](2);
        calls[0] = selfCall(account, abi.encodeCall(Olien.addSigner, (ecdsa(carol, PERM_APPROVE))));
        calls[1] = selfCall(account, abi.encodeCall(Olien.setThreshold, (3)));
        runAliceBob(account, calls);
        assertEq(account.getSigners().length, 3);
        assertEq(account.getConfig().threshold, 3);
        assertEq(account.getSigner(idOf(carol)).since, 1);

        // Removing below the threshold is refused at the end of the batch, not midway.
        Transaction memory t = txn(selfCall(account, abi.encodeCall(Olien.removeSigner, (idOf(carol)))));
        bytes32 hash = account.getTransactionHash(t);
        bytes32[] memory ids = new bytes32[](3);
        bytes[] memory sigs = new bytes[](3);
        (ids[0], ids[1], ids[2]) = (idOf(alice), idOf(bob), idOf(carol));
        (sigs[0], sigs[1], sigs[2]) = (signECDSA(alicePk, hash), signECDSA(bobPk, hash), signECDSA(carolPk, hash));
        vm.expectRevert(IOlien.BadConfig.selector);
        account.execute(t, pack(ids, sigs));

        Call[] memory fix = new Call[](2);
        fix[0] = selfCall(account, abi.encodeCall(Olien.setThreshold, (2)));
        fix[1] = selfCall(account, abi.encodeCall(Olien.removeSigner, (idOf(carol))));
        t = txn(fix);
        hash = account.getTransactionHash(t);
        (sigs[0], sigs[1], sigs[2]) = (signECDSA(alicePk, hash), signECDSA(bobPk, hash), signECDSA(carolPk, hash));
        (ids[0], ids[1], ids[2]) = (idOf(alice), idOf(bob), idOf(carol));
        account.execute(t, pack(ids, sigs));
        assertEq(account.getSigners().length, 2);
        assertEq(account.getSigner(idOf(carol)).kind, 0);
    }

    function test_unknownSelfCallIsRefused() public {
        Olien account = plainAccount();
        Transaction memory t = txn(selfCall(account, abi.encodeCall(Olien.approve, (keccak256("h")))));
        bytes32 hash = account.getTransactionHash(t);
        vm.expectRevert(abi.encodeWithSelector(IOlien.SelfCallRefused.selector, Olien.approve.selector));
        account.execute(t, aliceBob(hash));

        t = txn(Call(address(account), 0, hex"01"));
        hash = account.getTransactionHash(t);
        vm.expectRevert(abi.encodeWithSelector(IOlien.SelfCallRefused.selector, bytes4(0)));
        account.execute(t, aliceBob(hash));
    }

    function test_configFunctionsOnlyFromSelf() public {
        Olien account = plainAccount();
        vm.prank(alice);
        vm.expectRevert(IOlien.NotSelf.selector);
        account.setThreshold(1);
    }

    // --------------------------------------------------------------- EIP-1271

    function test_isValidSignature() public virtual {
        Olien account = plainAccount();
        bytes32 digest = keccak256("a cheque");
        bytes32 wrapped = account.getMessageHash(digest);
        bytes memory sigs = aliceBob(wrapped);
        assertEq(account.isValidSignature(digest, sigs), bytes4(0x1626ba7e));
        assertEq(account.isValidSignature(bytes("a cheque"), sigs), bytes4(0x20c13b0b));
        assertEq(account.isValidSignature(keccak256("other"), sigs), bytes4(0xffffffff));
        // A transaction signature is not a message signature.
        Transaction memory t = txn(transferCall(dave, 1e6));
        bytes32 hash = account.getTransactionHash(t);
        assertEq(account.isValidSignature(hash, aliceBob(hash)), bytes4(0xffffffff));

        // The threshold can kill a message hash.
        runAliceBob(account, selfCall(account, abi.encodeCall(Olien.cancel, (wrapped))));
        assertEq(account.isValidSignature(digest, sigs), bytes4(0xffffffff));
    }

    function test_nestedAccountSigns() public {
        Olien inner = deploy(initOf(two(ecdsa(bob, PERM_APPROVE), ecdsa(carol, PERM_APPROVE)), 2, 0), "inner");
        Olien outer = deploy(initOf(two(ecdsa(alice, PERM_APPROVE), contractSigner(address(inner), PERM_APPROVE)), 2, 0), "outer");

        Transaction memory t = txn(transferCall(dave, 9e6));
        bytes32 outerHash = outer.getTransactionHash(t);
        bytes32 innerHash = inner.getMessageHash(outerHash);
        bytes memory innerPacked = pack2(idOf(bob), signECDSA(bobPk, innerHash), idOf(carol), signECDSA(carolPk, innerHash));
        bytes memory sigs = pack2(idOf(alice), signECDSA(alicePk, outerHash), idOf(address(inner)), innerPacked);
        uint256 gasBefore = gasleft();
        outer.execute(t, sigs);
        emit log_named_uint("gas: execute, nested 2-of-2 inside 2-of-2", gasBefore - gasleft());
        assertEq(usdc.balanceOf(dave), 9e6);

        // The inner account's own transaction signatures do not pass as its message signature.
        t = txn(transferCall(dave, 1e6));
        outerHash = outer.getTransactionHash(t);
        bytes memory wrongInner = pack2(idOf(bob), signECDSA(bobPk, outerHash), idOf(carol), signECDSA(carolPk, outerHash));
        vm.expectRevert(IOlien.InvalidSignatures.selector);
        outer.execute(t, pack2(idOf(alice), signECDSA(alicePk, outerHash), idOf(address(inner)), wrongInner));
    }

    // ------------------------------------------------------------ sub-accounts

    function test_subAccounts() public {
        Olien account = plainAccount();
        address predicted = account.subAccount(3);
        vm.prank(eve);
        address created = account.createSubAccount(3);
        assertEq(created, predicted);
        assertEq(account.createSubAccount(3), created);
        assertEq(SubAccount(payable(created)).parent(), address(account));

        usdc.mint(created, 50e6);
        Call[] memory inner = one(transferCall(dave, 20e6));
        vm.prank(eve);
        vm.expectRevert(SubAccount.NotParent.selector);
        SubAccount(payable(created)).execute(inner);

        runAliceBob(account, Call(created, 0, abi.encodeCall(SubAccount.execute, (inner))));
        assertEq(usdc.balanceOf(dave), 20e6);
    }

    // ---------------------------------------------------------------- upgrade

    function test_implementationChangeAndFreeze() public virtual {
        Olien account = plainAccount();
        Olien next = new Olien(ENTRY_POINT, address(verifier), address(subImpl));

        Transaction memory t = txn(selfCall(account, abi.encodeCall(Olien.setImplementation, (address(usdc)))));
        bytes32 hash = account.getTransactionHash(t);
        vm.expectRevert(abi.encodeWithSelector(IOlien.NotAnImplementation.selector, address(usdc)));
        account.execute(t, aliceBob(hash));

        runAliceBob(account, selfCall(account, abi.encodeCall(Olien.setImplementation, (address(next)))));
        assertEq(account.implementation(), address(next));
        assertEq(account.getConfig().threshold, 2);

        runAliceBob(account, selfCall(account, abi.encodeCall(Olien.freezeImplementation, ())));
        assertTrue(account.getConfig().implementationFrozen);
        t = txn(selfCall(account, abi.encodeCall(Olien.setImplementation, (address(impl)))));
        hash = account.getTransactionHash(t);
        vm.expectRevert(IOlien.Frozen.selector);
        account.execute(t, aliceBob(hash));
    }

    // ------------------------------------------------------------- reentrancy

    function test_reentrantExecuteIsRefused() public {
        Olien account = plainAccount();
        Reenterer r = new Reenterer();
        Transaction memory innerTx = Transaction(1, one(transferCall(dave, 1e6)), 0, uint48(block.timestamp + 1 days));
        bytes32 innerHash = account.getTransactionHash(innerTx);
        r.arm(account, innerTx, aliceBob(innerHash));

        Transaction memory t = txn(Call(address(r), 0, abi.encodeCall(Reenterer.poke, ())));
        bytes32 hash = account.getTransactionHash(t);
        vm.expectRevert(IOlien.Reentered.selector);
        account.execute(t, aliceBob(hash));
    }

    function test_receivesTokensAndValue() public {
        Olien account = plainAccount();
        (bool ok,) = address(account).call{value: 1 ether}("");
        assertTrue(ok);
        assertEq(account.onERC721Received(address(0), address(0), 0, ""), Olien.onERC721Received.selector);
    }
}
