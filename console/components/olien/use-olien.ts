"use client";

import { useQuery, type QueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { BaseError, parseAbi, recoverAddress } from "viem";
import { chainSpec, decodeContext, olienPublicClient as publicClient } from "@/lib/chain";
import { verifyPasskeySignature } from "@/lib/passkey";
import { addressBookHash, decodeCalls, outgoing, type RawCall } from "@/lib/signing";
import {
  errorMessage,
  getAccount,
  getAccounts,
  getAddressBook,
  getApiKeys,
  getAudit,
  getChainInfo,
  getPolicy,
  getCheques,
  getPayrolls,
  getWebhookDeliveries,
  getWebhooks,
  getLedger,
  getProposal,
  getProposals,
  getScheduled,
  getVetoCall,
  nowSeconds,
  TreasuryError,
  type AccountView,
  type AddressBookEntry,
  type ChainInfo,
  type Hex,
  type ProposalStatus,
  type ProposalView,
  type SignerView,
} from "@/lib/treasury";

// Every open console page refetches on this cadence; the indexer refreshes views
// every 15 s, so 10 s keeps a member at most one interval behind the chain.
export const POLL_MS = 10_000;

export const olienKeys = {
  all: ["olien"] as const,
  accounts: ["olien", "accounts"] as const,
  account: (address: string) => ["olien", "account", address] as const,
  proposalsOf: (address: string) => ["olien", "proposals", address] as const,
  proposals: (address: string, statuses: string) => ["olien", "proposals", address, statuses] as const,
  proposal: (address: string, txHash: string) => ["olien", "proposal", address, txHash] as const,
  scheduled: (address: string) => ["olien", "scheduled", address] as const,
  vetoCall: (address: string, hash: string) => ["olien", "veto-call", address, hash] as const,
  ledger: (address: string, limit: number) => ["olien", "ledger", address, limit] as const,
  addressBook: (address: string) => ["olien", "address-book", address] as const,
  apiKeys: (address: string) => ["olien", "api-keys", address] as const,
  payrolls: (address: string) => ["olien", "payrolls", address] as const,
  cheques: (address: string) => ["olien", "cheques", address] as const,
  webhooks: (address: string) => ["olien", "webhooks", address] as const,
  deliveries: (address: string, id: number) => ["olien", "webhook-deliveries", address, id] as const,
  nativeBalance: (address: string) => ["olien", "native-balance", address] as const,
  policy: (address: string) => ["olien", "policy", address] as const,
  audit: (address: string) => ["olien", "audit", address] as const,
};

// What the service this console is talking to can do. The console offers a thing only
// when the service names it, so it never shows a form the service cannot answer or
// promises an expiry the service does not keep.
export function useServiceFeatures(): (feature: string) => boolean {
  const info = useQuery({ queryKey: ["olien", "chain-info"], queryFn: getChainInfo, staleTime: 5 * 60_000 });
  const features = info.data?.features ?? [];
  return (feature) => features.includes(feature);
}

export function useChainInfo() {
  return useQuery({ queryKey: ["olien", "chain-info"], queryFn: getChainInfo, staleTime: 5 * 60_000 });
}

// Which implementation an account runs: the address the service recorded for it, held
// against the ones the chain file names. v2 only where the service carries v2.
export function accountVersion(account: AccountView | undefined, chain: ChainInfo | undefined): "v1" | "v2" | null {
  if (!account || !chain) return null;
  const implementation = account.implementation.toLowerCase();
  if (chain.implementationV2 && implementation === chain.implementationV2.toLowerCase()) return "v2";
  if (chain.implementation && implementation === chain.implementation.toLowerCase()) return "v1";
  return null;
}

// v2's views (docs/16), read by this browser from its own RPC.
const V2_VIEWS = parseAbi([
  "struct ScheduledView { uint48 readyAt; uint64 epoch; uint8 path; bytes32 excluded; bytes32 callsHash; }",
  "function getState() view returns (uint48 inactivityDelay, uint48 lastActivity, bool policyOn)",
  "function getScheduledLog(uint256 from, uint256 limit) view returns (bytes32[])",
  "function getScheduled(bytes32 hash) view returns (ScheduledView)",
]);
const POLICY_VIEWS = parseAbi([
  "struct Policy { address token; uint128 tier; uint48 delay; bool requireKnown; bool learn; uint48 lockedUntil; }",
  "struct Call { address to; uint256 value; bytes data; }",
  "function policyOf(address account) view returns (Policy)",
  "function knownSince(address account, address to) view returns (uint48)",
  "function evaluate(Call[] calls) view returns (bool waits, uint48 delay)",
]);

export interface ChainPolicy {
  token: string;
  tier: bigint;
  delay: number;
  requireKnown: boolean;
  learn: boolean;
  lockedUntil: number;
  inactivityDelay: number;
  lastActivity: number;
  policyOn: boolean;
}

// The account's own transfer policy and what v2 keeps beside it, from the chain.
export function useChainPolicy(address: string, policyAddress: string | null | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ["olien", "chain-policy", address],
    enabled: enabled && Boolean(policyAddress),
    refetchInterval: 20_000,
    queryFn: async (): Promise<ChainPolicy> => {
      const [p, state] = await Promise.all([
        publicClient.readContract({ address: policyAddress as Hex, abi: POLICY_VIEWS, functionName: "policyOf", args: [address as Hex] }),
        publicClient.readContract({ address: address as Hex, abi: V2_VIEWS, functionName: "getState" }),
      ]);
      return { token: p.token, tier: p.tier, delay: Number(p.delay), requireKnown: p.requireKnown, learn: p.learn, lockedUntil: Number(p.lockedUntil), inactivityDelay: Number(state[0]), lastActivity: Number(state[1]), policyOn: state[2] };
    },
  });
}

// When the account came to know each of these addresses on the chain; zero for never.
export function useKnownOnChain(address: string, policyAddress: string | null | undefined, addresses: string[], enabled: boolean) {
  const key = addresses.map((a) => a.toLowerCase()).sort().join(",");
  return useQuery({
    queryKey: ["olien", "known-on-chain", address, key],
    enabled: enabled && Boolean(policyAddress),
    refetchInterval: 20_000,
    queryFn: async () => {
      const out = new Map<string, number>();
      for (const who of addresses) {
        const since = await publicClient.readContract({ address: policyAddress as Hex, abi: POLICY_VIEWS, functionName: "knownSince", args: [address as Hex, who as Hex] });
        out.set(who.toLowerCase(), Number(since));
      }
      return out;
    },
  });
}

// Whether the account's own policy would hold these calls, and for how long, asked of
// the policy contract the way the account asks it: a call from the account's address.
// The service is not consulted; a member sees the chain's own answer before signing.
export function useBrowserPolicyHold(address: string, policyAddress: string | null | undefined, calls: RawCall[], enabled: boolean) {
  const key = calls.map((call) => `${call.to}:${call.value}:${call.data}`).join("|");
  return useQuery({
    queryKey: ["olien", "policy-hold", address, key],
    enabled: enabled && Boolean(policyAddress),
    staleTime: 20_000,
    queryFn: async (): Promise<{ waits: boolean; delay: number }> => {
      const state = await publicClient.readContract({ address: address as Hex, abi: V2_VIEWS, functionName: "getState" });
      if (!state[2]) return { waits: false, delay: 0 };
      const [waits, delay] = await publicClient.readContract({
        address: policyAddress as Hex,
        abi: POLICY_VIEWS,
        functionName: "evaluate",
        args: [calls.map((call) => ({ to: call.to as Hex, value: BigInt(call.value), data: (call.data || "0x") as Hex }))],
        account: address as Hex,
      });
      return { waits, delay: Number(delay) };
    },
  });
}

export function useAccounts(enabled = true) {
  return useQuery({ queryKey: olienKeys.accounts, queryFn: getAccounts, refetchInterval: POLL_MS, enabled });
}

export function useOlienAccount(address: string | null) {
  return useQuery({
    queryKey: olienKeys.account(address ?? ""),
    queryFn: () => getAccount(address as string),
    refetchInterval: POLL_MS,
    enabled: Boolean(address),
  });
}

export function useProposals(address: string, statuses?: ProposalStatus[]) {
  const filter = statuses?.join(",") ?? "";
  return useQuery({
    queryKey: olienKeys.proposals(address, filter),
    queryFn: () => getProposals(address, statuses),
    refetchInterval: POLL_MS,
  });
}

export function useProposal(address: string, txHash: string) {
  return useQuery({
    queryKey: olienKeys.proposal(address, txHash),
    queryFn: () => getProposal(address, txHash),
    refetchInterval: POLL_MS,
  });
}

export function useScheduled(address: string) {
  return useQuery({
    queryKey: olienKeys.scheduled(address),
    queryFn: () => getScheduled(address),
    refetchInterval: POLL_MS,
  });
}

export function useVetoCall(address: string, hash: string, enabled: boolean) {
  return useQuery({
    queryKey: olienKeys.vetoCall(address, hash),
    queryFn: () => getVetoCall(address, hash),
    refetchInterval: POLL_MS,
    enabled,
  });
}

export function useLedger(address: string, limit = 100) {
  return useQuery({
    queryKey: olienKeys.ledger(address, limit),
    queryFn: () => getLedger(address, limit),
    refetchInterval: POLL_MS,
  });
}

export function useAddressBook(address: string) {
  return useQuery({ queryKey: olienKeys.addressBook(address), queryFn: () => getAddressBook(address) });
}

export function usePolicy(address: string, enabled: boolean) {
  return useQuery({ queryKey: olienKeys.policy(address), queryFn: () => getPolicy(address), refetchInterval: POLL_MS, enabled });
}

export function useAudit(address: string, enabled: boolean) {
  return useQuery({ queryKey: olienKeys.audit(address), queryFn: () => getAudit(address, 25), refetchInterval: POLL_MS, enabled });
}

export interface VerifiedEntry extends AddressBookEntry {
  // True only when this browser checked the entry's signature itself and found it to be
  // from a member who may approve payments.
  verified: boolean;
  signedBy: string | null;
}

async function verifyEntry(account: string, entry: AddressBookEntry, signers: SignerView[]): Promise<VerifiedEntry> {
  const unverified = { ...entry, verified: false, signedBy: null };
  if (!entry.signerId || !entry.signature || entry.addedAt == null) return unverified;
  const signer = signers.find((candidate) => candidate.signerId.toLowerCase() === entry.signerId?.toLowerCase());
  if (!signer || !signer.permissions.includes("approve")) return unverified;
  const hash = addressBookHash(chainSpec.id, account, { entry: entry.address, label: entry.label, category: entry.category ?? "", addedAt: entry.addedAt });
  const signature = entry.signature as Hex;
  let ok = false;
  try {
    if (signer.kind === "ecdsa" && signer.address) ok = (await recoverAddress({ hash, signature })).toLowerCase() === signer.address.toLowerCase();
    else if (signer.kind === "webauthn") ok = await verifyPasskeySignature(hash, signature, signer.x, signer.y);
    else if (signer.kind === "contract" && signer.address) ok = await publicClient.verifyHash({ address: signer.address as Hex, hash, signature });
  } catch {
    ok = false;
  }
  return ok ? { ...entry, verified: true, signedBy: signer.label || signer.signerId.slice(0, 10) } : unverified;
}

// The address book, with each entry's signature checked here. A label is somebody's
// claim about an address, and the service that stores the book is the one party that
// must not be able to make that claim, so a row counts only when a member's signature
// over the address, the label and the time checks out in this browser. A row without
// one, or with a signature from someone who is no longer a member, is unverified, and
// the screens treat its address as unknown.
export function useVerifiedBook(address: string, signers: SignerView[] | undefined) {
  const book = useAddressBook(address);
  const entries = book.data;
  const fingerprint = `${(entries ?? []).map((entry) => `${entry.address}:${entry.label}:${entry.signature ?? ""}`).join("|")}#${(signers ?? []).map((signer) => `${signer.signerId}:${signer.permissions.join("")}`).join("|")}`;
  const verified = useQuery({
    queryKey: ["olien", "verified-book", address, fingerprint],
    enabled: Boolean(entries && signers),
    staleTime: 60_000,
    queryFn: () => Promise.all((entries ?? []).map((entry) => verifyEntry(address, entry, signers ?? []))),
  });
  const list = verified.data ?? [];
  return {
    entries: list,
    known: new Map(list.filter((entry) => entry.verified).map((entry) => [entry.address.toLowerCase(), entry])),
    isLoading: book.isLoading || verified.isLoading,
    error: book.error ?? verified.error,
  };
}

// What to offer as a recipient is typed: the entries a member has signed, when the
// service signs entries at all, and otherwise the book as it stands.
export function useSuggestions(address: string): AddressBookEntry[] {
  const signed = useServiceFeatures()("signed-book");
  const account = useOlienAccount(address);
  const book = useVerifiedBook(address, account.data?.signers);
  return signed ? book.entries.filter((entry) => entry.verified) : book.entries;
}

const ACCOUNT_VIEWS = parseAbi([
  "struct ConfigView { uint16 threshold; uint16 vetoThreshold; uint16 effectiveVetoThreshold; uint16 signerCount; uint16 approverCount; uint16 vetoerCount; uint16 approverVetoerCount; uint16 recovererCount; uint48 configDelay; uint48 recoveryDelay; uint48 recoveryCoSignDelay; uint64 epoch; uint256 limitCount; bool implementationFrozen; }",
  "function getConfig() view returns (ConfigView)",
  "function getSigners() view returns (bytes32[])",
]);

// Whether the service's picture of an account is the chain's, asked by this browser of
// its own RPC: the epoch, the threshold and who the signers are. Those three decide
// what a signature is worth, and everything else on a page is built on them. Null
// while they agree, or the difference in words. The service's copy is up to a quarter
// of a minute behind a change, so a difference is reported only when it is still there
// the next time the chain is asked.
export function useChainAgreement(address: string, account: AccountView | undefined): string | null {
  const info = useChainInfo();
  const version = accountVersion(account, info.data);
  const scheduled = useScheduled(address);
  const chain = useQuery({
    queryKey: ["olien", "chain-view", address, version],
    enabled: Boolean(account),
    refetchInterval: 20_000,
    retry: 1,
    queryFn: async () => {
      const target = address as Hex;
      const [config, signers] = await Promise.all([
        publicClient.readContract({ address: target, abi: ACCOUNT_VIEWS, functionName: "getConfig" }),
        publicClient.readContract({ address: target, abi: ACCOUNT_VIEWS, functionName: "getSigners" }),
      ]);
      // A v2 account lists every hash it ever scheduled; the ones still waiting in this
      // epoch are what a service could be hiding, and the veto only helps while they wait.
      const waiting: string[] = [];
      if (version === "v2") {
        const log = await publicClient.readContract({ address: target, abi: V2_VIEWS, functionName: "getScheduledLog", args: [0n, 500n] });
        for (const hash of log) {
          const entry = await publicClient.readContract({ address: target, abi: V2_VIEWS, functionName: "getScheduled", args: [hash] });
          if (entry.readyAt !== 0 && Number(entry.epoch) === Number(config.epoch)) waiting.push(hash.toLowerCase());
        }
      }
      return { epoch: Number(config.epoch), threshold: Number(config.threshold), signers: signers.map((id) => id.toLowerCase()).sort(), waiting };
    },
  });
  const difference = (() => {
    if (!chain.data || !account) return null;
    if (chain.data.epoch !== account.epoch) return `the epoch is ${chain.data.epoch} on the chain and ${account.epoch} here`;
    if (chain.data.threshold !== account.threshold) return `the threshold is ${chain.data.threshold} on the chain and ${account.threshold} here`;
    const here = account.signers.map((signer) => signer.signerId.toLowerCase()).sort();
    if (here.length !== chain.data.signers.length || here.some((id, index) => id !== chain.data.signers[index])) return "the signers on the chain are not the signers shown here";
    if (scheduled.data) {
      const shown = new Set(scheduled.data.map((proposal) => proposal.txHash.toLowerCase()));
      const hidden = chain.data.waiting.find((hash) => !shown.has(hash));
      if (hidden) return `the chain holds a scheduled change this service does not show, ${hidden}`;
    }
    return null;
  })();
  const [streak, setStreak] = useState(0);
  const asked = chain.dataUpdatedAt;
  useEffect(() => {
    if (asked) setStreak((count) => (difference ? count + 1 : 0));
    // Counted once per answer from the chain, not once per render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asked]);
  return difference && streak >= 2 ? difference : null;
}

export function useApiKeys(address: string) {
  return useQuery({ queryKey: olienKeys.apiKeys(address), queryFn: () => getApiKeys(address) });
}

export function useWebhooks(address: string) {
  return useQuery({ queryKey: olienKeys.webhooks(address), queryFn: () => getWebhooks(address), refetchInterval: POLL_MS });
}

export function useWebhookDeliveries(address: string, id: number, enabled: boolean) {
  return useQuery({ queryKey: olienKeys.deliveries(address, id), queryFn: () => getWebhookDeliveries(address, id), refetchInterval: POLL_MS, enabled });
}

export function useCheques(address: string) {
  return useQuery({ queryKey: olienKeys.cheques(address), queryFn: () => getCheques(address), refetchInterval: POLL_MS });
}

export function usePayrolls(address: string) {
  return useQuery({ queryKey: olienKeys.payrolls(address), queryFn: () => getPayrolls(address), refetchInterval: POLL_MS });
}

// On Arc the native balance is USDC (18 decimals); it is what a member's own wallet
// spends on gas when it vetoes.
export function useNativeBalance(address: string | null | undefined) {
  return useQuery({
    queryKey: olienKeys.nativeBalance(address ?? ""),
    queryFn: () => publicClient.getBalance({ address: address as Hex }),
    enabled: Boolean(address),
    refetchInterval: 15_000,
  });
}

export interface BrowserSimulation {
  ran: number;
  // Calls to the account itself: they run after their delay, as the account, and
  // cannot be run from outside it.
  skipped: number;
  failures: { index: number; reason: string }[];
  short: { symbol: string; decimals: number; needs: bigint; holds: bigint }[];
  checkedAt: number;
}

const BALANCE_OF = parseAbi(["function balanceOf(address owner) view returns (uint256)"]);

// A revert is an answer; a chain that cannot be reached is not. Only the first is a
// verdict on the transaction, so the second is thrown for the query to report.
function revertReason(cause: unknown): string {
  if (cause instanceof BaseError) {
    if (cause.walk((error) => error instanceof Error && (error.name === "HttpRequestError" || error.name === "TimeoutError"))) throw cause;
    const reverted = cause.walk((error) => error instanceof Error && error.name === "ExecutionRevertedError");
    const reason = reverted instanceof BaseError ? reverted.shortMessage : cause.shortMessage;
    return reason.replace(/^Execution reverted with reason: /, "").replace(/\.$/, "");
  }
  throw cause;
}

// The transaction's calls, run by this browser against the chain it is built for, from
// the account's own address. The service runs them too and reports a verdict, but a
// verdict is a claim, and the security model's defence against a service that lies
// about what calldata does is that the client runs it. Each call is run on its own
// against the chain as it stands, so a batch whose later call needs an earlier one can
// read as failing; what the account holds is checked against the whole batch at once.
export function useBrowserSimulation(address: string, calls: RawCall[], enabled: boolean) {
  const key = calls.map((call) => `${call.to}:${call.value}:${call.data}`).join("|");
  return useQuery({
    queryKey: ["olien", "simulation", address, key],
    enabled,
    staleTime: 20_000,
    refetchInterval: 30_000,
    retry: 1,
    queryFn: async (): Promise<BrowserSimulation> => {
      const account = address as Hex;
      const failures: BrowserSimulation["failures"] = [];
      let ran = 0;
      let skipped = 0;
      for (const [index, call] of calls.entries()) {
        if (call.to.toLowerCase() === address.toLowerCase()) {
          skipped += 1;
          continue;
        }
        ran += 1;
        try {
          await publicClient.call({ account, to: call.to as Hex, data: (call.data || "0x") as Hex, value: BigInt(call.value) });
        } catch (cause) {
          failures.push({ index, reason: revertReason(cause) });
        }
      }
      const short: BrowserSimulation["short"] = [];
      for (const sum of outgoing(decodeCalls(calls, decodeContext(address)))) {
        const holds = sum.token ? await publicClient.readContract({ address: sum.token.address as Hex, abi: BALANCE_OF, functionName: "balanceOf", args: [account] }) : await publicClient.getBalance({ address: account });
        if (holds < sum.amount) short.push({ symbol: sum.token?.symbol ?? decodeContext(address).native.symbol, decimals: sum.token?.decimals ?? decodeContext(address).native.decimals, needs: sum.amount, holds });
      }
      return { ran, skipped, failures, short, checkedAt: nowSeconds() };
    },
  });
}

export function useNow(): number {
  const [now, setNow] = useState(nowSeconds);
  useEffect(() => {
    const timer = setInterval(() => setNow(nowSeconds()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

// After a write the service answers with the proposal as the chain shows it; put it
// in the cache and let every dependent view refetch.
export function applyProposal(queryClient: QueryClient, address: string, view: ProposalView) {
  queryClient.setQueryData(olienKeys.proposal(address, view.txHash), view);
  void queryClient.invalidateQueries({ queryKey: olienKeys.account(address) });
  void queryClient.invalidateQueries({ queryKey: olienKeys.proposalsOf(address) });
  void queryClient.invalidateQueries({ queryKey: olienKeys.scheduled(address) });
  void queryClient.invalidateQueries({ queryKey: olienKeys.accounts });
}

export function accountError(error: unknown): string {
  if (error instanceof TreasuryError && error.status === 403) {
    return "You are not a member of this Olien. It shows up once a member adds your wallet as a signer.";
  }
  if (error instanceof TreasuryError && error.status === 404) return "No Olien at this address.";
  return errorMessage(error);
}

const LAST_ACCOUNT = "olien.lastAccount";

export function rememberAccount(address: string) {
  try {
    window.localStorage.setItem(LAST_ACCOUNT, address.toLowerCase());
  } catch {
    // Storage can be blocked (private mode, disabled site data); the console works without it.
  }
}

export function lastAccount(): string | null {
  try {
    return window.localStorage.getItem(LAST_ACCOUNT);
  } catch {
    return null;
  }
}

export const ACTIVE_STATUSES: ProposalStatus[] = ["open", "ready", "blocked", "executing"];
export const CLOSED_STATUSES: ProposalStatus[] = ["vetoed", "cancelled", "replaced", "stale", "expired", "failed"];
