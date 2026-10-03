"use client";

import { useQuery, type QueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { BaseError, parseAbi } from "viem";
import { decodeContext, olienPublicClient as publicClient } from "@/lib/chain";
import { decodeCalls, outgoing, type RawCall } from "@/lib/signing";
import {
  errorMessage,
  getAccount,
  getAccounts,
  getAddressBook,
  getApiKeys,
  getChainInfo,
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
  type Hex,
  type ProposalStatus,
  type ProposalView,
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
};

// What the service this console is talking to can do. The console offers a thing only
// when the service names it, so it never shows a form the service cannot answer or
// promises an expiry the service does not keep.
export function useServiceFeatures(): (feature: string) => boolean {
  const info = useQuery({ queryKey: ["olien", "chain-info"], queryFn: getChainInfo, staleTime: 5 * 60_000 });
  const features = info.data?.features ?? [];
  return (feature) => features.includes(feature);
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
