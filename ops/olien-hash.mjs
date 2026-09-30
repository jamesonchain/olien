#!/usr/bin/env node
// The hash a member can recompute without the console.
//
//   node ops/olien-hash.mjs --self-test
//   node ops/olien-hash.mjs --calls proposal.json --rpc https://testnet-rpc.monad.xyz
//   node ops/olien-hash.mjs --calls calls.json --account 0x... --chain-id 10143 --nonce-key 0 --sequence 3 --epoch 1
//
// Everything a signer approves is one EIP-712 hash in the account's own domain, and the
// console refuses to sign when the hash it computes differs from the service's. That
// check runs inside the same browser tab that could be lying, which is the Bybit lesson:
// the page was the thing that had been changed. This script is the same arithmetic on a
// machine the page never touched. It has no dependencies, not even for keccak, so there
// is nothing to install and nothing to trust but this file and Node.
//
// It takes either a plain list of calls, or the proposal JSON the service serves at
// /api/treasury/accounts/<account>/proposals/<hash>, whose typedData is exactly what a
// wallet is asked to sign. With --rpc it also asks the account itself, through
// getTransactionHash, and compares. Exit code 0 means every answer agrees; 1 means one
// did not; 2 means the inputs were incomplete.
//
// Hashing follows contracts/src/OlienHash.sol line for line, and --self-test pins it to
// the vectors the service's tests pin, which were read off a live account.

import { readFileSync } from "node:fs";

// ----------------------------------------------------------------- keccak-256

const MASK = (1n << 64n) - 1n;
const ROUND = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
// Rotation offsets by column x and row y, as the specification tabulates them.
const ROTATE = [
  [0, 36, 3, 41, 18],
  [1, 44, 10, 45, 2],
  [62, 6, 43, 15, 61],
  [28, 55, 25, 21, 56],
  [27, 20, 39, 8, 14],
];

function rotate(lane, n) {
  return n === 0 ? lane : ((lane << BigInt(n)) | (lane >> BigInt(64 - n))) & MASK;
}

function permute(a) {
  for (let round = 0; round < 24; round++) {
    const c = [0n, 0n, 0n, 0n, 0n];
    for (let x = 0; x < 5; x++) c[x] = a[x] ^ a[x + 5] ^ a[x + 10] ^ a[x + 15] ^ a[x + 20];
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5] ^ rotate(c[(x + 1) % 5], 1);
      for (let y = 0; y < 25; y += 5) a[x + y] ^= d;
    }
    const b = new Array(25).fill(0n);
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) b[y + 5 * ((2 * x + 3 * y) % 5)] = rotate(a[x + 5 * y], ROTATE[x][y]);
    }
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) a[x + 5 * y] = b[x + 5 * y] ^ (~b[((x + 1) % 5) + 5 * y] & MASK & b[((x + 2) % 5) + 5 * y]);
    }
    a[0] ^= ROUND[round];
  }
}

// Keccak-256 as Ethereum uses it: rate 136, the original 0x01 padding rather than
// SHA-3's 0x06, little-endian lanes.
export function keccak256(bytes) {
  const rate = 136;
  const padded = new Uint8Array(Math.ceil((bytes.length + 1) / rate) * rate);
  padded.set(bytes);
  padded[bytes.length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;
  const state = new Array(25).fill(0n);
  for (let offset = 0; offset < padded.length; offset += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let lane = 0n;
      for (let j = 7; j >= 0; j--) lane = (lane << 8n) | BigInt(padded[offset + i * 8 + j]);
      state[i] ^= lane;
    }
    permute(state);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++) {
    let lane = state[i];
    for (let j = 0; j < 8; j++) {
      out[i * 8 + j] = Number(lane & 0xffn);
      lane >>= 8n;
    }
  }
  return out;
}

// ----------------------------------------------------------------- bytes and words

function hexToBytes(hex) {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0 || /[^0-9a-fA-F]/.test(clean)) throw new Error(`Not hex: ${hex}`);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(bytes) {
  let text = "0x";
  for (const byte of bytes) text += byte.toString(16).padStart(2, "0");
  return text;
}

function concat(...parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function word(value) {
  const n = BigInt(value);
  if (n < 0n || n >= 1n << 256n) throw new Error(`Does not fit a word: ${value}`);
  return hexToBytes(n.toString(16).padStart(64, "0"));
}

function addressWord(address) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error(`Not an address: ${address}`);
  return word(BigInt(address));
}

function padRight(bytes) {
  const out = new Uint8Array(Math.ceil(bytes.length / 32) * 32);
  out.set(bytes);
  return out;
}

const utf8 = (text) => new TextEncoder().encode(text);

// ----------------------------------------------------------------- OlienHash.sol

const DOMAIN_TYPEHASH = keccak256(utf8("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"));
const NAME_HASH = keccak256(utf8("Olien"));
const VERSION_HASH = keccak256(utf8("1"));
const CALL_TYPEHASH = keccak256(utf8("Call(address to,uint256 value,bytes data)"));
const TRANSACTION_TYPEHASH = keccak256(
  utf8("Transaction(uint256 nonce,uint64 epoch,Call[] calls,uint48 validAfter,uint48 validUntil)Call(address to,uint256 value,bytes data)"),
);

export function domainSeparator(chainId, account) {
  return keccak256(concat(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, word(chainId), addressWord(account)));
}

export function callHash(call) {
  return keccak256(concat(CALL_TYPEHASH, addressWord(call.to), word(call.value), keccak256(call.data)));
}

export function callsHash(calls) {
  return keccak256(concat(...calls.map(callHash)));
}

export function transactionHash(chainId, account, nonce, epoch, calls, validAfter, validUntil) {
  const structHash = keccak256(concat(TRANSACTION_TYPEHASH, word(nonce), word(epoch), callsHash(calls), word(validAfter), word(validUntil)));
  return { structHash, hash: keccak256(concat(hexToBytes("0x1901"), domainSeparator(chainId, account), structHash)) };
}

// ----------------------------------------------------------------- the account's own view

function selector(signature) {
  return keccak256(utf8(signature)).slice(0, 4);
}

// getTransactionHash((uint192,(address,uint256,bytes)[],uint48,uint48)), encoded by
// hand: the tuple is dynamic because of the calls, each call is dynamic because of its
// data, so every level is an offset table followed by its bodies.
export function encodeGetTransactionHash(nonceKey, calls, validAfter, validUntil) {
  const bodies = calls.map((call) => concat(addressWord(call.to), word(call.value), word(0x60), word(call.data.length), padRight(call.data)));
  const offsets = [];
  let running = 32 * calls.length;
  for (const body of bodies) {
    offsets.push(word(running));
    running += body.length;
  }
  const array = concat(word(calls.length), ...offsets, ...bodies);
  const tuple = concat(word(nonceKey), word(0x80), word(validAfter), word(validUntil), array);
  return concat(selector("getTransactionHash((uint192,(address,uint256,bytes)[],uint48,uint48))"), word(0x20), tuple);
}

async function rpc(url, method, params) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!response.ok) throw new Error(`${method}: HTTP ${response.status}`);
  const body = await response.json();
  if (body.error) throw new Error(`${method}: ${body.error.message ?? JSON.stringify(body.error)}`);
  return body.result;
}

async function call(url, to, data) {
  const result = await rpc(url, "eth_call", [{ to, data: bytesToHex(data) }, "latest"]);
  if (typeof result !== "string" || result.length < 66) throw new Error(`eth_call to ${to} returned nothing; is this an Olien account on this chain?`);
  return hexToBytes(result);
}

const wordAt = (bytes, index) => BigInt(bytesToHex(bytes.slice(index * 32, index * 32 + 32)));

// ----------------------------------------------------------------- inputs

function usage(message) {
  console.error(message);
  console.error("");
  console.error("  node ops/olien-hash.mjs --self-test");
  console.error("  node ops/olien-hash.mjs --calls <proposal.json | calls.json> [--rpc URL] [--expect 0x...]");
  console.error("      [--account 0x...] [--chain-id N] [--nonce-key N] [--sequence N | --nonce N] [--epoch N]");
  console.error("      [--valid-after N] [--valid-until N]");
  console.error("");
  console.error("Flags override what the file says. Without --rpc, the chain id, the nonce and the epoch");
  console.error("must come from the file or from flags.");
  process.exit(2);
}

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) usage(`Unexpected argument: ${arg}`);
    const name = arg.slice(2);
    if (name === "self-test") {
      flags.selfTest = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) usage(`--${name} needs a value.`);
    flags[name] = value;
    i += 1;
  }
  return flags;
}

function normaliseCall(raw, index) {
  if (!raw || typeof raw.to !== "string") throw new Error(`Call ${index + 1} has no "to".`);
  const value = raw.value === undefined || raw.value === null || raw.value === "" ? 0n : BigInt(raw.value);
  const data = hexToBytes(raw.data === undefined || raw.data === null || raw.data === "" ? "0x" : raw.data);
  return { to: raw.to, value, data };
}

// A bare list of calls, a proposal from the service, or the typed data inside one: all
// three name the same transaction, and the typed data is what a wallet is shown.
function readInput(path) {
  const json = JSON.parse(readFileSync(path, "utf8"));
  const found = {};
  let calls;
  if (Array.isArray(json)) {
    calls = json;
  } else {
    const typed = json.typedData ?? (json.domain && json.message ? json : null);
    if (typed) {
      calls = typed.message.calls;
      found.account = typed.domain.verifyingContract;
      found.chainId = BigInt(typed.domain.chainId);
      found.nonce = BigInt(typed.message.nonce);
      found.epoch = BigInt(typed.message.epoch);
      found.validAfter = BigInt(typed.message.validAfter);
      found.validUntil = BigInt(typed.message.validUntil);
    } else if (Array.isArray(json.calls)) {
      calls = json.calls;
    } else {
      throw new Error("The file is neither a list of calls, a proposal, nor typed data.");
    }
    if (typeof json.account === "string") found.account = json.account;
    if (json.nonce !== undefined && found.nonce === undefined) found.nonce = BigInt(json.nonce);
    if (json.epoch !== undefined && found.epoch === undefined) found.epoch = BigInt(json.epoch);
    if (json.validAfter !== undefined && found.validAfter === undefined) found.validAfter = BigInt(json.validAfter);
    if (json.validUntil !== undefined && found.validUntil === undefined) found.validUntil = BigInt(json.validUntil);
    if (typeof json.txHash === "string") found.expect = json.txHash;
  }
  return { calls: calls.map(normaliseCall), found };
}

// ----------------------------------------------------------------- self test

// The first two are Keccak's own; the rest are pinned in service/src/olien.rs against
// `cast call` on the Arc testnet proof account, so a wrong permutation, a wrong
// padding, a wrong typehash or a wrong field order each fail here before they can
// mislead anyone.
function selfTest() {
  const account = "0x12808a601475b87ce7b343A18f11062cc74Eae81";
  const calls = [{ to: account, value: 1n, data: hexToBytes("0x0102") }];
  const checks = [
    ["keccak256 of nothing", bytesToHex(keccak256(new Uint8Array())), "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"],
    ["keccak256 of abc", bytesToHex(keccak256(utf8("abc"))), "0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45"],
    ["domain on Arc testnet", bytesToHex(domainSeparator(5042002n, account)), "0x65e190017ae0f50cfa1e3f47d7252c6d2360ac12f03202583dfb0e9daefa1ddd"],
    [
      "transaction hash, lane 7 at 0, epoch 1, window 1 to 2",
      bytesToHex(transactionHash(5042002n, account, 7n << 64n, 1n, calls, 1n, 2n).hash),
      "0x62a39124dcbdb23686e7f79b68aee371ef5b372da9fceedc57382b0657bc4609",
    ],
    [
      "calldata for the account's own view",
      bytesToHex(encodeGetTransactionHash(7n, calls, 1n, 2n)),
      "0xcb8eb3ec000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000070000000000000000000000000000000000000000000000000000000000000080000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000002000000000000000000000000012808a601475b87ce7b343a18f11062cc74eae810000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000020102000000000000000000000000000000000000000000000000000000000000",
    ],
  ];
  let failed = 0;
  for (const [name, got, want] of checks) {
    const ok = got.toLowerCase() === want.toLowerCase();
    if (!ok) failed += 1;
    console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
    if (!ok) console.log(`     got  ${got}\n     want ${want}`);
  }
  console.log(failed === 0 ? "\nAll vectors agree." : `\n${failed} vector(s) disagree. Do not trust this copy of the script.`);
  process.exit(failed === 0 ? 0 : 1);
}

// ----------------------------------------------------------------- main

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.selfTest) selfTest();
  if (!flags.calls) usage("--calls is required: a proposal from the service, its typed data, or a list of calls.");

  const { calls, found } = readInput(flags.calls);
  const account = flags.account ?? found.account;
  if (!account) usage("Which account? Pass --account, or a file that names one.");
  const expect = flags.expect ?? found.expect;
  const validAfter = flags["valid-after"] !== undefined ? BigInt(flags["valid-after"]) : (found.validAfter ?? 0n);
  const validUntil = flags["valid-until"] !== undefined ? BigInt(flags["valid-until"]) : (found.validUntil ?? 0n);

  let chainId = flags["chain-id"] !== undefined ? BigInt(flags["chain-id"]) : found.chainId;
  let epoch = flags.epoch !== undefined ? BigInt(flags.epoch) : found.epoch;
  let nonce;
  if (flags.nonce !== undefined) nonce = BigInt(flags.nonce);
  else if (flags.sequence !== undefined) nonce = (BigInt(flags["nonce-key"] ?? 0) << 64n) | BigInt(flags.sequence);
  else nonce = found.nonce;
  let nonceKey = flags["nonce-key"] !== undefined ? BigInt(flags["nonce-key"]) : nonce !== undefined ? nonce >> 64n : 0n;

  const chain = {};
  if (flags.rpc) {
    const url = flags.rpc;
    chain.chainId = BigInt(await rpc(url, "eth_chainId", []));
    if (chainId !== undefined && chainId !== chain.chainId) {
      console.error(`The RPC serves chain ${chain.chainId}; the input says ${chainId}. A hash is only valid on one chain.`);
      process.exit(1);
    }
    chainId = chain.chainId;
    chain.nonce = wordAt(await call(url, account, concat(selector("getNonce(uint192)"), word(nonceKey))), 0);
    chain.epoch = wordAt(await call(url, account, selector("getConfig()")), 11);
    chain.domain = await call(url, account, selector("domainSeparator()"));
    if (nonce === undefined) nonce = chain.nonce;
    if (epoch === undefined) epoch = chain.epoch;
  }
  const missing = [];
  if (chainId === undefined) missing.push("--chain-id");
  if (nonce === undefined) missing.push("--sequence or --nonce");
  if (epoch === undefined) missing.push("--epoch");
  if (missing.length) usage(`Without --rpc these must be given: ${missing.join(", ")}.`);

  const domain = domainSeparator(chainId, account);
  const { structHash, hash } = transactionHash(chainId, account, nonce, epoch, calls, validAfter, validUntil);
  const sequence = nonce & ((1n << 64n) - 1n);
  const from = (flag, key) => (flags[flag] !== undefined ? "flag" : found[key] !== undefined ? "file" : "chain");
  let failed = false;
  const verdict = (ok, text) => {
    if (!ok) failed = true;
    return ok ? text : `DIFFERS: ${text}`;
  };

  console.log("Olien transaction hash, recomputed from the calls\n");
  console.log(`account      ${account}`);
  console.log(`chain        ${chainId} (${from("chain-id", "chainId")})`);
  console.log(`lane         ${nonceKey}, sequence ${sequence}, nonce ${nonce} (${flags.sequence !== undefined || flags.nonce !== undefined ? "flag" : found.nonce !== undefined ? "file" : "chain"})`);
  console.log(`epoch        ${epoch} (${from("epoch", "epoch")})`);
  console.log(`window       validAfter ${validAfter}, validUntil ${validUntil}${validUntil === 0n ? " (no expiry)" : ""}`);
  console.log(`calls        ${calls.length}`);
  calls.forEach((entry, index) => {
    const data = bytesToHex(entry.data);
    console.log(`  ${String(index + 1).padStart(2)}  to ${entry.to}  value ${entry.value}  data ${data.length > 74 ? `${data.slice(0, 74)}... (${entry.data.length} bytes)` : data}`);
    console.log(`      hash ${bytesToHex(callHash(entry))}`);
  });
  console.log("");
  console.log(`domain       ${bytesToHex(domain)}${chain.domain ? "   " + verdict(bytesToHex(chain.domain) === bytesToHex(domain), "the account's domainSeparator()") : ""}`);
  console.log(`calls hash   ${bytesToHex(callsHash(calls))}`);
  console.log(`struct hash  ${bytesToHex(structHash)}`);
  console.log(`hash         ${bytesToHex(hash)}`);

  if (flags.rpc) {
    if (chain.epoch !== epoch) {
      failed = true;
      console.log(`epoch        DIFFERS: the account is at epoch ${chain.epoch}; this hash was made at ${epoch}, so its signatures no longer verify.`);
    }
    if (chain.nonce !== nonce) {
      console.log(`chain        skipped: lane ${nonceKey} is at sequence ${chain.nonce & ((1n << 64n) - 1n)} on chain and this is sequence ${sequence}, so getTransactionHash would hash a different slot.`);
    } else {
      const onChain = await call(flags.rpc, account, encodeGetTransactionHash(nonceKey, calls, validAfter, validUntil));
      console.log(`chain        ${bytesToHex(onChain)}   ${verdict(bytesToHex(onChain) === bytesToHex(hash), "the account's own getTransactionHash")}`);
    }
  }
  if (expect) {
    console.log(`expected     ${expect}   ${verdict(expect.toLowerCase() === bytesToHex(hash), "what the console or the service shows")}`);
  }
  console.log("");
  console.log(failed ? "Something disagrees. Do not sign until you know why." : "Everything agrees.");
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
});
