// Client for the treasury transaction service (docs/treasury/11-service-api.md).
// Types mirror the contract field for field; every request goes through authFetch so
// the bearer session is attached and refreshed. Amounts are decimal strings in the
// token's smallest unit (USDC has 6 decimals), times are unix seconds, addresses are
// lowercase hex, hashes and signer ids are 0x plus 64 hex digits.

import { formatUnits, isAddress } from "viem";
import { authFetch } from "./session";
import { chainSpec, decodeContext, nativeSymbol } from "./chain";
import { annotate, decodeCalls, kindOf, summarise, transactionHash, transactionTypedData, type TransactionFields } from "./signing";

export type Hex = `0x${string}`;

export type Permission = "approve" | "veto" | "recover";
export type SignerKind = "ecdsa" | "p256" | "webauthn" | "contract";
export type AccountStatus = "deploying" | "live" | "disabled";
export type ProposalKind =
  | "transfer"
  | "batch"
  | "payroll"
  | "signer_change"
  | "rule_change"
  | "limit_change"
  | "cancel"
  | "contract_call";
export type ProposalStatus =
  | "open"
  | "ready"
  | "blocked"
  | "executing"
  | "executed"
  | "scheduled"
  | "vetoed"
  | "cancelled"
  | "replaced"
  | "stale"
  | "expired"
  | "failed";

export interface LinkedAddress {
  address: string;
  linkedAt: number;
}

export interface SignerInput {
  kind: SignerKind;
  address?: string;
  label: string;
  permissions: Permission[];
  // P-256 and passkey signers: the public key's coordinates as 32-byte hex.
  x?: string;
  y?: string;
  uvRequired?: boolean;
  // Passkeys only: backup-eligible at enrolment, so it lives in a cloud account rather
  // than on one device. Sent so the service can keep it once it stores it.
  synced?: boolean;
  // A Recourse account by name; the service resolves it and picks the kind.
  handle?: string;
}

const HANDLE = /^@?[a-z0-9][a-z0-9_.-]{1,31}$/i;

export function isHandle(value: string): boolean {
  return HANDLE.test(value.trim());
}

export interface SignerView {
  signerId: string;
  kind: SignerKind;
  address: string | null;
  x: string | null;
  y: string | null;
  label: string;
  permissions: Permission[];
  since: number;
  mine: boolean;
  // Passkeys only, when the service kept what the authenticator said at enrolment.
  synced?: boolean;
}

export interface AccountSummary {
  address: string;
  name: string;
  status: AccountStatus;
  threshold: number;
  signerCount: number;
  usdcBalance: string;
  eurcBalance: string;
  openProposals: number;
  scheduledChanges: number;
  createdAt: number;
}

export interface Lane {
  nonceKey: string;
  chainSequence: number;
}

export interface SpendingLimit {
  id: number;
  generation: number;
  token: string;
  from: string;
  amount: string;
  remaining: string;
  period: number;
  resetAt: number;
  anyDestination: boolean;
  signers: string[];
  destinations: string[];
}

export interface SubAccount {
  index: number;
  address: string;
  label: string | null;
}

export interface Membership {
  creator: boolean;
  signerIds: string[];
}

export interface AccountView {
  address: string;
  name: string;
  status: AccountStatus;
  chainId: number;
  implementation: string;
  implementationFrozen: boolean;
  epoch: number;
  threshold: number;
  vetoThreshold: number;
  effectiveVetoThreshold: number;
  configDelay: number;
  recoveryDelay: number;
  recoveryCoSignDelay: number;
  signers: SignerView[];
  usdcBalance: string;
  eurcBalance: string;
  entryPointDeposit: string;
  lanes: Lane[];
  limits: SpendingLimit[];
  subAccounts: SubAccount[];
  createTx: string | null;
  createdAt: number;
  membership: Membership;
}

export interface CreateAccountBody {
  name: string;
  signers: SignerInput[];
  threshold: number;
  vetoThreshold: number;
  configDelay: number;
  recoveryDelay: number;
  recoveryCoSignDelay: number;
}

export interface Call {
  to: string;
  value: string;
  data: string;
}

export interface DecodedCall {
  to: string;
  label: string;
  summary: string;
  selector: string;
  readable: boolean;
}

export interface ConfirmationView {
  signerId: string;
  address: string | null;
  label: string;
  kind: "offchain" | "onchain";
  signedAt: number;
}

export interface MissingSigner {
  signerId: string;
  label: string;
  mine: boolean;
}

export interface HardRule {
  rule: string;
  seconds: number | null;
  text: string;
}

export interface SimulationView {
  ok: boolean;
  error: string | null;
  checkedAt: number;
}

export interface VetoView {
  signerId: string;
  label: string;
  tx: string;
  at: number;
}

export interface RecipientInput {
  to: string;
  amount: string;
  label?: string;
  memo?: string;
}

export interface TypedDataField {
  name: string;
  type: string;
}

export interface TypedDataView {
  domain: { name: string; version: string; chainId: number; verifyingContract: string };
  types: Record<string, TypedDataField[]>;
  primaryType: string;
  message: {
    nonce: string;
    epoch: number;
    calls: Call[];
    validAfter: number;
    validUntil: number;
  };
}

export interface ProposalView {
  txHash: string;
  account: string;
  nonceKey: string;
  sequence: number;
  nonce: string;
  epoch: number;
  kind: ProposalKind;
  intent: Record<string, unknown> | null;
  calls: Call[];
  decoded: DecodedCall[];
  validAfter: number;
  validUntil: number;
  path: string;
  status: ProposalStatus;
  confirmations: ConfirmationView[];
  required: number;
  approvals: number;
  missing: MissingSigner[];
  blockedBy: string | null;
  hardRules: HardRule[];
  simulation: SimulationView | null;
  scheduledReadyAt: number | null;
  scheduledWindowEndsAt: number | null;
  scheduledExcluded: string | null;
  vetoes: VetoView[];
  effectiveVetoThreshold: number;
  executedTx: string | null;
  executedAt: number | null;
  // `via` names the API key that opened it, when one did.
  proposer: { accountId: number; name: string; via?: string | null } | null;
  createdAt: number;
  typedData: TypedDataView;
}

export interface VetoCall {
  to: string;
  data: string;
  signerIds: string[];
  // Passkey and P-256 signers that may veto; they sign a user operation the relayer
  // submits, since they have no wallet to send a transaction from.
  operationSignerIds: string[];
}

// A user operation the service prepared (spec §10). Every field goes back with the
// signature so the service can recompute the hash; it holds nothing in between.
export interface OperationJson {
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

export interface PreparedOperation {
  operation: OperationJson;
  hash: string;
  signerId: string;
}

export interface OperationReceipt {
  txHash: string;
  hash: string;
}

export interface LedgerEntry {
  id: number;
  tx: string;
  logIndex: number;
  token: string;
  // "USDC", "EURC", or "gas" for a user operation paid from the EntryPoint deposit.
  symbol: string;
  // 6 for the coins, 18 for gas: the amount is formatted by this, never by symbol.
  decimals: number;
  direction: "in" | "out";
  counterparty: string;
  counterpartyLabel: string | null;
  amount: string;
  blockNumber: number;
  blockTime: number;
  proposalTxHash: string | null;
  limitId: number | null;
  subAccount: string | null;
  memo: string | null;
}

// A ledger row's amount in its own unit. Gas on Arc is USDC too, so the word stays.
export function formatLedgerAmount(entry: LedgerEntry): string {
  if (entry.decimals === 18) return `${formatNative(BigInt(entry.amount || "0"))} gas`;
  return entry.symbol === "EURC" ? formatEuros(entry.amount) : formatUsdc(entry.amount);
}

// The same amount as a plain decimal for a spreadsheet, in the row's own decimals.
export function ledgerDecimal(entry: LedgerEntry): string {
  const n = BigInt(entry.amount || "0");
  const scale = 10n ** BigInt(entry.decimals);
  return `${n / scale}.${(n % scale).toString().padStart(entry.decimals, "0")}`;
}

export interface AddressBookEntry {
  address: string;
  label: string;
  category: string | null;
  createdAt?: number;
}

export interface TransferProposalBody {
  recipients: RecipientInput[];
  token?: string;
  nonceKey?: string;
  validUntil?: number;
}

export interface SignersProposalBody {
  add: SignerInput[];
  remove: string[];
  replace: { signerId: string; with: SignerInput }[];
  threshold?: number;
  vetoThreshold?: number;
  delays?: { configDelay: number; recoveryDelay: number; recoveryCoSignDelay: number };
}

export class TreasuryError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "TreasuryError";
    this.status = status;
  }
}

const BASE = "/api/treasury";

async function send(path: string, init: RequestInit = {}): Promise<unknown> {
  const res = await authFetch(`${BASE}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  if (!res.ok) {
    const message =
      body && typeof body === "object" && "error" in body && typeof (body as { error: unknown }).error === "string"
        ? (body as { error: string }).error
        : `The treasury service answered ${res.status}`;
    throw new TreasuryError(message, res.status);
  }
  return body;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  return (await send(path, init)) as T;
}

function post(body: unknown): RequestInit {
  return { method: "POST", body: JSON.stringify(body) };
}

export const getLinkedAddresses = () => request<LinkedAddress[]>("/linked-addresses");
export const linkAddress = (body: { address: string; signature: string }) =>
  request<LinkedAddress>("/link-address", post(body));

export const getAccounts = () => request<AccountSummary[]>("/accounts");
export const createAccount = (body: CreateAccountBody) => request<AccountView>("/accounts", post(body));
export const getAccount = (address: string) => request<AccountView>(`/accounts/${address}`);
// An Olien that is on the chain and not in this service: its rules, members and balance
// are read from the chain. The caller has to be one of its signers.
export const importAccount = (body: { address: string; name?: string }) => request<AccountView>("/accounts/import", post(body));

export const getProposals = (address: string, statuses?: ProposalStatus[]) =>
  request<ProposalView[]>(
    `/accounts/${address}/proposals${statuses && statuses.length ? `?status=${statuses.join(",")}` : ""}`,
  );
export const getProposal = (address: string, txHash: string) =>
  request<ProposalView>(`/accounts/${address}/proposals/${txHash}`);
export const confirmProposal = (address: string, txHash: string, body: { signerId: string; signature: string }) =>
  request<ProposalView>(`/accounts/${address}/proposals/${txHash}/confirmations`, post(body));
export const executeProposal = (address: string, txHash: string) =>
  request<ProposalView>(`/accounts/${address}/proposals/${txHash}/execute`, { method: "POST" });
export const cancelProposal = (address: string, txHash: string) =>
  request<ProposalView>(`/accounts/${address}/proposals/${txHash}/cancel`, { method: "POST" });
export const deleteProposal = async (address: string, txHash: string): Promise<void> => {
  await send(`/accounts/${address}/proposals/${txHash}`, { method: "DELETE" });
};
export const proposeTransfer = (address: string, body: TransferProposalBody) =>
  request<ProposalView>(`/accounts/${address}/proposals/transfer`, post(body));
export const proposeSigners = (address: string, body: SignersProposalBody) =>
  request<ProposalView>(`/accounts/${address}/proposals/signers`, post(body));

export const getScheduled = (address: string) => request<ProposalView[]>(`/accounts/${address}/scheduled`);
export const getVetoCall = (address: string, hash: string) =>
  request<VetoCall>(`/accounts/${address}/scheduled/${hash}/veto-call`);
// Paying from a spending limit: a wallet signer sends `call` itself; a passkey signs
// `operation` and the relayer submits it. The service checks the limit first either way.
export interface SpendPlan {
  call: { to: string; data: string };
  operation: PreparedOperation | null;
}

export const planSpend = (address: string, limitId: number, body: { to: string; amount: string; signerId: string }) =>
  request<SpendPlan>(`/accounts/${address}/limits/${limitId}/spend`, post(body));

export const prepareVetoOperation = (address: string, hash: string, signerId: string) =>
  request<PreparedOperation>(`/accounts/${address}/scheduled/${hash}/veto-operation?signerId=${encodeURIComponent(signerId)}`);
export const submitOperation = (address: string, body: { operation: OperationJson; signerId: string; signature: string }) =>
  request<OperationReceipt>(`/accounts/${address}/operations`, post(body));
export const executeScheduled = (address: string, hash: string) =>
  request<ProposalView>(`/accounts/${address}/scheduled/${hash}/execute`, { method: "POST" });

export const getLedger = (address: string, limit = 100) =>
  request<LedgerEntry[]>(`/accounts/${address}/ledger?limit=${limit}`);
export const getAddressBook = (address: string) =>
  request<AddressBookEntry[]>(`/accounts/${address}/address-book`);
export const addAddressBookEntry = (address: string, body: { address: string; label: string; category?: string }) =>
  request<AddressBookEntry>(`/accounts/${address}/address-book`, post(body));

// An ECDSA signer's id is its address left-padded to 32 bytes (spec: signer ids are
// bytes32; for ECDSA the low 20 bytes are the address).
export function signerIdFor(address: string): string {
  return `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}`;
}

export function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  return Boolean(a && b && a.toLowerCase() === b.toLowerCase());
}

export function isValidAddress(value: string): value is Hex {
  return isAddress(value, { strict: false });
}

// The exact EIP-191 text the service recovers a linked address from: lowercase
// address, decimal account id, newline separated, no trailing newline.
export function linkMessage(address: string, accountId: number): string {
  return `Recourse treasury link\naddress: ${address.toLowerCase()}\naccount: ${accountId}`;
}

/// The same number with a dollar sign, for a balance that stands alone.
export function formatDollars(raw: string | bigint): string {
  return `$${formatUsdc(raw).replace(/ USDC$/, "")}`;
}

/// Euros a treasury holds, shown only when it has some. Six decimals like USDC.
export function formatEuros(raw: string | bigint): string {
  return `\u20ac${formatUsdc(raw).replace(/ USDC$/, "")}`;
}

export function formatUsdc(raw: string | bigint): string {
  const n = typeof raw === "bigint" ? raw : BigInt(raw || "0");
  const negative = n < 0n;
  const abs = negative ? -n : n;
  const whole = abs / 1_000_000n;
  const frac6 = (abs % 1_000_000n).toString().padStart(6, "0");
  const trimmed = frac6.replace(/0+$/, "");
  const frac = trimmed.length <= 2 ? frac6.slice(0, 2) : trimmed;
  return `${negative ? "-" : ""}${whole.toLocaleString("en-US")}.${frac} USDC`;
}

// Arc's native balance is USDC with 18 decimals; it pays gas for a signer's own
// transactions (veto), so the keys panel shows it beside each linked address.
// The chain's gas token: USDC on Arc, MON on Monad. Named from lib/chain, never assumed.
export function formatNative(wei: bigint): string {
  const value = Number(formatUnits(wei, 18));
  if (value === 0) return `0 ${nativeSymbol}`;
  if (value < 0.0001) return `<0.0001 ${nativeSymbol}`;
  return `${value.toLocaleString("en-US", { maximumFractionDigits: 4 })} ${nativeSymbol}`;
}

// What the service says about its own chain; Settings holds it against lib/chain.
export interface ChainInfo {
  chainId: number;
  name: string;
  native: { symbol: string; decimals: number };
  explorerUrl: string;
  usdc: string;
  eurc: string | null;
  entryPoint: string | null;
  factory: string | null;
  implementation: string | null;
}

export const getChainInfo = () => request<ChainInfo>("/chain");

// Parses a human USDC amount to its 6-decimal integer string without floats.
export function parseUsdc(input: string): string | null {
  const text = input.trim().replace(/,/g, "");
  if (!/^\d*(\.\d*)?$/.test(text) || text === "" || text === ".") return null;
  const [whole = "0", frac = ""] = text.split(".");
  if (frac.length > 6) return null;
  const units = BigInt(whole || "0") * 1_000_000n + BigInt((frac + "000000").slice(0, 6));
  if (units <= 0n) return null;
  return units.toString();
}

export function shortAddress(value: string): string {
  return value && value.length > 12 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}

export function shortHash(value: string): string {
  return value && value.length > 18 ? `${value.slice(0, 10)}…${value.slice(-6)}` : value;
}

export function durationLabel(seconds: number): string {
  if (seconds <= 0) return "none";
  if (seconds % 86_400 === 0) {
    const days = seconds / 86_400;
    return `${days} ${days === 1 ? "day" : "days"}`;
  }
  if (seconds % 3_600 === 0) {
    const hours = seconds / 3_600;
    return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  }
  if (seconds % 60 === 0) {
    const minutes = seconds / 60;
    return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  }
  return `${seconds} seconds`;
}

export function countdownLabel(target: number, now: number): string {
  const left = target - now;
  if (left <= 0) return "ready";
  const days = Math.floor(left / 86_400);
  const hours = Math.floor((left % 86_400) / 3_600);
  const minutes = Math.floor((left % 3_600) / 60);
  const seconds = left % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (days > 0) return `${days}d ${pad(hours)}h ${pad(minutes)}m ${pad(seconds)}s`;
  if (hours > 0) return `${hours}h ${pad(minutes)}m ${pad(seconds)}s`;
  return `${minutes}m ${pad(seconds)}s`;
}

export function formatTime(unix: number | null | undefined): string {
  if (!unix) return "";
  return new Date(unix * 1000).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatDay(unix: number | null | undefined): string {
  if (!unix) return "";
  return new Date(unix * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function statusTone(status: ProposalStatus): string {
  switch (status) {
    case "ready":
      return "green";
    case "executed":
      return "treasury-executed";
    case "blocked":
    case "scheduled":
      return "amber";
    case "executing":
      return "treasury-blue";
    case "vetoed":
    case "cancelled":
    case "failed":
      return "red";
    case "replaced":
    case "stale":
    case "expired":
      return "treasury-muted";
    default:
      return "neutral";
  }
}

export function statusLabel(status: ProposalStatus): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

// What a proposal asks to be signed: the message of its typed data and nothing else.
// These are the fields that are hashed, so they are the fields that are decoded and
// shown. The proposal's own `calls`, `kind`, `decoded` and `intent` are the service's
// account of it; the domain it came with is not used at all.
export function signedFields(proposal: ProposalView): TransactionFields {
  const { message } = proposal.typedData;
  return { nonce: message.nonce, epoch: message.epoch, calls: message.calls, validAfter: message.validAfter, validUntil: message.validUntil };
}

// The typed data a wallet signs for a proposal of `account`, under this console's own
// chain. A proposal made for another account or chain then fails the hash check.
export function typedDataFor(proposal: ProposalView, account: string) {
  return transactionTypedData(chainSpec.id, account, signedFields(proposal));
}

// The hash a hardware wallet shows. Signing is refused when it differs from the
// proposal's txHash, so what is displayed is always what is signed.
export function proposalHash(proposal: ProposalView, account: string): Hex {
  return transactionHash(chainSpec.id, account, signedFields(proposal));
}

export function hashMatches(proposal: ProposalView, account: string): boolean {
  try {
    return proposalHash(proposal, account).toLowerCase() === proposal.txHash.toLowerCase();
  } catch {
    return false;
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.split("\n")[0];
  return String(error);
}

// Route params: an account address or a transaction hash, or nothing at all.
export function accountParam(value: string): string | null {
  return /^0x[0-9a-fA-F]{40}$/.test(value) ? value.toLowerCase() : null;
}

export function hashParam(value: string): string | null {
  return /^0x[0-9a-fA-F]{64}$/.test(value) ? value.toLowerCase() : null;
}

// A proposal in one line, from what its calldata does. The proposer's own words, a
// payroll's name, are added only when they agree with it.
export function proposalSummary(proposal: ProposalView): string {
  try {
    const ctx = decodeContext(proposal.account);
    const actions = decodeCalls(signedFields(proposal).calls, ctx);
    const described = annotate(actions, proposal.intent);
    const summary = summarise(actions, ctx);
    if (described.contradiction) return `Mislabelled: ${summary}`;
    return described.payrollName ? `${described.payrollName}: ${summary}` : summary;
  } catch {
    return "A transaction this console could not read";
  }
}

export function proposalKind(proposal: ProposalView): string {
  try {
    return kindOf(decodeCalls(signedFields(proposal).calls, decodeContext(proposal.account)));
  } catch {
    return "Transaction";
  }
}

// Spending limits: the console sends the target limit and the service encodes the
// setSpendingLimit, allowLimitSigner and allowLimitDestination batch. Creating or
// replacing one is a configuration change (scheduled); removing one runs at once.
export interface LimitProposalBody {
  id?: number | null;
  token?: string;
  amount: string;
  period: number;
  anyDestination: boolean;
  signers: string[];
  destinations: string[];
  subAccount?: number | null;
}

export const proposeLimit = (address: string, body: LimitProposalBody) =>
  request<ProposalView>(`/accounts/${address}/proposals/limit`, post(body));
export const proposeRemoveLimit = (address: string, body: { id: number }) =>
  request<ProposalView>(`/accounts/${address}/proposals/remove-limit`, post(body));

// A USDC amount as a plain decimal with six places, for spreadsheets.
export function ledgerCsv(entries: LedgerEntry[]): string {
  const escape = (value: string | number | null | undefined) => {
    const text = value == null ? "" : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const rows: (string | number | null)[][] = [
    ["time", "direction", "counterparty", "counterparty_label", "amount_usdc", "symbol", "memo", "proposal", "limit_id", "sub_account", "tx", "block"],
  ];
  for (const entry of entries) {
    rows.push([
      new Date(entry.blockTime * 1000).toISOString(),
      entry.direction,
      entry.counterparty,
      entry.counterpartyLabel,
      `${entry.direction === "out" ? "-" : ""}${ledgerDecimal(entry)}`,
      entry.symbol,
      entry.memo,
      entry.proposalTxHash,
      entry.limitId,
      entry.subAccount,
      entry.tx,
      entry.blockNumber,
    ]);
  }
  return `${rows.map((row) => row.map(escape).join(",")).join("\n")}\n`;
}

export const renameAccount = (address: string, name: string) =>
  request<AccountView>(`/accounts/${address}/name`, { ...post({ name }), method: "PUT" });

export const createSubAccount = (address: string, label: string) =>
  request<AccountView>(`/accounts/${address}/sub-accounts`, post({ label }));

// API keys: a bearer for finance tooling, scoped to one account. `read` sees what a
// member sees; `propose` can also put transfers in the queue. Neither signs.
export type ApiKeyScope = "read" | "propose";

export interface ApiKey {
  id: number;
  name: string;
  scope: ApiKeyScope;
  // The key's last four characters, for telling two keys apart.
  hint: string;
  createdBy: string;
  createdAt: number;
  lastUsedAt: number | null;
  // The last moment the key works; absent from a service that does not expire keys.
  expiresAt?: number | null;
}

// The key itself is in this response and in no other.
export interface MintedApiKey extends ApiKey {
  key: string;
}

// Payroll runs: a saved list of people and amounts. Running one opens a batch in
// the payroll lane that needs the same signatures as any payment; a schedule has the
// service open it on the day.
export type PayrollPeriod = "none" | "weekly" | "fortnightly" | "monthly";

export interface PayrollRun {
  id: number;
  name: string;
  token: string;
  recipients: RecipientInput[];
  total: string;
  period: PayrollPeriod;
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastRunTxHash: string | null;
  lastError: string | null;
  createdAt: number;
}

export interface PayrollBody {
  name: string;
  token?: string;
  recipients: RecipientInput[];
  period: PayrollPeriod;
  nextRunAt?: number | null;
}

export const getPayrolls = (address: string) => request<PayrollRun[]>(`/accounts/${address}/payrolls`);
export const createPayroll = (address: string, body: PayrollBody) => request<PayrollRun>(`/accounts/${address}/payrolls`, post(body));
export const updatePayroll = (address: string, id: number, body: PayrollBody) =>
  request<PayrollRun>(`/accounts/${address}/payrolls/${id}`, { ...post(body), method: "PUT" });
export const deletePayroll = (address: string, id: number) => request<void>(`/accounts/${address}/payrolls/${id}`, { method: "DELETE" });
export const runPayroll = (address: string, id: number) => request<ProposalView>(`/accounts/${address}/payrolls/${id}/run`, post({}));

// Webhooks: the service posts a signed JSON delivery when a ledger row lands or a
// proposal changes. The secret is shown once; the receiver checks x-olien-signature.
export type WebhookTopic = "ledger" | "proposals";

export interface Webhook {
  id: number;
  url: string;
  events: WebhookTopic[];
  disabledReason: string | null;
  lastDeliveryAt: number | null;
  lastStatus: number | null;
  pending: number;
  createdAt: number;
}

export interface CreatedWebhook extends Webhook {
  secret: string;
}

export interface WebhookDelivery {
  id: number;
  event: string;
  attempts: number;
  deliveredAt: number | null;
  abandonedAt: number | null;
  lastStatus: number | null;
  lastError: string | null;
  createdAt: number;
}

export const getWebhooks = (address: string) => request<Webhook[]>(`/accounts/${address}/webhooks`);
export const createWebhook = (address: string, body: { url: string; events: WebhookTopic[] }) =>
  request<CreatedWebhook>(`/accounts/${address}/webhooks`, post(body));
export const deleteWebhook = (address: string, id: number) => request<void>(`/accounts/${address}/webhooks/${id}`, { method: "DELETE" });
export const enableWebhook = (address: string, id: number) => request<Webhook>(`/accounts/${address}/webhooks/${id}/enable`, post({}));
export const testWebhook = (address: string, id: number) => request<WebhookDelivery>(`/accounts/${address}/webhooks/${id}/test`, post({}));
export const getWebhookDeliveries = (address: string, id: number) => request<WebhookDelivery[]>(`/accounts/${address}/webhooks/${id}/deliveries`);

// Cheques written by the treasury: USDC's own signed authorization, signed by the
// threshold over Message(digest) in the account's domain. Nothing moves on chain until
// the recipient cashes it from their Recourse app.
export type ChequeStatus = "open" | "issued" | "cashed" | "voiding" | "voided" | "expired";

export interface ChequeMessageTypedData {
  domain: { name: string; version: string; chainId: number; verifyingContract: string };
  types: Record<string, TypedDataField[]>;
  primaryType: "Message";
  message: { hash: string };
}

export interface TreasuryCheque {
  id: number;
  to: string;
  toLabel: string | null;
  amount: string;
  validAfter: number;
  validBefore: number;
  nonce: string;
  digest: string;
  messageHash: string;
  typedData: ChequeMessageTypedData;
  memo: string | null;
  status: ChequeStatus;
  signatures: ConfirmationView[];
  required: number;
  voidProposalTxHash: string | null;
  proposer: string | null;
  createdAt: number;
  issuedAt: number | null;
  cashedAt: number | null;
}

export const getCheques = (address: string) => request<TreasuryCheque[]>(`/accounts/${address}/cheques`);
export const writeCheque = (address: string, body: { to: string; amount: string; memo?: string; validFor?: number }) =>
  request<TreasuryCheque>(`/accounts/${address}/cheques`, post(body));
export const signCheque = (address: string, id: number, body: { signerId: string; signature: string }) =>
  request<TreasuryCheque>(`/accounts/${address}/cheques/${id}/signatures`, post(body));
export const voidCheque = (address: string, id: number) => request<TreasuryCheque | void>(`/accounts/${address}/cheques/${id}/void`, post({}));

export const getApiKeys = (address: string) => request<ApiKey[]>(`/accounts/${address}/api-keys`);
export const mintApiKey = (address: string, name: string, scope: ApiKeyScope, expiresInDays: number) =>
  request<MintedApiKey>(`/accounts/${address}/api-keys`, post({ name, scope, expiresInDays }));
export const revokeApiKey = (address: string, id: number) =>
  request<void>(`/accounts/${address}/api-keys/${id}`, { method: "DELETE" });
