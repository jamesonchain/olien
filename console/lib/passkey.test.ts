import assert from "node:assert/strict";
import { test } from "node:test";
import { bytesToHex, encodeAbiParameters, type Hex } from "viem";
import { verifyPasskeySignature } from "./passkey.ts";

// An assertion made the way an authenticator makes one, checked the way the console
// checks an address book entry signed by a passkey member.

const base64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

async function assertion(hash: Hex, flags = 0x05) {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const coordinate = (value: string) => `0x${Buffer.from(value, "base64url").toString("hex").padStart(64, "0")}`;
  const authData = new Uint8Array(37);
  authData[32] = flags;
  const fields = `"origin":"https://olien.org","crossOrigin":false`;
  const clientData = new TextEncoder().encode(`{"type":"webauthn.get","challenge":"${base64url(Buffer.from(hash.slice(2), "hex"))}",${fields}}`);
  const clientHash = new Uint8Array(await crypto.subtle.digest("SHA-256", clientData));
  const signed = new Uint8Array([...authData, ...clientHash]);
  const rs = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, signed));
  const signature = encodeAbiParameters(
    [{ type: "bytes" }, { type: "string" }, { type: "uint256" }, { type: "uint256" }],
    [bytesToHex(authData), fields, BigInt(bytesToHex(rs.slice(0, 32))), BigInt(bytesToHex(rs.slice(32)))],
  );
  return { signature, x: coordinate(jwk.x as string), y: coordinate(jwk.y as string) };
}

const HASH = `0x${"ab".repeat(32)}` as Hex;

test("a passkey's signature over a hash is accepted for its own key", async () => {
  const { signature, x, y } = await assertion(HASH);
  assert.equal(await verifyPasskeySignature(HASH, signature, x, y), true);
  assert.equal(await verifyPasskeySignature(HASH, signature, BigInt(x).toString(), BigInt(y).toString()), true, "coordinates as the service sends them, in decimal");
});

test("and for nothing else", async () => {
  const { signature, x, y } = await assertion(HASH);
  const other = await assertion(HASH);
  assert.equal(await verifyPasskeySignature(`0x${"cd".repeat(32)}`, signature, x, y), false, "another hash");
  assert.equal(await verifyPasskeySignature(HASH, signature, other.x, other.y), false, "another key");
  assert.equal(await verifyPasskeySignature(HASH, "0x1234", x, y), false, "something that is not an assertion");
  const absent = await assertion(HASH, 0x04);
  assert.equal(await verifyPasskeySignature(HASH, absent.signature, absent.x, absent.y), false, "an assertion with nobody present");
});
