"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Ban, CalendarClock, FileSignature, KeyRound, Pencil, Play, Plus, Trash2 } from "lucide-react";
import { useSignTypedData } from "wagmi";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  createPayroll,
  deletePayroll,
  errorMessage,
  formatDay,
  formatTime,
  formatUsdc,
  runPayroll,
  updatePayroll,
  isValidAddress,
  parseUsdc,
  signCheque,
  signerIdFor,
  voidCheque,
  writeCheque,
  type Hex,
  type TreasuryCheque,
  type PayrollPeriod,
  type PayrollRun,
} from "@/lib/treasury";
import { AddRecipientButton, AddressInput, draftsFrom, newRecipient, recipientsTotal, RecipientsEditor, validateRecipients, type RecipientDraft } from "./recipients";
import { AddressChip, Button, Dialog, EmptyState, Field, InlineError, Loading, Note, Panel, Pill, plural, Table, TxChip } from "./ui";
import { accountError, applyProposal, olienKeys, useAddressBook, useCheques, useOlienAccount, usePayrolls } from "./use-olien";
import { friendlyPasskeyError, knownPasskeys, passkeySupported, signWithPasskey } from "@/lib/passkey";
import { friendlyWalletError, useWalletSession, walletSigner } from "./wallet";
import { type AccountView } from "@/lib/treasury";
import { chainSpec, olienUsdcAddress } from "@/lib/chain";
import { chequeDigest, messageHash, messageTypedData } from "@/lib/signing";

const PERIODS: { id: PayrollPeriod; label: string }[] = [
  { id: "none", label: "Run by hand" },
  { id: "weekly", label: "Every week" },
  { id: "fortnightly", label: "Every two weeks" },
  { id: "monthly", label: "Every month" },
];

function periodLabel(period: PayrollPeriod): string {
  return PERIODS.find((p) => p.id === period)?.label ?? period;
}

// The first run's date as the date input wants it, in the viewer's own calendar.
function dateInputValue(unix: number | null): string {
  const d = unix ? new Date(unix * 1000) : new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Nine in the morning local time: payday, not midnight.
function unixFromDateInput(value: string): number | null {
  const [y, m, d] = value.split("-").map(Number);
  if (!y || !m || !d) return null;
  return Math.floor(new Date(y, m - 1, d, 9, 0, 0).getTime() / 1000);
}

function PayrollEditor({ address, existing, onClose }: { address: string; existing: PayrollRun | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const book = useAddressBook(address);
  const [name, setName] = useState(existing?.name ?? "");
  const [period, setPeriod] = useState<PayrollPeriod>(existing?.period ?? "none");
  const [firstRun, setFirstRun] = useState(dateInputValue(existing?.nextRunAt ?? null));
  const [recipients, setRecipients] = useState<RecipientDraft[]>(() => (existing ? draftsFrom(existing.recipients) : [newRecipient()]));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const total = recipientsTotal(recipients);

  async function save() {
    if (!name.trim()) {
      setError("Give the run a name.");
      return;
    }
    const list = validateRecipients(recipients);
    if (typeof list === "string") {
      setError(list);
      return;
    }
    const nextRunAt = period === "none" ? null : unixFromDateInput(firstRun);
    if (period !== "none" && !nextRunAt) {
      setError("Pick the first payday.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const body = { name: name.trim(), recipients: list, period, nextRunAt };
      if (existing) await updatePayroll(address, existing.id, body);
      else await createPayroll(address, body);
      await queryClient.invalidateQueries({ queryKey: olienKeys.payrolls(address) });
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
      setBusy(false);
    }
  }

  return (
    <Dialog open onClose={onClose} title={existing ? "Edit payroll run" : "New payroll run"}>
      <div className="olien-dialog-body olien-stack">
        <div className="olien-form-grid">
          <Field label="Name">
            <input className="olien-input" value={name} placeholder="Monthly salaries" maxLength={80} disabled={busy} onChange={(event) => setName(event.target.value)} />
          </Field>
          <Field label="Schedule" hint={period === "none" ? "Nothing runs until a member presses Run." : "On the day, the run appears in the queue for members to sign."}>
            <select className="olien-input" value={period} disabled={busy} onChange={(event) => setPeriod(event.target.value as PayrollPeriod)}>
              {PERIODS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </Field>
          {period !== "none" ? (
            <Field label="First payday">
              <input className="olien-input" type="date" value={firstRun} disabled={busy} onChange={(event) => setFirstRun(event.target.value)} />
            </Field>
          ) : null}
        </div>
        <div className="olien-payroll-people">
          <div className="olien-payroll-people-head">
            <strong>{plural(recipients.length, "person", "people")}</strong>
            <span className="olien-muted num">{formatUsdc(total)}</span>
            <AddRecipientButton recipients={recipients} onChange={setRecipients} disabled={busy} />
          </div>
          <RecipientsEditor recipients={recipients} onChange={setRecipients} book={book.data ?? []} disabled={busy} />
        </div>
        <InlineError message={error} />
        <div className="olien-dialog-actions">
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" busy={busy} onClick={() => void save()}>
            {existing ? "Save" : "Create run"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function PayrollRow({ address, run, onEdit }: { address: string; run: PayrollRun; onEdit: () => void }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<"run" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function runNow() {
    if (!window.confirm(`Open "${run.name}" for ${formatUsdc(run.total)} now? Members will be asked to sign it.`)) return;
    setBusy("run");
    setError(null);
    try {
      const created = await runPayroll(address, run.id);
      applyProposal(queryClient, address, created);
      await queryClient.invalidateQueries({ queryKey: olienKeys.payrolls(address) });
      router.push(`/${address}/transactions/${created.txHash}`);
    } catch (cause) {
      setError(errorMessage(cause));
      setBusy(null);
    }
  }

  async function remove() {
    if (!window.confirm(`Delete "${run.name}"? Proposals it already opened are not affected.`)) return;
    setBusy("delete");
    setError(null);
    try {
      await deletePayroll(address, run.id);
      await queryClient.invalidateQueries({ queryKey: olienKeys.payrolls(address) });
    } catch (cause) {
      setError(errorMessage(cause));
      setBusy(null);
    }
  }

  return (
    <tr>
      <td>
        <strong>{run.name}</strong>
        <div className="olien-muted">{plural(run.recipients.length, "person", "people")}</div>
        {run.lastError ? <InlineError message={run.lastError} /> : null}
        {error ? <InlineError message={error} /> : null}
      </td>
      <td className="num">{formatUsdc(run.total)}</td>
      <td>
        <Pill tone={run.period === "none" ? "gray" : "green"}>{periodLabel(run.period)}</Pill>
        {run.nextRunAt ? <div className="olien-muted">Next {formatDay(run.nextRunAt)}</div> : null}
      </td>
      <td className="olien-muted">
        {run.lastRunAt ? (
          run.lastRunTxHash ? (
            <Link href={`/${address}/transactions/${run.lastRunTxHash}`} className="olien-link">
              {formatTime(run.lastRunAt)}
            </Link>
          ) : (
            formatTime(run.lastRunAt)
          )
        ) : (
          "Never"
        )}
      </td>
      <td className="num">
        <div className="olien-actions">
          <Button size="sm" variant="primary" icon={<Play size={12} />} busy={busy === "run"} disabled={busy != null} onClick={() => void runNow()}>
            Run
          </Button>
          <Button size="sm" icon={<Pencil size={12} />} disabled={busy != null} onClick={onEdit}>
            Edit
          </Button>
          <Button size="sm" icon={<Trash2 size={12} />} busy={busy === "delete"} disabled={busy != null} onClick={() => void remove()}>
            Delete
          </Button>
        </div>
      </td>
    </tr>
  );
}

function chequeTone(status: TreasuryCheque["status"]): "green" | "amber" | "blue" | "red" | "gray" {
  switch (status) {
    case "open":
      return "amber";
    case "issued":
      return "blue";
    case "cashed":
      return "green";
    case "voiding":
      return "amber";
    default:
      return "gray";
  }
}

function chequeLabel(status: TreasuryCheque["status"]): string {
  switch (status) {
    case "open":
      return "Needs signatures";
    case "issued":
      return "Issued, not cashed";
    case "cashed":
      return "Cashed";
    case "voiding":
      return "Void proposed";
    case "voided":
      return "Voided";
    case "expired":
      return "Expired";
  }
}

// A cheque needs the threshold's signatures like a payment, but nothing goes on
// chain: the packed set is what the recipient's app hands to the token when they
// cash it. Members sign Message(digest) in the account's domain, the wallet showing
// it as typed data and a passkey signing the hash as it signs a confirmation.
function ChequeRow({ address, account, cheque }: { address: string; account: AccountView; cheque: TreasuryCheque }) {
  const queryClient = useQueryClient();
  const wallet = useWalletSession();
  const { signTypedDataAsync } = useSignTypedData();
  const [busy, setBusy] = useState<"wallet" | "passkey" | "void" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const signed = new Set(cheque.signatures.map((s) => s.signerId.toLowerCase()));
  const mySigner = walletSigner(account, wallet.address);
  const canWallet = cheque.status === "open" && Boolean(wallet.matches && mySigner?.permissions.includes("approve") && !signed.has(mySigner.signerId.toLowerCase()));
  const mine = new Set(knownPasskeys().map((record) => record.signerId.toLowerCase()));
  const passkeys = account.signers.filter((s) => s.kind === "webauthn" && s.permissions.includes("approve") && mine.has(s.signerId.toLowerCase()) && !signed.has(s.signerId.toLowerCase()));
  const canPasskey = cheque.status === "open" && passkeys.length > 0 && passkeySupported();

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: olienKeys.cheques(address) });
  }

  // A cheque is the account vouching for a hash, and the token pays whoever presents
  // it. So the hash is derived here from the recipient, amount and dates on this row.
  // One the service supplied could be the digest of a different cheque, or of
  // anything else the account can be made to vouch for.
  function localCheque() {
    const digest = chequeDigest({ chainId: chainSpec.id, token: olienUsdcAddress, from: address, to: cheque.to, value: cheque.amount, validAfter: cheque.validAfter, validBefore: cheque.validBefore, nonce: cheque.nonce });
    const hash = messageHash(chainSpec.id, address, digest);
    if (digest.toLowerCase() !== cheque.digest.toLowerCase() || hash.toLowerCase() !== cheque.messageHash.toLowerCase()) {
      throw new Error("This cheque's hash is not the hash of the recipient, amount and dates shown. Nothing was signed.");
    }
    return { typedData: messageTypedData(chainSpec.id, address, digest), hash };
  }

  async function signWithWallet() {
    if (!wallet.address || !mySigner) return;
    setBusy("wallet");
    setError(null);
    try {
      const signature = await signTypedDataAsync(localCheque().typedData);
      await signCheque(address, cheque.id, { signerId: signerIdFor(wallet.address), signature });
      await refresh();
    } catch (cause) {
      setError(friendlyWalletError(cause));
    } finally {
      setBusy(null);
    }
  }

  async function signWithKey() {
    setBusy("passkey");
    setError(null);
    try {
      const result = await signWithPasskey(localCheque().hash, passkeys.map((s) => ({ signerId: s.signerId, x: s.x, y: s.y })));
      await signCheque(address, cheque.id, result);
      await refresh();
    } catch (cause) {
      setError(friendlyPasskeyError(cause));
    } finally {
      setBusy(null);
    }
  }

  async function voidIt() {
    const question = cheque.status === "open" ? "Delete this draft cheque?" : "Void this cheque? It opens a cancellation for the members to approve; once executed the token refuses it.";
    if (!window.confirm(question)) return;
    setBusy("void");
    setError(null);
    try {
      await voidCheque(address, cheque.id);
      await refresh();
      await queryClient.invalidateQueries({ queryKey: olienKeys.proposalsOf(address) });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  }

  return (
    <tr>
      <td>
        <AddressChip address={cheque.to} label={cheque.toLabel} />
        {cheque.memo ? <div className="olien-muted">{cheque.memo}</div> : null}
        {error ? <InlineError message={error} /> : null}
      </td>
      <td className="num">{formatUsdc(cheque.amount)}</td>
      <td>
        <Pill tone={chequeTone(cheque.status)}>{chequeLabel(cheque.status)}</Pill>
        {cheque.status === "open" ? (
          <div className="olien-muted">
            {cheque.signatures.length} of {cheque.required} signed
          </div>
        ) : cheque.status === "voiding" && cheque.voidProposalTxHash ? (
          <div className="olien-muted">
            <Link href={`/${address}/transactions/${cheque.voidProposalTxHash}`} className="olien-link">
              Cancellation
            </Link>
          </div>
        ) : null}
      </td>
      <td className="olien-muted">
        {cheque.status === "cashed" && cheque.cashedAt ? formatTime(cheque.cashedAt) : `Until ${formatDay(cheque.validBefore)}`}
      </td>
      <td className="num">
        <div className="olien-actions">
          {canWallet ? (
            <Button size="sm" variant="primary" icon={<FileSignature size={12} />} busy={busy === "wallet"} disabled={busy != null} onClick={() => void signWithWallet()}>
              {busy === "wallet" ? "Confirm in wallet" : "Sign"}
            </Button>
          ) : null}
          {canPasskey ? (
            <Button size="sm" variant="primary" icon={<KeyRound size={12} />} busy={busy === "passkey"} disabled={busy != null} onClick={() => void signWithKey()}>
              {busy === "passkey" ? "Touch ID" : "Sign with passkey"}
            </Button>
          ) : null}
          {cheque.status === "open" || cheque.status === "issued" ? (
            <Button size="sm" icon={cheque.status === "open" ? <Trash2 size={12} /> : <Ban size={12} />} busy={busy === "void"} disabled={busy != null} onClick={() => void voidIt()}>
              {cheque.status === "open" ? "Delete" : "Void"}
            </Button>
          ) : null}
        </div>
      </td>
    </tr>
  );
}

function ChequeForm({ address, onClose }: { address: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const book = useAddressBook(address);
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const [days, setDays] = useState(90);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function write() {
    if (!isValidAddress(to)) return setError("The recipient needs a valid address.");
    const units = parseUsdc(amount);
    if (!units) return setError("The amount is in USDC with at most 6 decimals.");
    if (days < 1 || days > 365) return setError("A cheque is valid for 1 to 365 days.");
    setBusy(true);
    setError(null);
    try {
      await writeCheque(address, { to: to.toLowerCase(), amount: units, memo: memo.trim() || undefined, validFor: days * 86_400 });
      await queryClient.invalidateQueries({ queryKey: olienKeys.cheques(address) });
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
      setBusy(false);
    }
  }

  return (
    <Dialog open onClose={onClose} title="Write a cheque">
      <div className="olien-dialog-body olien-stack">
        <div className="olien-form-grid">
          <Field label="To" className="olien-field--wide">
            <AddressInput value={to} book={book.data ?? []} disabled={busy} onChange={(value) => setTo(value.trim())} onPick={(entry) => setTo(entry.address)} />
          </Field>
          <Field label="Amount (USDC)">
            <input className="olien-input num" value={amount} inputMode="decimal" placeholder="250.00" disabled={busy} onChange={(event) => setAmount(event.target.value)} />
          </Field>
          <Field label="Valid for (days)">
            <input className="olien-input olien-input--short num" type="number" min={1} max={365} value={days} disabled={busy} onChange={(event) => setDays(Math.max(1, Math.min(365, Math.floor(Number(event.target.value) || 1))))} />
          </Field>
          <Field label="Memo (optional)" className="olien-field--wide">
            <input className="olien-input" value={memo} maxLength={140} placeholder="Invoice 1042" disabled={busy} onChange={(event) => setMemo(event.target.value)} />
          </Field>
        </div>
        <p className="olien-muted olien-section-lede">
          Members sign it here; nothing leaves the account until the recipient cashes it from their Recourse app. Until then it can be voided.
        </p>
        <InlineError message={error} />
        <div className="olien-dialog-actions">
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" busy={busy} onClick={() => void write()}>
            Write cheque
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function ChequesSection({ address, account }: { address: string; account: AccountView }) {
  const cheques = useCheques(address);
  const [writing, setWriting] = useState(false);
  const list = cheques.data ?? [];
  return (
    <Panel
      title="Cheques"
      action={
        <Button size="sm" icon={<Plus size={13} />} disabled={account.status !== "live"} onClick={() => setWriting(true)}>
          Write a cheque
        </Button>
      }
    >
      <p className="olien-muted olien-section-lede">
        A cheque is a payment the recipient collects when they like. It needs the same signatures as a payment, but nothing moves until it is cashed,
        and an uncashed one can be voided.
      </p>
      {cheques.isLoading ? (
        <Loading label="Loading cheques" />
      ) : cheques.error ? (
        <InlineError message={errorMessage(cheques.error)} />
      ) : list.length === 0 ? (
        <EmptyState title="No cheques" hint="Write one to a contractor who will collect it when their invoice is due." />
      ) : (
        <Table head={["To", "Amount", "Status", "Valid", ""]}>
          {list.map((cheque) => (
            <ChequeRow key={cheque.id} address={address} account={account} cheque={cheque} />
          ))}
        </Table>
      )}
      {writing ? <ChequeForm address={address} onClose={() => setWriting(false)} /> : null}
    </Panel>
  );
}

export function OlienPayroll({ address }: { address: string }) {
  const account = useOlienAccount(address);
  const payrolls = usePayrolls(address);
  const [editing, setEditing] = useState<PayrollRun | null | "new">(null);

  if (account.isLoading) return <Loading label="Loading the Olien" />;
  if (account.error || !account.data) return <InlineError message={accountError(account.error)} />;

  const runs = payrolls.data ?? [];
  return (
    <div className="olien-page olien-stack">
      <Panel
        title="Payroll runs"
        action={
          <Button size="sm" variant="primary" icon={<Plus size={13} />} onClick={() => setEditing("new")}>
            New run
          </Button>
        }
      >
        <p className="olien-muted olien-section-lede">
          A run is the people you pay and what you pay them, saved once. Running it puts the whole list in the queue as one transaction that needs the
          usual signatures. With a schedule, the service opens it on the day and members find it waiting.
        </p>
        {payrolls.isLoading ? (
          <Loading label="Loading runs" />
        ) : payrolls.error ? (
          <InlineError message={errorMessage(payrolls.error)} />
        ) : runs.length === 0 ? (
          <EmptyState icon={<CalendarClock size={18} />} title="No runs yet" hint="Save salaries, contractor retainers, or anything you pay more than once." />
        ) : (
          <Table head={["Run", "Total", "Schedule", "Last run", ""]}>
            {runs.map((run) => (
              <PayrollRow key={run.id} address={address} run={run} onEdit={() => setEditing(run)} />
            ))}
          </Table>
        )}
        {runs.some((run) => run.period !== "none") ? (
          <Note tone="info" icon={<CalendarClock size={14} />}>
            Scheduled runs open as the member who saved them. If that member leaves the Olien, the run stops and says so here; editing it makes you its
            member.
          </Note>
        ) : null}
      </Panel>
      {editing ? <PayrollEditor address={address} existing={editing === "new" ? null : editing} onClose={() => setEditing(null)} /> : null}
      <ChequesSection address={address} account={account.data} />
    </div>
  );
}
