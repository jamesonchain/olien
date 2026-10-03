"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Lock, Plus, SlidersHorizontal, Trash2, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { durationLabel, errorMessage, proposeSigners, proposalSummary, shortAddress, type AccountView, type SignerKind, type SignerView, type SignersProposalBody } from "@/lib/treasury";
import { keyName, lockedByLosing, lockoutMessage, vetoRule, type Standing } from "@/lib/resilience";
import { MemberRows, newMember, signerInputOf, usePasskeyMember, validateMembers, type MemberDraft } from "./new-account";
import { useWalletSession } from "./wallet";
import { AddressChip, Button, Field, InlineError, Loading, Note, Panel, PermissionTags, plural, StatusPill, Table, Tag } from "./ui";
import { accountError, applyProposal, useOlienAccount, useProposals } from "./use-olien";

const KIND_LABELS: Record<SignerKind, string> = { ecdsa: "ECDSA", p256: "P-256", webauthn: "Passkey", contract: "Contract" };

type Form = { kind: "add" } | { kind: "remove"; signer: SignerView } | { kind: "threshold" } | null;

function TimeLockNote({ account }: { account: AccountView }) {
  return (
    <Note tone="info" icon={<Lock size={14} />}>
      This change waits {durationLabel(account.configDelay)} after execution and {plural(account.effectiveVetoThreshold, "veto", "vetoes")} stop it.
    </Note>
  );
}

function standingOf(signer: SignerView): Standing {
  return { key: keyName(signer.label, signer.mine, signer.kind), approve: signer.permissions.includes("approve"), recover: signer.permissions.includes("recover") };
}

// A live account is warned rather than refused: the change waits behind the time lock
// and can be vetoed, and the alternative to a fragile shape may be keeping a member
// who has already left.
function LockoutNote({ standing, threshold }: { standing: Standing[]; threshold: number }) {
  const lockout = lockedByLosing(standing, threshold);
  if (!lockout) return null;
  const text = lockoutMessage(lockout);
  return (
    <Note tone="warn" icon={<TriangleAlert size={14} />}>
      After this change, {text.charAt(0).toLowerCase() + text.slice(1)}
    </Note>
  );
}

function useProposeSigners(address: string) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function propose(body: SignersProposalBody) {
    setError(null);
    setBusy(true);
    try {
      const view = await proposeSigners(address, body);
      applyProposal(queryClient, address, view);
      router.push(`/${address}/transactions/${view.txHash}`);
    } catch (cause) {
      setError(errorMessage(cause));
      setBusy(false);
    }
  }
  return { propose, busy, error, setError };
}

function AddMemberForm({ address, account, onClose }: { address: string; account: AccountView; onClose: () => void }) {
  const [rows, setRows] = useState<MemberDraft[]>(() => [newMember()]);
  const { propose, busy, error, setError } = useProposeSigners(address);
  const taken = new Set(account.signers.map((signer) => (signer.address ?? signer.signerId).toLowerCase()));
  const { address: walletAddress } = useWalletSession();
  const passkey = usePasskeyMember((draft) => setRows((current) => [...current, draft]), walletAddress, setError);

  function submit() {
    const problem = validateMembers(rows, taken);
    if (problem) return setError(problem);
    void propose({
      add: rows.map((row, index) => signerInputOf(row, `Member ${account.signers.length + index + 1}`)),
      remove: [],
      replace: [],
    });
  }

  return (
    <Panel
      title="Add member"
      action={
        <Button size="sm" icon={<Plus size={13} />} disabled={busy} onClick={() => setRows((current) => [...current, newMember()])}>
          Another
        </Button>
      }
    >
      <MemberRows rows={rows} disabled={busy} onChange={(key, change) => setRows((current) => current.map((row) => (row.key === key ? { ...row, ...change } : row)))} onRemove={(key) => setRows((current) => current.filter((row) => row.key !== key))} passkey={passkey} />
      <TimeLockNote account={account} />
      <InlineError message={error} />
      <div className="olien-actions">
        <Button variant="primary" busy={busy} onClick={submit}>
          Create transaction
        </Button>
        <Button variant="ghost" disabled={busy} onClick={onClose}>
          Cancel
        </Button>
      </div>
    </Panel>
  );
}

function RemoveMemberForm({ address, account, signer, onClose }: { address: string; account: AccountView; signer: SignerView; onClose: () => void }) {
  const { propose, busy, error, setError } = useProposeSigners(address);
  const approversAfter = account.signers.filter((entry) => entry.signerId !== signer.signerId && entry.permissions.includes("approve")).length;
  const mustLower = account.threshold > approversAfter;
  const [threshold, setThreshold] = useState(Math.min(account.threshold, Math.max(1, approversAfter)));

  function submit() {
    if (approversAfter < 1) return setError("Removing this member leaves nobody who can approve. Add another approver first.");
    if (threshold < 1 || threshold > approversAfter) return setError(`The threshold must be between 1 and ${approversAfter} after this change.`);
    const body: SignersProposalBody = { add: [], remove: [signer.signerId], replace: [] };
    if (threshold !== account.threshold) body.threshold = threshold;
    void propose(body);
  }

  return (
    <Panel title="Remove member">
      <p className="olien-panel-lead">
        Remove <strong>{signer.label}</strong> {signer.address ? <AddressChip address={signer.address} /> : null} from this Olien. They cannot veto their own removal.
      </p>
      {mustLower || approversAfter !== account.signers.filter((entry) => entry.permissions.includes("approve")).length ? (
        <Field label="Threshold after the change" hint={mustLower ? `The current threshold of ${account.threshold} would exceed the ${approversAfter} approvers left, so it must come down.` : `${approversAfter} members can approve after this change.`}>
          <select className="olien-input olien-input--short" value={threshold} disabled={busy} onChange={(event) => setThreshold(Number(event.target.value))}>
            {Array.from({ length: Math.max(1, approversAfter) }, (_, index) => index + 1).map((n) => (
              <option key={n} value={n}>
                {n} of {approversAfter}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      <LockoutNote standing={account.signers.filter((entry) => entry.signerId !== signer.signerId).map(standingOf)} threshold={threshold} />
      <TimeLockNote account={account} />
      <InlineError message={error} />
      <div className="olien-actions">
        <Button variant="danger" busy={busy} onClick={submit}>
          Create transaction
        </Button>
        <Button variant="ghost" disabled={busy} onClick={onClose}>
          Cancel
        </Button>
      </div>
    </Panel>
  );
}

function ThresholdForm({ address, account, onClose }: { address: string; account: AccountView; onClose: () => void }) {
  const { propose, busy, error, setError } = useProposeSigners(address);
  const approvers = account.signers.filter((entry) => entry.permissions.includes("approve")).length;
  const vetoers = account.signers.filter((entry) => entry.permissions.includes("veto")).length;
  const approverVetoers = account.signers.filter((entry) => entry.permissions.includes("approve") && entry.permissions.includes("veto")).length;
  const [threshold, setThreshold] = useState(account.threshold);
  const [vetoThreshold, setVetoThreshold] = useState(account.vetoThreshold);

  function submit() {
    if (threshold === account.threshold && vetoThreshold === account.vetoThreshold) return setError("Nothing has changed yet.");
    if (threshold < 1 || threshold > approvers) return setError(`The threshold must be between 1 and ${approvers}.`);
    if (vetoThreshold < 0 || vetoThreshold > vetoers) return setError(`The veto threshold must be automatic or at most ${vetoers}.`);
    const body: SignersProposalBody = { add: [], remove: [], replace: [] };
    if (threshold !== account.threshold) body.threshold = threshold;
    if (vetoThreshold !== account.vetoThreshold) body.vetoThreshold = vetoThreshold;
    void propose(body);
  }

  return (
    <Panel title="Change threshold">
      <div className="olien-form-grid">
        <Field label="Approvals needed" hint={`Now ${account.threshold} of ${approvers}.`}>
          <select className="olien-input olien-input--short" value={threshold} disabled={busy} onChange={(event) => setThreshold(Number(event.target.value))}>
            {Array.from({ length: Math.max(1, approvers) }, (_, index) => index + 1).map((n) => (
              <option key={n} value={n}>
                {n} of {approvers}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Veto threshold" hint={vetoRule({ vetoThreshold, vetoers, approverVetoers, threshold })}>
          <select className="olien-input olien-input--short" value={vetoThreshold} disabled={busy} onChange={(event) => setVetoThreshold(Number(event.target.value))}>
            <option value={0}>Automatic</option>
            {Array.from({ length: vetoers }, (_, index) => index + 1).map((n) => (
              <option key={n} value={n}>
                {n} of {vetoers}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <LockoutNote standing={account.signers.map(standingOf)} threshold={threshold} />
      <TimeLockNote account={account} />
      <InlineError message={error} />
      <div className="olien-actions">
        <Button variant="primary" busy={busy} onClick={submit}>
          Create transaction
        </Button>
        <Button variant="ghost" disabled={busy} onClick={onClose}>
          Cancel
        </Button>
      </div>
    </Panel>
  );
}

export function OlienMembers({ address }: { address: string }) {
  const account = useOlienAccount(address);
  const pending = useProposals(address, ["open", "ready", "blocked", "executing", "scheduled"]);
  const [form, setForm] = useState<Form>(null);

  if (account.isLoading) return <Loading label="Loading members" />;
  if (account.error || !account.data) return <InlineError message={accountError(account.error)} />;

  const view = account.data;
  const approvers = view.signers.filter((signer) => signer.permissions.includes("approve")).length;
  const changes = (pending.data ?? []).filter((row) => row.kind === "signer_change" || row.kind === "rule_change");
  const writable = view.status === "live";

  return (
    <div className="olien-page">
      <div className="olien-members-head">
        <div className="olien-stats">
          <div>
            <span className="olien-panel-title">Threshold</span>
            <strong className="num">
              {view.threshold} of {approvers}
            </strong>
          </div>
          <div>
            <span className="olien-panel-title">Veto threshold</span>
            <strong className="num">{view.vetoThreshold === 0 ? `${view.effectiveVetoThreshold} (automatic)` : view.vetoThreshold}</strong>
          </div>
          <div>
            <span className="olien-panel-title">Time lock</span>
            <strong>{durationLabel(view.configDelay)}</strong>
          </div>
        </div>
        <div className="olien-actions">
          <Button icon={<SlidersHorizontal size={14} />} disabled={!writable} onClick={() => setForm({ kind: "threshold" })}>
            Change threshold
          </Button>
          <Button variant="primary" icon={<Plus size={14} />} disabled={!writable} onClick={() => setForm({ kind: "add" })}>
            Add member
          </Button>
        </div>
      </div>

      {form?.kind === "add" ? <AddMemberForm address={address} account={view} onClose={() => setForm(null)} /> : null}
      {form?.kind === "remove" ? <RemoveMemberForm address={address} account={view} signer={form.signer} onClose={() => setForm(null)} /> : null}
      {form?.kind === "threshold" ? <ThresholdForm address={address} account={view} onClose={() => setForm(null)} /> : null}

      {changes.length ? (
        <Panel title="Pending changes" flush>
          <Table head={["Change", "Status", "Approvals", ""]}>
            {changes.map((row) => (
              <tr key={row.txHash}>
                <td>
                  <Link href={`/${address}/transactions/${row.txHash}`} className="olien-row-title">
                    {proposalSummary(row)}
                  </Link>
                </td>
                <td>
                  <StatusPill status={row.status} />
                </td>
                <td className="num">
                  {row.approvals}/{row.required}
                </td>
                <td className="olien-cell-end">
                  <Link href={`/${address}/transactions/${row.txHash}`} className="olien-link">
                    Open
                  </Link>
                </td>
              </tr>
            ))}
          </Table>
        </Panel>
      ) : null}

      <Panel title="Members" flush>
        <Table head={["Member", "Kind", "Address", "Permissions", "Since", ""]}>
          {view.signers.map((signer) => (
            <tr key={signer.signerId}>
              <td>
                <strong>{signer.label}</strong>
                {signer.mine ? <Tag tone="accent">You</Tag> : null}
              </td>
              <td className="olien-muted">{KIND_LABELS[signer.kind] ?? signer.kind}</td>
              <td>{signer.address ? <AddressChip address={signer.address} /> : <code title={signer.signerId}>{shortAddress(signer.signerId)}</code>}</td>
              <td>
                <PermissionTags permissions={signer.permissions} />
              </td>
              <td className="olien-muted num">Epoch {signer.since}</td>
              <td className="olien-cell-end">
                <Button variant="ghost" size="sm" icon={<Trash2 size={13} />} disabled={!writable || view.signers.length === 1} onClick={() => setForm({ kind: "remove", signer })}>
                  Remove
                </Button>
              </td>
            </tr>
          ))}
        </Table>
      </Panel>
      <p className="olien-field-hint">
        Member and threshold changes are one transaction that, once executed, waits {durationLabel(view.configDelay)} and can be vetoed meanwhile. Since is the epoch the member was added in.
      </p>
    </div>
  );
}
