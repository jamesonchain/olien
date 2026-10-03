"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, ChevronRight, Copy, ExternalLink } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { erc20Abi } from "viem";
import { explorerAddressUrl, olienPublicClient as publicClient, olienUsdcAddress as usdcAddress } from "@/lib/chain";
import { formatEuros, formatDollars, formatUsdc, shortAddress, type AccountView, type LedgerEntry, type SignerView } from "@/lib/treasury";
import { DepositDialog } from "./deposit-dialog";
import { InlineError, Loading, Note } from "./ui";
import { accountError, useLedger, useOlienAccount } from "./use-olien";

// Squads' dashboard: the balance and its actions, the balance over time, the
// accounts under this one, and what moved today. Everything drawn comes from the
// ledger the indexer keeps, so the chart is history, not decoration.
export function OlienAccountHome({ address }: { address: string }) {
  const account = useOlienAccount(address);
  const ledger = useLedger(address, 200);
  const [depositOpen, setDepositOpen] = useState(false);

  if (account.isLoading) return <Loading label="Loading the Olien" />;
  if (account.error || !account.data) return <InlineError message={accountError(account.error)} />;

  const view = account.data;
  const entries = ledger.data ?? [];
  const approvers = view.signers.filter((signer) => signer.permissions.includes("approve"));

  return (
    <div className="olien-page olien-dash">
      {view.status === "deploying" ? <Note tone="warn">The creation transaction is still pending. The Olien becomes live once the receipt lands.</Note> : null}
      {view.status === "disabled" ? (
        <Note tone="error">The service disabled this Olien after its hash self-check failed, so it accepts no writes here. The account still works on chain with any other client.</Note>
      ) : null}
      <div className="olien-dash-grid">
        <BalanceCard view={view} entries={entries} approvers={approvers.length} onDeposit={() => setDepositOpen(true)} />
        <ChartCard view={view} entries={entries} />
        <AccountsCard view={view} />
        <FlowsCard entries={entries} loading={ledger.isLoading} />
      </div>
      <DepositDialog address={address} open={depositOpen} onClose={() => setDepositOpen(false)} />
    </div>
  );
}

const MONTH = 30 * 86_400;

function BalanceCard({ view, entries, approvers, onDeposit }: { view: AccountView; entries: LedgerEntry[]; approvers: number; onDeposit: () => void }) {
  const since = Math.floor(Date.now() / 1000) - MONTH;
  const delta = entries.filter((entry) => entry.blockTime >= since && entry.symbol === "USDC").reduce((sum, entry) => sum + (entry.direction === "in" ? 1n : -1n) * BigInt(entry.amount), 0n);
  return (
    <section className="olien-dash-card olien-dash-balance">
      <span className="olien-dash-label">Total Balance</span>
      <strong className="olien-dash-amount">{formatDollars(view.usdcBalance)}</strong>
      <div className="olien-dash-balance-meta">
        <span className={`olien-dash-delta ${delta < 0n ? "is-down" : ""}`}>
          <i aria-hidden /> {delta < 0n ? "-" : "+"} {formatDollars(delta < 0n ? -delta : delta)} <em>last month</em>
        </span>
        <span className="olien-dash-chip">
          Threshold <b>{view.threshold}/{approvers}</b>
        </span>
        {/* Only when there are euros. A permanent zero would read as a second
            account this treasury does not have. */}
        {BigInt(view.eurcBalance || "0") > 0n ? (
          <span className="olien-dash-chip">
            Also <b>{formatEuros(view.eurcBalance)}</b>
          </span>
        ) : null}
      </div>
      <div className="olien-dash-actions">
        <Link href={`/${view.address}/transactions/new`} className="olien-dash-action">
          <ArrowUp size={15} /> Send
        </Link>
        <button type="button" className="olien-dash-action" onClick={onDeposit}>
          <ArrowDown size={15} /> Deposit
        </button>
      </div>
    </section>
  );
}

// The balance walked backwards through the ledger from what the chain says now,
// so the line ends at today's number and every earlier point is what the account
// held after that movement. Six months of points, or as far as the ledger goes.
function series(view: AccountView, entries: LedgerEntry[]): { t: number; v: bigint }[] {
  const now = Math.floor(Date.now() / 1000);
  const usdc = entries.filter((entry) => entry.symbol === "USDC").sort((a, b) => b.blockTime - a.blockTime);
  let balance = BigInt(view.usdcBalance);
  const points: { t: number; v: bigint }[] = [{ t: now, v: balance }];
  for (const entry of usdc) {
    points.push({ t: entry.blockTime, v: balance });
    balance -= (entry.direction === "in" ? 1n : -1n) * BigInt(entry.amount);
    points.push({ t: entry.blockTime - 1, v: balance });
  }
  points.push({ t: Math.min(view.createdAt, now - 6 * MONTH), v: balance < 0n ? 0n : balance });
  return points.reverse();
}

function ChartCard({ view, entries }: { view: AccountView; entries: LedgerEntry[] }) {
  const points = useMemo(() => series(view, entries), [view, entries]);
  const [hover, setHover] = useState<number | null>(null);
  const width = 520;
  const height = 200;
  const pad = { l: 8, r: 8, t: 12, b: 26 };
  const t0 = points[0].t;
  const t1 = points[points.length - 1].t;
  const max = points.reduce((m, p) => (p.v > m ? p.v : m), 0n);
  const top = max === 0n ? 1_000_000n : max;
  const x = (t: number) => pad.l + ((t - t0) / Math.max(1, t1 - t0)) * (width - pad.l - pad.r);
  const y = (v: bigint) => pad.t + (1 - Number(v) / Number(top)) * (height - pad.t - pad.b);
  const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.t).toFixed(1)} ${y(p.v).toFixed(1)}`).join(" ");
  const area = `${path} L${x(t1).toFixed(1)} ${height - pad.b} L${x(t0).toFixed(1)} ${height - pad.b} Z`;
  const ticks = [1, 0.75, 0.5, 0.25, 0].map((f) => ({ f, label: formatDollars(BigInt(Math.round(Number(top) * f))) }));
  const months: { t: number; label: string }[] = [];
  for (let d = new Date(t0 * 1000); d.getTime() / 1000 <= t1; d.setMonth(d.getMonth() + 1)) {
    const first = new Date(d.getFullYear(), d.getMonth(), 1);
    months.push({ t: first.getTime() / 1000, label: first.toLocaleString("en-US", { month: "short" }) });
  }
  const shown = months.filter((m) => m.t >= t0).slice(-6);
  const hovered = hover === null ? null : points[hover];

  function onMove(event: React.MouseEvent<SVGSVGElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const px = ((event.clientX - rect.left) / rect.width) * width;
    let best = 0;
    for (let i = 1; i < points.length; i += 1) if (Math.abs(x(points[i].t) - px) < Math.abs(x(points[best].t) - px)) best = i;
    setHover(best);
  }

  return (
    <section className="olien-dash-card olien-dash-chart">
      <div className="olien-dash-chart-head">
        <span className="olien-dash-select">
          Main <ChevronRight size={12} />
        </span>
      </div>
      <div className="olien-dash-chart-body">
        <div className="olien-dash-ticks">
          {ticks.map((tick) => (
            <span key={tick.f}>{tick.label}</span>
          ))}
        </div>
        <div className="olien-dash-plot">
          <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" onMouseMove={onMove} onMouseLeave={() => setHover(null)} aria-label="Balance over time">
            <defs>
              <linearGradient id="olien-dash-fill" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0" stopColor="var(--accent)" stopOpacity="0.18" />
                <stop offset="1" stopColor="var(--accent)" stopOpacity="0" />
              </linearGradient>
            </defs>
            {ticks.map((tick) => (
              <line key={tick.f} x1={pad.l} x2={width - pad.r} y1={pad.t + (1 - tick.f) * (height - pad.t - pad.b)} y2={pad.t + (1 - tick.f) * (height - pad.t - pad.b)} className="grid" />
            ))}
            <path d={area} fill="url(#olien-dash-fill)" />
            <path d={path} className="line" />
            {hovered ? (
              <>
                <line x1={x(hovered.t)} x2={x(hovered.t)} y1={pad.t} y2={height - pad.b} className="cursor" />
                <circle cx={x(hovered.t)} cy={y(hovered.v)} r="3.5" className="point" />
              </>
            ) : null}
          </svg>
          {hovered ? (
            <div className="olien-dash-tip" style={{ left: `${(x(hovered.t) / width) * 100}%` }}>
              <small>Main</small>
              <strong>{formatDollars(hovered.v)}</strong>
              <span>{new Date(hovered.t * 1000).toLocaleDateString("en-US", { month: "long", day: "2-digit", year: "numeric" })}</span>
            </div>
          ) : null}
          <div className="olien-dash-months">
            {shown.map((m) => (
              <span key={m.t} style={{ left: `${(x(m.t) / width) * 100}%` }}>
                {m.label}
              </span>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

const TONES = ["a", "b", "c", "d"];

export function MemberAvatars({ signers, max = 4 }: { signers: SignerView[]; max?: number }) {
  return (
    <span className="olien-dash-avatars" aria-label={`${signers.length} members`}>
      {signers.slice(0, max).map((signer, index) => (
        <i key={signer.signerId} className={`tone-${TONES[index % TONES.length]}`} title={signer.label}>
          {signer.label.slice(0, 1).toUpperCase()}
        </i>
      ))}
      {signers.length > max ? <i className="more">+{signers.length - max}</i> : null}
    </span>
  );
}

function useUsdcBalance(address: string) {
  return useQuery({
    queryKey: ["olien", "usdc-balance", address],
    queryFn: () => publicClient.readContract({ address: usdcAddress, abi: erc20Abi, functionName: "balanceOf", args: [address as `0x${string}`] }),
    refetchInterval: 30_000,
  });
}

function SubAccountRow({ label, address, signers }: { label: string; address: string; signers: SignerView[] }) {
  const balance = useUsdcBalance(address);
  return <AccountRow label={label} address={address} balance={balance.data === undefined ? null : balance.data.toString()} signers={signers} />;
}

function AccountRow({ label, address, balance, signers }: { label: string; address: string; balance: string | null; signers: SignerView[] }) {
  const [copied, setCopied] = useState(false);
  return (
    <tr>
      <td>
        <strong>{label}</strong>
        <span className="olien-dash-addr">
          <code>{shortAddress(address)}</code>
          <button
            type="button"
            className="olien-icon-btn olien-icon-btn--tiny"
            aria-label="Copy address"
            onClick={() => {
              void navigator.clipboard.writeText(address);
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1200);
            }}
          >
            <Copy size={11} />
          </button>
          {copied ? <small>Copied</small> : null}
        </span>
      </td>
      <td className="num">{balance === null ? <span className="olien-muted">…</span> : formatDollars(balance)}</td>
      <td>
        <MemberAvatars signers={signers} />
      </td>
    </tr>
  );
}

function AccountsCard({ view }: { view: AccountView }) {
  return (
    <section className="olien-dash-card olien-dash-accounts">
      <div className="olien-dash-card-head">
        <h2>Accounts</h2>
        <Link href={`/${view.address}/settings`} className="olien-icon-btn" aria-label="Manage accounts">
          <ChevronRight size={16} />
        </Link>
      </div>
      <table>
        <thead>
          <tr>
            <th>Account</th>
            <th className="num">Balance</th>
            <th />
          </tr>
        </thead>
        <tbody>
          <AccountRow label={view.name} address={view.address} balance={view.usdcBalance} signers={view.signers} />
          {view.subAccounts.map((sub) => (
            <SubAccountRow key={sub.address} label={sub.label ?? `Sub-account ${sub.index}`} address={sub.address} signers={view.signers} />
          ))}
        </tbody>
      </table>
      {view.subAccounts.length === 0 ? (
        <p className="olien-dash-hint">
          Sub-accounts split one treasury into Operations, Payroll and the like, each with its own address.{" "}
          <Link href={`/${view.address}/settings`} className="olien-link">
            Add one in Settings
          </Link>
        </p>
      ) : null}
    </section>
  );
}

function FlowsCard({ entries, loading }: { entries: LedgerEntry[]; loading: boolean }) {
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const flows = entries.filter((entry) => entry.symbol !== "gas");
  const today = flows.filter((entry) => entry.blockTime * 1000 >= dayStart.getTime());
  const rows = (today.length ? today : flows).slice(0, 6);
  return (
    <section className="olien-dash-card olien-dash-flows">
      <div className="olien-dash-card-head">
        <h2>Inflows and outflows</h2>
      </div>
      <small className="olien-dash-day">{today.length ? "Today" : rows.length ? "Recent" : ""}</small>
      {loading ? <Loading label="Reading the ledger" /> : null}
      {!loading && rows.length === 0 ? <p className="olien-dash-hint">Nothing has moved yet. A deposit shows up here within a minute of landing.</p> : null}
      <ul>
        {rows.map((entry) => (
          <li key={`${entry.tx}-${entry.logIndex}`}>
            <i className={`olien-dash-coin ${entry.symbol.toLowerCase()}`} aria-hidden>
              {entry.symbol === "USDC" ? "$" : "€"}
            </i>
            <span className="olien-dash-flow-amount">
              <strong className={entry.direction}>
                {entry.direction === "in" ? "+" : "-"}
                {formatUsdc(entry.amount).replace(/ USDC$/, "")} {entry.symbol}
              </strong>
              <small>{formatDollars(entry.amount)}</small>
            </span>
            <span className="olien-dash-flow-who">
              <small>{entry.direction === "in" ? "From" : "To"}</small>
              <a href={explorerAddressUrl(entry.counterparty)} target="_blank" rel="noreferrer">
                {entry.counterpartyLabel ?? shortAddress(entry.counterparty)} <ExternalLink size={10} />
              </a>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
