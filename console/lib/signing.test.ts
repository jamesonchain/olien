import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeFunctionData, type Hex } from "viem";
import {
  addressBookHash,
  annotate,
  checkOperation,
  chequeDigest,
  decodeCall,
  decodeCalls,
  describeAction,
  kindOf,
  loginMessage,
  messageHash,
  OLIEN_ABI,
  outgoing,
  operationCalls,
  summarise,
  transactionHash,
  userOperationHash,
  type DecodeContext,
  type OperationFields,
} from "./signing.ts";

// The vectors below are the ones service/src/olien.rs and treasury_cheques.rs pin, which
// were read off live accounts with cast or printed by the contract's own library. If
// this file and the chain ever disagree, a signature made here is over something the
// account will not accept, or worse, over something else it will.

const ARC = 5042002;
const PROOF = "0x12808a601475b87ce7b343A18f11062cc74Eae81";
const USDC = "0x534b2f3A21130d7a60830c2Df862319e593943A3";
const ACCOUNT = "0x00000000000000000000000000000000000000AB";
const ctx: DecodeContext = { account: ACCOUNT, tokens: [{ address: USDC, symbol: "USDC", decimals: 6 }], native: { symbol: "MON", decimals: 18 } };

// `cast calldata "transfer(address,uint256)" 0xd6c5…983a 1000000`
const TRANSFER = "0xa9059cbb000000000000000000000000d6c574461d96ee708f58fe553049ad4f48bb983a00000000000000000000000000000000000000000000000000000000000f4240";
const PAYEE = "0xD6c574461d96Ee708f58Fe553049aD4f48BB983A";

test("v2's rules read as rules, with the old shapes still read", () => {
  const rule = (data: Hex) => {
    const action = decodeCall({ to: ACCOUNT, value: "0", data }, ctx);
    assert.equal(action.type, "rule");
    return describeAction(action, ctx);
  };
  const policy = { token: USDC as Hex, tier: 25_000_000_000n, delay: 86_400, requireKnown: true, learn: true, lockedUntil: 1_800_000_000 };
  assert.equal(
    rule(encodeFunctionData({ abi: OLIEN_ABI, functionName: "setTransferPolicy", args: [policy] })),
    "Set the transfer policy: payments over 25,000.00 USDC wait 1 day; payments to addresses this account does not know wait 1 day; an address paid after a wait becomes known; loosening is refused until 2027-01-15",
  );
  assert.equal(
    rule(encodeFunctionData({ abi: OLIEN_ABI, functionName: "setTransferPolicy", args: [{ ...policy, tier: 0n, requireKnown: false }] })),
    "Clear the transfer policy: nothing waits",
  );
  assert.equal(rule(encodeFunctionData({ abi: OLIEN_ABI, functionName: "setKnown", args: [[PAYEE], true] })), `Know the address ${PAYEE}`);
  assert.equal(rule(encodeFunctionData({ abi: OLIEN_ABI, functionName: "setKnown", args: [[PAYEE, USDC], false] })), `Forget 2 addresses ${PAYEE}, ${USDC}`);
  assert.equal(
    rule(encodeFunctionData({ abi: OLIEN_ABI, functionName: "setDelays", args: [86_400, 86_400, 0, 90 * 86_400] })),
    "Set delays: rule changes 1 day, recovery 1 day, co-signed recovery no delay, one member may recover a key after 90 days of silence",
  );
  assert.equal(
    rule(encodeFunctionData({ abi: OLIEN_ABI, functionName: "setDelays", args: [86_400, 86_400, 0] })),
    "Set delays: rule changes 1 day, recovery 1 day, co-signed recovery no delay",
  );
  const hash = `0x${"ab".repeat(32)}` as Hex;
  assert.match(rule(encodeFunctionData({ abi: OLIEN_ABI, functionName: "setImplementation", args: [PAYEE, hash] })), /whose code hashes to 0xababab/);
  assert.doesNotMatch(rule(encodeFunctionData({ abi: OLIEN_ABI, functionName: "setImplementation", args: [PAYEE] })), /hashes to/);
  // Panic is a single-signer act, never part of a transaction.
  assert.equal(decodeCall({ to: ACCOUNT, value: "0", data: encodeFunctionData({ abi: OLIEN_ABI, functionName: "panic" }) }, ctx).type, "unreadable");
});

test("a transaction hashes as the account hashes it", () => {
  const fields = { nonce: 7n << 64n, epoch: 1, calls: [{ to: PROOF, value: 1, data: "0x0102" }], validAfter: 1, validUntil: 2 };
  assert.equal(transactionHash(ARC, PROOF, fields), "0x62a39124dcbdb23686e7f79b68aee371ef5b372da9fceedc57382b0657bc4609");
});

test("the same proposal under another account or chain is a different hash", () => {
  const fields = { nonce: 7n << 64n, epoch: 1, calls: [{ to: PROOF, value: 1, data: "0x0102" }], validAfter: 1, validUntil: 2 };
  const here = transactionHash(ARC, PROOF, fields);
  assert.notEqual(transactionHash(ARC, ACCOUNT, fields), here);
  assert.notEqual(transactionHash(10143, PROOF, fields), here);
});

test("a token transfer is read from its calldata", () => {
  const action = decodeCall({ to: USDC, value: "0", data: TRANSFER }, ctx);
  assert.deepEqual(action, { type: "transfer", token: ctx.tokens[0], to: PAYEE, amount: 1_000_000n });
  assert.equal(describeAction(action, ctx), `Send 1.00 USDC to ${PAYEE}`);
});

test("calldata that only resembles a transfer is not shown as one", () => {
  assert.equal(decodeCall({ to: USDC, value: "0", data: `${TRANSFER}00` }, ctx).type, "unreadable", "a trailing byte");
  assert.equal(decodeCall({ to: USDC, value: "1", data: TRANSFER }, ctx).type, "unreadable", "money riding along");
  const dirty = TRANSFER.replace("a9059cbb000000000000000000000000", "a9059cbb000000000000000000000001");
  assert.equal(decodeCall({ to: USDC, value: "0", data: dirty }, ctx).type, "unreadable", "dirty padding above the address");
  assert.equal(decodeCall({ to: "0x00000000000000000000000000000000000000cd", value: "0", data: TRANSFER }, ctx).type, "unreadable", "a token this console does not know");
});

test("an approval is named as the standing permission it is", () => {
  const data = encodeFunctionData({ abi: [{ type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] }], functionName: "approve", args: [PAYEE, (1n << 256n) - 1n] });
  const action = decodeCall({ to: USDC, value: "0", data }, ctx);
  assert.equal(action.type, "allowance");
  assert.match(describeAction(action, ctx), /take any amount of USDC from this account, at any time/);
});

test("a plain send of the gas token is a payment, and an empty call is not", () => {
  assert.deepEqual(decodeCall({ to: PAYEE, value: "1500000000000000000", data: "0x" }, ctx), { type: "native", to: PAYEE, amount: 1_500_000_000_000_000_000n });
  assert.equal(decodeCall({ to: PAYEE, value: "0", data: "0x" }, ctx).type, "unreadable");
});

const self = (functionName: string, args: unknown[]) => ({ to: ACCOUNT, value: "0", data: encodeFunctionData({ abi: OLIEN_ABI, functionName, args } as Parameters<typeof encodeFunctionData>[0]) });

test("the account's own rule changes are read in words", () => {
  const key = `0x${"11".repeat(32)}${"22".repeat(32)}` as Hex;
  const added = decodeCall(self("addSigner", [{ kind: 1, permissions: 3, flags: 0, key: PAYEE }]), ctx);
  assert.equal(describeAction(added, ctx), `Add ${PAYEE} as a signer with approve + veto`);
  assert.match(describeAction(decodeCall(self("addSigner", [{ kind: 3, permissions: 1, flags: 1, key }]), ctx), ctx), /^Add a passkey \(0x[0-9a-f]{6}…[0-9a-f]{4}\) as a signer with approve$/);
  assert.equal(describeAction(decodeCall(self("removeSigner", [`0x${"0".repeat(24)}${PAYEE.slice(2)}`]), ctx), ctx), `Remove signer ${PAYEE}`);
  assert.equal(describeAction(decodeCall(self("setThreshold", [2]), ctx), ctx), "Set the approval threshold to 2");
  assert.equal(describeAction(decodeCall(self("setVetoThreshold", [0]), ctx), ctx), "Set the veto threshold to automatic");
  assert.equal(
    describeAction(decodeCall(self("setSpendingLimit", [0n, { token: USDC, subAccount: 0n, amount: 500_000_000n, period: 86_400, anyDestination: false }]), ctx), ctx),
    "Create a spending limit: 500.00 USDC per 1 day, to listed destinations only",
  );
});

test("the changes that can take the account away are marked as dangerous", () => {
  const upgrade = decodeCall(self("setImplementation", [PAYEE]), ctx);
  assert.deepEqual(upgrade.type === "rule" && [upgrade.danger, upgrade.text], [true, `Replace the code that runs this account with the contract at ${PAYEE}`]);
  const noDelay = decodeCall(self("setDelays", [0, 86_400, 3_600]), ctx);
  assert.equal(noDelay.type === "rule" && noDelay.danger, true, "a config delay of zero switches the veto off");
  const delay = decodeCall(self("setDelays", [86_400, 86_400, 3_600]), ctx);
  assert.equal(delay.type === "rule" && delay.danger, false);
});

test("a call to the account that a transaction may not make is unreadable", () => {
  assert.equal(decodeCall(self("veto", [`0x${"ab".repeat(32)}`]), ctx).type, "unreadable");
  assert.equal(decodeCall({ to: ACCOUNT, value: "0", data: "0xdeadbeef" }, ctx).type, "unreadable");
  assert.equal(decodeCall({ ...self("setThreshold", [2]), value: "1" }, ctx).type, "unreadable");
});

test("a proposal is named for what it does", () => {
  const pay = decodeCalls([{ to: USDC, value: "0", data: TRANSFER }], ctx);
  assert.equal(kindOf(pay), "Payment");
  assert.equal(summarise(pay, ctx), "Send 1.00 USDC to 0xD6c574…983A");
  const batch = decodeCalls([{ to: USDC, value: "0", data: TRANSFER }, { to: USDC, value: "0", data: TRANSFER }], ctx);
  assert.equal(kindOf(batch), "Batch payment");
  assert.equal(summarise(batch, ctx), "Send 2.00 USDC to 2 recipients");
  assert.equal(kindOf(decodeCalls([self("setThreshold", [2])], ctx)), "Rule change");
  assert.equal(kindOf(decodeCalls([{ to: USDC, value: "0", data: TRANSFER }, { to: PAYEE, value: "0", data: "0x12345678" }], ctx)), "Contract call");
});

test("what leaves the account is summed per token", () => {
  const actions = decodeCalls(
    [{ to: USDC, value: "0", data: TRANSFER }, { to: USDC, value: "0", data: TRANSFER }, { to: PAYEE, value: "5", data: "0x" }, self("setThreshold", [2])],
    ctx,
  );
  assert.deepEqual(outgoing(actions), [{ token: ctx.tokens[0], amount: 2_000_000n }, { token: null, amount: 5n }]);
  assert.deepEqual(outgoing(decodeCalls([self("setThreshold", [2])], ctx)), []);
});

test("a description is attached only when it agrees with the calldata", () => {
  const actions = decodeCalls([{ to: USDC, value: "0", data: TRANSFER }], ctx);
  const honest = annotate(actions, { recipients: [{ to: PAYEE.toLowerCase(), amount: "1000000", label: "Acme Ltd", memo: "Invoice 1042" }], payroll: { name: "September" } });
  assert.deepEqual(honest, { notes: [{ label: "Acme Ltd", memo: "Invoice 1042" }], contradiction: null, payrollName: "September" });
  assert.deepEqual(annotate(actions, null).notes, [null]);
  assert.equal(annotate(actions, { labels: [] }).contradiction, null, "an intent that describes no payments claims nothing");
});

test("a description that says something else is refused, not shown", () => {
  const actions = decodeCalls([{ to: USDC, value: "0", data: TRANSFER }], ctx);
  const wrongPayee = annotate(actions, { recipients: [{ to: "0x00000000000000000000000000000000000000cd", amount: "1000000", label: "Acme Ltd" }] });
  assert.match(wrongPayee.contradiction ?? "", /the calldata pays 0xD6c574461d96Ee708f58Fe553049aD4f48BB983A/);
  assert.deepEqual(wrongPayee.notes, [null], "the false label is dropped");
  assert.match(annotate(actions, { recipients: [{ to: PAYEE, amount: "1" }] }).contradiction ?? "", /different amount/);
  assert.match(annotate(actions, { recipients: [] }).contradiction ?? "", /describes 0 payments and the transaction makes 1 call/);
  const rule = decodeCalls([self("setThreshold", [1])], ctx);
  assert.match(annotate(rule, { recipients: [{ to: PAYEE, amount: "1000000" }] }).contradiction ?? "", /is not one/);
});

// Pinned in service/src/olien.rs as well: the service checks an entry's signature
// against the hash it computes, so the two must be the same hash.
test("an address book entry hashes as the service hashes it", () => {
  const fields = { entry: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC", label: "Acme Ltd", category: "Supplier", addedAt: 1_791_201_600 };
  assert.equal(addressBookHash(10143, ACCOUNT, fields), "0xbba321448f5927f73078c7d1ffa63d1b3c3612d586cf19665eeb2fca7c7c1cb3");
  assert.notEqual(addressBookHash(10143, ACCOUNT, { ...fields, addedAt: fields.addedAt + 1 }), addressBookHash(10143, ACCOUNT, fields), "the time is part of what is signed");
  assert.notEqual(addressBookHash(10143, PROOF, fields), addressBookHash(10143, ACCOUNT, fields), "and the entry belongs to one account");
});

test("a cheque's digest is the token's own, and the message hash the account's", () => {
  const digest = chequeDigest({ chainId: ARC, token: "0x3600000000000000000000000000000000000000", from: PAYEE, to: "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc", value: "1500000", validAfter: 0, validBefore: 2_000_000_000, nonce: `0x${"11".repeat(32)}` });
  assert.equal(digest, "0x6cce28229ed8f091ce5d706f78c015497cf66db524fdd86919cfb877f4fa59b4");
  assert.equal(messageHash(ARC, PROOF, `0x${"11".repeat(32)}`), "0x752e2d6bbdfbb51bb7255ac18e5bac6b5ac1fbc662cd3db5b86c1eee9fd703f4");
});

const VETOED = "0xb6d2dc83590271a7c0a5ab5fbf6a2dad418bbfd533c253e3d69a6772712809c7";
const pair = (high: bigint, low: bigint) => `0x${high.toString(16).padStart(32, "0")}${low.toString(16).padStart(32, "0")}`;
const operation: OperationFields = {
  sender: ACCOUNT,
  nonce: "7",
  callData:
    "0x8dd7712f00000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000ab000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000024fb6f93f9b6d2dc83590271a7c0a5ab5fbf6a2dad418bbfd533c253e3d69a6772712809c700000000000000000000000000000000000000000000000000000000",
  accountGasLimits: pair(500_000n, 300_000n),
  preVerificationGas: "60000",
  gasFees: pair(1_000_000_000n, 2_000_000_000n),
  validAfter: 0,
  validUntil: 1_800_000_000,
  epoch: 3,
};
const veto = encodeFunctionData({ abi: OLIEN_ABI, functionName: "veto", args: [VETOED] });

test("an operation hashes as the contract hashes it, and its one call can be read back", () => {
  assert.equal(userOperationHash(ARC, ACCOUNT, operation), "0xdc99dbfd7bb1e9bda0d7b9bb8c2175acc00edc39f4a0fadf106a08a11526d994");
  assert.deepEqual(operationCalls(operation.callData), [{ to: ACCOUNT, value: 0n, data: veto }]);
  assert.equal(operationCalls(`0x12345678${operation.callData.slice(10)}`), null, "another selector is not the account's");
  assert.equal(operationCalls(`${operation.callData}00`), null, "trailing bytes are not canonical");
});

test("an operation is signed only when it is the call that was asked for", () => {
  const base = { chainId: ARC, account: ACCOUNT, operation, expected: veto, now: 1_799_999_000, gasPrice: 1_000_000_000n };
  const checked = checkOperation(base);
  assert.equal(checked.hash, "0xdc99dbfd7bb1e9bda0d7b9bb8c2175acc00edc39f4a0fadf106a08a11526d994");
  assert.equal(checked.maxCost, 860_000n * 2_000_000_000n);

  const other = encodeFunctionData({ abi: OLIEN_ABI, functionName: "veto", args: [`0x${"cd".repeat(32)}`] });
  assert.throws(() => checkOperation({ ...base, expected: other }), /something other than what you asked for/);
  assert.throws(() => checkOperation({ ...base, account: PROOF }), /different account/);
  assert.throws(() => checkOperation({ ...base, now: 1_700_000_000 }), /longer than this console will sign for/);
  assert.throws(() => checkOperation({ ...base, now: 1_800_000_001 }), /longer than this console will sign for/);
  assert.throws(() => checkOperation({ ...base, gasPrice: 1n }), /far more than the chain's gas price/);
  assert.throws(() => checkOperation({ ...base, gasPrice: null }), /could not be read/);
  assert.throws(() => checkOperation({ ...base, operation: { ...operation, accountGasLimits: pair(5_000_000n, 300_000n) } }), /more gas than this call can need/);
});

test("the sign-in text is built here and a malformed challenge is refused", () => {
  assert.equal(loginMessage(PAYEE.toLowerCase(), "q7Zt3-abcdefghij", 1_800_000_000), `Sign in to Olien\n\nAddress: ${PAYEE}\nNonce: q7Zt3-abcdefghij\nExpires: 1800000000`);
  assert.throws(() => loginMessage(PAYEE, "short", 1_800_000_000));
  assert.throws(() => loginMessage(PAYEE, "has a\nnewline in it", 1_800_000_000));
});
