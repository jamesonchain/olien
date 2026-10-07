#!/usr/bin/env node
// Watches Olien accounts for scheduled changes, asking only the chain.
//
//   node ops/watch-scheduled.mjs --rpc https://testnet-rpc.monad.xyz --chain-id 10143 \
//     --account 0x... [--account 0x...] [--interval 30] [--lookback 5000] [--webhook https://...]
//     [--from-block N] [--once]
//
// --from-block starts a v1 account's watch at an earlier block instead of the current
// one; --once looks once and exits, for a cron job or a check.
//
// A member who trusts the console trusts the service behind it to show every change
// that is waiting, and a service that hid one would be hiding the only window in which
// a veto helps. This script is the other pair of eyes: it reads the account itself and
// says, on its own output and to a webhook if given, what has been scheduled, what it
// does, when it can run, and when it died or ran. It needs the console's node_modules
// for viem and reads the console's own decoder, so what it prints is what the signing
// screen would have shown.
//
// A v2 account (docs/16) lists what it scheduled in getScheduledLog, so nothing is
// missed however the script is restarted. A v1 account is watched through its
// Scheduled events from the block the script started at, in chunks the RPC allows.

import { createPublicClient, http, parseAbi, decodeFunctionData, getAddress } from "../console/node_modules/viem/_esm/index.js";
import { decodeCalls, summarise } from "../console/lib/signing.ts";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const accounts = args.flatMap((a, i) => (a === "--account" ? [getAddress(args[i + 1])] : []));
const rpc = flag("rpc", null);
const chainId = Number(flag("chain-id", 10143));
const interval = Number(flag("interval", 30)) * 1000;
const lookback = BigInt(flag("lookback", 5000));
const chunk = BigInt(flag("chunk", 100));
const scheduledEvent = () => abi.find((e) => e.type === "event" && e.name === "Scheduled");
const webhook = flag("webhook", null);
const usdc = flag("usdc", null);
const fromBlock = flag("from-block", null);
const once = args.includes("--once");
if (!rpc || accounts.length === 0) {
  console.error("usage: node ops/watch-scheduled.mjs --rpc <url> --chain-id <id> --account 0x... [--account 0x...]");
  process.exit(2);
}

const client = createPublicClient({
  chain: { id: chainId, name: `chain ${chainId}`, nativeCurrency: { name: "gas", symbol: "gas", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } },
  transport: http(rpc),
});
const abi = parseAbi([
  "struct Call { address to; uint256 value; bytes data; }",
  "struct Transaction { uint192 nonceKey; Call[] calls; uint48 validAfter; uint48 validUntil; }",
  "struct ScheduledView { uint48 readyAt; uint64 epoch; uint8 path; bytes32 excluded; bytes32 callsHash; }",
  "struct ConfigView { uint16 threshold; uint16 vetoThreshold; uint16 effectiveVetoThreshold; uint16 signerCount; uint16 approverCount; uint16 vetoerCount; uint16 approverVetoerCount; uint16 recovererCount; uint48 configDelay; uint48 recoveryDelay; uint48 recoveryCoSignDelay; uint64 epoch; uint256 limitCount; bool implementationFrozen; }",
  "function OLIEN_VERSION() view returns (string)",
  "function getConfig() view returns (ConfigView)",
  "function getScheduled(bytes32 hash) view returns (ScheduledView)",
  "function getScheduledLog(uint256 from, uint256 limit) view returns (bytes32[])",
  "function isDead(bytes32 hash) view returns (bool)",
  "function execute(Transaction txn, bytes signatures)",
  "function executeScheduled(bytes32 hash, Call[] calls)",
  "event Scheduled(bytes32 indexed hash, uint48 readyAt, uint8 path, bytes32 excluded)",
]);
const ctx = (account) => ({ account, tokens: usdc ? [{ address: usdc, symbol: "USDC", decimals: 6 }] : [], native: { symbol: "gas", decimals: 18 } });
const when = (seconds) => new Date(Number(seconds) * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC";
const paths = { 1: "threshold", 2: "recovery" };

async function say(account, line, detail = {}) {
  const text = `${new Date().toISOString().slice(11, 19)} ${account} ${line}`;
  console.log(text);
  if (webhook) {
    await fetch(webhook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, account, ...detail }) }).catch((e) => console.error(`webhook: ${e.message}`));
  }
}

/// The calls behind a scheduled hash, found by walking back through the account's
/// Scheduled events to the transaction that scheduled it and reading its input.
async function callsBehind(account, hash, head) {
  for (let to = head; to > head - lookback && to > 0n; to -= chunk) {
    const from = to - chunk + 1n > 0n ? to - chunk + 1n : 0n;
    const logs = await client.getLogs({ address: account, event: scheduledEvent(), args: { hash }, fromBlock: from, toBlock: to });
    if (logs.length === 0) continue;
    const tx = await client.getTransaction({ hash: logs[0].transactionHash });
    try {
      const decoded = decodeFunctionData({ abi, data: tx.input });
      if (decoded.functionName === "execute") return decoded.args[0].calls;
    } catch {
      // A user operation or a relayer's own wrapper: the calls are not at the top of the input.
    }
    return null;
  }
  return null;
}

function describe(account, calls) {
  if (!calls) return "calls not found in the lookback window";
  const raw = calls.map((c) => ({ to: c.to, value: c.value.toString(), data: c.data }));
  return summarise(decodeCalls(raw, ctx(account)), ctx(account));
}

const state = new Map(accounts.map((a) => [a, { version: null, cursor: 0, block: null, pending: new Map() }]));

async function tick() {
  const head = await client.getBlockNumber();
  for (const account of accounts) {
    const st = state.get(account);
    try {
      if (st.version === null) {
        st.version = await client.readContract({ address: account, abi, functionName: "OLIEN_VERSION" }).catch(() => "1.0.0");
        st.block = fromBlock === null ? head : BigInt(fromBlock) - 1n;
        await say(account, `watching, Olien ${st.version}, from block ${st.block + 1n}`);
      }
      const fresh = [];
      if (st.version.startsWith("2")) {
        const page = await client.readContract({ address: account, abi, functionName: "getScheduledLog", args: [BigInt(st.cursor), 100n] });
        st.cursor += page.length;
        fresh.push(...page);
      } else {
        // The RPC caps a query at `chunk` blocks; ten in flight at a time keeps a long
        // catch-up to minutes rather than an hour.
        const ranges = [];
        for (let from = st.block + 1n; from <= head; from += chunk) {
          ranges.push([from, from + chunk - 1n < head ? from + chunk - 1n : head]);
        }
        for (let i = 0; i < ranges.length; i += 10) {
          const pages = await Promise.all(
            ranges.slice(i, i + 10).map(([from, to]) => client.getLogs({ address: account, event: scheduledEvent(), fromBlock: from, toBlock: to })),
          );
          for (const logs of pages) fresh.push(...logs.map((l) => l.args.hash));
        }
        st.block = head;
      }
      for (const hash of fresh) {
        const entry = await client.readContract({ address: account, abi, functionName: "getScheduled", args: [hash] });
        if (entry.readyAt === 0) continue;
        const calls = await callsBehind(account, hash, head);
        st.pending.set(hash, entry);
        await say(account, `SCHEDULED ${hash}\n    ${describe(account, calls)}\n    ${paths[entry.path] ?? entry.path} path, can run from ${when(entry.readyAt)} for 7 days, epoch ${entry.epoch}`, { hash, readyAt: Number(entry.readyAt), path: entry.path });
      }
      const config = await client.readContract({ address: account, abi, functionName: "getConfig" });
      for (const [hash, entry] of st.pending) {
        const now = await client.readContract({ address: account, abi, functionName: "getScheduled", args: [hash] });
        if (now.readyAt !== 0 && now.epoch === config.epoch) continue;
        const dead = await client.readContract({ address: account, abi, functionName: "isDead", args: [hash] });
        const fate = dead ? "VETOED or cancelled" : now.readyAt === 0 ? "RAN" : "STALE, the rules moved";
        await say(account, `${fate} ${hash}`, { hash, fate });
        st.pending.delete(hash);
      }
    } catch (e) {
      await say(account, `error: ${e.shortMessage ?? e.message}`);
    }
  }
}

await tick();
if (!once) setInterval(tick, interval);
