"use client";

import { Plus } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { errorMessage, formatUsdc, shortAddress } from "@/lib/treasury";
import { InlineError, Loading, Pill, plural } from "./ui";
import { lastAccount, useAccounts } from "./use-olien";
import { useWalletSession } from "./wallet";

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
    </div>
  );
}
