// Passkeys as Olien signers. A passkey is a P-256 key the authenticator holds; the
// account stores its coordinates and checks WebAuthn assertions on chain, so a laptop's
// Touch ID can approve a payment the same way a hardware wallet does. Nothing here talks
// to the service: it produces the signer input to add and the envelope to confirm with.

import { bytesToHex, encodeAbiParameters, hexToBytes, keccak256, type Hex } from "viem";

export interface PasskeyRecord {
  signerId: Hex;
  x: Hex;
  y: Hex;
  // Backup-eligible at enrolment: the authenticator copies this key to every device on
  // the same Apple or Google account, so it is not a device. Null when the browser
  // could not say.
  synced: boolean | null;
  credentialId: string;
  label: string;
  createdAt: number;
}

export interface PasskeyCandidate {
  signerId: string;
  x: string | null;
  y: string | null;
}

const STORE = "olien.passkeys.v1";
const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

export function passkeySupported(): boolean {
  return typeof window !== "undefined" && "PublicKeyCredential" in window && typeof navigator.credentials?.create === "function";
}

// Credential ids this browser created, so an assertion can name them; a passkey synced
// to another device still answers as a discoverable credential without this list.
export function knownPasskeys(): PasskeyRecord[] {
  try {
    const raw = window.localStorage.getItem(STORE);
    return raw ? (JSON.parse(raw) as PasskeyRecord[]) : [];
  } catch {
    return [];
  }
}

function remember(record: PasskeyRecord) {
  try {
    const rest = knownPasskeys().filter((known) => known.signerId !== record.signerId);
    window.localStorage.setItem(STORE, JSON.stringify([...rest, record]));
  } catch {
    // Storage refused: signing still works through the discoverable credential.
  }
}

export function signerIdOfKey(x: bigint, y: bigint): Hex {
  return keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [x, y]));
}

// The service stores coordinates as decimal strings and the console as hex; BigInt reads both.
function coordinate(value: string | null | undefined): bigint {
  if (!value) throw new Error("This passkey signer has no public key on record.");
  return BigInt(value);
}

function hex32(value: bigint): Hex {
  return `0x${value.toString(16).padStart(64, "0")}` as Hex;
}

function base64url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let text = "";
  for (const byte of view) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(text: string): ArrayBuffer {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4 ? "=".repeat(4 - (padded.length % 4)) : "";
  return plain(Uint8Array.from(atob(padded + pad), (char) => char.charCodeAt(0)));
}

// The relying party a passkey is bound to. WebAuthn defaults it to whatever origin
// served the page, which means a member who enrolled on a preview URL, or on the old
// vercel.app host, cannot sign once the console moves to its own domain: a passkey does
// not travel between domains and there is no migration. Pinning it to the domain that
// will still be there makes the binding a deployment setting rather than an accident of
// which URL someone happened to open. Unset locally, where inheriting the origin is right.
const RP_ID = process.env.NEXT_PUBLIC_PASSKEY_RP_ID?.trim() || undefined;

// WebAuthn takes BufferSource over a plain ArrayBuffer; viem's byte arrays may sit on a shared one.
function plain(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

// Byte 32 of the authenticator data holds the flags; bit 3 is BE, backup eligible. The
// WebAuthn spec puts the security boundary at the cloud account rather than the device,
// and enrolment is the one moment the authenticator says which side of that line the
// key is on.
function backupEligible(response: AuthenticatorAttestationResponse): boolean | null {
  if (typeof response.getAuthenticatorData !== "function") return null;
  const data = new Uint8Array(response.getAuthenticatorData());
  return data.length > 32 ? (data[32] & 0x08) !== 0 : null;
}

export async function createPasskey(label: string, userHandle: string): Promise<PasskeyRecord> {
  if (!passkeySupported()) throw new Error("This browser cannot create a passkey.");
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const credential = (await navigator.credentials.create({
    publicKey: {
      challenge,
      rp: RP_ID ? { name: "Olien", id: RP_ID } : { name: "Olien" },
      user: { id: new TextEncoder().encode(userHandle).slice(0, 64), name: userHandle, displayName: label },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
      attestation: "none",
      timeout: 60_000,
    },
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error("No passkey was created.");
  const response = credential.response as AuthenticatorAttestationResponse;
  if (response.getPublicKeyAlgorithm() !== -7) throw new Error("The authenticator did not make a P-256 key.");
  const spki = response.getPublicKey();
  if (!spki) throw new Error("The browser did not return the passkey's public key.");
  // SubjectPublicKeyInfo for P-256 ends with the uncompressed point: 0x04, x, y.
  const der = new Uint8Array(spki);
  const point = der.slice(der.length - 65);
  if (point[0] !== 4) throw new Error("Unexpected public key encoding.");
  const x = bytesToHex(point.slice(1, 33));
  const y = bytesToHex(point.slice(33, 65));
  const record: PasskeyRecord = {
    signerId: signerIdOfKey(BigInt(x), BigInt(y)),
    x,
    y,
    synced: backupEligible(response),
    credentialId: base64url(credential.rawId),
    label,
    createdAt: Date.now(),
  };
  remember(record);
  return record;
}

// Signs a transaction hash with a passkey and packs the assertion the way the account's
// verifier reads it: (authenticatorData, clientDataJSON after the challenge, r, s).
export async function signWithPasskey(hash: Hex, candidates: PasskeyCandidate[]): Promise<{ signerId: string; signature: Hex }> {
  if (!passkeySupported()) throw new Error("This browser cannot use a passkey.");
  const wanted = new Set(candidates.map((candidate) => candidate.signerId.toLowerCase()));
  const known = knownPasskeys().filter((record) => wanted.has(record.signerId.toLowerCase()));
  const challenge = hexToBytes(hash);
  const assertion = (await navigator.credentials.get({
    publicKey: {
      challenge: plain(challenge),
      // Must name the same relying party the key was made under, or the authenticator
      // does not recognise it as one of its own.
      ...(RP_ID ? { rpId: RP_ID } : {}),
      userVerification: "required",
      timeout: 60_000,
      allowCredentials: known.map((record) => ({ type: "public-key" as const, id: fromBase64url(record.credentialId) })),
    },
  })) as PublicKeyCredential | null;
  if (!assertion) throw new Error("No passkey answered.");
  const response = assertion.response as AuthenticatorAssertionResponse;
  const authData = new Uint8Array(response.authenticatorData);
  const clientDataJSON = new TextDecoder().decode(response.clientDataJSON);
  const prefix = `{"type":"webauthn.get","challenge":"${base64url(challenge)}",`;
  if (!clientDataJSON.startsWith(prefix)) throw new Error("The browser's client data does not carry the expected challenge.");
  // The verifier rebuilds the JSON from the prefix, these fields and a closing brace, so
  // the brace the browser wrote stays out of what is sent.
  if (!clientDataJSON.endsWith("}")) throw new Error("The browser's client data is not a JSON object.");
  const fields = clientDataJSON.slice(prefix.length, -1);
  const [r, s] = derToScalars(new Uint8Array(response.signature));

  // The assertion names a credential, not a public key, so find the candidate whose key
  // checks out; that is the signer id the service expects.
  const clientHash = new Uint8Array(await crypto.subtle.digest("SHA-256", response.clientDataJSON));
  const signed = new Uint8Array(authData.length + clientHash.length);
  signed.set(authData);
  signed.set(clientHash, authData.length);
  const rawSignature = new Uint8Array(64);
  rawSignature.set(hexToBytes(hex32(r)), 0);
  rawSignature.set(hexToBytes(hex32(s)), 32);
  let signer: PasskeyCandidate | null = null;
  for (const candidate of candidates) {
    const raw = new Uint8Array(65);
    raw[0] = 4;
    raw.set(hexToBytes(hex32(coordinate(candidate.x))), 1);
    raw.set(hexToBytes(hex32(coordinate(candidate.y))), 33);
    const key = await crypto.subtle.importKey("raw", raw, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    if (await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, rawSignature, signed)) {
      signer = candidate;
      break;
    }
  }
  if (!signer) throw new Error("The passkey that answered is not a signer of this account.");

  // Authenticators do not normalise s; the verifier takes the low half only, and n - s is the same signature.
  const lowS = s > P256_N / 2n ? P256_N - s : s;
  const signature = encodeAbiParameters(
    [{ type: "bytes" }, { type: "string" }, { type: "uint256" }, { type: "uint256" }],
    [bytesToHex(authData), fields, r, lowS],
  );
  return { signerId: signer.signerId, signature };
}

// DER SEQUENCE { INTEGER r, INTEGER s }, each big-endian with a possible leading zero.
function derToScalars(der: Uint8Array): [bigint, bigint] {
  if (der[0] !== 0x30) throw new Error("Unexpected signature encoding.");
  let offset = 2;
  if (der[1] & 0x80) offset += der[1] & 0x7f;
  const read = (): bigint => {
    if (der[offset] !== 0x02) throw new Error("Unexpected signature encoding.");
    const length = der[offset + 1];
    const bytes = der.slice(offset + 2, offset + 2 + length);
    offset += 2 + length;
    return BigInt(bytesToHex(bytes));
  };
  const r = read();
  const s = read();
  return [r, s];
}

export function friendlyPasskeyError(cause: unknown): string {
  const name = cause instanceof Error ? cause.name : "";
  const text = cause instanceof Error ? cause.message : String(cause);
  if (name === "NotAllowedError") return "The passkey prompt was dismissed or timed out. Nothing was signed.";
  if (name === "InvalidStateError") return "This device already holds a passkey for this account.";
  if (name === "SecurityError") return "Passkeys need a secure origin: https, or localhost while developing.";
  if (name === "NotSupportedError") return "This browser cannot create a passkey here.";
  return text;
}
