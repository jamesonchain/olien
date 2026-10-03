// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";

import {Olien} from "../src/Olien.sol";
import {OlienFactory} from "../src/OlienFactory.sol";
import {OlienProxy} from "../src/OlienProxy.sol";
import {OlienVerifier} from "../src/OlienVerifier.sol";
import {SubAccount} from "../src/SubAccount.sol";
import {Init, SignerInput, KIND_ECDSA, PERM_APPROVE, PERM_VETO} from "../src/IOlien.sol";

/// The deployed Olien, held to the source in this repository.
///
/// An account's address is a function of the factory's address, and the factory's of its
/// creation code. The compiler ends that code with a hash of the source paths, so the
/// same Solidity compiled from another directory deploys to another address. This
/// repository is such a directory: it was split out of the one v1 was deployed from, and
/// a deploy made by recompiling here would give a new chain a different factory, and
/// every team a different address there than the one they hold on Arc and Monad.
///
/// So v1 is deployed from the exact bytes in deployments/v1/creation.json, and this test
/// holds those bytes to two things: that they land on the addresses the deployment files
/// record, and that the logic in them is the logic of the source beside this file. A
/// change to the account that alters its code fails here, which is the point: that is
/// a new version with new salts and new addresses, not an edit.
contract OlienCanonicalTest is Test {
    address constant DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    bytes constant DEPLOYER_CODE =
        hex"7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3";

    string internal book;
    address internal entryPoint;

    function setUp() public {
        book = vm.readFile(string.concat(vm.projectRoot(), "/../deployments/v1/creation.json"));
        entryPoint = vm.parseJsonAddress(book, ".entryPoint");
        assertEq(vm.parseJsonAddress(book, ".deployer"), DEPLOYER, "the deployer the bytes were made for");
        if (DEPLOYER.code.length == 0) vm.etch(DEPLOYER, DEPLOYER_CODE);
    }

    function _pinned(string memory name) internal view returns (bytes32 salt, address recorded, bytes memory initCode) {
        string memory at = string.concat(".contracts.", name);
        salt = vm.parseJsonBytes32(book, string.concat(at, ".salt"));
        recorded = vm.parseJsonAddress(book, string.concat(at, ".address"));
        initCode = vm.parseJsonBytes(book, string.concat(at, ".initCode"));
    }

    /// Sends the pinned bytes through the deployer exactly as ops/deploy-olien.sh does.
    function _deploy(string memory name) internal returns (address deployed) {
        (bytes32 salt, address recorded, bytes memory initCode) = _pinned(name);
        address predicted =
            address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), DEPLOYER, salt, keccak256(initCode))))));
        assertEq(predicted, recorded, string.concat(name, ": the pinned bytes no longer predict the recorded address"));
        (bool ok, bytes memory out) = DEPLOYER.call(abi.encodePacked(salt, initCode));
        assertTrue(ok, string.concat(name, ": the deployer refused the pinned bytes"));
        deployed = address(bytes20(out));
        assertEq(deployed, recorded, string.concat(name, ": deployed somewhere other than the recorded address"));
        assertGt(deployed.code.length, 0, string.concat(name, ": no code after deploying"));
    }

    /// The hash of runtime code without the compiler's trailing metadata, whose last two
    /// bytes give its own length. What is left is the logic and the immutables.
    function _logic(bytes memory code) internal pure returns (bytes32 result) {
        uint256 tail = (uint256(uint8(code[code.length - 2])) << 8) + uint256(uint8(code[code.length - 1])) + 2;
        require(tail < code.length, "metadata longer than the code");
        uint256 length = code.length - tail;
        assembly {
            result := keccak256(add(code, 32), length)
        }
    }

    function _metadataLength(bytes memory code) internal pure returns (uint256) {
        return (uint256(uint8(code[code.length - 2])) << 8) + uint256(uint8(code[code.length - 1])) + 2;
    }

    function _hashOf(bytes memory code, uint256 from, uint256 to) internal pure returns (bytes32 result) {
        require(from <= to && to <= code.length, "range");
        uint256 length = to - from;
        assembly {
            result := keccak256(add(add(code, 32), from), length)
        }
    }

    function _find(bytes memory haystack, bytes memory needle) internal pure returns (uint256) {
        bytes32 wanted = keccak256(needle);
        for (uint256 i = 0; i + needle.length <= haystack.length; i++) {
            if (haystack[i] == needle[0] && _hashOf(haystack, i, i + needle.length) == wanted) return i;
        }
        revert("the proxy's metadata is not inside the factory");
    }

    /// The factory carries the proxy's creation code inside its own, and that inner code
    /// ends with a metadata hash of its own. So the factory is compared with both hashes
    /// left out: the inner one, found by looking for this build's proxy metadata, and
    /// the outer one at the very end.
    function _assertFactoryIsThisSource(address canonical, address rebuilt) internal view {
        bytes memory deployed = canonical.code;
        bytes memory local = rebuilt.code;
        assertEq(deployed.length, local.length, "the factory's code is a different length from what is deployed");
        bytes memory proxy = type(OlienProxy).creationCode;
        uint256 inner = _metadataLength(proxy);
        bytes memory innerMetadata = new bytes(inner);
        for (uint256 i = 0; i < inner; i++) innerMetadata[i] = proxy[proxy.length - inner + i];
        uint256 at = _find(local, innerMetadata);
        uint256 end = local.length - _metadataLength(local);
        assertEq(_hashOf(deployed, 0, at), _hashOf(local, 0, at), "the factory's source has moved from what is deployed");
        assertEq(_hashOf(deployed, at + inner, end), _hashOf(local, at + inner, end), "the factory's source has moved from what is deployed");
    }

    function test_the_salts_are_the_names_the_deploy_script_always_used() public view {
        (bytes32 verifier,,) = _pinned("verifier");
        (bytes32 subAccount,,) = _pinned("subAccountImplementation");
        (bytes32 implementation,,) = _pinned("implementation");
        (bytes32 factory,,) = _pinned("factory");
        assertEq(verifier, keccak256("olien.v1.verifier"));
        assertEq(subAccount, keccak256("olien.v1.sub-account"));
        assertEq(implementation, keccak256("olien.v1.implementation"));
        assertEq(factory, keccak256("olien.v1.factory"));
    }

    function test_the_pinned_bytes_land_on_the_recorded_addresses_and_are_this_source() public {
        address verifier = _deploy("verifier");
        address subAccount = _deploy("subAccountImplementation");
        address implementation = _deploy("implementation");
        address factory = _deploy("factory");

        assertEq(_logic(verifier.code), _logic(address(new OlienVerifier()).code), "the verifier's source has moved from what is deployed");
        assertEq(_logic(subAccount.code), _logic(address(new SubAccount()).code), "the sub-account's source has moved from what is deployed");
        assertEq(
            _logic(implementation.code),
            _logic(address(new Olien(entryPoint, verifier, subAccount)).code),
            "the account's source has moved from what is deployed"
        );
        _assertFactoryIsThisSource(factory, address(new OlienFactory(implementation)));

        // And what the deployed factory makes is this repository's proxy over that account.
        SignerInput[] memory signers = new SignerInput[](1);
        signers[0] = SignerInput(KIND_ECDSA, PERM_APPROVE | PERM_VETO, 0, abi.encodePacked(address(0xA11CE)));
        Init memory init = Init(signers, 1, 0, 1 days, 1 days, 0);
        address predicted = OlienFactory(factory).getAddress(init, bytes32(uint256(1)));
        address account = OlienFactory(factory).createAccount(init, bytes32(uint256(1)));
        assertEq(account, predicted, "the factory deployed somewhere other than it predicted");
        bytes memory initializer = abi.encodeCall(Olien.initialize, (init));
        assertEq(
            _logic(account.code),
            _logic(address(new OlienProxy(implementation, initializer)).code),
            "the proxy's source has moved from what the deployed factory makes"
        );
        assertEq(Olien(payable(account)).getConfig().threshold, 1, "the new account is not initialised");

        // The deployed account is wired to the pieces deployed beside it, and the factory to it.
        assertEq(Olien(payable(implementation)).ENTRY_POINT(), entryPoint);
        assertEq(Olien(payable(implementation)).VERIFIER(), verifier);
        assertEq(Olien(payable(implementation)).SUB_ACCOUNT_IMPLEMENTATION(), subAccount);
        assertEq(OlienFactory(factory).implementation(), implementation);
    }

    /// What goes wrong without the pinned bytes, stated as a fact so nobody has to find it
    /// out on a mainnet: this directory's own build is not the deployed one.
    function test_recompiling_here_does_not_reproduce_the_deployed_addresses() public view {
        (bytes32 salt, address recorded,) = _pinned("verifier");
        address recompiled = address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), DEPLOYER, salt, keccak256(type(OlienVerifier).creationCode)))))
        );
        assertTrue(recompiled != recorded, "this build now reproduces the deployment; the pinned bytes may no longer be needed");
    }
}
