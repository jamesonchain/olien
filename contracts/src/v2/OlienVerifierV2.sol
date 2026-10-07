// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {P256} from "@openzeppelin/contracts/utils/cryptography/P256.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";

import {WebAuthn} from "../WebAuthn.sol";
import {OlienHash} from "../OlienHash.sol";
import {PackedUserOperation} from "../IEntryPoint.sol";
import {Call, KIND_ECDSA, KIND_P256, KIND_WEBAUTHN, KIND_CONTRACT, FLAG_UV_REQUIRED} from "../IOlien.sol";

interface IOlienVerifierV2 {
    function verify(uint8 kind, bytes32 hash, bytes32 id, uint8 flags, uint256 x, uint256 y, bytes calldata signature)
        external
        view
        returns (bool);
    function transactionHash(
        bytes32 domain,
        uint256 nonce,
        uint64 epoch,
        Call[] calldata calls,
        uint48 validAfter,
        uint48 validUntil
    ) external pure returns (bytes32);
    function userOperationHash(
        bytes32 domain,
        bytes calldata validateCalldata,
        uint48 validAfter,
        uint48 validUntil,
        uint64 epoch,
        address entryPoint
    ) external view returns (bytes32);
}

/// @title OlienVerifierV2
/// @notice One signature check for every kind of signer, and the EIP-712 hashes signers sign,
///         kept out of the account so the account fits the code size limit with its rules.
///         Stateless; the account holds its address as an immutable. v1's verifier checked
///         P-256 and passkeys only and the account hashed and checked the rest; v2's account
///         does neither itself. The hashes are `OlienHash`'s, unchanged from v1.
///
/// P-256 goes to the RIP-7212 precompile first. The precompile answers a wrong signature
/// with empty data, which is also what a chain without the precompile answers. On an
/// empty answer the precompile is asked about a known-good vector: if that succeeds the
/// precompile is there and the signature was simply wrong; only if the probe is empty too
/// does OpenZeppelin's Solidity verifier run.
contract OlienVerifierV2 is IOlienVerifierV2 {
    address private constant PRECOMPILE = address(0x100);

    // RIP-7212 specification test vector: hash, r, s, x, y.
    bytes private constant PROBE = abi.encode(
        0x4cee90eb86eaa050036147a12d49004b6b9c72bd725d39d4785011fe190f0b4d,
        0xa73bd4903f0ce3b639bbbf6e8e80d16931ff4bcf5993d58468e8fb19086e8cac,
        0x36dbcd03009df8c59286b162af3bd7fcc0450c9aa81be5d10d312af6c66b1d60,
        0x4aebd3099c618202fcfe16ae7770b0c49ab5eadf74b754204a3bb6060e44eff3,
        0x7618b065f9832de4ca6ca971a7a1adc826d0f7c00181a5fb2ddf79ae00b4e10e
    );

    // Group orders halved: only canonical (low s) signatures are accepted, on either curve.
    uint256 private constant P256_HALF_N = 0x7fffffff800000007fffffffffffffffde737d56d38bcf4279dce5617e3192a8;
    uint256 private constant SECP256K1_HALF_N = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    bytes4 private constant MAGIC_1271 = 0x1626ba7e;

    /// @notice Whether `signature` is `id`'s signature over `hash`, checked as the signer's kind:
    ///         an address recovers, a curve point verifies, a contract is asked.
    function verify(uint8 kind, bytes32 hash, bytes32 id, uint8 flags, uint256 x, uint256 y, bytes calldata signature)
        external
        view
        returns (bool)
    {
        if (kind == KIND_ECDSA) return _ecdsa(hash, id, signature);
        if (kind == KIND_P256) {
            if (signature.length != 64) return false;
            return _p256(hash, bytes32(signature[0:32]), bytes32(signature[32:64]), bytes32(x), bytes32(y));
        }
        if (kind == KIND_WEBAUTHN) {
            (bool ok, bytes32 message, bytes32 r, bytes32 s) =
                WebAuthn.unpack(hash, flags & FLAG_UV_REQUIRED != 0, signature);
            return ok && _p256(message, r, s, bytes32(x), bytes32(y));
        }
        if (kind == KIND_CONTRACT) {
            (bool ok, bytes memory answer) = address(uint160(uint256(id))).staticcall(
                abi.encodeWithSelector(IERC1271.isValidSignature.selector, hash, signature)
            );
            return ok && answer.length == 32 && abi.decode(answer, (bytes4)) == MAGIC_1271;
        }
        return false;
    }

    function transactionHash(
        bytes32 domain,
        uint256 nonce,
        uint64 epoch,
        Call[] calldata calls,
        uint48 validAfter,
        uint48 validUntil
    ) external pure returns (bytes32) {
        return OlienHash.transaction(domain, nonce, epoch, calls, validAfter, validUntil);
    }

    /// @notice The hash of the user operation inside an account's `validateUserOp` calldata,
    ///         passed whole so the account copies bytes rather than re-encoding a struct.
    function userOperationHash(
        bytes32 domain,
        bytes calldata validateCalldata,
        uint48 validAfter,
        uint48 validUntil,
        uint64 epoch,
        address entryPoint
    ) external view returns (bytes32) {
        return this.hashOperation(domain, abi.decode(validateCalldata[4:], (PackedUserOperation)), validAfter, validUntil, epoch, entryPoint);
    }

    /// @dev Only so the library's calldata-typed hash can be reached from memory; external for
    ///      that reason alone.
    function hashOperation(
        bytes32 domain,
        PackedUserOperation calldata op,
        uint48 validAfter,
        uint48 validUntil,
        uint64 epoch,
        address entryPoint
    ) external pure returns (bytes32) {
        return OlienHash.userOperation(domain, op, validAfter, validUntil, epoch, entryPoint);
    }

    function _ecdsa(bytes32 hash, bytes32 id, bytes calldata signature) private pure returns (bool) {
        if (signature.length != 65) return false;
        bytes32 r = bytes32(signature[0:32]);
        bytes32 sv = bytes32(signature[32:64]);
        uint8 v = uint8(signature[64]);
        if (uint256(sv) > SECP256K1_HALF_N) return false;
        if (v < 27) v += 27;
        if (v > 30) {
            // eth_sign: the wallet prefixed the hash before signing.
            v -= 4;
            hash = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", hash));
        }
        if (v != 27 && v != 28) return false;
        address recovered = ecrecover(hash, v, r, sv);
        return recovered != address(0) && recovered == address(uint160(uint256(id)));
    }

    function _p256(bytes32 hash, bytes32 r, bytes32 s, bytes32 x, bytes32 y) private view returns (bool) {
        if (uint256(s) == 0 || uint256(s) > P256_HALF_N) return false;
        (bool ok, bytes memory answer) = PRECOMPILE.staticcall(abi.encode(hash, r, s, x, y));
        if (ok && answer.length == 32) return abi.decode(answer, (uint256)) == 1;
        (ok, answer) = PRECOMPILE.staticcall(PROBE);
        if (ok && answer.length == 32) return false;
        return P256.verifySolidity(hash, r, s, x, y);
    }
}
