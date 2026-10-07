"use client";

import { useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, KeyRound, Lock, Siren } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { encodeFunctionData, getAddress, isAddress, keccak256 } from "viem";
import { useSendTransaction } from "wagmi";
import { chainName, chainSpec, nativeSymbol, olienPublicClient as publicClient, olienUsdcAddress } from "@/lib/chain";
import { checkOperation, formatAmount, OLIEN_ABI } from "@/lib/signing";
import { durationLabel, errorMessage, formatTime, nowSeconds, parseUsdc, preparePanicOperation, proposeRuleChange, submitOperation, type AccountView, type Hex, type ProposalView } from "@/lib/treasury";
import { friendlyPasskeyError, knownPasskeys, passkeySupported, signWithPasskey } from "@/lib/passkey";
import { Button, DurationInput, Field, InlineError, Loading, Note, Panel, Spinner, Table, Tag, TxChip } from "./ui";
import { accountVersion, applyProposal, olienKeys, useAddressBook, useChainInfo, useChainPolicy, useKnownOnChain } from "./use-olien";
import { friendlyWalletError, useOlienChain, useWalletSession, walletSigner } from "./wallet";

// The second implementation of the account (docs/16-account-v2.md), as the console
// shows it: which version an Olien runs and the move between them, the panic one
// vetoer can pull, and the transfer policy the account itself enforces. Everything
// here is read from the chain by this browser; the service only carries proposals.

function useRouteToProposal(address: string) {
  const router = useRouter();
  const queryClient = useQueryClient();
  return (view: ProposalView) => {
    applyProposal(queryClient, address, view);
    router.push(`/${address}/transactions/${view.txHash}`);
  };
}

// ------------------------------------------------------------------ version

export function VersionSection({ address, account }: { address: string; account: AccountView }) {
  const info = useChainInfo();
  const go = useRouteToProposal(address);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const version = accountVersion(account, info.data);
  const v2 = info.data?.implementationV2 ?? null;
  if (!v2) return null;

  async function move() {
    if (!v2) return;
    setError(null);
    setBusy(true);
    try {
      // The hash of the code the account will run is named in the call, and it is
      // this browser's hash of the chain's bytes, not a number the service supplied.
      const code = (await publicClient.getCode({ address: v2 as Hex })) ?? "0x";
      const hash = keccak256(code);
      const said = info.data?.implementationV2CodeHash;
      if (code === "0x" || (said && hash.toLowerCase() !== said.toLowerCase())) {
        setError("The code at the version 2 address is not what the service says it is. Nothing was proposed.");
        return;
      }
      const data = encodeFunctionData({ abi: OLIEN_ABI, functionName: "setImplementation", args: [getAddress(v2), hash] });
      go(await proposeRuleChange(address, { calls: [{ to: address, data }], intent: { description: "Move this account to version 2" } }));
    } catch (cause) {
      setError(errorMessage(cause));
      setBusy(false);
    }
  }

  return (
    <Panel title="Version">
      {version === "v2" ? (
        <>
          <p>
            This Olien runs <strong>version 2</strong> of the account: money above a tier or to an unknown address waits and any vetoer can stop it, one vetoer can stop everything in flight, a lost colleague&apos;s key can be replaced after a long silence, and spending limits refill by the hour.
          </p>
          <PanicButton address={address} account={account} />
        </>
      ) : (
        <>
          <p>
            This Olien runs <strong>version 1</strong>. Version 2 is on {chainName}, at {v2}. The move is a rule change like any other: it waits {durationLabel(account.configDelay)} and can be vetoed, the signers, the rules and the balance stay, and spending limits do not come across and are made again afterwards.
          </p>
          <div className="olien-actions">
            <Button variant="primary" icon={<ArrowUpRight size={14} />} busy={busy} onClick={() => void move()}>
              Propose the move to version 2
            </Button>
          </div>
          <InlineError message={error} />
        </>
      )}
    </Panel>
  );
}

// -------------------------------------------------------------------- panic

// One vetoer stops everything in flight: the epoch moves, every open approval, pending
// operation and scheduled change dies, and nothing else changes. Two clicks, since
// there is no undo, and the team re-proposes what it still wants.
export function PanicButton({ address, account }: { address: string; account: AccountView }) {
  const wallet = useWalletSession();
  const ensureChain = useOlienChain();
  const queryClient = useQueryClient();
  const { sendTransactionAsync } = useSendTransaction();
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const mySigner = walletSigner(account, wallet.address);
  const canWallet = Boolean(wallet.matches && mySigner?.permissions.includes("veto"));
  const mine = new Set(knownPasskeys().map((record) => record.signerId.toLowerCase()));
  const passkeys = account.signers.filter((signer) => signer.kind === "webauthn" && signer.permissions.includes("veto") && mine.has(signer.signerId.toLowerCase()));
  const canPasskey = passkeys.length > 0 && passkeySupported();
  if (!canWallet && !canPasskey) return null;

  async function afterwards(tx: string) {
    setSent(tx);
    setArmed(false);
    await queryClient.invalidateQueries({ queryKey: olienKeys.account(address) });
    await queryClient.invalidateQueries({ queryKey: olienKeys.proposalsOf(address) });
  }

  async function withWallet() {
    setError(null);
    setBusy(true);
    try {
      await ensureChain();
      const balance = await publicClient.getBalance({ address: wallet.address as Hex });
      if (balance === 0n) {
        setError(`Your wallet needs a little ${nativeSymbol} on ${chainName} for gas before it can pull the brake.`);
        return;
      }
      await afterwards(await sendTransactionAsync({ to: address as Hex, data: encodeFunctionData({ abi: OLIEN_ABI, functionName: "panic" }) }));
    } catch (cause) {
      setError(friendlyWalletError(cause));
    } finally {
      setBusy(false);
    }
  }

  async function withPasskey() {
    const first = passkeys[0];
    if (!first) return;
    setError(null);
    setBusy(true);
    try {
      const prepared = await preparePanicOperation(address, first.signerId);
      // The hash is computed here, from an operation checked to be this panic alone.
      const gasPrice = await publicClient.getGasPrice().catch(() => null);
      const expected = encodeFunctionData({ abi: OLIEN_ABI, functionName: "panic" });
      const operation = checkOperation({ chainId: chainSpec.id, account: address, operation: prepared.operation, expected, now: nowSeconds(), gasPrice });
      const signed = await signWithPasskey(operation.hash, passkeys.map((signer) => ({ signerId: signer.signerId, x: signer.x, y: signer.y })));
      const receipt = await submitOperation(address, { operation: prepared.operation, signerId: signed.signerId, signature: signed.signature });
      await afterwards(receipt.txHash);
    } catch (cause) {
      setError(friendlyPasskeyError(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="olien-veto">
      {sent ? (
        <p className="olien-ok">
          The brake was pulled: <TxChip hash={sent} />. Everything that was in flight is dead; propose again what the team still wants.
        </p>
      ) : null}
      {!armed ? (
        <div className="olien-actions">
          <Button variant="danger" icon={<Siren size={14} />} onClick={() => setArmed(true)}>
            Stop everything in flight
          </Button>
          <span className="olien-field-hint">For a key you no longer trust. Every open approval, pending operation and scheduled change dies at once; no rule, member or balance changes. Once a day.</span>
        </div>
      ) : (
        <div className="olien-actions">
          {canWallet ? (
            <Button variant="danger" icon={<Siren size={14} />} busy={busy} onClick={() => void withWallet()}>
              {busy ? "Confirm in wallet" : "Yes, stop everything"}
            </Button>
          ) : null}
          {canPasskey ? (
            <Button variant="danger" icon={<KeyRound size={14} />} busy={busy} onClick={() => void withPasskey()}>
              {busy ? "Touch ID" : "Yes, stop everything with passkey"}
            </Button>
          ) : null}
          <Button variant="secondary" disabled={busy} onClick={() => setArmed(false)}>
            Not now
          </Button>
        </div>
      )}
      <InlineError message={error} />
    </div>
  );
}

// ------------------------------------------------------------- the policy

function tierLabel(token: string, tier: bigint): string {
  if (tier === 0n) return "no tier";
  return token.toLowerCase() === olienUsdcAddress.toLowerCase() ? `${formatAmount(tier, 6)} USDC` : `${tier} units of ${token}`;
}

export function ChainPolicySection({ address, account }: { address: string; account: AccountView }) {
  const info = useChainInfo();
  const version = accountVersion(account, info.data);
  const policyAddress = info.data?.policy ?? null;
  const policy = useChainPolicy(address, policyAddress, version === "v2");
  const go = useRouteToProposal(address);
  const [editing, setEditing] = useState(false);
  const [tier, setTier] = useState("");
  const [delay, setDelay] = useState(86_400);
  const [requireKnown, setRequireKnown] = useState(false);
  const [learn, setLearn] = useState(true);
  const [lockDate, setLockDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (version !== "v2") return null;

  function open() {
    const current = policy.data;
    setTier(current && current.tier > 0n && current.token.toLowerCase() === olienUsdcAddress.toLowerCase() ? formatAmount(current.tier, 6).replace(/,/g, "") : "");
    setDelay(current?.delay || 86_400);
    setRequireKnown(current?.requireKnown ?? false);
    setLearn(current?.learn ?? true);
    setLockDate(current?.lockedUntil ? new Date(current.lockedUntil * 1000).toISOString().slice(0, 10) : "");
    setError(null);
    setEditing(true);
  }

  async function submit() {
    setError(null);
    const units = tier.trim() === "" ? "0" : parseUsdc(tier);
    if (units === null) return setError("The tier is a USDC amount, up to six decimals.");
    const holds = units !== "0" || requireKnown;
    if (holds && delay === 0) return setError("A policy that holds anything needs a wait.");
    if (delay > 30 * 86_400) return setError("A wait cannot exceed 30 days.");
    const lockedUntil = lockDate ? Math.floor(new Date(`${lockDate}T00:00:00Z`).getTime() / 1000) : 0;
    setBusy(true);
    try {
      const data = encodeFunctionData({
        abi: OLIEN_ABI,
        functionName: "setTransferPolicy",
        args: [{ token: getAddress(olienUsdcAddress), tier: BigInt(units), delay, requireKnown, learn, lockedUntil }],
      });
      go(await proposeRuleChange(address, { calls: [{ to: address, data }], intent: { description: holds ? "Set the transfer policy" : "Clear the transfer policy" } }));
    } catch (cause) {
      setError(errorMessage(cause));
      setBusy(false);
    }
  }

  const current = policy.data;
  return (
    <Panel title="Transfer policy, on the chain">
      {policy.isLoading ? (
        <Loading label="Reading the policy from the chain" />
      ) : policy.error ? (
        <InlineError message={errorMessage(policy.error)} />
      ) : current ? (
        <>
          {current.policyOn ? (
            <div className="olien-rules">
              {current.tier > 0n ? (
                <div className="olien-rule">
                  <Lock size={12} />
                  <span>A payment over {tierLabel(current.token, current.tier)} waits {durationLabel(current.delay)}, and any vetoer can stop it.</span>
                </div>
              ) : null}
              {current.requireKnown ? (
                <div className="olien-rule">
                  <Lock size={12} />
                  <span>
                    A payment to an address this account does not know waits {durationLabel(current.delay)}.{current.learn ? " An address paid after the wait becomes known." : ""}
                  </span>
                </div>
              ) : null}
              {current.lockedUntil > nowSeconds() ? (
                <div className="olien-rule">
                  <Lock size={12} />
                  <span>Loosening any of this is refused until {formatTime(current.lockedUntil)}.</span>
                </div>
              ) : null}
            </div>
          ) : (
            <p className="olien-muted">Nothing waits yet. A policy the account enforces itself holds money that the service&apos;s treasury policy cannot: members holding the threshold can walk past the service, and not past the chain.</p>
          )}
          <p className="olien-field-hint">
            {current.inactivityDelay ? `After ${durationLabel(current.inactivityDelay)} without any member acting, one member alone may replace a colleague's key behind the recovery delay. ` : ""}
            Tightening the policy runs as soon as the threshold signs; loosening it waits {durationLabel(account.configDelay)} and can be vetoed.
          </p>
          {editing ? (
            <div className="olien-form">
              <Field label="Payments over" hint="In USDC. Empty means no tier.">
                <input className="olien-input" value={tier} onChange={(event) => setTier(event.target.value)} placeholder="25000" inputMode="decimal" />
              </Field>
              <Field label="Wait">
                <DurationInput value={delay} onChange={setDelay} />
              </Field>
              <label className="olien-check">
                <input type="checkbox" checked={requireKnown} onChange={(event) => setRequireKnown(event.target.checked)} /> Payments to addresses this account does not know wait too
              </label>
              <label className="olien-check">
                <input type="checkbox" checked={learn} onChange={(event) => setLearn(event.target.checked)} /> An address paid after a wait becomes known
              </label>
              <Field label="Lock until" hint="Loosening is refused before this day. Empty means no lock.">
                <input className="olien-input" type="date" value={lockDate} onChange={(event) => setLockDate(event.target.value)} />
              </Field>
              <div className="olien-actions">
                <Button variant="primary" busy={busy} onClick={() => void submit()}>
                  Propose
                </Button>
                <Button variant="secondary" disabled={busy} onClick={() => setEditing(false)}>
                  Cancel
                </Button>
              </div>
              <InlineError message={error} />
            </div>
          ) : (
            <div className="olien-actions">
              <Button variant="secondary" onClick={open}>
                {current.policyOn ? "Change the policy" : "Set a policy"}
              </Button>
            </div>
          )}
          <KnownAddresses address={address} policyAddress={policyAddress} />
        </>
      ) : null}
    </Panel>
  );
}

// The addresses the account knows on the chain, held against the address book members
// signed here. Knowing one is a rule change; forgetting one is immediate.
function KnownAddresses({ address, policyAddress }: { address: string; policyAddress: string | null }) {
  const book = useAddressBook(address);
  const go = useRouteToProposal(address);
  const [extra, setExtra] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const entries = book.data ?? [];
  const known = useKnownOnChain(address, policyAddress, entries.map((entry) => entry.address), entries.length > 0);

  async function propose(who: string, know: boolean) {
    setError(null);
    if (!isAddress(who)) return setError("That is not an address.");
    setBusy(`${who}:${know}`);
    try {
      const data = encodeFunctionData({ abi: OLIEN_ABI, functionName: "setKnown", args: [[getAddress(who)], know] });
      go(await proposeRuleChange(address, { calls: [{ to: address, data }], intent: { description: know ? `Know ${who}` : `Forget ${who}` } }));
    } catch (cause) {
      setError(errorMessage(cause));
      setBusy(null);
    }
  }

  return (
    <div className="olien-known">
      <h4>Known addresses</h4>
      {entries.length === 0 ? (
        <p className="olien-muted">The address book is empty. An address the account knows is paid without waiting.</p>
      ) : (
        <Table head={["Label", "Address", "On the chain", ""]}>
          {entries.map((entry) => {
            const since = known.data?.get(entry.address.toLowerCase()) ?? 0;
            return (
              <tr key={entry.address}>
                <td>{entry.label}</td>
                <td className="olien-mono">{entry.address}</td>
                <td>{known.isLoading ? <Spinner /> : since ? <Tag tone="accent">known since {formatTime(since)}</Tag> : <Tag>not known</Tag>}</td>
                <td>
                  <Button size="sm" variant="secondary" busy={busy === `${entry.address}:${!since}`} onClick={() => void propose(entry.address, !since)}>
                    {since ? "Forget" : "Know"}
                  </Button>
                </td>
              </tr>
            );
          })}
        </Table>
      )}
      <div className="olien-actions">
        <input className="olien-input" value={extra} onChange={(event) => setExtra(event.target.value)} placeholder="0x… any address to know" />
        <Button size="sm" variant="secondary" busy={busy === `${extra}:true`} onClick={() => void propose(extra.trim(), true)}>
          Know
        </Button>
      </div>
      <InlineError message={error} />
      <Note tone="info">Knowing an address waits the config delay and can be vetoed, like any rule change. Forgetting one runs as soon as the threshold signs.</Note>
    </div>
  );
}
