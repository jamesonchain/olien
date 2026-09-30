"use client";

import { chainName } from "@/lib/chain";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Info, KeyRound, Plus, Trash2, TriangleAlert, Users } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { createPasskey, friendlyPasskeyError, passkeySupported, type PasskeyRecord } from "@/lib/passkey";
import { createAccount, durationLabel, errorMessage, isHandle, isValidAddress, shortAddress, type CreateAccountBody, type Permission, type SignerInput } from "@/lib/treasury";
import { delayWarnings, keyName, lockedByLosing, lockoutMessage, syncedCanMeet, syncedMessage, vetoRule } from "@/lib/resilience";
import { AddressChip, Button, cx, Disclosure, DurationInput, Field, InlineError, PermissionTags, Spinner, Tag } from "./ui";
import { olienKeys, rememberAccount } from "./use-olien";
import { useWalletSession } from "./wallet";

const HOUR = 3_600;
const DAY = 86_400;
const MAX_DELAY = 30 * DAY;

export interface MemberDraft {
  key: number;
  kind: "ecdsa" | "webauthn";
  address: string;
  label: string;
  approve: boolean;
  veto: boolean;
  recover: boolean;
  // Passkeys: the public key and the id the contract will give it.
  x?: string;
  y?: string;
  signerId?: string;
  // Backup-eligible: the authenticator syncs it across a cloud account.
  synced?: boolean | null;
}

export interface PasskeyAdder {
  add: () => void;
  busy: boolean;
  supported: boolean;
}

let draftSequence = 0;

export function newMember(partial: Partial<MemberDraft> = {}): MemberDraft {
  draftSequence += 1;
  return { key: draftSequence, kind: "ecdsa", address: "", label: "", approve: true, veto: true, recover: false, ...partial };
}

// A passkey vetoes through a user operation the relayer submits, so it starts with the
// same permissions as a wallet. Its default name says what the authenticator said about
// it, since that is the one fact about a passkey the other members cannot see.
export function newPasskeyMember(record: PasskeyRecord): MemberDraft {
  const label = record.synced ? "Synced passkey" : "Passkey on this device";
  return newMember({ kind: "webauthn", label, approve: true, veto: true, x: record.x, y: record.y, signerId: record.signerId, synced: record.synced });
}

export function signerInputOf(row: MemberDraft, fallbackLabel: string): SignerInput {
  const label = row.label.trim() || fallbackLabel;
  if (row.kind === "webauthn") return { kind: "webauthn", label, permissions: permissionsOf(row), x: row.x, y: row.y, uvRequired: true, synced: row.synced ?? undefined };
  // A Recourse account by @handle: the service resolves it and decides whether it is
  // a Safe (a contract signer) or a plain key, and labels it by the handle unless told.
  if (!isValidAddress(row.address)) return { kind: "ecdsa", handle: row.address.trim().replace(/^@/, ""), label: row.label.trim() || row.address.trim(), permissions: permissionsOf(row) };
  return { kind: "ecdsa", address: row.address.toLowerCase(), label, permissions: permissionsOf(row) };
}

// Creates a passkey on this device and hands it to the list as a member draft. One
// Touch ID or Face ID prompt; the public key comes back from the browser.
export function usePasskeyMember(onAdd: (draft: MemberDraft) => void, userHandle: string | null | undefined, onError: (message: string) => void): PasskeyAdder {
  const [busy, setBusy] = useState(false);
  const supported = passkeySupported();
  return {
    busy,
    supported,
    add: () => {
      setBusy(true);
      void createPasskey("Passkey on this device", userHandle ?? "olien")
        .then((record) => onAdd(newPasskeyMember(record)))
        .catch((cause) => onError(friendlyPasskeyError(cause)))
        .finally(() => setBusy(false));
    },
  };
}

export function permissionsOf(draft: MemberDraft): Permission[] {
  const list: Permission[] = [];
  if (draft.approve) list.push("approve");
  if (draft.veto) list.push("veto");
  if (draft.recover) list.push("recover");
  return list;
}

export function PermissionToggles({ draft, onChange, disabled }: { draft: MemberDraft; onChange: (change: Partial<MemberDraft>) => void; disabled?: boolean }) {
  const items: { key: "approve" | "veto" | "recover"; label: string }[] = [
    { key: "approve", label: "Approve" },
    { key: "veto", label: "Veto" },
    { key: "recover", label: "Recover" },
  ];
  return (
    <span className="olien-toggles" role="group" aria-label="Permissions">
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          className={cx("olien-toggle", draft[item.key] && "is-on")}
          aria-pressed={draft[item.key]}
          disabled={disabled}
          onClick={() => onChange({ [item.key]: !draft[item.key] })}
        >
          {draft[item.key] ? <Check size={12} /> : null}
          {item.label}
        </button>
      ))}
    </span>
  );
}

export function MemberRows({
  rows,
  onChange,
  onRemove,
  disabled,
  passkey,
}: {
  rows: MemberDraft[];
  onChange: (key: number, change: Partial<MemberDraft>) => void;
  onRemove: (key: number) => void;
  disabled?: boolean;
  passkey?: PasskeyAdder;
}) {
  return (
    <div className="olien-member-rows">
      {rows.map((row, index) => (
        <div className="olien-member-row" key={row.key}>
          {row.kind === "webauthn" ? (
            <div className="olien-field">
              <span className="olien-field-label">Passkey {index + 1}</span>
              <span className="olien-passkey-row">
                <Tag tone="accent">{row.synced ? "Synced passkey" : "Passkey"}</Tag>
                <code title={row.signerId}>{row.signerId ? `${row.signerId.slice(0, 10)}…${row.signerId.slice(-4)}` : ""}</code>
              </span>
            </div>
          ) : (
            <Field label={`Address or @handle ${index + 1}`}>
              <input className="olien-input olien-input--mono" value={row.address} placeholder="0x… or @name" spellCheck={false} disabled={disabled} onChange={(event) => onChange(row.key, { address: event.target.value.trim() })} />
            </Field>
          )}
          <Field label="Label">
            <input className="olien-input" value={row.label} placeholder={`Member ${index + 1}`} disabled={disabled} onChange={(event) => onChange(row.key, { label: event.target.value })} />
          </Field>
          <div className="olien-field">
            <span className="olien-field-label">Permissions</span>
            <PermissionToggles draft={row} disabled={disabled} onChange={(change) => onChange(row.key, change)} />
          </div>
          <button type="button" className="olien-icon-btn olien-member-remove" aria-label={`Remove member ${index + 1}`} disabled={disabled || rows.length === 1} onClick={() => onRemove(row.key)}>
            <Trash2 size={14} />
          </button>
        </div>
      ))}
      {passkey ? (
        <div className="olien-member-add-passkey">
          <Button size="sm" icon={<KeyRound size={13} />} busy={passkey.busy} disabled={disabled || !passkey.supported} onClick={passkey.add}>
            Add a passkey from this device
          </Button>
          <span className="olien-field-hint">
            {passkey.supported
              ? "Touch ID or Face ID signs for it and the relayer pays its gas. A passkey synced to an Apple or Google account lives on every device signed into that account."
              : "This browser cannot create passkeys."}
          </span>
        </div>
      ) : null}
    </div>
  );
}

// Validates one draft list the way the contract will: valid, unique addresses, a
// permission each, at least one approver.
export function validateMembers(rows: MemberDraft[], taken: Set<string> = new Set()): string | null {
  if (rows.length === 0) return "Add at least one member.";
  const seen = new Set(taken);
  for (const [index, row] of rows.entries()) {
    if (row.kind === "webauthn") {
      const id = row.signerId?.toLowerCase() ?? "";
      if (!id || !row.x || !row.y) return `Member ${index + 1} is a passkey without a key.`;
      if (seen.has(id)) return `Member ${index + 1} repeats a passkey already in the list.`;
      seen.add(id);
      if (!row.approve && !row.veto && !row.recover) return `Member ${index + 1} needs at least one permission.`;
      continue;
    }
    if (!isValidAddress(row.address) && !isHandle(row.address)) return `Member ${index + 1} needs an address or an @handle.`;
    const lower = row.address.trim().toLowerCase().replace(/^@/, "");
    if (seen.has(lower)) return `Member ${index + 1} repeats an address already in the list.`;
    seen.add(lower);
    if (!row.approve && !row.veto && !row.recover) return `Member ${index + 1} needs at least one permission.`;
  }
  return null;
}

type Step = "name" | "members" | "review";
const STEPS: { id: Step; label: string }[] = [
  { id: "name", label: "Olien Details" },
  { id: "members", label: "Members & Threshold" },
  { id: "review", label: "Review" },
];

// Squads' create flow: three underlined steps, a headline for each, one card that
// holds the step, and two equal buttons at its foot.
export function OlienNewAccount() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { address: walletAddress } = useWalletSession();
  const [step, setStep] = useState<Step>("name");
  const [name, setName] = useState("");
  const [members, setMembers] = useState<MemberDraft[]>(() => [newMember({ address: walletAddress ?? "", label: "Me" })]);
  const [threshold, setThreshold] = useState(1);
  // One by default: any member can stop a rule change while it waits, and cannot stop
  // money or their own removal, so the griefing that makes one unsafe elsewhere is
  // excluded here. Automatic stays available for teams that want the quorum to decide.
  const [vetoThreshold, setVetoThreshold] = useState(1);
  const [configDelay, setConfigDelay] = useState(DAY);
  const [recoveryDelay, setRecoveryDelay] = useState(2 * DAY);
  const [recoveryCoSignDelay, setRecoveryCoSignDelay] = useState(HOUR);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const passkey = usePasskeyMember((draft) => setMembers((current) => [...current, draft]), walletAddress, setError);

  const approvers = members.filter((row) => row.approve).length;
  const vetoers = members.filter((row) => row.veto).length;
  const recoverers = members.filter((row) => row.recover).length;
  const stepIndex = STEPS.findIndex((entry) => entry.id === step);
  const boundedThreshold = Math.min(Math.max(1, threshold), Math.max(1, approvers));
  const approverVetoers = members.filter((row) => row.approve && row.veto).length;
  const isMine = (row: MemberDraft) => Boolean(walletAddress && row.kind === "ecdsa" && row.address.toLowerCase() === walletAddress.toLowerCase());
  const lockout = lockedByLosing(
    members.map((row, index) => ({ key: keyName(row.label.trim() || `Member ${index + 1}`, isMine(row), row.kind), approve: row.approve, recover: row.recover })),
    boundedThreshold,
  );
  const syncedAlone = syncedCanMeet(members, boundedThreshold);
  // Nobody holds Veto: the contract refuses an explicit threshold above the vetoer
  // count, and the review screen says why the choice is moot.
  const vetoChoice = vetoers === 0 ? 0 : vetoThreshold;
  const delayWarning = delayWarnings({ configDelay, recoveryDelay, recoverers });

  function patch(key: number, change: Partial<MemberDraft>) {
    setMembers((current) => current.map((row) => (row.key === key ? { ...row, ...change } : row)));
  }

  function next() {
    setError(null);
    if (step === "name") {
      if (!name.trim()) return setError("Give the Olien a name.");
      if (name.trim().length > 80) return setError("Keep the name under 80 characters.");
      setStep("members");
    } else if (step === "members") {
      const problem = validateMembers(members);
      if (problem) return setError(problem);
      if (approvers === 0) return setError("At least one member must be able to approve.");
      // Refused rather than warned: at creation there is nothing to lose by fixing it,
      // and a treasury one lost laptop can brick is not one this console will make.
      if (lockout) return setError(lockoutMessage(lockout));
      setThreshold(boundedThreshold);
      setStep("review");
    }
  }

  function body(): CreateAccountBody | string {
    if (vetoChoice < 0 || (vetoChoice > 0 && vetoChoice > vetoers)) return `The veto threshold must be automatic or at most ${vetoers}, the number of members that can veto.`;
    for (const [label, seconds] of [
      ["config delay", configDelay],
      ["recovery delay", recoveryDelay],
      ["recovery co-sign delay", recoveryCoSignDelay],
    ] as const) {
      if (seconds > MAX_DELAY) return `The ${label} cannot exceed 30 days.`;
    }
    if (recoverers > 0 && recoveryDelay < HOUR) return "With a recover member the recovery delay must be at least 1 hour.";
    return {
      name: name.trim(),
      signers: members.map((row, index) => signerInputOf(row, `Member ${index + 1}`)),
      threshold: boundedThreshold,
      vetoThreshold: vetoChoice,
      configDelay,
      recoveryDelay,
      recoveryCoSignDelay,
    };
  }

  async function create() {
    const payload = body();
    if (typeof payload === "string") {
      setError(payload);
      return;
    }
    setError(null);
    setCreating(true);
    try {
      const view = await createAccount(payload);
      rememberAccount(view.address);
      await queryClient.invalidateQueries({ queryKey: olienKeys.accounts });
      router.push(`/olien/${view.address}`);
    } catch (cause) {
      setError(errorMessage(cause));
      setCreating(false);
    }
  }

  const headline: Record<Step, [string, string]> = {
    name: ["Secure your team's money in a few clicks", "Give your Olien a name. You can always adjust the details later."],
    members: ["Add members and configure security", "Add your team members and set the threshold."],
    review: ["Review and confirm", "One last look at the parameters before the Olien is deployed."],
  };

  return (
    <div className="olien-wiz">
      <ol className="olien-wiz-steps" aria-label="Steps">
        {STEPS.map((entry, index) => (
          <li key={entry.id} className={cx("olien-wiz-step", index <= stepIndex && "is-reached", entry.id === step && "is-active")} aria-current={entry.id === step ? "step" : undefined}>
            {entry.label}
          </li>
        ))}
      </ol>
      <div className="olien-wiz-head">
        <h1>{headline[step][0]}</h1>
        <p>{headline[step][1]}</p>
      </div>

      {step === "name" ? (
        <section className="olien-wiz-card">
          <h2>Create an Olien</h2>
          <div className="olien-wiz-name">
            <span className="olien-wiz-plus" aria-hidden>
              <Plus size={16} />
            </span>
            <label className="olien-wiz-name-field">
              <input className="olien-wiz-input olien-wiz-input--big" value={name} placeholder="Olien name" autoFocus disabled={creating} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => event.key === "Enter" && next()} />
              <span className="olien-field-hint">Members see this name in the switcher and in alerts.</span>
            </label>
          </div>
          <InlineError message={error} />
          <div className="olien-wiz-actions">
            <button type="button" className="olien-wiz-btn" onClick={() => router.push("/app")}>
              Cancel
            </button>
            <button type="button" className="olien-wiz-btn is-primary" onClick={next}>
              Next
            </button>
          </div>
        </section>
      ) : null}

      {step === "members" ? (
        <>
          <section className="olien-wiz-card">
            <h2>Add initial members</h2>
            <MemberRows rows={members} onChange={patch} onRemove={(key) => setMembers((current) => current.filter((row) => row.key !== key))} passkey={passkey} disabled={creating} />
            <button type="button" className="olien-wiz-btn olien-wiz-btn--add" onClick={() => setMembers((current) => [...current, newMember()])}>
              <Plus size={15} /> Add Member
            </button>
            <p className="olien-wiz-warn">
              <TriangleAlert size={14} /> Only add keys the team controls. An exchange deposit address cannot sign, and a member that cannot sign cannot approve.
            </p>
          </section>
          <section className="olien-wiz-card">
            <h2>Set confirmation threshold</h2>
            <div className="olien-wiz-slider">
              <div>
                <input type="range" min={1} max={Math.max(1, approvers)} value={boundedThreshold} disabled={creating || approvers <= 1} aria-label="Approvals needed" onChange={(event) => setThreshold(Number(event.target.value))} />
                <div className="olien-wiz-slider-scale">
                  <span>1</span>
                  <b>{boundedThreshold}</b>
                  <span>{Math.max(1, approvers)}</span>
                </div>
              </div>
              <p>
                {boundedThreshold} of {approvers} {approvers === 1 ? "member" : "members"} with approve must sign before a transaction runs.
              </p>
            </div>
            {lockout ? (
              <p className="olien-wiz-warn">
                <TriangleAlert size={14} /> {lockoutMessage(lockout)}
              </p>
            ) : null}
            {syncedAlone ? (
              <p className="olien-wiz-warn">
                <TriangleAlert size={14} /> {syncedMessage(syncedAlone)}
              </p>
            ) : null}
            <InlineError message={error} />
            <div className="olien-wiz-actions">
              <button type="button" className="olien-wiz-btn" onClick={() => setStep("name")}>
                Back
              </button>
              <button type="button" className="olien-wiz-btn is-primary" onClick={next}>
                Next
              </button>
            </div>
          </section>
        </>
      ) : null}

      {step === "review" ? (
        <section className="olien-wiz-card">
          <h2>Review your Olien</h2>
          <div className="olien-wiz-review-name">
            <span className="olien-wiz-avatar" aria-hidden>
              {name.trim().slice(0, 1).toUpperCase()}
            </span>
            <strong>{name.trim()}</strong>
          </div>
          <div className="olien-wiz-tiles">
            <div>
              <Users size={14} />
              <strong>{members.length}</strong>
              <span>Members</span>
            </div>
            <div>
              <Check size={14} />
              <strong>
                {boundedThreshold}/{approvers}
              </strong>
              <span>Threshold</span>
            </div>
            <div>
              <Info size={14} />
              <strong>$0</strong>
              <span>Deploy fee</span>
            </div>
          </div>
          <p className="olien-wiz-fine">
            <Info size={13} /> The relayer pays the deployment. The address is predicted from the members and a random salt, and the account can take deposits the moment it exists.{" "}
            {configDelay === 0
              ? "Changes to members or rules take effect the moment the threshold approves them."
              : `Changes to members or rules wait ${durationLabel(configDelay)}. ${vetoRule({ vetoThreshold: vetoChoice, vetoers, approverVetoers, threshold: boundedThreshold })}`}
          </p>
          {delayWarning.configDelay ? (
            <p className="olien-wiz-warn">
              <TriangleAlert size={14} /> {delayWarning.configDelay}
            </p>
          ) : null}
          <ul className="olien-wiz-members">
            {members.map((row, index) => (
              <li key={row.key}>
                <span>
                  <strong>{row.label.trim() || `Member ${index + 1}`}</strong>
                  {walletAddress && row.address.toLowerCase() === walletAddress.toLowerCase() ? <Tag tone="accent">You</Tag> : null}
                </span>
                {row.kind === "webauthn" ? <Tag tone="accent">{row.synced ? "Synced passkey" : "Passkey"}</Tag> : <AddressChip address={row.address} />}
                <PermissionTags permissions={permissionsOf(row)} />
              </li>
            ))}
          </ul>
          <Disclosure summary="Advanced">
            <div className="olien-form-grid">
              <Field label="Veto threshold" hint={vetoRule({ vetoThreshold: vetoChoice, vetoers, approverVetoers, threshold: boundedThreshold })}>
                <select className="olien-input olien-input--short" value={vetoChoice} disabled={creating || vetoers === 0} onChange={(event) => setVetoThreshold(Number(event.target.value))}>
                  <option value={0}>Automatic</option>
                  {Array.from({ length: vetoers }, (_, index) => index + 1).map((n) => (
                    <option key={n} value={n}>
                      {n} of {vetoers}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Config delay" hint={`Member, threshold and time lock changes wait ${durationLabel(configDelay)} after execution and can be vetoed meanwhile.`} error={delayWarning.configDelay}>
                <DurationInput value={configDelay} disabled={creating} onChange={setConfigDelay} />
              </Field>
              <Field label="Recovery delay" hint={`A recovery by a recover member alone waits ${durationLabel(recoveryDelay)}. At least 1 hour when a recover member exists.`} error={delayWarning.recoveryDelay}>
                <DurationInput value={recoveryDelay} disabled={creating} onChange={setRecoveryDelay} />
              </Field>
              <Field label="Recovery co-sign delay" hint={`A recovery co-signed by an approver waits ${durationLabel(recoveryCoSignDelay)}.`}>
                <DurationInput value={recoveryCoSignDelay} disabled={creating} onChange={setRecoveryCoSignDelay} />
              </Field>
            </div>
          </Disclosure>
          {creating ? (
            <p className="olien-wiz-fine">
              <Spinner /> Creating on {chainName}. This takes 10 to 30 seconds; the page moves to the new Olien when the receipt lands.
            </p>
          ) : null}
          <InlineError message={error} />
          <div className="olien-wiz-actions">
            <button type="button" className="olien-wiz-btn" disabled={creating} onClick={() => setStep("members")}>
              Back
            </button>
            <button type="button" className="olien-wiz-btn is-primary" disabled={creating} onClick={() => void create()}>
              {creating ? `Creating on ${chainName}` : "Confirm"}
            </button>
          </div>
        </section>
      ) : null}
    </div>
  );
}
