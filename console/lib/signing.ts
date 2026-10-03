// Everything a member signs, rebuilt in the browser from what the screen shows.
//
// The service proposes; it must never be the one that says what a signature means. A
// passkey shows its holder nothing and a wallet shows a hash or raw calldata, so this
// console is the only place a person reads what they are approving. It used to read it
// from the service: a payment's recipients from the proposal's free-form intent, a
// cheque's hash and a veto's hash exactly as given. Bybit, Radiant and WazirX were all
// signers approving what a screen told them. So the screen is derived from the bytes
// instead: calls are decoded from the very message that is hashed, the domain is built
// from this console's own chain and the account in the address bar, and every hash that
// reaches a key is computed here. What the service sent is compared, never trusted.
//
// Pure, with viem as the only import, so the vectors the contract and the service pin
// can be pinned here too and run without a browser.

import { concat, decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeFunctionData, getAddress, hashTypedData, keccak256, parseAbi, slice, stringToHex, type Hex } from "viem";

// ----------------------------------------------------------------- the account's domain

export function olienDomain(chainId: number, account: string) {
  return { name: "Olien", version: "1", chainId, verifyingContract: getAddress(account) } as const;
}

function domainSeparator(chainId: number, account: string): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
      [
        keccak256(stringToHex("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")),
        keccak256(stringToHex("Olien")),
        keccak256(stringToHex("1")),
        BigInt(chainId),
        getAddress(account),
      ],
    ),
  );
}

// ----------------------------------------------------------------- transactions

export interface RawCall {
  to: string;
  value: string | bigint | number;
  data: string;
}

export interface TransactionFields {
  nonce: string | bigint;
  epoch: string | bigint | number;
  calls: RawCall[];
  validAfter: number;
  validUntil: number;
}

const TRANSACTION_TYPES = {
  Call: [
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "data", type: "bytes" },
  ],
  Transaction: [
    { name: "nonce", type: "uint256" },
    { name: "epoch", type: "uint64" },
    { name: "calls", type: "Call[]" },
    { name: "validAfter", type: "uint48" },
    { name: "validUntil", type: "uint48" },
  ],
} as const;

// The typed data a wallet is asked to sign, with the domain taken from where the member
// is standing rather than from the proposal. A proposal built for another account or
// another chain then hashes to something other than its own txHash, and is refused.
export function transactionTypedData(chainId: number, account: string, fields: TransactionFields) {
  return {
    domain: olienDomain(chainId, account),
    types: TRANSACTION_TYPES,
    primaryType: "Transaction" as const,
    message: {
      nonce: BigInt(fields.nonce),
      epoch: BigInt(fields.epoch),
      calls: fields.calls.map((call) => ({ to: getAddress(call.to), value: BigInt(call.value), data: (call.data || "0x") as Hex })),
      validAfter: fields.validAfter,
      validUntil: fields.validUntil,
    },
  };
}

export function transactionHash(chainId: number, account: string, fields: TransactionFields): Hex {
  return hashTypedData(transactionTypedData(chainId, account, fields));
}

// ----------------------------------------------------------------- reading calldata

export interface TokenInfo {
  address: string;
  symbol: string;
  decimals: number;
}

export interface DecodeContext {
  account: string;
  tokens: TokenInfo[];
  native: { symbol: string; decimals: number };
}

export type Action =
  | { type: "transfer"; token: TokenInfo; to: Hex; amount: bigint }
  | { type: "allowance"; token: TokenInfo; spender: Hex; amount: bigint }
  | { type: "native"; to: Hex; amount: bigint }
  | { type: "rule"; name: string; text: string; danger: boolean }
  | { type: "unreadable"; to: Hex; selector: Hex | null; bytes: number; value: bigint; why: string };

const ERC20_ABI = parseAbi(["function transfer(address to, uint256 amount) returns (bool)", "function approve(address spender, uint256 amount) returns (bool)"]);

// The calls an account accepts to itself on the threshold path: the configuration
// functions, cancel and removeSpendingLimit (spec §6.2). `veto` and `spend` are here for
// the single-signer operations, and are refused as part of a transaction below.
export const OLIEN_ABI = parseAbi([
  "struct SignerInput { uint8 kind; uint8 permissions; uint8 flags; bytes key; }",
  "struct SpendingLimitInput { address token; uint256 subAccount; uint128 amount; uint48 period; bool anyDestination; }",
  "function addSigner(SignerInput input)",
  "function removeSigner(bytes32 id)",
  "function replaceSigner(bytes32 oldId, SignerInput input)",
  "function setThreshold(uint16 newThreshold)",
  "function setVetoThreshold(uint16 newVetoThreshold)",
  "function setDelays(uint48 configDelay, uint48 recoveryDelay, uint48 recoveryCoSignDelay)",
  "function setSpendingLimit(uint256 id, SpendingLimitInput input) returns (uint256)",
  "function allowLimitSigner(uint256 id, bytes32 signerId)",
  "function allowLimitDestination(uint256 id, address to)",
  "function removeSpendingLimit(uint256 id)",
  "function cancel(bytes32 hash)",
  "function setImplementation(address newImplementation)",
  "function freezeImplementation()",
  "function veto(bytes32 hash)",
  "function spend(uint256 id, address to, uint256 amount)",
]);

const OPERATION_ONLY = new Set(["veto", "spend"]);
const MAX_UINT256 = (1n << 256n) - 1n;

export function formatAmount(amount: bigint, decimals: number): string {
  const unit = 10n ** BigInt(decimals);
  const whole = amount / unit;
  const fraction = (amount % unit).toString().padStart(decimals, "0");
  const trimmed = fraction.replace(/0+$/, "");
  const shown = trimmed.length <= 2 ? fraction.slice(0, 2) : trimmed;
  return `${whole.toLocaleString("en-US")}${decimals === 0 ? "" : `.${shown}`}`;
}

export function shortId(value: string): string {
  return value.length > 14 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value;
}

function duration(seconds: bigint | number): string {
  const s = Number(seconds);
  if (s === 0) return "no delay";
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (s % 86_400 === 0) return unit(s / 86_400, "day");
  if (s % 3_600 === 0) return unit(s / 3_600, "hour");
  if (s % 60 === 0) return unit(s / 60, "minute");
  return unit(s, "second");
}

// A signer id is the address itself, left padded, for a wallet or a contract, and a
// hash of the public key for a passkey; the address is the thing a person can check.
function signerOfId(id: Hex): string {
  return /^0x0{24}/.test(id) ? getAddress(`0x${id.slice(26)}`) : `key ${shortId(id)}`;
}

function permissionNames(bits: number): string {
  const names = [bits & 1 ? "approve" : null, bits & 2 ? "veto" : null, bits & 4 ? "recover" : null].filter(Boolean);
  return names.length ? names.join(" + ") : "no permissions";
}

function signerOfInput(input: { kind: number; permissions: number; key: Hex }): string {
  const bytes = (input.key.length - 2) / 2;
  if ((input.kind === 1 || input.kind === 4) && bytes === 20) return `${getAddress(input.key)}${input.kind === 4 ? " (a contract account)" : ""}`;
  if ((input.kind === 2 || input.kind === 3) && bytes === 64) return `a ${input.kind === 3 ? "passkey" : "P-256 key"} (${shortId(keccak256(input.key))})`;
  return `a signer of an unknown kind (${input.kind})`;
}

function tokenName(address: string, ctx: DecodeContext): TokenInfo | null {
  return ctx.tokens.find((token) => token.address.toLowerCase() === address.toLowerCase()) ?? null;
}

type RuleArgs = readonly unknown[];

function describeRule(name: string, args: RuleArgs, ctx: DecodeContext): { text: string; danger: boolean } {
  switch (name) {
    case "addSigner": {
      const input = args[0] as { kind: number; permissions: number; key: Hex };
      return { text: `Add ${signerOfInput(input)} as a signer with ${permissionNames(input.permissions)}`, danger: false };
    }
    case "removeSigner":
      return { text: `Remove signer ${signerOfId(args[0] as Hex)}`, danger: false };
    case "replaceSigner": {
      const input = args[1] as { kind: number; permissions: number; key: Hex };
      return { text: `Replace signer ${signerOfId(args[0] as Hex)} with ${signerOfInput(input)}, holding ${permissionNames(input.permissions)}`, danger: false };
    }
    case "setThreshold":
      return { text: `Set the approval threshold to ${args[0]}`, danger: false };
    case "setVetoThreshold":
      return { text: Number(args[0]) === 0 ? "Set the veto threshold to automatic" : `Set the veto threshold to ${args[0]}`, danger: false };
    case "setDelays": {
      const config = args[0] as number;
      return {
        text: `Set delays: rule changes ${duration(config)}, recovery ${duration(args[1] as number)}, co-signed recovery ${duration(args[2] as number)}`,
        danger: Number(config) === 0,
      };
    }
    case "setSpendingLimit": {
      const id = args[0] as bigint;
      const input = args[1] as { token: Hex; subAccount: bigint; amount: bigint; period: number; anyDestination: boolean };
      const token = tokenName(input.token, ctx);
      const amount = token ? `${formatAmount(input.amount, token.decimals)} ${token.symbol}` : `${input.amount} units of the token at ${getAddress(input.token)}`;
      const from = input.subAccount === 0n ? "" : ` from sub-account ${input.subAccount - 1n}`;
      return {
        text: `${id === 0n ? "Create a spending limit" : `Replace spending limit ${id}`}: ${amount} ${Number(input.period) === 0 ? "once" : `per ${duration(input.period)}`}${from}, ${input.anyDestination ? "to any destination" : "to listed destinations only"}`,
        danger: false,
      };
    }
    case "allowLimitSigner":
      return { text: `Let signer ${signerOfId(args[1] as Hex)} spend alone under limit ${args[0]}`, danger: false };
    case "allowLimitDestination":
      return { text: `Let limit ${args[0]} pay ${getAddress(args[1] as Hex)}`, danger: false };
    case "removeSpendingLimit":
      return { text: `Remove spending limit ${args[0]}`, danger: false };
    case "cancel":
      return { text: `Cancel the proposal ${args[0]}`, danger: false };
    case "setImplementation":
      return { text: `Replace the code that runs this account with the contract at ${getAddress(args[0] as Hex)}`, danger: true };
    case "freezeImplementation":
      return { text: "Freeze this account's code forever", danger: true };
    default:
      return { text: name, danger: false };
  }
}

function unreadable(call: RawCall, why: string): Action {
  const data = (call.data || "0x") as Hex;
  const bytes = (data.length - 2) / 2;
  return { type: "unreadable", to: getAddress(call.to), selector: bytes >= 4 ? slice(data, 0, 4) : null, bytes, value: BigInt(call.value), why };
}

// One call as a person would describe it, or `unreadable` with the reason. A decode
// counts only when encoding it again gives back the same bytes, so trailing data,
// dirty padding and look-alike encodings are never shown as the clean thing they
// resemble.
export function decodeCall(call: RawCall, ctx: DecodeContext): Action {
  const data = (call.data || "0x") as Hex;
  const value = BigInt(call.value);
  const to = call.to.toLowerCase();

  if (to === ctx.account.toLowerCase()) {
    if (value !== 0n) return unreadable(call, "a call to the account itself that also carries money");
    try {
      const decoded = decodeFunctionData({ abi: OLIEN_ABI, data });
      const args = (decoded.args ?? []) as RuleArgs;
      const again = encodeFunctionData({ abi: OLIEN_ABI, functionName: decoded.functionName, args } as Parameters<typeof encodeFunctionData>[0]);
      if (again.toLowerCase() !== data.toLowerCase()) return unreadable(call, "the encoding is not the canonical one");
      if (OPERATION_ONLY.has(decoded.functionName)) return unreadable(call, `${decoded.functionName} is not a call a transaction may make to the account`);
      const { text, danger } = describeRule(decoded.functionName, args, ctx);
      return { type: "rule", name: decoded.functionName, text, danger };
    } catch {
      return unreadable(call, "not one of the account's own functions");
    }
  }

  const token = tokenName(call.to, ctx);
  if (token) {
    if (value !== 0n) return unreadable(call, "a token call that also carries money");
    try {
      const decoded = decodeFunctionData({ abi: ERC20_ABI, data });
      const again = encodeFunctionData({ abi: ERC20_ABI, functionName: decoded.functionName, args: decoded.args } as Parameters<typeof encodeFunctionData>[0]);
      if (again.toLowerCase() !== data.toLowerCase()) return unreadable(call, "the encoding is not the canonical one");
      const [party, amount] = decoded.args as readonly [Hex, bigint];
      if (decoded.functionName === "transfer") return { type: "transfer", token, to: getAddress(party), amount };
      return { type: "allowance", token, spender: getAddress(party), amount };
    } catch {
      return unreadable(call, `a call to ${token.symbol} that is neither a transfer nor an approval`);
    }
  }

  if (data === "0x" && value > 0n) return { type: "native", to: getAddress(call.to), amount: value };
  return unreadable(call, "a call to a contract this console cannot read");
}

export function decodeCalls(calls: RawCall[], ctx: DecodeContext): Action[] {
  return calls.map((call) => decodeCall(call, ctx));
}

export function describeAction(action: Action, ctx: DecodeContext): string {
  switch (action.type) {
    case "transfer":
      return `Send ${formatAmount(action.amount, action.token.decimals)} ${action.token.symbol} to ${action.to}`;
    case "allowance":
      return action.amount === MAX_UINT256
        ? `Let ${action.spender} take any amount of ${action.token.symbol} from this account, at any time`
        : `Let ${action.spender} take up to ${formatAmount(action.amount, action.token.decimals)} ${action.token.symbol} from this account, at any time`;
    case "native":
      return `Send ${formatAmount(action.amount, ctx.native.decimals)} ${ctx.native.symbol} to ${action.to}`;
    case "rule":
      return action.text;
    case "unreadable":
      return `Unreadable call to ${action.to}${action.selector ? ` (${action.selector}, ${action.bytes} bytes)` : ""}${action.value > 0n ? ` carrying ${formatAmount(action.value, ctx.native.decimals)} ${ctx.native.symbol}` : ""}`;
  }
}

// What a proposal is, from what it does rather than from the kind it was filed under.
export function kindOf(actions: Action[]): string {
  if (actions.length === 0) return "Empty";
  if (actions.some((action) => action.type === "unreadable")) return "Contract call";
  if (actions.every((action) => action.type === "transfer" || action.type === "native")) return actions.length === 1 ? "Payment" : "Batch payment";
  if (actions.every((action) => action.type === "rule")) return "Rule change";
  if (actions.every((action) => action.type === "allowance")) return "Allowance";
  return "Mixed";
}

export function summarise(actions: Action[], ctx: DecodeContext): string {
  if (actions.length === 0) return "No calls";
  if (actions.length === 1) return describeAction(actions[0], ctx).replace(/0x[0-9a-fA-F]{40}/g, (address) => shortId(address));
  const transfers = actions.filter((action): action is Extract<Action, { type: "transfer" }> => action.type === "transfer");
  if (transfers.length === actions.length && transfers.every((action) => action.token.address === transfers[0].token.address)) {
    const total = transfers.reduce((sum, action) => sum + action.amount, 0n);
    return `Send ${formatAmount(total, transfers[0].token.decimals)} ${transfers[0].token.symbol} to ${transfers.length} recipients`;
  }
  const unread = actions.filter((action) => action.type === "unreadable").length;
  return `${actions.length} calls${unread ? `, ${unread} unreadable` : ""}: ${actions
    .slice(0, 3)
    .map((action) => describeAction(action, ctx).replace(/0x[0-9a-fA-F]{40}/g, (address) => shortId(address)))
    .join("; ")}${actions.length > 3 ? "; and more" : ""}`;
}

export interface Outgoing {
  // Null is the chain's own gas token.
  token: TokenInfo | null;
  amount: bigint;
}

// What leaves the account if every call runs, per token: the figure to hold against
// what the account has.
export function outgoing(actions: Action[]): Outgoing[] {
  const sums = new Map<string, Outgoing>();
  for (const action of actions) {
    const entry = action.type === "transfer" ? { key: action.token.address.toLowerCase(), token: action.token, amount: action.amount } : action.type === "native" ? { key: "", token: null, amount: action.amount } : null;
    if (!entry) continue;
    const sum = sums.get(entry.key);
    if (sum) sum.amount += entry.amount;
    else sums.set(entry.key, { token: entry.token, amount: entry.amount });
  }
  return [...sums.values()];
}

// ----------------------------------------------------------------- the proposer's words

export interface Annotation {
  label: string | null;
  memo: string | null;
}

export interface Annotated {
  notes: (Annotation | null)[];
  // Set when the description that came with the proposal says something its calldata
  // does not do. The description is then shown nowhere.
  contradiction: string | null;
  payrollName: string | null;
}

// A proposal carries a free-form intent: who the proposer says is being paid, and why.
// It is commentary. It is attached to a decoded payment only when it agrees with that
// payment exactly, so a label or a memo can add to what the calldata says and never
// stand in for it.
export function annotate(actions: Action[], intent: unknown): Annotated {
  const none: Annotated = { notes: actions.map(() => null), contradiction: null, payrollName: null };
  if (!intent || typeof intent !== "object") return none;
  const recipients = (intent as { recipients?: unknown }).recipients;
  if (!Array.isArray(recipients)) return none;
  if (recipients.length !== actions.length) {
    return { ...none, contradiction: `it describes ${recipients.length} ${recipients.length === 1 ? "payment" : "payments"} and the transaction makes ${actions.length} ${actions.length === 1 ? "call" : "calls"}` };
  }
  const notes: (Annotation | null)[] = [];
  for (const [index, entry] of recipients.entries()) {
    const action = actions[index];
    const claimed = entry as { to?: unknown; amount?: unknown; label?: unknown; memo?: unknown };
    const to = typeof claimed.to === "string" ? claimed.to.toLowerCase() : "";
    const amount = typeof claimed.amount === "string" && /^\d+$/.test(claimed.amount) ? BigInt(claimed.amount) : null;
    if (action.type !== "transfer") return { ...none, contradiction: `it calls call ${index + 1} a payment and it is not one` };
    if (action.to.toLowerCase() !== to) return { ...none, contradiction: `it names ${to || "nobody"} as recipient ${index + 1} and the calldata pays ${action.to}` };
    if (amount === null || action.amount !== amount) return { ...none, contradiction: `it gives a different amount for payment ${index + 1} than the calldata sends` };
    notes.push({ label: typeof claimed.label === "string" && claimed.label.trim() ? claimed.label.trim() : null, memo: typeof claimed.memo === "string" && claimed.memo.trim() ? claimed.memo.trim() : null });
  }
  const payroll = (intent as { payroll?: { name?: unknown } }).payroll;
  return { notes, contradiction: null, payrollName: payroll && typeof payroll.name === "string" && payroll.name.trim() ? payroll.name.trim() : null };
}

// ----------------------------------------------------------------- messages and cheques

const MESSAGE_TYPES = { Message: [{ name: "hash", type: "bytes32" }] } as const;

// Message(hash) in the account's domain: what members sign for the account to vouch for
// a hash under ERC-1271. Any hash the account vouches for is honoured by whoever asks,
// so the hash is only ever one this console derived itself.
export function messageTypedData(chainId: number, account: string, hash: Hex) {
  return { domain: olienDomain(chainId, account), types: MESSAGE_TYPES, primaryType: "Message" as const, message: { hash } };
}

export function messageHash(chainId: number, account: string, hash: Hex): Hex {
  return hashTypedData(messageTypedData(chainId, account, hash));
}

export interface ChequeFields {
  chainId: number;
  token: string;
  from: string;
  to: string;
  value: string | bigint;
  validAfter: number;
  validBefore: number;
  nonce: string;
}

// The token's own digest for TransferWithAuthorization (EIP-3009), in USDC's domain:
// name "USDC", version "2", checked against the live contract on Arc and on Monad.
export function chequeDigest(fields: ChequeFields): Hex {
  return hashTypedData({
    domain: { name: "USDC", version: "2", chainId: fields.chainId, verifyingContract: getAddress(fields.token) },
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    message: {
      from: getAddress(fields.from),
      to: getAddress(fields.to),
      value: BigInt(fields.value),
      validAfter: BigInt(fields.validAfter),
      validBefore: BigInt(fields.validBefore),
      nonce: fields.nonce as Hex,
    },
  });
}

// ----------------------------------------------------------------- single-signer operations

export interface OperationFields {
  sender: string;
  nonce: string;
  callData: string;
  accountGasLimits: string;
  preVerificationGas: string;
  gasFees: string;
  validAfter: number;
  validUntil: number;
  epoch: number;
}

export const ENTRY_POINT_V07: Hex = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";

const USER_OPERATION_TYPEHASH = keccak256(
  stringToHex(
    "UserOperation(address sender,uint256 nonce,bytes initCode,bytes callData,uint128 verificationGasLimit,uint128 callGasLimit,uint256 preVerificationGas,uint128 maxPriorityFeePerGas,uint128 maxFeePerGas,bytes paymasterAndData,uint48 validAfter,uint48 validUntil,uint64 epoch,address entryPoint)",
  ),
);
const EXECUTE_USER_OP_SELECTOR = slice(keccak256(stringToHex("executeUserOp((address,uint256,bytes,bytes,bytes32,uint256,bytes32,bytes,bytes),bytes32)")), 0, 4);
const CALLS_PARAMETER = [
  {
    type: "tuple[]",
    components: [
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
    ],
  },
] as const;
const LOW_128 = (1n << 128n) - 1n;
const EMPTY_HASH = keccak256("0x");

// `OlienHash.userOperation`: the account's own hash of an operation, with no init code
// and no paymaster, which is the only shape this console ever signs.
export function userOperationHash(chainId: number, account: string, op: OperationFields, entryPoint: string = ENTRY_POINT_V07): Hex {
  const limits = BigInt(op.accountGasLimits);
  const fees = BigInt(op.gasFees);
  const word = { type: "uint256" } as const;
  const head = encodeAbiParameters(
    [{ type: "bytes32" }, { type: "address" }, word, { type: "bytes32" }, { type: "bytes32" }, word, word, word],
    [USER_OPERATION_TYPEHASH, getAddress(op.sender), BigInt(op.nonce), EMPTY_HASH, keccak256(op.callData as Hex), limits >> 128n, limits & LOW_128, BigInt(op.preVerificationGas)],
  );
  const tail = encodeAbiParameters(
    [word, word, { type: "bytes32" }, word, word, word, { type: "address" }],
    [fees >> 128n, fees & LOW_128, EMPTY_HASH, BigInt(op.validAfter), BigInt(op.validUntil), BigInt(op.epoch), getAddress(entryPoint)],
  );
  return keccak256(concat(["0x1901", domainSeparator(chainId, account), keccak256(concat([head, tail]))]));
}

// The calls inside an operation's callData, or null for any shape but the account's own:
// `executeUserOp.selector ‖ abi.encode(Call[])`, canonically encoded.
export function operationCalls(callData: string): RawCall[] | null {
  const data = callData as Hex;
  if (data.length < 10 || slice(data, 0, 4).toLowerCase() !== EXECUTE_USER_OP_SELECTOR.toLowerCase()) return null;
  try {
    const body = slice(data, 4);
    const [calls] = decodeAbiParameters(CALLS_PARAMETER, body);
    if (encodeAbiParameters(CALLS_PARAMETER, [calls]).toLowerCase() !== body.toLowerCase()) return null;
    return calls.map((call) => ({ to: call.to, value: call.value, data: call.data }));
  } catch {
    return null;
  }
}

/// An operation is signed and sent within minutes. Two hours is the most this console
/// will sign for, so a signed operation cannot be held back and used on another day.
const MAX_OPERATION_LIFETIME = 2 * 3_600;
/// A veto measured 250k gas for the whole bundle; this is room, not a target.
const MAX_OPERATION_GAS = 3_000_000n;

export interface CheckedOperation {
  hash: Hex;
  // The most the account's gas deposit can be charged for it.
  maxCost: bigint;
}

// Checks that an operation the service prepared is exactly the one call the member
// asked for, on this account, for a short time and a bounded price, and returns the
// hash to sign, computed here. Throws with the reason otherwise.
export function checkOperation(input: { chainId: number; account: string; operation: OperationFields; expected: Hex; now: number; gasPrice: bigint | null; entryPoint?: string }): CheckedOperation {
  const { operation, account } = input;
  if (operation.sender.toLowerCase() !== account.toLowerCase()) throw new Error("The operation is for a different account. Nothing was signed.");
  const calls = operationCalls(operation.callData);
  if (!calls || calls.length !== 1) throw new Error("The operation does not carry exactly one call. Nothing was signed.");
  const [call] = calls;
  if (call.to.toLowerCase() !== account.toLowerCase() || BigInt(call.value) !== 0n || call.data.toLowerCase() !== input.expected.toLowerCase()) {
    throw new Error("The operation does something other than what you asked for. Nothing was signed.");
  }
  if (operation.validAfter > input.now || operation.validUntil <= input.now || operation.validUntil - input.now > MAX_OPERATION_LIFETIME) {
    throw new Error("The operation is valid for longer than this console will sign for. Nothing was signed.");
  }
  const limits = BigInt(operation.accountGasLimits);
  const fees = BigInt(operation.gasFees);
  const gas = (limits >> 128n) + (limits & LOW_128) + BigInt(operation.preVerificationGas);
  const maxFee = fees & LOW_128;
  if (gas > MAX_OPERATION_GAS) throw new Error("The operation asks for more gas than this call can need. Nothing was signed.");
  if (input.gasPrice === null) throw new Error("The chain's gas price could not be read, so the operation's fee could not be checked. Nothing was signed.");
  if (maxFee > input.gasPrice * 10n + 1_000_000_000n) throw new Error("The operation offers far more than the chain's gas price. Nothing was signed.");
  return { hash: userOperationHash(input.chainId, account, operation, input.entryPoint), maxCost: gas * maxFee };
}

// ----------------------------------------------------------------- signing in

// The text a wallet signs to enter the console, built here from the nonce the service
// issued. A challenge that could be any text could be a 32-byte hash dressed as one.
export function loginMessage(address: string, nonce: string, expiresAt: number): string {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(nonce)) throw new Error("The sign-in challenge is malformed. Nothing was signed.");
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0) throw new Error("The sign-in challenge is malformed. Nothing was signed.");
  return `Sign in to Olien\n\nAddress: ${getAddress(address)}\nNonce: ${nonce}\nExpires: ${expiresAt}`;
}
