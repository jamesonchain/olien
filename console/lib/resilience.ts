// The rules the contract cannot check and the screens must say out loud. `_checkConfig`
// proves a configuration can act; it cannot know whether the keys behind it still exist,
// whether two passkeys are really one cloud account, or what a delay of zero costs. Each
// rule here is a pure function of a configuration's shape, so the wizard, the members
// page and the settings page give one answer for one shape.

export interface Standing {
  // How a message names this member's key: "your key", "Alice's key".
  key: string;
  approve: boolean;
  recover: boolean;
}

export interface Lockout {
  key: string;
  threshold: number;
  approversLeft: number;
}

export function keyName(label: string, mine: boolean, kind = "ecdsa"): string {
  if (mine) return "your key";
  return kind === "webauthn" ? `the passkey "${label}"` : `${label}'s key`;
}

// The first member whose lost key would lock the account forever, or null when the
// configuration survives losing any one key. A lost key takes its approval and its power
// to recover with it; the account is still alive if the rest can reach the threshold, or
// if someone left can start a recovery, which replaces the lost key with equal permissions.
export function lockedByLosing(members: Standing[], threshold: number): Lockout | null {
  const approvers = members.filter((member) => member.approve).length;
  const recoverers = members.filter((member) => member.recover).length;
  for (const member of members) {
    const approversLeft = approvers - (member.approve ? 1 : 0);
    const recoverersLeft = recoverers - (member.recover ? 1 : 0);
    if (approversLeft >= threshold || recoverersLeft > 0) continue;
    return { key: member.key, threshold, approversLeft };
  }
  return null;
}

export function lockoutMessage(lockout: Lockout): string {
  const left = lockout.approversLeft === 0 ? "no approver" : `${lockout.approversLeft} ${lockout.approversLeft === 1 ? "approver" : "approvers"}`;
  const fixes = ["Add another approver", ...(lockout.threshold > 1 ? ["lower the threshold"] : []), "or give a member on another device Recover"];
  return `Losing ${lockout.key} would lock this Olien forever: ${lockout.threshold} ${lockout.threshold === 1 ? "approval" : "approvals"} would be needed with ${left} left, and nobody could recover. ${fixes.join(", ")}.`;
}

const DAY = 86_400;

export interface DelayWarnings {
  configDelay: string | null;
  recoveryDelay: string | null;
}

// A config delay of zero is the one setting that turns the veto off entirely; the
// security model promises the client says so. A recovery that waits under a day gives
// the members little chance to notice a guardian gone wrong, which only matters when a
// guardian exists.
export function delayWarnings(input: { configDelay: number; recoveryDelay: number; recoverers: number }): DelayWarnings {
  return {
    configDelay: input.configDelay === 0 ? "With no delay, a compromised quorum can change who controls this Olien instantly. The veto never fires." : null,
    recoveryDelay: input.recoverers > 0 && input.recoveryDelay < DAY ? "Under a day gives the other members little time to see a recovery and veto it." : null,
  };
}

// `_effectiveVetoThreshold` in Olien.sol: an explicit value stands; otherwise the fewest
// approver-vetoers whose refusal makes the threshold unreachable, floored at one.
export function effectiveVetoThreshold(input: { vetoThreshold: number; approverVetoers: number; threshold: number }): number {
  if (input.vetoThreshold !== 0) return input.vetoThreshold;
  if (input.approverVetoers < input.threshold) return 1;
  return input.approverVetoers - input.threshold + 1;
}

// What a veto threshold means for the people in the room, so the choice is made
// knowingly. One is safe because a vetoer can delay a change, never money, and never
// their own removal: the removed signer is excluded from vetoing it.
export function vetoRule(input: { vetoThreshold: number; vetoers: number; approverVetoers: number; threshold: number }): string {
  if (input.vetoers === 0) return "No member holds Veto, so nothing can stop a scheduled change. Give Veto to at least one member.";
  if (input.vetoThreshold === 1) return "Any one member with Veto can stop a change to members or rules while it waits. That member can delay a change, never money, and never their own removal, which is why one is safe here.";
  if (input.vetoThreshold >= 2) return `It takes ${input.vetoThreshold} members with Veto to stop a change while it waits. Fewer than ${input.vetoThreshold} who see a hostile change cannot stop it.`;
  const automatic = effectiveVetoThreshold(input);
  return `Automatic is ${automatic} today: the fewest members holding approve and veto whose refusal makes the threshold unreachable. It stops a quorum that changes its mind, not a quorum that has been compromised.`;
}

// A passkey the authenticator marked backup-eligible lives on every device signed into
// the same Apple or Google account, so two of them may be one key. Below a threshold of
// two there is nothing hidden: any single approver already spends alone.
export function syncedCanMeet(members: { approve: boolean; synced?: boolean | null }[], threshold: number): number | null {
  if (threshold < 2) return null;
  const synced = members.filter((member) => member.approve && member.synced === true).length;
  return synced >= threshold ? synced : null;
}

export function syncedMessage(count: number): string {
  return `${count} synced passkeys can meet the threshold on their own. Passkeys synced to one Apple or Google account are one key to whoever gets into that account; if these share an account, that person can spend alone.`;
}
