"use client";

import { ArrowLeftRight, ArrowUpRight, CalendarClock, Check, ChevronDown, Copy, Home, LogOut, Menu, Moon, Plus, Send, Settings, Sun, Users, X } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSelectedLayoutSegments } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useDisconnect } from "wagmi";
import { chainName, explorerAddressUrl, explorerName } from "@/lib/chain";
import { accountParam, formatDollars, formatUsdc, shortAddress, type AccountView } from "@/lib/treasury";
import { DepositDialog } from "./deposit-dialog";
import { useOlienTheme } from "./theme";
import { AddressChip, Button, cx, Dialog, Spinner } from "./ui";
import { rememberAccount, useAccounts, useOlienAccount } from "./use-olien";
import { OlienLanding } from "./landing";
import { LandingDoor, MismatchBanner, SignInCard, useWalletSession } from "./wallet";

function titleFor(segments: string[], address: string | null, name: string | undefined): string {
  if (!address) return segments[0] === "new" ? "Create an Olien" : "Your Oliens";
  switch (segments[1]) {
    case "transactions":
      if (segments[2] === "new") return "Send";
      return segments[2] ? "Transaction" : "Transactions";
    case "members":
      return "Members";
    case "payroll":
      return "Payroll";
    case "settings":
      return "Settings";
    default:
      return "Dashboard";
  }
}

function AccountSwitcher({ address, name, view }: { address: string | null; name: string | undefined; view: AccountView | undefined }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const accounts = useAccounts();

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const others = (accounts.data ?? []).filter((row) => row.address !== address);

  return (
    <div className="olien-switcher" ref={ref}>
      <button type="button" className={cx("olien-switcher-btn", view && "olien-switcher-btn--card")} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
        <span className="olien-switcher-avatar" aria-hidden>
          {address && name ? name.slice(0, 1).toUpperCase() : "O"}
        </span>
        <span className="olien-switcher-text">
          {view ? (
            <>
              <small>{view.name}</small>
              <strong className="olien-switcher-balance">{formatDollars(view.usdcBalance)}</strong>
            </>
          ) : (
            <>
              <strong>{address ? (name ?? shortAddress(address)) : "Select an Olien"}</strong>
              <small>{address ? shortAddress(address) : chainName}</small>
            </>
          )}
        </span>
        <ChevronDown size={14} />
      </button>
      {view ? (
        <div className="olien-switcher-foot">
          <span className="olien-dash-chip">
            Threshold <b>{view.threshold}/{view.signers.filter((signer) => signer.permissions.includes("approve")).length}</b>
          </span>
          <button
            type="button"
            className="olien-icon-btn olien-icon-btn--small"
            aria-label="Copy address"
            onClick={() => void navigator.clipboard.writeText(view.address)}
          >
            <Copy size={12} />
          </button>
          <a className="olien-icon-btn olien-icon-btn--small" href={explorerAddressUrl(view.address)} target="_blank" rel="noreferrer" aria-label={`Open in ${explorerName}`}>
            <ArrowUpRight size={12} />
          </a>
        </div>
      ) : null}
      {open ? (
        <div className="olien-menu" role="menu">
          {accounts.isLoading ? (
            <div className="olien-menu-note">
              <Spinner /> Loading your Oliens
            </div>
          ) : null}
          {others.map((row) => (
            <Link key={row.address} role="menuitem" href={`/${row.address}`} className="olien-menu-item" onClick={() => setOpen(false)}>
              <span className="olien-switcher-avatar" aria-hidden>
                {row.name.slice(0, 1).toUpperCase()}
              </span>
              <span className="olien-switcher-text">
                <strong>{row.name}</strong>
                <small>{shortAddress(row.address)}</small>
              </span>
              <span className="olien-menu-balance">{formatUsdc(row.usdcBalance)}</span>
            </Link>
          ))}
          {!accounts.isLoading && others.length === 0 ? <div className="olien-menu-note">{address ? "No other Oliens" : "No Oliens yet"}</div> : null}
          <Link role="menuitem" href="/new" className="olien-menu-item olien-menu-item--create" onClick={() => setOpen(false)}>
            <Plus size={14} /> Create an Olien
          </Link>
        </div>
      ) : null}
    </div>
  );
}

function WalletChip() {
  const { address } = useWalletSession();
  const [copied, setCopied] = useState(false);
  if (!address) return null;
  return (
    <button
      type="button"
      className="olien-wallet-chip"
      title={copied ? "Copied" : "Copy address"}
      onClick={() => {
        void navigator.clipboard.writeText(address);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1400);
      }}
    >
      <span className="olien-dot olien-dot--wallet" aria-hidden />
      <code>{shortAddress(address)}</code>
      {copied ? <Check size={12} /> : <Copy size={12} />}
    </button>
  );
}

export function OlienShell({ children }: { children: ReactNode }) {
  const segments = useSelectedLayoutSegments();
  const pathname = usePathname();
  const router = useRouter();
  const wallet = useWalletSession();
  const { disconnect } = useDisconnect();
  const address = segments[0] && segments[0] !== "new" ? accountParam(segments[0]) : null;
  const account = useOlienAccount(wallet.session && wallet.connected ? address : null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [depositOpen, setDepositOpen] = useState(false);
  const [theme, toggleTheme] = useOlienTheme();

  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (address) rememberAccount(address);
  }, [address]);

  if (wallet.settling) {
    return (
      <div className="olien olien-gate">
        <div className="olien-loading" role="status">
          <Spinner size={16} />
          <span>Opening Olien</span>
        </div>
      </div>
    );
  }

  // Signed out, the console is its own front door: the landing, with connecting and
  // signing in as the one action. Squads does the same at app.squads.so.
  if (!wallet.session) {
    return (
      <div className="olien">
        <OlienLanding action={<LandingDoor />} />
      </div>
    );
  }

  if (!wallet.connected) {
    return (
      <div className="olien">
        <SignInCard mode="reconnect" />
      </div>
    );
  }

  // Creating an Olien is its own page, in Squads' shape: the bar, then one column.
  if (segments[0] === "new") {
    return (
      <div className="olien olien-focus">
        {!wallet.matches ? <MismatchBanner /> : null}
        <header className="olien-landing-bar">
          <Link href="/app" className="olien-wordmark">
            Olien<span className="olien-dot" aria-hidden />
          </Link>
          <div className="olien-landing-bar-right">
            <span className="olien-network-chip">
              Network Status <span className="olien-dot" aria-hidden />
            </span>
            <WalletChip />
          </div>
        </header>
        <main className="olien-focus-main">{children}</main>
      </div>
    );
  }

  const name = account.data?.name;
  const title = titleFor(segments, address, name);
  const section = segments[1] ?? "";
  const nav = address
    ? [
        { href: `/${address}`, label: "Home", icon: <Home size={16} />, active: section === "" },
        { href: `/${address}/transactions`, label: "Transactions", icon: <ArrowLeftRight size={16} />, active: section === "transactions" },
        { href: `/${address}/members`, label: "Members", icon: <Users size={16} />, active: section === "members" },
        { href: `/${address}/payroll`, label: "Payroll", icon: <CalendarClock size={16} />, active: section === "payroll" },
        { href: `/${address}/settings`, label: "Settings", icon: <Settings size={16} />, active: section === "settings" },
      ]
    : [];

  async function signOut() {
    await wallet.signOut();
    disconnect();
    router.push("/app");
  }

  return (
    <div className="olien olien-shell" data-theme={theme}>
      <aside className={cx("olien-sidebar", menuOpen && "is-open")}>
        <div className="olien-sidebar-top">
          <Link href="/app" className="olien-wordmark">
            Olien<span className="olien-dot" aria-hidden />
          </Link>
          <button type="button" className="olien-icon-btn olien-menu-toggle" aria-label={menuOpen ? "Close menu" : "Open menu"} aria-expanded={menuOpen} onClick={() => setMenuOpen((current) => !current)}>
            {menuOpen ? <X size={18} /> : <Menu size={18} />}
          </button>
        </div>
        <div className="olien-sidebar-body">
          <AccountSwitcher address={address} name={name} view={account.data} />
          {nav.length ? (
            <nav className="olien-nav" aria-label="Olien">
              {nav.map((item) => (
                <Link key={item.href} href={item.href} className={cx("olien-nav-item", item.active && "is-active")} aria-current={item.active ? "page" : undefined}>
                  {item.icon}
                  {item.label}
                </Link>
              ))}
            </nav>
          ) : null}
          <div className="olien-sidebar-bottom">
            <button type="button" className="olien-signout" onClick={toggleTheme}>
              {theme === "light" ? <Moon size={14} /> : <Sun size={14} />} {theme === "light" ? "Dark theme" : "Light theme"}
            </button>
            <button type="button" className="olien-signout" onClick={() => void signOut()}>
              <LogOut size={14} /> Sign out
            </button>
          </div>
        </div>
      </aside>

      <div className="olien-main">
        {!wallet.matches ? <MismatchBanner /> : null}
        <header className="olien-topbar">
          <h1 className="olien-page-title">{title}</h1>
          <div className="olien-topbar-actions">
            <span className="olien-network-chip">
              Network status <span className="olien-dot" aria-hidden />
            </span>
            <WalletChip />
            {address ? (
              <>
                <Button onClick={() => setDepositOpen(true)}>Deposit</Button>
                <Link href={`/${address}/transactions/new`} className="olien-btn olien-btn--primary">
                  <Send size={14} /> Send
                </Link>
              </>
            ) : null}
          </div>
        </header>
        <main className="olien-content">{children}</main>
        {address ? <DepositDialog address={address} open={depositOpen} onClose={() => setDepositOpen(false)} /> : null}
      </div>
    </div>
  );
}
