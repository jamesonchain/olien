"use client";

import { ArrowLeftRight } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { errorMessage, formatTime, kindLabel, proposalSummary, type ProposalStatus, type ProposalView } from "@/lib/treasury";
import { EmptyState, InlineError, Initials, Loading, Panel, proposerLabel, StatusPill, Table, Tabs } from "./ui";
import { ACTIVE_STATUSES, CLOSED_STATUSES, useProposals } from "./use-olien";

export function TransactionsTable({
  address,
  rows,
  loading,
  error,
  emptyTitle,
  emptyHint,
}: {
  address: string;
  rows: ProposalView[];
  loading: boolean;
  error: unknown;
  emptyTitle: string;
  emptyHint?: ReactNode;
}) {
  const router = useRouter();
  if (loading) return <Loading label="Loading transactions" />;
  if (error) return <InlineError message={errorMessage(error)} />;
  if (rows.length === 0) return <EmptyState icon={<ArrowLeftRight size={18} />} title={emptyTitle} hint={emptyHint} />;

  return (
    <Table head={["Transaction", "Status", "Approvals", "Created", "Proposer"]} className="olien-table--transactions">
      {rows.map((row) => {
        const href = `/${address}/transactions/${row.txHash}`;
        return (
          <tr key={row.txHash} className="olien-row--link" onClick={() => router.push(href)}>
            <td>
              <Link href={href} className="olien-row-title">
                {proposalSummary(row)}
              </Link>
              <small className="olien-muted">{kindLabel(row.kind)}</small>
            </td>
            <td>
              <StatusPill status={row.status} />
            </td>
            <td>
              <span className="olien-approvals-cell">
                <span className="num">
                  {row.approvals}/{row.required}
                </span>
                {row.confirmations.length ? <Initials names={row.confirmations.map((confirmation) => confirmation.label)} /> : null}
              </span>
            </td>
            <td className="num olien-muted">{formatTime(row.createdAt)}</td>
            <td className="olien-muted">{proposerLabel(row.proposer)}</td>
          </tr>
        );
      })}
    </Table>
  );
}

type Filter = "all" | "active" | "scheduled" | "executed" | "closed";

const FILTERS: Record<Filter, ProposalStatus[] | null> = {
  all: null,
  active: ACTIVE_STATUSES,
  scheduled: ["scheduled"],
  executed: ["executed"],
  closed: CLOSED_STATUSES,
};

const EMPTY: Record<Filter, { title: string; hint: string }> = {
  all: { title: "No transactions yet", hint: "Send creates the first one." },
  active: { title: "Nothing waiting on approvals", hint: "Open, ready, blocked and executing transactions show here." },
  scheduled: { title: "No scheduled changes", hint: "Member, threshold and time lock changes wait here after execution until the time lock passes." },
  executed: { title: "Nothing executed yet", hint: "Executed transactions show here with their receipt." },
  closed: { title: "Nothing closed", hint: "Vetoed, cancelled, replaced, stale, expired and failed transactions land here." },
};

export function OlienTransactions({ address }: { address: string }) {
  const proposals = useProposals(address);
  const [filter, setFilter] = useState<Filter>("all");
  const all = [...(proposals.data ?? [])].sort((a, b) => b.createdAt - a.createdAt);
  const count = (key: Filter) => (FILTERS[key] ? all.filter((row) => FILTERS[key]!.includes(row.status)).length : all.length);
  const rows = FILTERS[filter] ? all.filter((row) => FILTERS[filter]!.includes(row.status)) : all;

  return (
    <div className="olien-page">
      <Tabs
        items={[
          { id: "all", label: "All", count: count("all") },
          { id: "active", label: "Active", count: count("active") },
          { id: "scheduled", label: "Scheduled", count: count("scheduled") },
          { id: "executed", label: "Executed", count: count("executed") },
          { id: "closed", label: "Closed", count: count("closed") },
        ]}
        value={filter}
        onChange={setFilter}
      />
      <Panel flush>
        <TransactionsTable address={address} rows={rows} loading={proposals.isLoading} error={proposals.error} emptyTitle={EMPTY[filter].title} emptyHint={EMPTY[filter].hint} />
      </Panel>
    </div>
  );
}
