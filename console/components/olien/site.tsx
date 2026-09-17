import { Check } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
// Olien's own repository, not a constant borrowed from another product's footer.
const GITHUB_URL = "https://github.com/sQuiDbOb18/olien";
import { DashboardShot } from "./site-mockup";

const APP = "/app";
const SPEC_URL = `${GITHUB_URL}/blob/main/docs/treasury/10-account-spec.md`;
const DOCS_URL = `${GITHUB_URL}/tree/main/docs/treasury`;

// The Olien product page, in the shape of squads.xyz/multisig: a hero card with the
// product in it, proof, three feature chapters, the protocol, pricing, one last door.
export function OlienSite() {
  return (
    <>
      <Nav />
      <main>
        <Hero />
        <Proof />
        <Treasury />
        <Rules />
        <Members />
        <Protocol />
        <Pricing />
        <Door />
      </main>
      <Footer />
    </>
  );
}

function Nav() {
  return (
    <header className="osite-nav">
      <div className="osite-nav-inner">
        <Link href="/" className="osite-brand" aria-label="Olien Multisig">
          <span className="osite-brand-mark" aria-hidden />
          <span className="osite-brand-word">OLIEN</span>
          <span className="osite-brand-sep" aria-hidden />
          <span className="osite-brand-product">Multisig</span>
        </Link>
        <nav className="osite-nav-links" aria-label="Primary">
          <a href="#product">Product</a>
          <a href="#rules">Rules</a>
          <a href="#protocol">Protocol</a>
          <a href="#pricing">Pricing</a>
        </nav>
        <Link href={APP} className="osite-btn osite-btn--dark osite-btn--sm">
          Get started
        </Link>
      </div>
    </header>
  );
}

function Hero() {
  return (
    <section className="osite-hero" id="product">
      <div className="osite-hero-card">
        <div className="osite-hero-copy">
          <h1>Olien Multisig</h1>
          <p>The multisig platform to secure and manage USDC</p>
          <Link href={APP} className="osite-btn osite-btn--dark">
            Get started
          </Link>
        </div>
        <div className="osite-hero-shot">
          <DashboardShot />
        </div>
      </div>
    </section>
  );
}

function Proof() {
  return (
    <section className="osite-proof">
      <h2>
        Built with the first teams on Arc,
        <br />
        ahead of mainnet on 16 September
      </h2>
      <ul className="osite-logos" aria-label="Built on">
        <li>
          <Image src="/brand/arc-mark.svg" alt="" width={22} height={22} /> Arc
        </li>
        <li>
          <Image src="/brand/usdc.svg" alt="" width={22} height={22} /> USDC
        </li>
        <li>
          <Image src="/brand/circle-mark.png" alt="" width={22} height={22} /> Circle
        </li>
        <li>
          <span className="osite-logo-glyph" aria-hidden>
            S
          </span>
          Safe
        </li>
        <li>
          <span className="osite-logo-glyph" aria-hidden>
            P
          </span>
          Pimlico
        </li>
      </ul>
    </section>
  );
}

function Treasury() {
  return (
    <section className="osite-chapter osite-chapter--dark">
      <div className="osite-chapter-copy">
        <h2>Treasury Management</h2>
        <p>Streamline operations with approval workflows, conversion between USDC and EURC, and payments that clear in seconds.</p>
        <ul className="osite-points">
          <li>
            <strong>Propose, approve, execute.</strong> Any member drafts a payment, the others read it in plain terms and approve, anyone executes.
          </li>
          <li>
            <strong>Gas is the money.</strong> The treasury pays its own fees in USDC. There is no second token to keep topped up.
          </li>
          <li>
            <strong>Cheques and invoices.</strong> Write a cheque a contractor cashes when they like, or approve an invoice they sent. Both are USDC&apos;s own signed authorizations.
          </li>
          <li>
            <strong>A ledger the accountant can use.</strong> Every movement labelled, tied to the proposal that caused it, exported when asked.
          </li>
        </ul>
      </div>
      <div className="osite-chapter-art">
        <div className="osite-float osite-float--buttons" aria-hidden>
          <span>Send</span>
          <span>Deposit</span>
          <span>Convert</span>
        </div>
        <div className="osite-float osite-float--ledger" aria-hidden>
          <div className="osite-ledger-row">
            <i className="out" />
            <span>
              <strong>Payroll, September</strong>
              <small>12 people, one approval round</small>
            </span>
            <b>-$84,200.00</b>
          </div>
          <div className="osite-ledger-row">
            <i className="in" />
            <span>
              <strong>Invoice #218, Ade</strong>
              <small>approved by 3 of 5</small>
            </span>
            <b>+$16,500.00</b>
          </div>
          <div className="osite-ledger-row">
            <i className="fx" />
            <span>
              <strong>Convert 20,000 USDC to EURC</strong>
              <small>through Arc FX</small>
            </span>
            <b>18,540.00 EURC</b>
          </div>
        </div>
      </div>
    </section>
  );
}

function Rules() {
  return (
    <section className="osite-chapter osite-chapter--light" id="rules">
      <div className="osite-chapter-head">
        <h2>Rules the chain enforces</h2>
        <p>Two kinds, labelled honestly. On-chain rules the account itself enforces, and policies the service applies on top. You always know which is which.</p>
      </div>
      <div className="osite-rule-grid">
        <article className="osite-rule">
          <div className="osite-rule-art osite-rule-art--threshold" aria-hidden>
            <span className="is-on" />
            <span className="is-on" />
            <span className="is-on" />
            <span />
            <span />
            <b>3 of 5</b>
          </div>
          <h3>Approval thresholds</h3>
          <p>Set how many members must approve, applied to every transaction. Raise it above an amount with a policy.</p>
        </article>
        <article className="osite-rule">
          <div className="osite-rule-art osite-rule-art--lock" aria-hidden>
            <small>Add member</small>
            <strong>23:41:07</strong>
            <span>
              <i /> waiting, any vetoer can stop it
            </span>
          </div>
          <h3>Time lock and veto</h3>
          <p>Changing members or rules waits 24 hours, and members holding a veto can stop it during the wait. Taking a power away never waits.</p>
        </article>
        <article className="osite-rule">
          <div className="osite-rule-art osite-rule-art--limit" aria-hidden>
            <span>
              <small>Ops card</small>
              <b>$2,500 / day</b>
            </span>
            <i style={{ width: "62%" }} />
            <small>$1,550.00 spent today, one signature</small>
          </div>
          <h3>Spending limits</h3>
          <p>Let one member pay small, known destinations alone, within a daily amount. Remove a limit at once, without a wait.</p>
        </article>
      </div>
    </section>
  );
}

function Members() {
  return (
    <section className="osite-chapter osite-chapter--light osite-chapter--members">
      <div className="osite-chapter-head">
        <h2>Members that are people, not keys</h2>
        <p>Add a passkey on a laptop, a hardware wallet, or an account from an app that carries a member directory. A member who loses a phone recovers their own account without the treasury changing at all.</p>
      </div>
      <ul className="osite-member-grid">
        <li>
          <span className="osite-member-avatar" aria-hidden>
            A
          </span>
          <strong>@ade</strong>
          <small>Named through a member directory, approves on a phone</small>
        </li>
        <li>
          <span className="osite-member-avatar is-key" aria-hidden />
          <strong>Kemi&apos;s MacBook</strong>
          <small>Passkey, verified by the chain&apos;s own P-256 precompile</small>
        </li>
        <li>
          <span className="osite-member-avatar is-hw" aria-hidden />
          <strong>Ledger 0x6bsk</strong>
          <small>Hardware wallet, the hash shown for comparison</small>
        </li>
        <li>
          <span className="osite-member-avatar is-plus" aria-hidden>
            +
          </span>
          <strong>Add a member</strong>
          <small>Takes effect after the 24 hour wait</small>
        </li>
      </ul>
    </section>
  );
}

function Protocol() {
  return (
    <section className="osite-protocol" id="protocol">
      <div className="osite-protocol-copy">
        <h2>Built on the Olien account</h2>
        <p>
          Olien Multisig runs on the Olien account, an open-source smart account for Arc. Its rules are enforced by the contract and the chain, not by a company server, a
          black box, or a trusted third party.
        </p>
        <p>The account needs no service to work. A team can leave with their keys and execute against the contract directly with any client.</p>
        <a className="osite-btn osite-btn--dark osite-btn--sm" href={SPEC_URL} target="_blank" rel="noreferrer">
          Read the specification
        </a>
      </div>
      <div className="osite-plates" aria-hidden>
        <span className="osite-plate osite-plate--base" />
        <span className="osite-plate osite-plate--mid" />
        <span className="osite-plate osite-plate--top" />
        <span className="osite-plate osite-plate--chip" />
      </div>
    </section>
  );
}

const TIERS = [
  {
    name: "Basic",
    blurb: "A multisig account for teams of any size, free on testnet and on mainnet",
    price: "$0",
    unit: "/ month",
    cta: "Get started",
    href: APP,
    lead: null,
    items: [
      "A smart account with unlimited members",
      "Proposals, approvals and execution",
      "Time lock and veto on changes",
      "Spending limits",
      "Cheques and invoices",
      "USDC and EURC, converted through Arc FX",
      "A labelled ledger",
      "Members by @handle, passkey or hardware wallet",
    ],
  },
  {
    name: "Pro",
    blurb: "Run a company's money on Arc, paid from the treasury itself",
    price: "$49",
    unit: "/ month",
    cta: "Try free for 30 days",
    href: APP,
    lead: "Everything in Basic, plus:",
    items: ["Approval tiers by amount", "Payroll runs on a schedule", "Sub-accounts", "Known destinations only", "Push and email alerts for every member", "CSV export for the accountant", "API keys"],
  },
  {
    name: "Enterprise",
    blurb: "Custom implementations, dedicated support and onboarding",
    price: "Custom",
    unit: "",
    cta: "Contact us",
    href: "mailto:hello@olien.org?subject=Olien%20Enterprise",
    lead: "Everything in Pro, plus:",
    items: ["Unlimited accounts", "Assisted onboarding", "Custom policies", "Priority support", "Reporting and compliance integrations"],
  },
];

function Pricing() {
  return (
    <section className="osite-pricing" id="pricing">
      <div className="osite-chapter-head osite-chapter-head--center">
        <h2>Pricing Plan</h2>
        <p>Accessible pricing based on software economics, not rent on assets under management.</p>
      </div>
      <div className="osite-tiers">
        {TIERS.map((tier) => (
          <article key={tier.name} className={`osite-tier${tier.name === "Pro" ? " osite-tier--dark" : ""}`}>
            <h3>{tier.name}</h3>
            <p className="osite-tier-blurb">{tier.blurb}</p>
            <div className="osite-tier-price">
              <strong>{tier.price}</strong>
              {tier.unit ? <span>{tier.unit}</span> : null}
            </div>
            {tier.href.startsWith("mailto:") ? (
              <a className="osite-tier-cta" href={tier.href}>
                {tier.cta}
              </a>
            ) : (
              <Link className="osite-tier-cta" href={tier.href}>
                {tier.cta}
              </Link>
            )}
            <hr />
            {tier.lead ? <p className="osite-tier-lead">{tier.lead}</p> : null}
            <ul>
              {tier.items.map((item) => (
                <li key={item}>
                  <Check size={13} aria-hidden /> {item}
                </li>
              ))}
            </ul>
          </article>
        ))}
      </div>
      <p className="osite-pricing-note">The subscription is a spending limit the treasury grants to Olien, visible like any other rule and revocable at once. No fee on assets, ever.</p>
    </section>
  );
}

function Door() {
  return (
    <section className="osite-door">
      <h2>Create your Olien in a few clicks</h2>
      <Link href={APP} className="osite-btn osite-btn--light">
        Create my Olien
      </Link>
    </section>
  );
}

function Footer() {
  return (
    <footer className="osite-footer">
      <div className="osite-footer-inner">
        <div className="osite-footer-brand">
          <span className="osite-brand">
            <span className="osite-brand-mark" aria-hidden />
            <span className="osite-brand-word">OLIEN</span>
          </span>
          <p>All rights reserved.</p>
          <p>Olien is software, not a bank or a digital asset custodian. The team holds every key; Olien holds none.</p>
        </div>
        <div className="osite-footer-cols">
          <div>
            <h4>Products</h4>
            <Link href="/" aria-current="page">
              Olien Multisig
            </Link>
            <Link href={APP}>Console</Link>
          </div>
          <div>
            <h4>Resources</h4>
            <a href={DOCS_URL} target="_blank" rel="noreferrer">
              Docs
            </a>
            <a href={SPEC_URL} target="_blank" rel="noreferrer">
              Account spec
            </a>
            <a href={GITHUB_URL} target="_blank" rel="noreferrer">
              GitHub
            </a>
          </div>
          <div>
            <h4>Company</h4>
            <Link href="/">About</Link>
            <Link href="/support">Support</Link>
          </div>
          <div>
            <h4>Legal</h4>
            <Link href="/terms">Terms of Service</Link>
            <Link href="/privacy">Privacy Policy</Link>
          </div>
        </div>
      </div>
    </footer>
  );
}
