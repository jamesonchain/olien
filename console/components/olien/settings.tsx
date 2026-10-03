"use client";

import { useQueryClient } from "@tanstack/react-query";
import { ArrowDownLeft, ArrowUpRight, Download, KeyRound, Lock, Plus, Radio, Send, Trash2, TriangleAlert } from "lucide-react";
import { encodeFunctionData } from "viem";
import { useSendTransaction } from "wagmi";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { olienUsdcAddress as usdcAddress } from "@/lib/chain";
import {
  addAddressBookEntry,
  durationLabel,
  errorMessage,
  formatDay,
  formatLedgerAmount,
  formatNative,
  formatTime,
  formatUsdc,
  getLedger,
  isValidAddress,
  nowSeconds,
  ledgerCsv,
  parseUsdc,
  proposeLimit,
  proposeRemoveLimit,
  proposeSigners,
  shortAddress,
  type AccountView,
  type LedgerEntry,
  type ProposalView,
  type SpendingLimit,
  renameAccount,
  createSubAccount,
  planSpend,
  submitOperation,
  type Hex,
  mintApiKey,
  revokeApiKey,
  createWebhook,
  deleteWebhook,
  enableWebhook,
  testWebhook,
  type Webhook,
  type WebhookTopic,
  type CreatedWebhook,
  type ApiKey,
  type ApiKeyScope,
  type MintedApiKey,
} from "@/lib/treasury";
import { AddressChip, Button, CopyButton, cx, DurationInput, EmptyState, Field, InlineError, KeyValue, Loading, Note, Panel, Pill, plural, Table, Tabs, TxChip } from "./ui";
import { accountError, applyProposal, olienKeys, useAddressBook, useApiKeys, useLedger, useOlienAccount, useServiceFeatures, useWebhookDeliveries, useWebhooks } from "./use-olien";
import { AddressInput } from "./recipients";
import { friendlyWalletError, useOlienChain, useWalletSession, walletSigner } from "./wallet";
import { chainName, chainSpec, olienPublicClient } from "@/lib/chain";
import { checkOperation, OLIEN_ABI } from "@/lib/signing";
import { friendlyPasskeyError, knownPasskeys, passkeySupported, signWithPasskey } from "@/lib/passkey";
import { delayWarnings } from "@/lib/resilience";

const HOUR = 3_600;
const DAY = 86_400;
const MAX_DELAY = 30 * DAY;

function useRouteToProposal(address: string) {
  const router = useRouter();
  const queryClient = useQueryClient();
  return (view: ProposalView) => {
    applyProposal(queryClient, address, view);
    router.push(`/${address}/transactions/${view.txHash}`);
  };
}

function TimeLockNote({ account }: { account: AccountView }) {
  return (
    <Note tone="info" icon={<Lock size={14} />}>
      This change waits {durationLabel(account.configDelay)} after execution and {plural(account.effectiveVetoThreshold, "veto", "vetoes")} stop it.
    </Note>
  );
}

function AddressesSection({ account }: { account: AccountView }) {
  return (
    <Panel title="Name and addresses">
      <KeyValue
        items={[
          { label: "Name", value: account.name },
          { label: "Olien address", value: <AddressChip address={account.address} /> },
          {
            label: "Implementation",
            value: (
              <span className="olien-inline">
                <AddressChip address={account.implementation} />
                <Pill tone={account.implementationFrozen ? "gray" : "blue"}>{account.implementationFrozen ? "Frozen" : "Upgradable"}</Pill>
              </span>
            ),
          },
          { label: "Epoch", value: String(account.epoch) },
          { label: "Entry point deposit", value: formatNative(BigInt(account.entryPointDeposit || "0")) },
          { label: "Chain", value: account.chainId === chainSpec.id ? `${chainName} (${account.chainId})` : `Chain ${account.chainId}, but this console is built for ${chainName} (${chainSpec.id})` },
          { label: "Created", value: account.createTx ? <TxChip hash={account.createTx} /> : formatTime(account.createdAt) },
        ]}
      />
      <RenameForm account={account} />
    </Panel>
  );
}

function TimeLockSection({ address, account }: { address: string; account: AccountView }) {
  const go = useRouteToProposal(address);
  const [editing, setEditing] = useState(false);
  const [configDelay, setConfigDelay] = useState(account.configDelay);
  const [recoveryDelay, setRecoveryDelay] = useState(account.recoveryDelay);
  const [recoveryCoSignDelay, setRecoveryCoSignDelay] = useState(account.recoveryCoSignDelay);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recoverers = account.signers.filter((signer) => signer.permissions.includes("recover")).length;
  const warnings = delayWarnings({ configDelay, recoveryDelay, recoverers });
  const live = delayWarnings({ configDelay: account.configDelay, recoveryDelay: account.recoveryDelay, recoverers });

  async function submit() {
    setError(null);
    if (configDelay === account.configDelay && recoveryDelay === account.recoveryDelay && recoveryCoSignDelay === account.recoveryCoSignDelay) return setError("Nothing has changed yet.");
    if ([configDelay, recoveryDelay, recoveryCoSignDelay].some((seconds) => seconds > MAX_DELAY)) return setError("A delay cannot exceed 30 days.");
    if (recoverers > 0 && recoveryDelay < HOUR) return setError("With a recover member the recovery delay must be at least 1 hour.");
    setBusy(true);
    try {
      go(await proposeSigners(address, { add: [], remove: [], replace: [], delays: { configDelay, recoveryDelay, recoveryCoSignDelay } }));
    } catch (cause) {
      setError(errorMessage(cause));
      setBusy(false);
    }
  }

  return (
    <Panel
      title="Time lock"
      action={
        !editing ? (
          <Button size="sm" disabled={account.status !== "live"} onClick={() => setEditing(true)}>
            Change
          </Button>
        ) : null
      }
    >
      {!editing ? (
        <>
          <KeyValue
            items={[
              { label: "Config delay", value: durationLabel(account.configDelay) },
              { label: "Recovery delay", value: durationLabel(account.recoveryDelay) },
              { label: "Recovery co-sign delay", value: durationLabel(account.recoveryCoSignDelay) },
            ]}
          />
          {live.configDelay || live.recoveryDelay ? (
            <Note tone="warn" icon={<TriangleAlert size={14} />}>
              {[live.configDelay, live.recoveryDelay].filter(Boolean).join(" ")}
            </Note>
          ) : null}
        </>
      ) : (
        <>
          <div className="olien-form-grid">
            <Field label="Config delay" hint="Member, threshold and time lock changes wait this long after execution." error={warnings.configDelay}>
              <DurationInput value={configDelay} disabled={busy} onChange={setConfigDelay} />
            </Field>
            <Field label="Recovery delay" hint="A recovery by a recover member alone waits this long. At least 1 hour when a recover member exists." error={warnings.recoveryDelay}>
              <DurationInput value={recoveryDelay} disabled={busy} onChange={setRecoveryDelay} />
            </Field>
            <Field label="Recovery co-sign delay" hint="A recovery co-signed by an approver waits this long.">
              <DurationInput value={recoveryCoSignDelay} disabled={busy} onChange={setRecoveryCoSignDelay} />
            </Field>
          </div>
          <TimeLockNote account={account} />
          <InlineError message={error} />
          <div className="olien-actions">
            <Button variant="primary" busy={busy} onClick={() => void submit()}>
              Create transaction
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </>
      )}
    </Panel>
  );
}

const PERIODS: { seconds: number; label: string }[] = [
  { seconds: DAY, label: "Every day" },
  { seconds: 7 * DAY, label: "Every week" },
  { seconds: 30 * DAY, label: "Every 30 days" },
  { seconds: 0, label: "One time, no reset" },
];

function periodLabel(seconds: number): string {
  if (seconds === 0) return "one time";
  return `per ${durationLabel(seconds)}`;
}

function LimitForm({ address, account, onClose }: { address: string; account: AccountView; onClose: () => void }) {
  const go = useRouteToProposal(address);
  const [amount, setAmount] = useState("");
  const [period, setPeriod] = useState(DAY);
  const [signers, setSigners] = useState<string[]>([]);
  const [anyDestination, setAnyDestination] = useState(true);
  const [destinations, setDestinations] = useState<string[]>([""]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    const units = parseUsdc(amount);
    if (!units) return setError("Enter an amount in USDC with at most 6 decimals.");
    if (signers.length === 0) return setError("Pick at least one member who may spend under this limit.");
    const list = destinations.map((value) => value.trim()).filter(Boolean);
    if (!anyDestination) {
      if (list.length === 0) return setError("Add at least one destination, or allow any destination.");
      for (const [index, value] of list.entries()) if (!isValidAddress(value)) return setError(`Destination ${index + 1} needs a valid address.`);
    }
    setBusy(true);
    try {
      go(await proposeLimit(address, { token: usdcAddress, amount: units, period, anyDestination, signers, destinations: anyDestination ? [] : list.map((value) => value.toLowerCase()) }));
    } catch (cause) {
      setError(errorMessage(cause));
      setBusy(false);
    }
  }

  return (
    <div className="olien-subform">
      <div className="olien-form-grid">
        <Field label="Amount (USDC)">
          <input className="olien-input num" value={amount} inputMode="decimal" placeholder="500.00" disabled={busy} onChange={(event) => setAmount(event.target.value)} />
        </Field>
        <Field label="Period" hint={period === 0 ? "Spent once; nothing refills." : "Refills in full when the window resets, whatever was spent just before it, so the true cap across one reset is twice the amount."}>
          <select className="olien-input" value={period} disabled={busy} onChange={(event) => setPeriod(Number(event.target.value))}>
            {PERIODS.map((entry) => (
              <option key={entry.seconds} value={entry.seconds}>
                {entry.label}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="olien-field">
        <span className="olien-field-label">Who may spend alone</span>
        <div className="olien-checks">
          {account.signers.map((signer) => (
            <label key={signer.signerId} className="olien-check">
              <input
                type="checkbox"
                checked={signers.includes(signer.signerId)}
                disabled={busy}
                onChange={(event) => setSigners((current) => (event.target.checked ? [...current, signer.signerId] : current.filter((id) => id !== signer.signerId)))}
              />
              {signer.label} {signer.address ? <code className="olien-muted">{shortAddress(signer.address)}</code> : null}
            </label>
          ))}
        </div>
      </div>
      <div className="olien-field">
        <span className="olien-field-label">Destinations</span>
        <div className="olien-checks">
          <label className="olien-check">
            <input type="radio" name="olien-limit-destinations" checked={anyDestination} disabled={busy} onChange={() => setAnyDestination(true)} /> Any destination
          </label>
          <label className="olien-check">
            <input type="radio" name="olien-limit-destinations" checked={!anyDestination} disabled={busy} onChange={() => setAnyDestination(false)} /> Only these addresses
          </label>
        </div>
        {!anyDestination ? (
          <div className="olien-address-rows">
            {destinations.map((value, index) => (
              <div key={index} className="olien-address-row">
                <input className="olien-input olien-input--mono" value={value} placeholder="0x" spellCheck={false} disabled={busy} onChange={(event) => setDestinations((current) => current.map((entry, i) => (i === index ? event.target.value.trim() : entry)))} />
                <button type="button" className="olien-icon-btn" aria-label={`Remove destination ${index + 1}`} disabled={busy || destinations.length === 1} onClick={() => setDestinations((current) => current.filter((_, i) => i !== index))}>
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
            <Button size="sm" icon={<Plus size={13} />} disabled={busy} onClick={() => setDestinations((current) => [...current, ""])}>
              Add destination
            </Button>
          </div>
        ) : null}
      </div>
      <TimeLockNote account={account} />
      <InlineError message={error} />
      <div className="olien-actions">
        <Button variant="primary" busy={busy} onClick={() => void submit()}>
          Create transaction
        </Button>
        <Button variant="ghost" disabled={busy} onClick={onClose}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

// Paying from a limit without the threshold. A wallet signer sends the call itself
// and pays its own gas; a passkey signs an operation the relayer submits and the
// Olien pays. Either way the service has already checked the limit would allow it.
function SpendForm({ address, account, limit, onClose }: { address: string; account: AccountView; limit: SpendingLimit; onClose: () => void }) {
  const queryClient = useQueryClient();
  const wallet = useWalletSession();
  const ensureChain = useOlienChain();
  const { sendTransactionAsync } = useSendTransaction();
  const book = useAddressBook(address);
  const [to, setTo] = useState(limit.anyDestination ? "" : (limit.destinations[0] ?? ""));
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState<"wallet" | "passkey" | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const named = new Set(limit.signers.map((id) => id.toLowerCase()));
  const mySigner = walletSigner(account, wallet.address);
  const byWallet = Boolean(wallet.matches && mySigner && named.has(mySigner.signerId.toLowerCase()));
  const mine = new Set(knownPasskeys().map((record) => record.signerId.toLowerCase()));
  const passkeys = account.signers.filter((signer) => signer.kind === "webauthn" && named.has(signer.signerId.toLowerCase()) && mine.has(signer.signerId.toLowerCase()));
  const byPasskey = passkeys.length > 0 && passkeySupported();

  function checked(): { to: string; amount: string } | string {
    if (!isValidAddress(to)) return "The recipient needs a valid address.";
    const units = parseUsdc(amount);
    if (!units) return "The amount is in USDC with at most 6 decimals.";
    if (BigInt(units) > BigInt(limit.remaining)) return `Only ${formatUsdc(limit.remaining)} is left on this limit.`;
    return { to: to.toLowerCase(), amount: units };
  }

  // spend(id, to, amount) on this account, from what was typed in this form. Both ways
  // of paying send or sign exactly this and nothing the service wrote.
  const spendData = (input: { to: string; amount: string }) => encodeFunctionData({ abi: OLIEN_ABI, functionName: "spend", args: [BigInt(limit.id), input.to as Hex, BigInt(input.amount)] });

  async function finish(tx: string) {
    setSent(tx);
    // The indexer sees the Spent event within an interval; the balance and the
    // ledger follow it.
    await queryClient.invalidateQueries({ queryKey: olienKeys.all });
  }

  async function payWithWallet() {
    const input = checked();
    if (typeof input === "string" || !mySigner) return setError(typeof input === "string" ? input : null);
    setError(null);
    setBusy("wallet");
    try {
      // The service is asked only whether the limit allows it; its answer carries a
      // call, and that call is not the one sent.
      await planSpend(address, limit.id, { ...input, signerId: mySigner.signerId });
      await ensureChain();
      const tx = await sendTransactionAsync({ to: address as Hex, data: spendData(input) });
      await finish(tx);
    } catch (cause) {
      setError(friendlyWalletError(cause));
    } finally {
      setBusy(null);
    }
  }

  async function payWithPasskey() {
    const input = checked();
    const first = passkeys[0];
    if (typeof input === "string" || !first) return setError(typeof input === "string" ? input : null);
    setError(null);
    setBusy("passkey");
    try {
      const plan = await planSpend(address, limit.id, { ...input, signerId: first.signerId });
      if (!plan.operation) throw new Error("The service did not prepare an operation for this signer.");
      // A passkey signs whatever hash it is handed and shows its holder nothing, so
      // the hash is computed here, from an operation checked to be this spend alone.
      const gasPrice = await olienPublicClient.getGasPrice().catch(() => null);
      const operation = checkOperation({ chainId: chainSpec.id, account: address, operation: plan.operation.operation, expected: spendData(input), now: nowSeconds(), gasPrice });
      const signed = await signWithPasskey(operation.hash, passkeys.map((signer) => ({ signerId: signer.signerId, x: signer.x, y: signer.y })));
      const receipt = await submitOperation(address, { operation: plan.operation.operation, signerId: signed.signerId, signature: signed.signature });
      await finish(receipt.txHash);
    } catch (cause) {
      setError(friendlyPasskeyError(cause));
    } finally {
      setBusy(null);
    }
  }

  if (sent) {
    return (
      <div className="olien-confirm">
        <span className="olien-ok">
          Paid. <TxChip hash={sent} />
        </span>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Done
        </Button>
      </div>
    );
  }

  return (
    <div className="olien-spend-form">
      <div className="olien-form-grid">
        <Field label="To" className="olien-field--wide">
          {limit.anyDestination ? (
            <AddressInput value={to} book={book.data ?? []} disabled={busy != null} onChange={(value) => setTo(value.trim())} onPick={(entry) => setTo(entry.address)} />
          ) : (
            <select className="olien-input" value={to} disabled={busy != null} onChange={(event) => setTo(event.target.value)}>
              {limit.destinations.map((destination) => (
                <option key={destination} value={destination}>
                  {book.data?.find((entry) => entry.address.toLowerCase() === destination.toLowerCase())?.label ?? shortAddress(destination)}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Amount (USDC)">
          <input className="olien-input num" value={amount} inputMode="decimal" placeholder="250.00" disabled={busy != null} onChange={(event) => setAmount(event.target.value)} />
        </Field>
      </div>
      <InlineError message={error} />
      <div className="olien-actions">
        {byWallet ? (
          <Button variant="primary" size="sm" icon={<Send size={12} />} busy={busy === "wallet"} disabled={busy != null} onClick={() => void payWithWallet()}>
            {busy === "wallet" ? "Confirm in wallet" : "Pay from wallet"}
          </Button>
        ) : null}
        {byPasskey ? (
          <Button variant="primary" size="sm" icon={<KeyRound size={12} />} busy={busy === "passkey"} disabled={busy != null} onClick={() => void payWithPasskey()}>
            {busy === "passkey" ? "Touch ID" : "Pay with passkey"}
          </Button>
        ) : null}
        <Button variant="ghost" size="sm" disabled={busy != null} onClick={onClose}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function LimitRow({ address, account, limit }: { address: string; account: AccountView; limit: SpendingLimit }) {
  const go = useRouteToProposal(address);
  const wallet = useWalletSession();
  const [confirm, setConfirm] = useState(false);
  const [paying, setPaying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Whether this browser can pay from the limit: its wallet is a named spender, or it
  // holds a passkey that is.
  const named = new Set(limit.signers.map((id) => id.toLowerCase()));
  const mySigner = walletSigner(account, wallet.address);
  const mine = new Set(knownPasskeys().map((record) => record.signerId.toLowerCase()));
  const canPay =
    account.status === "live" &&
    BigInt(limit.remaining || "0") > 0n &&
    (Boolean(wallet.matches && mySigner && named.has(mySigner.signerId.toLowerCase())) ||
      account.signers.some((signer) => signer.kind === "webauthn" && named.has(signer.signerId.toLowerCase()) && mine.has(signer.signerId.toLowerCase())));
  const labelOf = (signerId: string) => account.signers.find((signer) => signer.signerId.toLowerCase() === signerId.toLowerCase())?.label ?? shortAddress(signerId);
  const from = limit.from && limit.from !== "0x0000000000000000000000000000000000000000" && limit.from.toLowerCase() !== account.address.toLowerCase() ? account.subAccounts.find((sub) => sub.address.toLowerCase() === limit.from.toLowerCase())?.label ?? shortAddress(limit.from) : null;

  async function remove() {
    setError(null);
    setBusy(true);
    try {
      go(await proposeRemoveLimit(address, { id: limit.id }));
    } catch (cause) {
      setError(errorMessage(cause));
      setBusy(false);
    }
  }

  return (
    <li className="olien-limit">
      <div className="olien-limit-main">
        <strong className="num">
          {formatUsdc(limit.amount)} {periodLabel(limit.period)}
        </strong>
        <span className="olien-muted num">
          {formatUsdc(limit.remaining)} left{limit.period > 0 ? `, resets ${formatTime(limit.resetAt)}` : ""}
        </span>
        <span>
          Spenders: {limit.signers.length ? limit.signers.map(labelOf).join(", ") : "none"}
          {from ? ` from ${from}` : ""}
        </span>
        <span className="olien-inline">
          Destinations: {limit.anyDestination ? "any" : limit.destinations.length ? limit.destinations.map((to) => <AddressChip key={to} address={to} />) : "none yet"}
        </span>
        <small className="olien-muted">Limit {limit.id}, generation {limit.generation}</small>
        <InlineError message={error} />
        {paying ? <SpendForm address={address} account={account} limit={limit} onClose={() => setPaying(false)} /> : null}
      </div>
      <div className="olien-limit-actions">
        {canPay && !paying && !confirm ? (
          <Button size="sm" icon={<Send size={13} />} onClick={() => setPaying(true)}>
            Pay
          </Button>
        ) : null}
        {!confirm ? (
          <Button variant="ghost" size="sm" icon={<Trash2 size={13} />} disabled={account.status !== "live" || paying} onClick={() => setConfirm(true)}>
            Remove
          </Button>
        ) : (
          <div className="olien-confirm">
            <span>Remove this limit? It takes effect as soon as the threshold approves, with no delay.</span>
            <Button variant="danger" size="sm" busy={busy} onClick={() => void remove()}>
              Create transaction
            </Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirm(false)}>
              Keep
            </Button>
          </div>
        )}
      </div>
    </li>
  );
}

function LimitsSection({ address, account }: { address: string; account: AccountView }) {
  const [creating, setCreating] = useState(false);
  return (
    <Panel
      title="Spending limits"
      action={
        !creating ? (
          <Button size="sm" icon={<Plus size={13} />} disabled={account.status !== "live"} onClick={() => setCreating(true)}>
            Create spending limit
          </Button>
        ) : null
      }
    >
      <p className="olien-panel-lead">A named member pays alone up to the amount per period, without the threshold. The period is a fixed window that refills on a clock, so across one reset up to twice the amount can move. Creating one is a configuration change behind the time lock; removing one runs at once.</p>
      {creating ? <LimitForm address={address} account={account} onClose={() => setCreating(false)} /> : null}
      {account.limits.length === 0 ? (
        <EmptyState title="No spending limits" hint="Every payment needs the threshold until a limit names a member." />
      ) : (
        <ul className="olien-limits">
          {account.limits.map((limit) => (
            <LimitRow key={`${limit.id}-${limit.generation}`} address={address} account={account} limit={limit} />
          ))}
        </ul>
      )}
    </Panel>
  );
}

function AddressBookSection({ address }: { address: string }) {
  const book = useAddressBook(address);
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [entryAddress, setEntryAddress] = useState("");
  const [label, setLabel] = useState("");
  const [category, setCategory] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    if (!isValidAddress(entryAddress)) return setError("Enter a valid address.");
    if (!label.trim()) return setError("Give the address a label.");
    setBusy(true);
    try {
      await addAddressBookEntry(address, { address: entryAddress.toLowerCase(), label: label.trim(), ...(category.trim() ? { category: category.trim() } : {}) });
      await queryClient.invalidateQueries({ queryKey: olienKeys.addressBook(address) });
      setEntryAddress("");
      setLabel("");
      setCategory("");
      setAdding(false);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  const entries = book.data ?? [];

  return (
    <Panel
      title="Address book"
      action={
        !adding ? (
          <Button size="sm" icon={<Plus size={13} />} onClick={() => setAdding(true)}>
            Add address
          </Button>
        ) : null
      }
    >
      {adding ? (
        <div className="olien-subform">
          <div className="olien-form-grid olien-form-grid--3">
            <Field label="Address">
              <input className="olien-input olien-input--mono" value={entryAddress} placeholder="0x" spellCheck={false} disabled={busy} onChange={(event) => setEntryAddress(event.target.value.trim())} />
            </Field>
            <Field label="Label">
              <input className="olien-input" value={label} placeholder="Acme Ltd" disabled={busy} onChange={(event) => setLabel(event.target.value)} />
            </Field>
            <Field label="Category (optional)">
              <input className="olien-input" value={category} placeholder="Supplier" disabled={busy} onChange={(event) => setCategory(event.target.value)} />
            </Field>
          </div>
          <InlineError message={error} />
          <div className="olien-actions">
            <Button variant="primary" busy={busy} onClick={() => void submit()}>
              Save
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
      {book.isLoading ? (
        <Loading label="Loading the address book" />
      ) : book.error ? (
        <InlineError message={errorMessage(book.error)} />
      ) : entries.length === 0 ? (
        <EmptyState title="No saved addresses" hint="Labels show in the ledger and as suggestions when you send." />
      ) : (
        <Table head={["Label", "Address", "Category"]}>
          {entries.map((entry) => (
            <tr key={entry.address}>
              <td>
                <strong>{entry.label}</strong>
              </td>
              <td>
                <AddressChip address={entry.address} />
              </td>
              <td className="olien-muted">{entry.category || ""}</td>
            </tr>
          ))}
        </Table>
      )}
    </Panel>
  );
}

function SubAccountsSection({ account }: { account: AccountView }) {
  const queryClient = useQueryClient();
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      await createSubAccount(account.address, label.trim());
      await queryClient.invalidateQueries({ queryKey: olienKeys.all });
      setLabel("");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="Sub-accounts">
      {/* The index is the contract's, chosen by the service, so the only thing to
          ask for is what this one is for. */}
      <form
        className="olien-inline-form"
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        <input
          className="olien-input"
          placeholder="What is it for? Payroll, contractors, travel"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          maxLength={80}
          disabled={busy}
        />
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? "Creating" : "Create sub-account"}
        </Button>
      </form>
      {error ? <InlineError message={error} /> : null}
      {account.subAccounts.length === 0 ? (
        <EmptyState title="None yet" hint="A sub-account is a separate address only this Olien can operate; a spending limit can draw from one." />
      ) : (
        <Table head={["Index", "Label", "Address"]}>
          {account.subAccounts.map((sub) => (
            <tr key={sub.address}>
              <td className="num">{sub.index}</td>
              <td>{sub.label ?? ""}</td>
              <td>
                <AddressChip address={sub.address} />
              </td>
            </tr>
          ))}
        </Table>
      )}
    </Panel>
  );
}

type Direction = "all" | "in" | "out";

// Filters narrow what is shown and what is exported alike, so the file matches the
// table a person was looking at when they pressed Export.
function matches(entry: LedgerEntry, direction: Direction, token: string, query: string): boolean {
  if (direction !== "all" && entry.direction !== direction) return false;
  if (token !== "all" && entry.symbol !== token) return false;
  if (!query) return true;
  const hay = [entry.counterparty, entry.counterpartyLabel ?? "", entry.memo ?? "", entry.tx, entry.symbol].join(" ").toLowerCase();
  return hay.includes(query);
}

function LedgerSection({ address }: { address: string }) {
  const ledger = useLedger(address, 100);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [direction, setDirection] = useState<Direction>("all");
  const [token, setToken] = useState("all");
  const [search, setSearch] = useState("");
  const query = search.trim().toLowerCase();

  async function exportCsv() {
    setError(null);
    setExporting(true);
    try {
      const rows = (await getLedger(address, 1000)).filter((entry) => matches(entry, direction, token, query));
      const blob = new Blob([ledgerCsv(rows)], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `olien-${address.slice(2, 10)}-ledger.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setExporting(false);
    }
  }

  const all = ledger.data ?? [];
  const tokens = Array.from(new Set(all.map((entry) => entry.symbol)));
  const entries = all.filter((entry) => matches(entry, direction, token, query));
  const filtered = direction !== "all" || token !== "all" || query !== "";

  return (
    <Panel
      title="Ledger"
      flush
      action={
        <Button size="sm" icon={<Download size={13} />} busy={exporting} disabled={entries.length === 0} onClick={() => void exportCsv()}>
          {filtered ? "Export these" : "Export CSV"}
        </Button>
      }
    >
      {all.length > 0 ? (
        <div className="olien-panel-pad olien-ledger-filters">
          <Tabs<Direction>
            items={[
              { id: "all", label: "All" },
              { id: "in", label: "In" },
              { id: "out", label: "Out" },
            ]}
            value={direction}
            onChange={setDirection}
          />
          {tokens.length > 1 ? (
            <select className="olien-input olien-input--short" value={token} onChange={(event) => setToken(event.target.value)} aria-label="Token">
              <option value="all">Every token</option>
              {tokens.map((symbol) => (
                <option key={symbol} value={symbol}>
                  {symbol}
                </option>
              ))}
            </select>
          ) : null}
          <input className="olien-input" placeholder="Search a name, memo, address or tx" value={search} onChange={(event) => setSearch(event.target.value)} aria-label="Search the ledger" />
        </div>
      ) : null}
      {error ? (
        <div className="olien-panel-pad">
          <InlineError message={error} />
        </div>
      ) : null}
      {ledger.isLoading ? (
        <Loading label="Loading the ledger" />
      ) : ledger.error ? (
        <InlineError message={errorMessage(ledger.error)} />
      ) : all.length === 0 ? (
        <EmptyState title="No movements yet" hint="Deposit USDC to the Olien address to fund it." />
      ) : entries.length === 0 ? (
        <EmptyState title="Nothing matches" hint="Clear a filter to see the rest." />
      ) : (
        <Table head={["Time", "", "Counterparty", "Amount", "Memo", "Tx"]}>
          {entries.map((entry) => (
            <tr key={`${entry.tx}-${entry.logIndex}`}>
              <td className="num olien-muted">{formatTime(entry.blockTime)}</td>
              <td>
                <span className={cx("olien-direction", entry.direction === "in" ? "is-in" : "is-out")} title={entry.direction === "in" ? "Received" : "Sent"}>
                  {entry.direction === "in" ? <ArrowDownLeft size={13} /> : <ArrowUpRight size={13} />}
                </span>
              </td>
              <td>
                <AddressChip address={entry.counterparty} label={entry.counterpartyLabel} />
              </td>
              <td className={cx("num", entry.direction === "in" ? "olien-ok" : "")}>
                {entry.direction === "in" ? "+" : "-"}
                {formatLedgerAmount(entry)}
              </td>
              <td className="olien-muted">
                {entry.memo ? <span>{entry.memo} </span> : null}
                {entry.proposalTxHash ? (
                  <Link href={`/${address}/transactions/${entry.proposalTxHash}`} className="olien-link">
                    {entry.memo ? "transaction" : "Transaction"}
                  </Link>
                ) : entry.limitId != null ? (
                  `Limit ${entry.limitId}`
                ) : null}
              </td>
              <td>
                <TxChip hash={entry.tx} />
              </td>
            </tr>
          ))}
        </Table>
      )}
    </Panel>
  );
}

function scopeLabel(scope: ApiKeyScope): string {
  return scope === "propose" ? "Read and propose" : "Read only";
}

function ApiKeyRow({ address, item }: { address: string; item: ApiKey }) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function revoke() {
    if (!window.confirm(`Revoke "${item.name}"? Anything using it stops working now.`)) return;
    setBusy(true);
    setError(null);
    try {
      await revokeApiKey(address, item.id);
      await queryClient.invalidateQueries({ queryKey: olienKeys.apiKeys(address) });
    } catch (cause) {
      setError(errorMessage(cause));
      setBusy(false);
    }
  }

  return (
    <tr>
      <td>
        <strong>{item.name}</strong>
        {error ? <InlineError message={error} /> : null}
      </td>
      <td>
        <Pill tone={item.scope === "propose" ? "amber" : "gray"}>{scopeLabel(item.scope)}</Pill>
      </td>
      <td className="olien-mono olien-muted">olk_…{item.hint}</td>
      {/* A wallet member is named by its address; in full it takes the room the other columns need. */}
      <td className="olien-muted" title={item.createdBy}>
        {isValidAddress(item.createdBy) ? shortAddress(item.createdBy) : item.createdBy}
      </td>
      <td className="olien-muted">{item.lastUsedAt ? formatDay(item.lastUsedAt) : "Never"}</td>
      <td className="olien-muted">
        {item.expiresAt == null ? "" : item.expiresAt <= nowSeconds() ? <Pill tone="red">Expired</Pill> : null} {item.expiresAt == null ? "" : formatDay(item.expiresAt)}
      </td>
      <td className="num">
        <Button size="sm" onClick={() => void revoke()} busy={busy} disabled={busy} icon={<Trash2 size={13} />}>
          Revoke
        </Button>
      </td>
    </tr>
  );
}

// A key acts as the member who made it and needs the same signatures as they would,
// so the console can offer it to any member without a second permission system.
function ApiKeysSection({ address }: { address: string }) {
  const queryClient = useQueryClient();
  const keys = useApiKeys(address);
  const expires = useServiceFeatures()("key-expiry");
  const [name, setName] = useState("");
  const [scope, setScope] = useState<ApiKeyScope>("read");
  const [days, setDays] = useState(90);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [minted, setMinted] = useState<MintedApiKey | null>(null);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const fresh = await mintApiKey(address, name.trim(), scope, expires ? days : undefined);
      setMinted(fresh);
      setName("");
      await queryClient.invalidateQueries({ queryKey: olienKeys.apiKeys(address) });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="API keys">
      <p className="olien-muted olien-section-lede">
        For payroll and accounting tools. A read key sees what you see. A propose key can also put transfers in the queue, where they need the same
        signatures as any other. No key can sign, execute, or change who the members are.
        {expires ? " Every key has a last day, so one that is forgotten stops by itself." : ""}
      </p>
      <form
        className="olien-inline-form"
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        <input
          className="olien-input"
          placeholder="What will use it? Payroll, Xero, the CLI"
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={80}
          disabled={busy}
          required
        />
        <select className="olien-input olien-input--short" value={scope} disabled={busy} onChange={(event) => setScope(event.target.value as ApiKeyScope)}>
          <option value="read">Read only</option>
          <option value="propose">Read and propose</option>
        </select>
        {expires ? (
          <select className="olien-input olien-input--short" value={days} disabled={busy} aria-label="How long the key lasts" onChange={(event) => setDays(Number(event.target.value))}>
            <option value={30}>For 30 days</option>
            <option value={90}>For 90 days</option>
            <option value={365}>For a year</option>
          </select>
        ) : null}
        <Button type="submit" variant="primary" disabled={busy || !name.trim()} icon={<KeyRound size={14} />}>
          {busy ? "Creating" : "Create key"}
        </Button>
      </form>
      {error ? <InlineError message={error} /> : null}
      {minted ? (
        <Note tone="warn" icon={<KeyRound size={14} />}>
          <div className="olien-secret">
            <div>
              <strong>{minted.name}</strong> is ready. Copy it now: this is the only time it is shown.
            </div>
            <div className="olien-secret-value">
              <code>{minted.key}</code>
              <CopyButton value={minted.key} title="Copy key" />
            </div>
            <div className="olien-muted">
              Send it as <code>Authorization: Bearer {"<key>"}</code> to <code>/api/treasury/accounts/{address}/…</code>.
            </div>
            <Button size="sm" onClick={() => setMinted(null)}>
              I have copied it
            </Button>
          </div>
        </Note>
      ) : null}
      {keys.isLoading ? (
        <Loading label="Loading keys" />
      ) : keys.error ? (
        <InlineError message={errorMessage(keys.error)} />
      ) : !keys.data || keys.data.length === 0 ? (
        <EmptyState title="No keys" hint="A key lets a system read this account, or put payouts in the queue for the members to sign." />
      ) : (
        <Table head={["Name", "Can", "Key", "Made by", "Last used", expires ? "Expires" : "", ""]}>
          {keys.data.map((item) => (
            <ApiKeyRow key={item.id} address={address} item={item} />
          ))}
        </Table>
      )}
    </Panel>
  );
}

const TOPICS: { id: WebhookTopic; label: string; hint: string }[] = [
  { id: "ledger", label: "Money moved", hint: "Every ledger row: a payment in or out, gas, a limit spend." },
  { id: "proposals", label: "Proposal changed", hint: "Opened, approved, executed, scheduled, vetoed, failed." },
];

function WebhookRow({ address, hook }: { address: string; hook: Webhook }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<"test" | "enable" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const deliveries = useWebhookDeliveries(address, hook.id, open);

  async function act(kind: "test" | "enable" | "delete") {
    if (kind === "delete" && !window.confirm(`Remove the webhook to ${hook.url}?`)) return;
    setBusy(kind);
    setError(null);
    try {
      if (kind === "test") await testWebhook(address, hook.id);
      if (kind === "enable") await enableWebhook(address, hook.id);
      if (kind === "delete") await deleteWebhook(address, hook.id);
      await queryClient.invalidateQueries({ queryKey: olienKeys.webhooks(address) });
      if (kind === "test") {
        setOpen(true);
        await queryClient.invalidateQueries({ queryKey: olienKeys.deliveries(address, hook.id) });
      }
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  }

  const status = hook.disabledReason ? (
    <Pill tone="red">Off</Pill>
  ) : hook.lastStatus == null ? (
    <Pill tone="gray">Waiting</Pill>
  ) : hook.lastStatus >= 200 && hook.lastStatus < 300 ? (
    <Pill tone="green">OK {hook.lastStatus}</Pill>
  ) : (
    <Pill tone="amber">Answered {hook.lastStatus}</Pill>
  );

  return (
    <li className="olien-limit">
      <div className="olien-limit-main">
        <strong className="olien-mono">{hook.url}</strong>
        <span className="olien-inline">
          {status}
          <span className="olien-muted">{hook.events.map((topic) => TOPICS.find((t) => t.id === topic)?.label ?? topic).join(", ")}</span>
          {hook.pending > 0 ? <span className="olien-muted">{plural(hook.pending, "delivery", "deliveries")} pending</span> : null}
        </span>
        {hook.lastDeliveryAt ? <small className="olien-muted">Last delivery {formatTime(hook.lastDeliveryAt)}</small> : null}
        {hook.disabledReason ? <InlineError message={hook.disabledReason} /> : null}
        <InlineError message={error} />
        {open ? (
          deliveries.isLoading ? (
            <Loading label="Loading deliveries" />
          ) : deliveries.data && deliveries.data.length > 0 ? (
            <Table head={["Event", "When", "Tries", "Result"]} className="olien-table--compact">
              {deliveries.data.map((delivery) => (
                <tr key={delivery.id}>
                  <td className="olien-mono">{delivery.event}</td>
                  <td className="num olien-muted">{formatTime(delivery.createdAt)}</td>
                  <td className="num">{delivery.attempts}</td>
                  <td className={delivery.deliveredAt ? "olien-ok" : delivery.abandonedAt ? "olien-muted" : ""}>
                    {delivery.deliveredAt ? `Delivered, ${delivery.lastStatus}` : delivery.abandonedAt ? `Given up: ${delivery.lastError ?? ""}` : delivery.lastError ? `Retrying: ${delivery.lastError}` : "Queued"}
                  </td>
                </tr>
              ))}
            </Table>
          ) : (
            <span className="olien-muted">Nothing delivered yet.</span>
          )
        ) : null}
      </div>
      <div className="olien-limit-actions">
        <Button size="sm" busy={busy === "test"} disabled={busy != null || Boolean(hook.disabledReason)} onClick={() => void act("test")}>
          Send a test
        </Button>
        <Button variant="ghost" size="sm" disabled={busy != null} onClick={() => setOpen((value) => !value)}>
          {open ? "Hide deliveries" : "Deliveries"}
        </Button>
        {hook.disabledReason ? (
          <Button variant="ghost" size="sm" busy={busy === "enable"} disabled={busy != null} onClick={() => void act("enable")}>
            Switch on
          </Button>
        ) : null}
        <Button variant="ghost" size="sm" icon={<Trash2 size={13} />} busy={busy === "delete"} disabled={busy != null} onClick={() => void act("delete")}>
          Remove
        </Button>
      </div>
    </li>
  );
}

function WebhooksSection({ address }: { address: string }) {
  const queryClient = useQueryClient();
  const hooks = useWebhooks(address);
  const [url, setUrl] = useState("");
  const [topics, setTopics] = useState<WebhookTopic[]>(["ledger", "proposals"]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedWebhook | null>(null);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const fresh = await createWebhook(address, { url: url.trim(), events: topics });
      setCreated(fresh);
      setUrl("");
      await queryClient.invalidateQueries({ queryKey: olienKeys.webhooks(address) });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="Webhooks">
      <p className="olien-muted olien-section-lede">
        The service posts a signed JSON delivery to your URL when money moves or a proposal changes, so an accounting system reconciles as it happens.
        Each delivery carries an <code>x-olien-signature</code> header to check against the secret.
      </p>
      <form
        className="olien-inline-form"
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        <input className="olien-input olien-input--mono" placeholder="https://hooks.example.com/olien" value={url} onChange={(event) => setUrl(event.target.value)} disabled={busy} required />
        <Button type="submit" variant="primary" disabled={busy || !url.trim() || topics.length === 0} icon={<Radio size={14} />}>
          {busy ? "Adding" : "Add webhook"}
        </Button>
      </form>
      <div className="olien-inline olien-topics">
        {TOPICS.map((topic) => (
          <label key={topic.id} className="olien-check" title={topic.hint}>
            <input
              type="checkbox"
              checked={topics.includes(topic.id)}
              disabled={busy}
              onChange={(event) => setTopics((current) => (event.target.checked ? [...current, topic.id] : current.filter((t) => t !== topic.id)))}
            />
            {topic.label}
          </label>
        ))}
      </div>
      {error ? <InlineError message={error} /> : null}
      {created ? (
        <Note tone="warn" icon={<Radio size={14} />}>
          <div className="olien-secret">
            <div>Signing secret for {created.url}. Copy it now: this is the only time it is shown.</div>
            <div className="olien-secret-value">
              <code>{created.secret}</code>
              <CopyButton value={created.secret} title="Copy secret" />
            </div>
            <div className="olien-muted">
              Check <code>x-olien-signature</code>: <code>t=&lt;unix&gt;,v1=&lt;hex&gt;</code>, where v1 is HMAC-SHA256 of <code>&lt;t&gt;.&lt;body&gt;</code> under this secret.
            </div>
            <Button size="sm" onClick={() => setCreated(null)}>
              I have copied it
            </Button>
          </div>
        </Note>
      ) : null}
      {hooks.isLoading ? (
        <Loading label="Loading webhooks" />
      ) : hooks.error ? (
        <InlineError message={errorMessage(hooks.error)} />
      ) : !hooks.data || hooks.data.length === 0 ? (
        <EmptyState title="No webhooks" hint="Add one and press Send a test to see a delivery land." />
      ) : (
        <ul className="olien-limits">
          {hooks.data.map((hook) => (
            <WebhookRow key={hook.id} address={address} hook={hook} />
          ))}
        </ul>
      )}
    </Panel>
  );
}

export function OlienSettings({ address }: { address: string }) {
  const account = useOlienAccount(address);
  if (account.isLoading) return <Loading label="Loading settings" />;
  if (account.error || !account.data) return <InlineError message={accountError(account.error)} />;
  const view = account.data;
  return (
    <div className="olien-page olien-stack">
      <AddressesSection account={view} />
      <TimeLockSection address={address} account={view} />
      <LimitsSection address={address} account={view} />
      <AddressBookSection address={address} />
      <SubAccountsSection account={view} />
      <ApiKeysSection address={address} />
      <WebhooksSection address={address} />
      <LedgerSection address={address} />
    </div>
  );
}

// The name lives in the service, not on chain, so any member changes it at once.
function RenameForm({ account }: { account: AccountView }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(account.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changed = name.trim() !== account.name && name.trim().length > 0;

  async function save() {
    setError(null);
    setBusy(true);
    try {
      await renameAccount(account.address, name.trim());
      await queryClient.invalidateQueries({ queryKey: olienKeys.all });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="olien-subform">
      <Field label="Rename" hint="The name lives in the service, not on chain; every member sees the change at once.">
        <span className="olien-inline">
          <input className="olien-input" value={name} maxLength={80} disabled={busy} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => event.key === "Enter" && changed && void save()} />
          <Button size="sm" variant="primary" busy={busy} disabled={!changed} onClick={() => void save()}>
            Save
          </Button>
        </span>
      </Field>
      <InlineError message={error} />
    </div>
  );
}
