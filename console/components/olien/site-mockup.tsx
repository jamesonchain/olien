import { ArrowDown, ArrowLeftRight, ArrowUp, ChevronDown, ChevronRight } from "lucide-react";

// The hero's product shot, drawn in HTML so it stays sharp at any size and every
// figure can be changed in one place. A made-up treasury with three sub-accounts.
export function DashboardShot() {
  return (
    <div className="osite-shot" role="img" aria-label="The Olien console: a treasury dashboard beside a phone approving the same account">
      <div className="osite-frame">
      <div className="osite-dash">
        <aside className="osite-dash-side">
          <div className="osite-dash-brand">
            <i aria-hidden /> OLIEN
          </div>
          <div className="osite-dash-switch">
            <small>Founders Olien</small>
            <strong>$4,900,643.00</strong>
            <span>
              Threshold <b>3/5</b>
            </span>
          </div>
          <ul>
            {["Dashboard", "Transactions", "Members", "Treasury", "Payments", "Convert", "Cheques", "Invoices", "Settings"].map((item, index) => (
              <li key={item} className={index === 0 ? "is-on" : undefined}>
                {item}
              </li>
            ))}
          </ul>
        </aside>
        <div className="osite-dash-main">
          <div className="osite-dash-top">
            <span>
              Network status <i aria-hidden />
            </span>
            <span>
              <i className="wallet" aria-hidden /> 4,000
            </span>
          </div>
          <h3>Dashboard</h3>
          <div className="osite-dash-grid">
            <div className="osite-dash-card osite-dash-balance">
              <small>Total Balance</small>
              <strong>$4,900,643.00</strong>
              <span className="osite-dash-delta">
                <b>+ $15,232.48</b> last month <em>Threshold 3/5</em>
              </span>
              <div className="osite-dash-actions">
                <span className="is-dark">
                  <ArrowUp size={10} /> Send
                </span>
                <span className="is-dark">
                  <ArrowDown size={10} /> Deposit
                </span>
                <span className="is-dark">
                  <ArrowLeftRight size={10} /> Convert
                </span>
              </div>
            </div>
            <div className="osite-dash-card osite-dash-chart">
              <div className="osite-dash-chart-head">
                <span>
                  Marketing <ChevronDown size={9} />
                </span>
              </div>
              <div className="osite-dash-chart-body">
                <div className="osite-dash-ticks">
                  {["$600,000", "$400,000", "$300,000", "$200,000", "$100,000", "$0"].map((tick) => (
                    <span key={tick}>{tick}</span>
                  ))}
                </div>
                <div className="osite-dash-plot">
                  <svg viewBox="0 0 300 110" preserveAspectRatio="none" aria-hidden>
                    <defs>
                      <linearGradient id="osite-fill" x1="0" x2="0" y1="0" y2="1">
                        <stop offset="0" stopColor="#075b46" stopOpacity="0.16" />
                        <stop offset="1" stopColor="#075b46" stopOpacity="0" />
                      </linearGradient>
                    </defs>
                    <path d="M0 80 C 40 78, 70 60, 100 62 S 150 88, 180 70 S 230 30, 260 34 S 290 20, 300 18 L300 110 L0 110 Z" fill="url(#osite-fill)" />
                    <path d="M0 80 C 40 78, 70 60, 100 62 S 150 88, 180 70 S 230 30, 260 34 S 290 20, 300 18" className="line" />
                    <circle cx="180" cy="70" r="2.6" className="point" />
                  </svg>
                  <div className="osite-dash-tip">
                    <small>Marketing</small>
                    <strong>$280,512.00</strong>
                    <span>June 01, 2026</span>
                  </div>
                  <div className="osite-dash-months">
                    {["Apr", "Jun", "Aug", "Oct"].map((month) => (
                      <span key={month}>{month}</span>
                    ))}
                  </div>
                </div>
              </div>
            </div>
            <div className="osite-dash-card osite-dash-accounts">
              <div className="osite-dash-card-head">
                Accounts <ChevronRight size={10} />
              </div>
              <table>
                <thead>
                  <tr>
                    <th>Account</th>
                    <th>Balance</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {[
                    ["Operations", "c9Rs...d5q", "$3,400,000.00", 4],
                    ["Payroll", "YfNQ...sr5u", "$1,000,643.00", 2],
                    ["Marketing", "dTsG...2fc1", "$500,000.00", 3],
                  ].map(([name, address, balance, members]) => (
                    <tr key={name as string}>
                      <td>
                        <strong>{name}</strong>
                        <small>{address}</small>
                      </td>
                      <td className="num">{balance}</td>
                      <td>
                        <span className="osite-dash-avatars" aria-hidden>
                          {Array.from({ length: members as number }).map((_, index) => (
                            <i key={index} className={`t${index}`} />
                          ))}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="osite-dash-card osite-dash-flows">
              <div className="osite-dash-card-head">Inflows and outflows</div>
              <small className="osite-dash-day">Today</small>
              <ul>
                {[
                  ["out", "-24.10 USDC", "$24.10", "Fee"],
                  ["in", "+16,500.00 USDC", "$16,500.00", "Invoice #218"],
                  ["in", "+42.00 EURC", "$45.72", "Convert"],
                ].map(([dir, amount, usd, label]) => (
                  <li key={amount}>
                    <i className={dir} aria-hidden />
                    <span>
                      <strong className={dir}>{amount}</strong>
                      <small>{usd}</small>
                    </span>
                    <em>{label}</em>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </div>
      </div>

      <div className="osite-phone">
        <div className="osite-phone-head">
          <span>
            <strong>Founders Olien</strong>
            <small>Payroll</small>
          </span>
          <b>×</b>
        </div>
        <div className="osite-phone-balance">
          <strong>$58,500.48</strong>
          <small>Balance</small>
        </div>
        <div className="osite-phone-tabs">
          <span className="is-on">Coins</span>
          <span>Members</span>
        </div>
        <ul>
          {[
            ["USDC", "$27,000.00", "27,000.00"],
            ["EURC", "$20,180.48", "18,540.00"],
            ["Cheques", "$11,320.00", "3 uncashed"],
          ].map(([coin, usd, detail]) => (
            <li key={coin}>
              <i className={coin.toLowerCase()} aria-hidden />
              <span>{coin}</span>
              <b>
                {usd}
                <small>{detail}</small>
              </b>
            </li>
          ))}
        </ul>
        <div className="osite-phone-bar">
          <i />
          <i />
          <i />
        </div>
      </div>
    </div>
  );
}
