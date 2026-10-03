"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Ban, Check, Circle, KeyRound, Lock, Play, Trash2, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useSendTransaction, useSignTypedData } from "wagmi";
import { chainName, nativeSymbol, olienPublicClient as publicClient } from "@/lib/chain";
import {
  cancelProposal,
  confirmProposal,
  deleteProposal,
  errorMessage,
  executeProposal,
  executeScheduled,
  formatTime,
  formatUsdc,
  getProposal,
  prepareVetoOperation,
  submitOperation,
  hashMatches,
  kindLabel,
  proposalHash,
  proposalSummary,
  shortAddress,
  signerIdFor,
  typedDataFor,
  type AccountView,
  type Hex,
  type ProposalView,
  type RecipientInput,
} from "@/lib/treasury";
import { AddressChip, Button, CopyButton, Countdown, cx, Disclosure, InlineError, KeyValue, Loading, Note, Panel, plural, proposerLabel, Spinner, StatusPill, Tag, TxChip } from "./ui";
import { accountError, applyProposal, olienKeys, useNow, useOlienAccount, useProposal, useVetoCall } from "./use-olien";
import { friendlyPasskeyError, knownPasskeys, passkeySupported, signWithPasskey } from "@/lib/passkey";
import { friendlyWalletError, useOlienChain, useWalletSession, walletSigner } from "./wallet";

const SIGNABLE = ["open", "ready", "blocked", "failed"];

function transferRecipients(view: ProposalView): RecipientInput[] | null {
  if (view.kind !== "transfer" || !view.intent) return null;
  const recipients = view.intent.recipients;
  if (!Array.isArray(recipients)) return null;
  return recipients.filter((entry): entry is RecipientInput => Boolean(entry && typeof entry === "object" && typeof (entry as RecipientInput).to === "string"));
}

function ResultBanner({ address, view }: { address: string; view: ProposalView }) {
  switch (view.status) {
    case "executed":
      return (
        <Note tone="ok" icon={<Check size={15} />}>
          Executed {formatTime(view.executedAt)}.{view.executedTx ? <> Transaction <TxChip hash={view.executedTx} />.</> : null}
        </Note>
      );
    case "scheduled":
      return (
        <Note tone="info" icon={<Lock size={15} />}>
          Executed and now scheduled: this change takes effect{" "}
          {view.scheduledReadyAt ? (
            <>
              in <Countdown target={view.scheduledReadyAt} /> ({formatTime(view.scheduledReadyAt)})
            </>
          ) : (
            "after its delay"
          )}
          . {view.effectiveVetoThreshold} {view.effectiveVetoThreshold === 1 ? "veto stops" : "vetoes stop"} it before then.{" "}
          <Link href={`/${address}/transactions`} className="olien-link">
            All scheduled changes
          </Link>
        </Note>
      );
    case "executing":
      return (
        <Note tone="info" icon={<Spinner />}>
          The relayer has sent the transaction and is waiting for the receipt.
        </Note>
      );
    case "failed":
      return (
        <Note tone="error" icon={<X size={15} />}>
          The relayer&apos;s transaction reverted. The slot is still free: fix the cause and execute again with the same approvals.
        </Note>
      );
    case "vetoed":
      return (
        <Note tone="error" icon={<Ban size={15} />}>
          Vetoed by {view.vetoes.map((veto) => veto.label).join(", ") || "a member"}. The change will not take effect.
        </Note>
      );
    case "cancelled":
      return (
        <Note tone="error" icon={<Ban size={15} />}>
          Cancelled on chain.
        </Note>
      );
    case "replaced":
      return <Note tone="warn">Another transaction took this slot, so this one can no longer run.</Note>;
    case "stale":
      return <Note tone="warn">The Olien&apos;s epoch moved after this was proposed; its signatures no longer verify. Propose it again.</Note>;
    case "expired":
      return <Note tone="warn">Expired {formatTime(view.validUntil)} without executing. Propose it again if it is still wanted.</Note>;
    case "blocked":
      return <Note tone="warn">Approved, but a lower sequence in the same lane is still open. It runs once that one executes or is cancelled.</Note>;
    default:
      return null;
  }
}

function VetoControls({ address, view, account }: { address: string; view: ProposalView; account: AccountView }) {
  const wallet = useWalletSession();
  const ensureChain = useOlienChain();
  const queryClient = useQueryClient();
  const { sendTransactionAsync } = useSendTransaction();
  const vetoCall = useVetoCall(address, view.txHash, view.status === "scheduled");
  const [busy, setBusy] = useState<"sending" | "waiting" | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const mySigner = walletSigner(account, wallet.address);
  const ids = (vetoCall.data?.signerIds ?? []).map((id) => id.toLowerCase());
  const canVeto = Boolean(wallet.matches && wallet.address && ids.includes(signerIdFor(wallet.address)));
  const isVetoer = Boolean(mySigner?.permissions.includes("veto"));
  // A passkey this browser holds that may still veto: it signs a user operation the
  // relayer submits, since a passkey has no wallet to send from. The assertion itself
  // proves which one answered, so this needs no wallet match.
  const operationIds = new Set((vetoCall.data?.operationSignerIds ?? []).map((id) => id.toLowerCase()));
  const mine = new Set(knownPasskeys().map((record) => record.signerId.toLowerCase()));
  const passkeyVetoers = account.signers.filter((signer) => signer.kind === "webauthn" && operationIds.has(signer.signerId.toLowerCase()) && mine.has(signer.signerId.toLowerCase()));
  const canPasskeyVeto = passkeyVetoers.length > 0 && passkeySupported();

  // The indexer turns the Vetoed event into a veto within one interval; give it a
  // minute before handing back to the page's own polling.
  async function waitForVeto() {
    setBusy("waiting");
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 4_000));
      const next = await getProposal(address, view.txHash);
      if (next.status === "vetoed" || next.vetoes.length > view.vetoes.length) {
        applyProposal(queryClient, address, next);
        break;
      }
    }
    await queryClient.invalidateQueries({ queryKey: olienKeys.vetoCall(address, view.txHash) });
  }

  async function veto() {
    if (!wallet.address || !vetoCall.data) return;
    setError(null);
    setBusy("sending");
    try {
      await ensureChain();
      const balance = await publicClient.getBalance({ address: wallet.address as Hex });
      if (balance === 0n) {
        setError(`Your wallet needs a little ${nativeSymbol} on ${chainName} for gas before it can veto.`);
        return;
      }
      const hash = await sendTransactionAsync({ to: vetoCall.data.to as Hex, data: vetoCall.data.data as Hex });
      setSent(hash);
      await waitForVeto();
    } catch (cause) {
      setError(friendlyWalletError(cause));
    } finally {
      setBusy(null);
    }
  }

  async function vetoWithPasskey() {
    const first = passkeyVetoers[0];
    if (!first) return;
    setError(null);
    setBusy("sending");
    try {
      // The hash does not depend on which signer answers, so prepare for one and let
      // any of them sign; the submit names the one that did.
      const prepared = await prepareVetoOperation(address, view.txHash, first.signerId);
      const signed = await signWithPasskey(prepared.hash as Hex, passkeyVetoers.map((signer) => ({ signerId: signer.signerId, x: signer.x, y: signer.y })));
      const receipt = await submitOperation(address, { operation: prepared.operation, signerId: signed.signerId, signature: signed.signature });
      setSent(receipt.txHash);
      await waitForVeto();
    } catch (cause) {
      setError(friendlyPasskeyError(cause));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="olien-veto">
      {busy === "waiting" ? (
        <p className="olien-muted">
          <Spinner /> Veto sent{sent ? <>, <TxChip hash={sent} /></> : null}. Waiting for the indexer to see it.
        </p>
      ) : sent ? (
        <p className="olien-ok">
          Veto transaction sent: <TxChip hash={sent} />
        </p>
      ) : null}
      {vetoCall.isLoading ? (
        <p className="olien-muted">
          <Spinner /> Checking whether you can veto.
        </p>
      ) : vetoCall.error ? (
        <InlineError message={errorMessage(vetoCall.error)} />
      ) : canVeto || canPasskeyVeto ? (
        <div className="olien-actions">
          {canVeto ? (
            <Button variant="danger" icon={<Ban size={14} />} busy={busy !== null} onClick={() => void veto()}>
              {busy === "sending" ? "Confirm in wallet" : "Veto"}
            </Button>
          ) : null}
          {canPasskeyVeto ? (
            <Button variant="danger" icon={<KeyRound size={14} />} busy={busy !== null} onClick={() => void vetoWithPasskey()}>
              {busy === "sending" ? "Touch ID" : "Veto with passkey"}
            </Button>
          ) : null}
          <span className="olien-field-hint">
            {canVeto ? `A veto from your wallet is a transaction of its own; it pays the gas in ${nativeSymbol}.` : "The Olien pays the gas for a passkey veto from its own balance."}
          </span>
        </div>
      ) : (
        <p className="olien-muted">
          {!isVetoer
            ? "Your wallet does not hold veto on this Olien."
            : view.scheduledExcluded && mySigner && view.scheduledExcluded.toLowerCase() === mySigner.signerId.toLowerCase()
              ? "This change removes your signer, so you cannot veto it."
              : view.vetoes.some((entry) => mySigner && entry.signerId.toLowerCase() === mySigner.signerId.toLowerCase())
                ? "You already vetoed this change."
                : "Your wallet cannot veto this change."}
        </p>
      )}
      <InlineError message={error} />
    </div>
  );
}

type Action = "approve" | "passkey" | "execute" | "executeScheduled" | "cancel" | "delete";

export function OlienTransaction({ address, txHash }: { address: string; txHash: string }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const now = useNow();
  const account = useOlienAccount(address);
  const proposal = useProposal(address, txHash);
  const wallet = useWalletSession();
  const ensureChain = useOlienChain();
  const { signTypedDataAsync } = useSignTypedData();
  const [busy, setBusy] = useState<Action | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (account.isLoading || proposal.isLoading) return <Loading label="Loading the transaction" />;
  if (account.error || !account.data) return <InlineError message={accountError(account.error)} />;
  if (proposal.error || !proposal.data) return <InlineError message={errorMessage(proposal.error)} />;

  const view = proposal.data;
  const acct = account.data;
  const hashOk = hashMatches(view);
  const mySigner = walletSigner(acct, wallet.address);
  const myId = mySigner?.signerId.toLowerCase() ?? null;
  const confirmedBy = new Map(view.confirmations.map((confirmation) => [confirmation.signerId.toLowerCase(), confirmation]));
  const approvers = acct.signers.filter((signer) => signer.permissions.includes("approve"));
  // Any passkey approver that has not signed yet may answer the prompt; the assertion
  // itself proves which one did, so this needs no wallet match.
  const passkeyApprovers = approvers.filter((signer) => signer.kind === "webauthn" && !confirmedBy.has(signer.signerId.toLowerCase()));
  const signable = SIGNABLE.includes(view.status);
  const canApprove = signable && hashOk && wallet.matches && Boolean(mySigner?.permissions.includes("approve")) && myId !== null && !confirmedBy.has(myId);
  const canPasskey = signable && hashOk && passkeyApprovers.length > 0 && passkeySupported();
  const alreadyApproved = myId !== null && confirmedBy.has(myId);
  const canExecute = view.status === "ready" || (view.status === "failed" && view.approvals >= view.required);
  const canCancel = signable && view.confirmations.length > 0;
  const isProposer = view.proposer != null && wallet.session != null && view.proposer.accountId === wallet.session.accountId;
  const canDelete = isProposer && ((view.status === "open" && view.confirmations.length === 0) || ["stale", "expired", "failed"].includes(view.status));
  const scheduledReady = view.status === "scheduled" && view.scheduledReadyAt != null && view.scheduledReadyAt <= now;
  const windowOpen = view.scheduledWindowEndsAt == null || view.scheduledWindowEndsAt > now;
  const recipients = transferRecipients(view);

  async function run(action: Action, job: () => Promise<void>) {
    setError(null);
    setBusy(action);
    try {
      await job();
    } catch (cause) {
      setError(action === "approve" ? friendlyWalletError(cause) : action === "passkey" ? friendlyPasskeyError(cause) : errorMessage(cause));
    } finally {
      setBusy(null);
    }
  }

  function approve() {
    return run("approve", async () => {
      if (!mySigner || !wallet.address) return;
      await ensureChain();
      const computed = proposalHash(view);
      if (computed.toLowerCase() !== view.txHash.toLowerCase()) {
        setError(`Hash mismatch, not signing. The typed data hashes to ${computed}; the proposal says ${view.txHash}.`);
        return;
      }
      const data = typedDataFor(view);
      const signature = await signTypedDataAsync({ domain: data.domain, types: data.types, primaryType: data.primaryType, message: data.message });
      applyProposal(queryClient, address, await confirmProposal(address, txHash, { signerId: signerIdFor(wallet.address), signature }));
    });
  }

  function approveWithPasskey() {
    return run("passkey", async () => {
      const computed = proposalHash(view);
      if (computed.toLowerCase() !== view.txHash.toLowerCase()) {
        setError(`Hash mismatch, not signing. The typed data hashes to ${computed}; the proposal says ${view.txHash}.`);
        return;
      }
      const signed = await signWithPasskey(view.txHash as `0x${string}`, passkeyApprovers.map((signer) => ({ signerId: signer.signerId, x: signer.x, y: signer.y })));
      applyProposal(queryClient, address, await confirmProposal(address, txHash, signed));
    });
  }

  const execute = () => run("execute", async () => applyProposal(queryClient, address, await executeProposal(address, txHash)));
  const executeNow = () => run("executeScheduled", async () => applyProposal(queryClient, address, await executeScheduled(address, txHash)));
  const cancel = () =>
    run("cancel", async () => {
      const next = await cancelProposal(address, txHash);
      applyProposal(queryClient, address, next);
      router.push(`/${address}/transactions/${next.txHash}`);
    });
  const remove = () =>
    run("delete", async () => {
      await deleteProposal(address, txHash);
      await queryClient.invalidateQueries({ queryKey: olienKeys.proposalsOf(address) });
      router.push(`/${address}/transactions`);
    });

  return (
    <div className="olien-page">
      <div className="olien-tx-head">
        <div>
          <span className="olien-panel-title">{kindLabel(view.kind)}</span>
          <h2 className="olien-tx-summary">{proposalSummary(view)}</h2>
          <p className="olien-muted">
            Proposed by {proposerLabel(view.proposer)} on {formatTime(view.createdAt)}. Lane {view.nonceKey}, sequence {view.sequence}.
          </p>
        </div>
        <StatusPill status={view.status} />
      </div>

      <ResultBanner address={address} view={view} />

      <div className="olien-split">
        <div className="olien-col">
          <Panel
            title="Approvals"
            action={
              <span className="num olien-muted">
                {view.approvals} of {view.required}
              </span>
            }
          >
            <ul className="olien-approvers">
              {approvers.map((signer) => {
                const confirmation = confirmedBy.get(signer.signerId.toLowerCase());
                return (
                  <li key={signer.signerId} className={cx("olien-approver", confirmation && "is-done")}>
                    <span className="olien-approver-mark" aria-hidden>
                      {confirmation ? <Check size={13} /> : <Circle size={13} />}
                    </span>
                    <span className="olien-approver-who">
                      <strong>
                        {signer.label}
                        {signer.mine ? <Tag tone="accent">You</Tag> : null}
                      </strong>
                      {signer.address ? <AddressChip address={signer.address} /> : <small className="olien-muted">{signer.kind} signer</small>}
                    </span>
                    <span className="olien-approver-when num olien-muted">
                      {confirmation ? `${confirmation.kind === "onchain" ? "Approved on chain" : "Signed"} ${formatTime(confirmation.signedAt)}` : "Waiting"}
                    </span>
                  </li>
                );
              })}
            </ul>
            {view.blockedBy ? (
              <p className="olien-field-hint">
                Blocked behind{" "}
                <Link href={`/${address}/transactions/${view.blockedBy}`} className="olien-link">
                  {shortAddress(view.blockedBy)}
                </Link>{" "}
                in the same lane.
              </p>
            ) : null}

            {view.status === "scheduled" ? (
              <div className="olien-scheduled">
                <div className="olien-scheduled-grid">
                  <div>
                    <span className="olien-panel-title">Takes effect</span>
                    <strong>{view.scheduledReadyAt ? <Countdown target={view.scheduledReadyAt} /> : "pending"}</strong>
                    <small className="olien-muted">{formatTime(view.scheduledReadyAt)}</small>
                  </div>
                  <div>
                    <span className="olien-panel-title">Window ends</span>
                    <strong>{view.scheduledWindowEndsAt ? formatTime(view.scheduledWindowEndsAt) : "open"}</strong>
                    <small className="olien-muted">must run before this</small>
                  </div>
                  <div>
                    <span className="olien-panel-title">Vetoes</span>
                    <strong className="num">
                      {view.vetoes.length} of {view.effectiveVetoThreshold}
                    </strong>
                    <small className="olien-muted">{plural(view.effectiveVetoThreshold, "veto", "vetoes")} stop it</small>
                  </div>
                </div>
                {view.vetoes.length ? (
                  <ul className="olien-approvers">
                    {view.vetoes.map((veto) => (
                      <li key={veto.signerId} className="olien-approver is-veto">
                        <span className="olien-approver-mark" aria-hidden>
                          <Ban size={13} />
                        </span>
                        <span className="olien-approver-who">
                          <strong>{veto.label}</strong>
                          <TxChip hash={veto.tx} />
                        </span>
                        <span className="olien-approver-when num olien-muted">Vetoed {formatTime(veto.at)}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
                <VetoControls address={address} view={view} account={acct} />
                {scheduledReady && windowOpen ? (
                  <div className="olien-actions">
                    <Button variant="primary" icon={<Play size={14} />} busy={busy === "executeScheduled"} disabled={busy !== null} onClick={() => void executeNow()}>
                      Execute now
                    </Button>
                    <span className="olien-field-hint">The delay has passed. The relayer applies the change and pays the gas.</span>
                  </div>
                ) : null}
              </div>
            ) : null}

            {canApprove || canPasskey || alreadyApproved || canExecute || canCancel || canDelete ? (
              <div className="olien-action-row">
                {canApprove ? (
                  <Button variant="primary" icon={<Check size={14} />} busy={busy === "approve"} disabled={busy !== null} onClick={() => void approve()}>
                    {busy === "approve" ? "Confirm in wallet" : "Approve"}
                  </Button>
                ) : null}
                {canPasskey ? (
                  <Button variant={canApprove ? "secondary" : "primary"} icon={<KeyRound size={14} />} busy={busy === "passkey"} disabled={busy !== null} onClick={() => void approveWithPasskey()}>
                    {busy === "passkey" ? "Touch ID or Face ID" : "Approve with passkey"}
                  </Button>
                ) : null}
                {alreadyApproved && signable ? (
                  <span className="olien-ok">
                    <Check size={14} /> You approved this.
                  </span>
                ) : null}
                {canExecute ? (
                  <Button variant={canApprove ? "secondary" : "primary"} icon={<Play size={14} />} busy={busy === "execute"} disabled={busy !== null} onClick={() => void execute()}>
                    {busy === "execute" ? "Executing" : view.status === "failed" ? "Execute again" : "Execute"}
                  </Button>
                ) : null}
                {canCancel ? (
                  <Button icon={<Ban size={14} />} busy={busy === "cancel"} disabled={busy !== null} onClick={() => void cancel()}>
                    Cancel
                  </Button>
                ) : null}
                {canDelete && !confirmDelete ? (
                  <Button variant="ghost" icon={<Trash2 size={14} />} disabled={busy !== null} onClick={() => setConfirmDelete(true)}>
                    Delete
                  </Button>
                ) : null}
              </div>
            ) : null}
            {confirmDelete ? (
              <div className="olien-confirm">
                <span>Delete this transaction? It has no signatures and leaves no trace on chain.</span>
                <Button variant="danger" size="sm" busy={busy === "delete"} onClick={() => void remove()}>
                  Delete
                </Button>
                <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => setConfirmDelete(false)}>
                  Keep
                </Button>
              </div>
            ) : null}
            {signable && !wallet.matches ? <p className="olien-field-hint">Sign in with the connected wallet to approve.</p> : null}
            {signable && wallet.matches && !mySigner ? <p className="olien-field-hint">Your wallet {wallet.address ? shortAddress(wallet.address) : ""} is not a member of this Olien, so it cannot approve.</p> : null}
            {!hashOk && signable ? <InlineError message="The typed data in this proposal does not hash to its txHash. Approving is disabled until the service fixes it." /> : null}
            {canExecute ? <p className="olien-field-hint">Execute sends it through the relayer, which pays the gas and waits for the receipt.</p> : null}
            {canCancel ? <p className="olien-field-hint">Cancel creates a new transaction carrying cancel(hash); once it collects the same threshold it kills this one at once.</p> : null}
            <InlineError message={error} />
          </Panel>

          <Panel title="Transaction">
            {recipients && recipients.length ? (
              <ul className="olien-calls">
                {recipients.map((recipient, index) => (
                  <li key={`${recipient.to}-${index}`} className="olien-call">
                    <span className="olien-call-index">{index + 1}</span>
                    <div className="olien-call-body">
                      <strong className="num">{formatUsdc(recipient.amount)}</strong>
                      <span>
                        to <AddressChip address={recipient.to} label={recipient.label} />
                      </span>
                      {recipient.memo ? <small className="olien-muted">Memo: {recipient.memo}</small> : null}
                    </div>
                  </li>
                ))}
              </ul>
            ) : view.decoded.length ? (
              <ul className="olien-calls">
                {view.decoded.map((call, index) => (
                  <li key={`${call.to}-${index}`} className="olien-call">
                    <span className="olien-call-index">{index + 1}</span>
                    <div className="olien-call-body">
                      <strong>{call.summary}</strong>
                      <span>
                        <AddressChip address={call.to} label={call.label} /> <code className="olien-muted">{call.selector}</code>
                        {call.readable ? null : <small className="olien-muted"> not decoded</small>}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="olien-muted">The service could not decode these calls; check the raw calldata below.</p>
            )}

            {view.hardRules.length ? (
              <div className="olien-rules">
                {view.hardRules.map((rule, index) => (
                  <div key={`${rule.rule}-${index}`} className="olien-rule">
                    <Lock size={12} />
                    <span>{rule.text}</span>
                  </div>
                ))}
              </div>
            ) : null}

            <div className={cx("olien-sim", view.simulation ? (view.simulation.ok ? "is-ok" : "is-fail") : "")}>
              {view.simulation ? (
                view.simulation.ok ? (
                  <>
                    <Check size={14} /> Simulation passed, checked {formatTime(view.simulation.checkedAt)}.
                  </>
                ) : (
                  <>
                    <X size={14} /> Simulation failed: {view.simulation.error ?? "the call reverts"}. Checked {formatTime(view.simulation.checkedAt)}.
                  </>
                )
              ) : (
                "Not simulated yet."
              )}
            </div>

            <KeyValue
              items={[
                { label: "Valid after", value: view.validAfter ? formatTime(view.validAfter) : "Immediately" },
                { label: "Valid until", value: formatTime(view.validUntil) },
                { label: "Lane", value: view.nonceKey },
                { label: "Sequence", value: String(view.sequence) },
                { label: "Nonce", value: view.nonce },
                { label: "Epoch", value: String(view.epoch) },
                { label: "Path", value: view.path },
              ]}
            />

            <Disclosure summary="Raw calldata">
              <div className="olien-raw">
                {view.calls.map((call, index) => (
                  <div key={index} className="olien-raw-call">
                    <span>to</span>
                    <code>{call.to}</code>
                    <span>value</span>
                    <code>{call.value}</code>
                    <span>data</span>
                    <code>{call.data}</code>
                  </div>
                ))}
              </div>
            </Disclosure>
          </Panel>
        </div>

        <aside className="olien-col olien-col--side">
          <Panel title="Transaction hash">
            <div className="olien-hash">
              <code>{view.txHash}</code>
              <CopyButton value={view.txHash} title="Copy hash" />
            </div>
            <p className="olien-field-hint">Compare this with your wallet&apos;s hash before signing. To check it away from this page, ops/olien-hash.mjs in the repository recomputes it from the calls on any machine with Node.</p>
          </Panel>
          <Panel title="Details">
            <KeyValue
              items={[
                { label: "Proposer", value: proposerLabel(view.proposer) },
                { label: "Created", value: formatTime(view.createdAt) },
                { label: "Olien", value: <AddressChip address={view.account} /> },
                ...(view.executedTx ? [{ label: "Executed tx", value: <TxChip hash={view.executedTx} /> }] : []),
                ...(view.executedAt ? [{ label: "Executed", value: formatTime(view.executedAt) }] : []),
              ]}
            />
          </Panel>
        </aside>
      </div>
    </div>
  );
}
