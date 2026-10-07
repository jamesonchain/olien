// A whole account life through a running service, with keys made for the run. The
// relayer pays about 0.05 of the gas token; the keys only sign messages.
//
//   node ops/live-check.mjs https://olien-service-production.up.railway.app
//
// RPC_URL and CHAIN_ID override the Monad testnet defaults.
import { readFileSync } from "node:fs";
import { createPublicClient, http, keccak256, parseAbi } from "../console/node_modules/viem/_esm/index.js";
import { privateKeyToAccount, generatePrivateKey } from "../console/node_modules/viem/_esm/accounts/index.js";
import { addressBookTypedData, loginMessage, transactionHash, transactionTypedData } from "../console/lib/signing.ts";

const API = (process.argv[2] ?? "").replace(/\/$/, "");
if (!API) { console.error("usage: node ops/live-check.mjs <service url>"); process.exit(2); }
const RPC = process.env.RPC_URL ?? "https://testnet-rpc.monad.xyz";
const CHAIN = Number(process.env.CHAIN_ID ?? 10143);
const RELAYER = (await (await fetch(`${API}/health`)).json()).relayer.address;
const book = JSON.parse(readFileSync(new URL("../deployments/v1/creation.json", import.meta.url), "utf8"));
const reader = createPublicClient({ chain: { id: CHAIN, name: "Monad Testnet", nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } }, transport: http(RPC) });
const views = parseAbi(["struct ConfigView { uint16 threshold; uint16 vetoThreshold; uint16 effectiveVetoThreshold; uint16 signerCount; uint16 approverCount; uint16 vetoerCount; uint16 approverVetoerCount; uint16 recovererCount; uint48 configDelay; uint48 recoveryDelay; uint48 recoveryCoSignDelay; uint64 epoch; uint256 limitCount; bool implementationFrozen; }", "function getConfig() view returns (ConfigView)"]);
const now = () => Math.floor(Date.now() / 1000);
const failures = [];
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : `\n     ${detail}`}`);
  if (!ok) failures.push(name);
};
const brief = (value) => JSON.stringify(value).slice(0, 300);
async function api(bearer, method, path, body) {
  const res = await fetch(`${API}${path}`, { method, headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json };
}
async function signIn(who) {
  const address = who.address.toLowerCase();
  const challenge = (await api(null, "POST", "/api/auth/wallet/challenge", { address })).body;
  const message = loginMessage(address, challenge.nonce, challenge.expiresAt);
  return (await api(null, "POST", "/api/auth/wallet", { address, nonce: challenge.nonce, signature: await who.signMessage({ message }) })).body.accessToken;
}
const signerId = (who) => `0x${"0".repeat(24)}${who.address.slice(2).toLowerCase()}`;
const [alice, bob, carol] = [generatePrivateKey(), generatePrivateKey(), generatePrivateKey()].map(privateKeyToAccount);
const session = new Map();
for (const who of [alice, bob, carol]) session.set(who.address, await signIn(who));
const as = (who) => session.get(who.address);

const before = await reader.getBalance({ address: RELAYER });
console.log(`relayer holds ${(Number(before) / 1e18).toFixed(4)} MON before`);
const started = Date.now();
const created = await api(as(alice), "POST", "/api/treasury/accounts", {
  name: `Service check ${new Date().toISOString().slice(0, 10)}`,
  signers: [{ kind: "ecdsa", address: alice.address.toLowerCase(), label: "A", permissions: ["approve", "veto"] }, { kind: "ecdsa", address: bob.address.toLowerCase(), label: "B", permissions: ["approve", "veto"] }],
  threshold: 2, vetoThreshold: 1, configDelay: 300, recoveryDelay: 86400, recoveryCoSignDelay: 0,
});
check(`an account is created on Monad through the relayer, in ${((Date.now() - started) / 1000).toFixed(0)}s`, created.status === 200 && created.body.status === "live", brief(created.body));
if (created.status !== 200) process.exit(1);
const account = created.body.address;
const base = `/api/treasury/accounts/${account}`;
console.log(`     ${account}  created in ${created.body.createTx}`);
check("its code on the chain is the one code every account has", keccak256(await reader.getCode({ address: account })) === book.accountCodeHash);
const config = await reader.readContract({ address: account, abi: views, functionName: "getConfig" });
check("and the chain holds the rules that were asked for", Number(config.threshold) === 2 && Number(config.vetoThreshold) === 1 && Number(config.configDelay) === 300 && Number(config.epoch) === 1, brief({ threshold: Number(config.threshold), epoch: Number(config.epoch) }));

const policy = await api(as(alice), "PUT", `${base}/policy`, { tiers: [{ above: "1000000000", approvals: 2 }], requireKnownDestination: true, newDestinationDelay: 3600 });
check("a policy is set and takes effect at once", policy.status === 200 && policy.body.policy.requireKnownDestination && policy.body.pending === null, brief(policy.body));
const addedAt = now();
const entry = { entry: "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc", label: "Acme Ltd", category: "Supplier", addedAt };
const signed = await api(as(bob), "POST", `${base}/address-book`, { address: entry.entry.toLowerCase(), label: entry.label, category: entry.category, signerId: signerId(bob), signature: await bob.signTypedData(addressBookTypedData(CHAIN, account, entry)), addedAt });
check("a member signs an address into the book", signed.status === 200 && signed.body.signerId === signerId(bob), brief(signed.body));
const key = await api(as(alice), "POST", `${base}/api-keys`, { name: "check", scope: "read", expiresInDays: 7 });
check("a key is minted with a last day", key.status === 200 && Math.round((key.body.expiresAt - key.body.createdAt) / 86400) === 7);

const proposed = await api(as(alice), "POST", `${base}/proposals/signers`, { add: [{ kind: "ecdsa", address: carol.address.toLowerCase(), label: "C", permissions: ["approve"] }], remove: [], replace: [] });
check("a rule change is proposed and the chain's delay is stated", proposed.status === 200 && proposed.body.hardRules?.[0]?.seconds === 300 && proposed.body.softRules?.length === 0, brief({ status: proposed.body?.status, hard: proposed.body?.hardRules, soft: proposed.body?.softRules }));
const approve = async (who) => {
  const fields = proposed.body.typedData.message;
  if (transactionHash(CHAIN, account, fields).toLowerCase() !== proposed.body.txHash.toLowerCase()) throw new Error("the console's hash is not the service's");
  return api(as(who), "POST", `${base}/proposals/${proposed.body.txHash}/confirmations`, { signerId: signerId(who), signature: await who.signTypedData(transactionTypedData(CHAIN, account, fields)) });
};
await approve(alice);
const ready = (await approve(bob)).body;
check("two approvals, signed as the console signs, make it ready", ready.status === "ready", brief({ status: ready?.status, approvals: ready?.approvals }));
const executing = Date.now();
const executed = await api(as(bob), "POST", `${base}/proposals/${proposed.body.txHash}/execute`);
check(`the relayer executes it and the chain schedules it, in ${((Date.now() - executing) / 1000).toFixed(0)}s`, executed.status === 200 && executed.body.status === "scheduled" && Math.abs((executed.body.scheduledReadyAt ?? 0) - (now() + 300)) < 120, brief({ status: executed.body?.status, readyAt: executed.body?.scheduledReadyAt, tx: executed.body?.executedTx }));
console.log(`     ${executed.body?.executedTx}`);

const trail = (await api(as(alice), "GET", `${base}/audit`)).body;
check("the audit trail holds every act, and holds together", trail?.intact === true && ["account.created", "policy.changed", "book.added", "key.minted", "proposal.opened", "proposal.approved", "proposal.executed"].every((action) => trail.rows.some((row) => row.action === action)), brief(trail?.rows?.map((row) => row.action)));
check("someone not yet a signer cannot open the account", (await api(as(carol), "POST", "/api/treasury/accounts/import", { address: account })).status === 403);
check("a signer opening it again gets the same account", (await api(as(bob), "POST", "/api/treasury/accounts/import", { address: account })).body?.name?.startsWith("Service check"));
const after = await reader.getBalance({ address: RELAYER });
console.log(`relayer holds ${(Number(after) / 1e18).toFixed(4)} MON after; the run cost ${(Number(before - after) / 1e18).toFixed(4)} MON`);
console.log(failures.length ? `\n${failures.length} check(s) failed.` : "\nEvery check passed.");
process.exit(failures.length ? 1 : 0);
