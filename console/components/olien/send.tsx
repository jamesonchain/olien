"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { errorMessage, formatDay, formatUsdc, nowSeconds, proposeTransfer } from "@/lib/treasury";
import { AddRecipientButton, newRecipient, recipientsTotal, RecipientsEditor, validateRecipients, type RecipientDraft } from "./recipients";
import { Button, Disclosure, Field, InlineError, Loading, Note, Panel } from "./ui";
import { accountError, applyProposal, useOlienAccount, useSuggestions } from "./use-olien";

const DAY = 86_400;

export function OlienSend({ address }: { address: string }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const account = useOlienAccount(address);
  const entries = useSuggestions(address);
  const [recipients, setRecipients] = useState<RecipientDraft[]>(() => [newRecipient()]);
  const [lane, setLane] = useState("0");
  const [validDays, setValidDays] = useState(7);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (account.isLoading) return <Loading label="Loading the Olien" />;
  if (account.error || !account.data) return <InlineError message={accountError(account.error)} />;

  const view = account.data;
  const approvers = view.signers.filter((signer) => signer.permissions.includes("approve"));
  const total = recipientsTotal(recipients);
  const balance = BigInt(view.usdcBalance || "0");
  const overBalance = total > balance;

  async function submit() {
    if (!/^\d+$/.test(lane)) {
      setError("The lane is a whole number, 0 by default.");
      return;
    }
    if (validDays < 1 || validDays > 30) {
      setError("A transaction can stay valid for 1 to 30 days.");
      return;
    }
    const list = validateRecipients(recipients);
    if (typeof list === "string") {
      setError(list);
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const created = await proposeTransfer(address, { recipients: list, nonceKey: lane, validUntil: nowSeconds() + validDays * DAY });
      applyProposal(queryClient, address, created);
      router.push(`/${address}/transactions/${created.txHash}`);
    } catch (cause) {
      setError(errorMessage(cause));
      setSubmitting(false);
    }
  }

  return (
    <div className="olien-page">
      <div className="olien-split">
        <div className="olien-col">
          <Panel title="Recipients" action={<AddRecipientButton recipients={recipients} onChange={setRecipients} disabled={submitting} />}>
            <RecipientsEditor recipients={recipients} onChange={setRecipients} book={entries} disabled={submitting} />
          </Panel>

          <Panel>
            <Disclosure summary="Advanced">
              <div className="olien-form-grid">
                <Field label="Lane" hint="Transactions in one lane run in order. Use another lane for a payment that must not wait behind this one.">
                  <input className="olien-input olien-input--short num" value={lane} inputMode="numeric" disabled={submitting} onChange={(event) => setLane(event.target.value.trim())} />
                </Field>
                <Field label="Valid for (days)" hint={`Expires on ${formatDay(nowSeconds() + validDays * DAY)} if not executed by then.`}>
                  <input className="olien-input olien-input--short num" type="number" min={1} max={30} value={validDays} disabled={submitting} onChange={(event) => setValidDays(Math.max(1, Math.min(30, Math.floor(Number(event.target.value) || 1))))} />
                </Field>
              </div>
            </Disclosure>
          </Panel>
        </div>

        <aside className="olien-col olien-col--side">
          <Panel title="Summary">
            <dl className="olien-kv">
              <div>
                <dt>Total</dt>
                <dd className="num">{formatUsdc(total)}</dd>
              </div>
              <div>
                <dt>Balance</dt>
                <dd className="num">{formatUsdc(balance)}</dd>
              </div>
              <div>
                <dt>Needs</dt>
                <dd>
                  {view.threshold} of {approvers.length} approvals
                </dd>
              </div>
            </dl>
            <ul className="olien-approver-list">
              {approvers.map((signer) => (
                <li key={signer.signerId}>
                  {signer.label}
                  {signer.mine ? <span className="olien-tag olien-tag--accent">You</span> : null}
                </li>
              ))}
            </ul>
            {overBalance ? <Note tone="warn">The total exceeds the balance. Members can still approve, but it will not execute until the Olien is funded.</Note> : null}
            <InlineError message={error} />
            <Button variant="primary" className="olien-btn--block" busy={submitting} onClick={() => void submit()}>
              {submitting ? "Creating" : "Create transaction"}
            </Button>
            <p className="olien-field-hint">Creating it costs nothing. Members approve, then anyone executes and the Olien pays its own gas in USDC.</p>
          </Panel>
        </aside>
      </div>
    </div>
  );
}
