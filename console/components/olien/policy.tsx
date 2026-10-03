"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Check, Clock, Download, Plus, Trash2, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { cancelPolicyChange, durationLabel, errorMessage, formatTime, formatUsdc, getAuditCsv, parseUsdc, setPolicy, shortAddress, type AccountView, type AuditRow, type SoftRule, type TreasuryPolicy } from "@/lib/treasury";
import { Button, cx, DurationInput, EmptyState, Field, InlineError, Loading, Note, Panel, Pill, Table } from "./ui";
import { olienKeys, useAudit, usePolicy } from "./use-olien";

const DAY = 86_400;
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function clock(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function minutesOf(text: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (!match) return null;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  return minutes >= 0 && minutes <= 1_440 ? minutes : null;
}

function offsetLabel(minutes: number): string {
  if (minutes === 0) return "UTC";
  const sign = minutes > 0 ? "+" : "-";
  const hours = Math.floor(Math.abs(minutes) / 60);
  const rest = Math.abs(minutes) % 60;
  return `UTC${sign}${hours}${rest ? `:${String(rest).padStart(2, "0")}` : ""}`;
}

function daysLabel(days: number[]): string {
  const sorted = [...days].sort((a, b) => a - b);
  const run = sorted.every((day, index) => index === 0 || day === sorted[index - 1] + 1);
  if (sorted.length === 7) return "every day";
  if (run && sorted.length > 2) return `${DAY_NAMES[sorted[0]]} to ${DAY_NAMES[sorted[sorted.length - 1]]}`;
  return sorted.map((day) => DAY_NAMES[day]).join(", ");
}

function plainUsdc(units: string): string {
  const value = BigInt(units || "0");
  const fraction = (value % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return fraction ? `${value / 1_000_000n}.${fraction}` : `${value / 1_000_000n}`;
}

// What the policy still has against a payment or a cheque. Shown apart from the
// chain's own rules and said to be softer, because a member who mistook one for the
// other would trust it with more than it can carry.
export function SoftRules({ rules, compact }: { rules: SoftRule[] | undefined; compact?: boolean }) {
  if (!rules?.length) return null;
  return (
    <div className="olien-rules">
      {rules.map((rule, index) => (
        <div key={`${rule.rule}-${index}`} className="olien-rule olien-rule--policy">
          <Clock size={12} />
          <span>
            {rule.text}
            {rule.until ? ` It lets go ${formatTime(rule.until)}.` : ""}
          </span>
        </div>
      ))}
      {compact ? null : <p className="olien-field-hint">Treasury policy is kept by this service and not by the chain. It holds a payment here; it cannot hold one that members send to the chain themselves.</p>}
    </div>
  );
}

// The service's picture of the account against the chain's, asked by this browser. The
// caller asks, because a page that signs also has to stop signing on the answer.
export function ChainAgreementBanner({ difference }: { difference: string | null }) {
  if (!difference) return null;
  return (
    <Note tone="error" icon={<TriangleAlert size={15} />}>
      What the service says about this account is not what the chain says: {difference}. This browser asked the chain itself. Sign nothing here until the two agree.
    </Note>
  );
}

function PolicySummary({ policy, threshold }: { policy: TreasuryPolicy; threshold: number }) {
  return (
    <ul className="olien-policy-lines">
      {policy.tiers.length === 0 ? (
        <li>Every payment needs the account&apos;s own threshold of {threshold}, whatever its size.</li>
      ) : (
        policy.tiers.map((tier) => (
          <li key={tier.above}>
            Above <strong className="num">{formatUsdc(tier.above)}</strong> in one transaction: <strong>{tier.approvals}</strong> approvals.
          </li>
        ))
      )}
      <li>
        {policy.requireKnownDestination
          ? `Pays only addresses a member has signed into the address book${policy.newDestinationDelay ? `, and a new one waits ${durationLabel(policy.newDestinationDelay)} first` : ""}.`
          : "Pays any address."}
      </li>
      <li>
        {policy.hours
          ? `Payments run ${daysLabel(policy.hours.days)}, ${clock(policy.hours.start)} to ${clock(policy.hours.end)} (${offsetLabel(policy.hours.utcOffset)}).`
          : "Payments run at any hour."}
      </li>
    </ul>
  );
}

interface TierDraft {
  key: number;
  amount: string;
  approvals: number;
}

function PolicyForm({ address, account, current, onClose }: { address: string; account: AccountView; current: TreasuryPolicy; onClose: () => void }) {
  const queryClient = useQueryClient();
  const approvers = account.signers.filter((signer) => signer.permissions.includes("approve")).length;
  const [tiers, setTiers] = useState<TierDraft[]>(() => current.tiers.map((tier, index) => ({ key: index, amount: plainUsdc(tier.above), approvals: tier.approvals })));
  const [requireKnown, setRequireKnown] = useState(current.requireKnownDestination);
  const [wait, setWait] = useState(current.requireKnownDestination ? current.newDestinationDelay : DAY);
  const [hoursOn, setHoursOn] = useState(Boolean(current.hours));
  const [days, setDays] = useState<number[]>(current.hours?.days ?? [1, 2, 3, 4, 5]);
  const [start, setStart] = useState(clock(current.hours?.start ?? 540));
  const [end, setEnd] = useState(clock(current.hours?.end ?? 1_080));
  // The offset is the one this browser is in, fixed at the moment of saving: a rule
  // that means the same instants on every machine, and does not move with the seasons.
  const [offset] = useState(() => current.hours?.utcOffset ?? -new Date().getTimezoneOffset());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function build(): TreasuryPolicy | string {
    const list = [];
    for (const [index, tier] of tiers.entries()) {
      const units = parseUsdc(tier.amount);
      if (units == null) return `Tier ${index + 1} needs an amount in USDC with at most 6 decimals.`;
      if (tier.approvals < 1) return `Tier ${index + 1} needs at least one approval.`;
      if (tier.approvals > approvers) return `Tier ${index + 1} asks for ${tier.approvals} approvals and this account has ${approvers} members who can approve.`;
      list.push({ above: units, approvals: tier.approvals });
    }
    list.sort((a, b) => (BigInt(a.above) < BigInt(b.above) ? -1 : 1));
    for (let index = 1; index < list.length; index += 1) {
      if (list[index].above === list[index - 1].above) return "Two tiers start at the same amount.";
      if (list[index].approvals < list[index - 1].approvals) return "A larger amount cannot need fewer approvals than a smaller one.";
    }
    let hours = null;
    if (hoursOn) {
      const from = minutesOf(start);
      const to = minutesOf(end);
      if (from == null || to == null || from >= to) return "The hours need an opening time before a closing time.";
      if (days.length === 0) return "Pick at least one day.";
      hours = { days: [...days].sort((a, b) => a - b), start: from, end: to, utcOffset: offset };
    }
    return { tiers: list, requireKnownDestination: requireKnown, newDestinationDelay: requireKnown ? wait : 0, hours };
  }

  async function submit() {
    const wanted = build();
    if (typeof wanted === "string") return setError(wanted);
    setError(null);
    setBusy(true);
    try {
      queryClient.setQueryData(olienKeys.policy(address), await setPolicy(address, wanted));
      await queryClient.invalidateQueries({ queryKey: olienKeys.proposalsOf(address) });
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
      setBusy(false);
    }
  }

  return (
    <div className="olien-subform">
      <div className="olien-field">
        <span className="olien-field-label">Approvals by amount</span>
        {tiers.map((tier) => (
          <div key={tier.key} className="olien-address-row">
            <span className="olien-muted">Above</span>
            <input className="olien-input num" value={tier.amount} inputMode="decimal" placeholder="25000" aria-label="Amount in USDC" disabled={busy} onChange={(event) => setTiers((list) => list.map((item) => (item.key === tier.key ? { ...item, amount: event.target.value } : item)))} />
            <span className="olien-muted">USDC, ask for</span>
            <select className="olien-input olien-input--short" value={tier.approvals} aria-label="Approvals" disabled={busy} onChange={(event) => setTiers((list) => list.map((item) => (item.key === tier.key ? { ...item, approvals: Number(event.target.value) } : item)))}>
              {Array.from({ length: Math.max(approvers, tier.approvals) }, (_, index) => index + 1).map((count) => (
                <option key={count} value={count}>
                  {count} of {approvers}
                </option>
              ))}
            </select>
            <button type="button" className="olien-icon-btn" aria-label="Remove this tier" disabled={busy} onClick={() => setTiers((list) => list.filter((item) => item.key !== tier.key))}>
              <Trash2 size={14} />
            </button>
          </div>
        ))}
        <div>
          <Button size="sm" icon={<Plus size={13} />} disabled={busy || tiers.length >= 8} onClick={() => setTiers((list) => [...list, { key: Date.now(), amount: "", approvals: Math.min(approvers, account.threshold + 1) }])}>
            Add a tier
          </Button>
        </div>
        <span className="olien-field-hint">A tier can ask for more approvals than the account&apos;s threshold of {account.threshold}, never fewer. A batch is held to its total.</span>
      </div>

      <div className="olien-field">
        <label className="olien-check">
          <input type="checkbox" checked={requireKnown} disabled={busy} onChange={(event) => setRequireKnown(event.target.checked)} /> Pay only addresses in the address book
        </label>
        {requireKnown ? (
          <Field label="A new address waits" hint="How long after a member signs an address into the book before it can be paid. Anyone who does not recognise it can remove it meanwhile.">
            <DurationInput value={wait} disabled={busy} onChange={setWait} />
          </Field>
        ) : null}
      </div>

      <div className="olien-field">
        <label className="olien-check">
          <input type="checkbox" checked={hoursOn} disabled={busy} onChange={(event) => setHoursOn(event.target.checked)} /> Let payments run only during set hours
        </label>
        {hoursOn ? (
          <>
            <span className="olien-toggles" role="group" aria-label="Days">
              {DAY_NAMES.map((name, day) => (
                <button key={name} type="button" className={cx("olien-toggle", days.includes(day) && "is-on")} aria-pressed={days.includes(day)} disabled={busy} onClick={() => setDays((list) => (list.includes(day) ? list.filter((item) => item !== day) : [...list, day]))}>
                  {name}
                </button>
              ))}
            </span>
            <div className="olien-address-row">
              <input type="time" className="olien-input olien-input--short" value={start} aria-label="Opens" disabled={busy} onChange={(event) => setStart(event.target.value)} />
              <span className="olien-muted">to</span>
              <input type="time" className="olien-input olien-input--short" value={end} aria-label="Closes" disabled={busy} onChange={(event) => setEnd(event.target.value)} />
              <span className="olien-muted">{offsetLabel(offset)}</span>
            </div>
          </>
        ) : null}
      </div>

      <Note tone="info" icon={<Clock size={14} />}>
        A change that only tightens the policy takes effect at once. One that loosens anything waits {durationLabel(account.configDelay)}, the same delay as a change to the account&apos;s own rules, and any member can cancel it in that time.
      </Note>
      <InlineError message={error} />
      <div className="olien-actions">
        <Button variant="primary" busy={busy} onClick={() => void submit()}>
          Save policy
        </Button>
        <Button variant="ghost" disabled={busy} onClick={onClose}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

export function PolicySection({ address, account }: { address: string; account: AccountView }) {
  const queryClient = useQueryClient();
  const policy = usePolicy(address, true);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function cancel() {
    setBusy(true);
    setError(null);
    try {
      queryClient.setQueryData(olienKeys.policy(address), await cancelPolicyChange(address));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel
      title="Treasury policy"
      action={
        !editing && policy.data ? (
          <Button size="sm" disabled={account.status !== "live"} onClick={() => setEditing(true)}>
            Change
          </Button>
        ) : null
      }
    >
      <p className="olien-panel-lead">
        The account decides who may approve and how many it takes. This decides how much, to whom and when: a large payment needs more approvals, a new address waits, and nothing runs outside the team&apos;s hours. It is kept by this service, so it holds a payment here and cannot hold one that members send to the chain themselves.
      </p>
      {policy.isLoading ? (
        <Loading label="Loading the policy" />
      ) : policy.error || !policy.data ? (
        <InlineError message={errorMessage(policy.error)} />
      ) : editing ? (
        <PolicyForm address={address} account={account} current={policy.data.policy} onClose={() => setEditing(false)} />
      ) : (
        <>
          <PolicySummary policy={policy.data.policy} threshold={account.threshold} />
          {policy.data.pending ? (
            <Note tone="warn" icon={<Clock size={14} />}>
              <div className="olien-secret">
                <div>
                  A looser policy is waiting and takes effect {formatTime(policy.data.pending.effectiveAt)}
                  {policy.data.pending.proposedBy ? `, proposed by ${policy.data.pending.proposedBy.startsWith("0x") ? shortAddress(policy.data.pending.proposedBy) : policy.data.pending.proposedBy}` : ""}: {policy.data.pending.loosens.join("; ")}.
                </div>
                <PolicySummary policy={policy.data.pending.policy} threshold={account.threshold} />
                <div>
                  <Button size="sm" variant="danger" busy={busy} onClick={() => void cancel()}>
                    Cancel this change
                  </Button>
                </div>
              </div>
            </Note>
          ) : null}
          <InlineError message={error} />
        </>
      )}
    </Panel>
  );
}

const ACTIONS: Record<string, string> = {
  "account.created": "Created the account",
  "account.imported": "Opened the account from the chain",
  "account.renamed": "Renamed the account",
  "proposal.opened": "Proposed a transaction",
  "proposal.approved": "Approved a transaction",
  "proposal.executed": "Executed a transaction",
  "proposal.failed": "An execution failed",
  "proposal.deleted": "Deleted a proposal",
  "book.added": "Signed an address into the book",
  "book.removed": "Removed an address from the book",
  "policy.changed": "Changed the treasury policy",
  "policy.proposed": "Proposed a looser policy",
  "policy.cancelled": "Cancelled a policy change",
  "policy.applied": "A waiting policy change took effect",
  "key.minted": "Created an API key",
  "key.revoked": "Revoked an API key",
  "webhook.created": "Added a webhook",
  "webhook.deleted": "Removed a webhook",
  "cheque.written": "Wrote a cheque",
  "cheque.signed": "Signed a cheque",
  "cheque.issued": "A cheque was issued",
  "cheque.deleted": "Deleted a draft cheque",
  "cheque.voiding": "Began voiding a cheque",
};

function who(row: AuditRow): string {
  const actor = row.actor ? (row.actor.startsWith("0x") ? shortAddress(row.actor) : row.actor) : "The service";
  return row.via ? `${actor}, through the key ${row.via}` : actor;
}

function about(row: AuditRow): string {
  if (!row.subject) return "";
  return /^0x[0-9a-fA-F]{40,}$/.test(row.subject) ? shortAddress(row.subject) : row.subject;
}

export function AuditSection({ address }: { address: string }) {
  const audit = useAudit(address, true);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function exportCsv() {
    setError(null);
    setExporting(true);
    try {
      const { csv, intact } = await getAuditCsv(address);
      if (!intact) setError("The trail in this export does not hold together: a row was altered or removed after it was written.");
      const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `olien-${address.slice(2, 10)}-audit.csv`;
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

  return (
    <Panel
      title="Audit trail"
      action={
        <Button size="sm" icon={<Download size={13} />} busy={exporting} onClick={() => void exportCsv()}>
          Export CSV
        </Button>
      }
    >
      <p className="olien-panel-lead">
        Who did what to this account, in order: proposals, approvals, the address book, the policy, keys and cheques. Each row carries the hash of the one before it, so a row changed or removed afterwards shows.
      </p>
      <InlineError message={error} />
      {audit.isLoading ? (
        <Loading label="Loading the trail" />
      ) : audit.error || !audit.data ? (
        <InlineError message={errorMessage(audit.error)} />
      ) : audit.data.rows.length === 0 ? (
        <EmptyState title="Nothing recorded yet" hint="The trail starts with the next thing anyone does." />
      ) : (
        <>
          <p className="olien-field-hint">
            {audit.data.intact ? (
              <Pill tone="green">
                <Check size={11} /> Unbroken
              </Pill>
            ) : (
              <Pill tone="red">Altered</Pill>
            )}{" "}
            The latest {audit.data.rows.length}. The export has the rest.
          </p>
          <Table head={["When", "Who", "What", "About"]}>
            {audit.data.rows.map((row) => (
              <tr key={row.id}>
                <td className="olien-muted num">{formatTime(row.at)}</td>
                <td>{who(row)}</td>
                <td>{ACTIONS[row.action] ?? row.action}</td>
                <td className="olien-muted olien-mono" title={row.subject ?? undefined}>
                  {about(row)}
                </td>
              </tr>
            ))}
          </Table>
        </>
      )}
    </Panel>
  );
}
