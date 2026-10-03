"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { errorMessage, formatUsdc, importAccount, isValidAddress, shortAddress, TreasuryError } from "@/lib/treasury";
import { Button, Disclosure, Field, InlineError, Loading, Pill, plural } from "./ui";
import { lastAccount, olienKeys, rememberAccount, useAccounts } from "./use-olien";
import { useWalletSession } from "./wallet";

// An Olien is on the chain whether or not this service has heard of it: one made
// through another service, or one this service lost. Adding it by address rebuilds its
// row from the chain, and the service lets only a signer do it.
function OpenExisting() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [address, setAddress] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    if (!isValidAddress(address)) return setError("Enter the Olien's address.");
    setBusy(true);
    try {
      const view = await importAccount({ address: address.toLowerCase(), ...(name.trim() ? { name: name.trim() } : {}) });
      rememberAccount(view.address);
      await queryClient.invalidateQueries({ queryKey: olienKeys.accounts });
      router.push(`/${view.address}`);
    } catch (cause) {
      if (cause instanceof TreasuryError && cause.status === 403) setError("Your wallet is not a signer of that Olien, so it cannot be added from here.");
      else if (cause instanceof TreasuryError && (cause.status === 404 || cause.status === 405)) setError("This service cannot add an existing Olien yet.");
      else setError(errorMessage(cause));
      setBusy(false);
    }
  }

  return (
    <Disclosure summary="Open an Olien that already exists">
      <p className="olien-field-hint">
        An Olien lives on the chain, not in this console. If one names your wallet as a signer and is not listed above, add it by its address: its members, rules and balance are read from the chain. Labels, and proposals that were still collecting signatures, were never on the chain and do not come back.
      </p>
      <div className="olien-form-grid">
        <Field label="Address">
          <input className="olien-input olien-input--mono" value={address} placeholder="0x" spellCheck={false} disabled={busy} onChange={(event) => setAddress(event.target.value.trim())} />
        </Field>
        <Field label="Name (optional)">
          <input className="olien-input" value={name} placeholder="Operations" maxLength={80} disabled={busy} onChange={(event) => setName(event.target.value)} />
        </Field>
      </div>
      <InlineError message={error} />
      <div className="olien-actions">
        <Button variant="primary" busy={busy} onClick={() => void submit()}>
          Open
        </Button>
      </div>
    </Disclosure>
  );
}

// Squads' "select a squad" screen: every Olien the wallet belongs to, the last one
// opened first, and the create card always reachable.
export function OlienStart() {
  const accounts = useAccounts();
  const { address } = useWalletSession();
  const [last] = useState<string | null>(() => (typeof window === "undefined" ? null : lastAccount()));

  const rows = [...(accounts.data ?? [])].sort((a, b) => {
    if (a.address === last) return -1;
    if (b.address === last) return 1;
    return b.createdAt - a.createdAt;
  });

  return (
    <div className="olien-page">
      <p className="olien-page-intro">
        Every Olien that names <code>{address ? shortAddress(address) : "your wallet"}</code> as a signer, and the ones you created.
      </p>
      {accounts.isLoading ? <Loading label="Loading your Oliens" /> : null}
      {accounts.error ? <InlineError message={errorMessage(accounts.error)} /> : null}
      {!accounts.isLoading ? (
        <div className="olien-cards">
          {rows.map((row) => (
            <Link key={row.address} href={`/${row.address}`} className="olien-card olien-card--account">
              <div className="olien-card-head">
                <span className="olien-switcher-avatar" aria-hidden>
                  {row.name.slice(0, 1).toUpperCase()}
                </span>
                <span className="olien-switcher-text">
                  <strong>{row.name}</strong>
                  <small>
                    <code>{shortAddress(row.address)}</code>
                  </small>
                </span>
                {row.status !== "live" ? <Pill tone={row.status === "deploying" ? "amber" : "red"}>{row.status}</Pill> : null}
              </div>
              <div className="olien-card-balance">{formatUsdc(row.usdcBalance)}</div>
              <div className="olien-card-meta">
                <span>
                  {row.threshold} of {row.signerCount} to approve
                </span>
                <span>{plural(row.openProposals, "open proposal")}</span>
                <span>{plural(row.scheduledChanges, "scheduled change")}</span>
              </div>
            </Link>
          ))}
          <Link href="/new" className="olien-card olien-card--create">
            <span className="olien-card-plus">
              <Plus size={18} />
            </span>
            <strong>Create an Olien</strong>
            <p>Name it, add members, set the threshold. It exists on chain in a few seconds and can take deposits at once.</p>
          </Link>
        </div>
      ) : null}
      {!accounts.isLoading && !accounts.error && rows.length === 0 ? (
        <p className="olien-muted">No Olien names your wallet as a signer yet. Create one, or ask a member to add {address ? shortAddress(address) : "your wallet"}.</p>
      ) : null}
      {!accounts.isLoading ? <OpenExisting /> : null}
    </div>
  );
}
