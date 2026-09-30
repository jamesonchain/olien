import assert from "node:assert/strict";
import { test } from "node:test";
import { delayWarnings, effectiveVetoThreshold, keyName, lockedByLosing, lockoutMessage, syncedCanMeet, vetoRule } from "./resilience.ts";

const member = (key: string, approve = true, recover = false) => ({ key, approve, recover });

test("a one of one with nobody to recover is locked by its only key", () => {
  assert.deepEqual(lockedByLosing([member("your key")], 1), { key: "your key", threshold: 1, approversLeft: 0 });
});

test("a two of two with no guardian is locked by either key", () => {
  const lockout = lockedByLosing([member("your key"), member("Bob's key")], 2);
  assert.equal(lockout?.key, "your key");
  assert.equal(lockout?.approversLeft, 1);
});

test("a two of three survives any one loss", () => {
  assert.equal(lockedByLosing([member("a"), member("b"), member("c")], 2), null);
});

test("a three of three does not", () => {
  assert.equal(lockedByLosing([member("a"), member("b"), member("c")], 3)?.key, "a");
});

test("a recover-only guardian makes a two of two survivable", () => {
  assert.equal(lockedByLosing([member("a"), member("b"), member("guardian", false, true)], 2), null);
});

test("a guardian who is also one of the two approvers is the key that must not be lost", () => {
  const lockout = lockedByLosing([member("a", true, true), member("b")], 2);
  assert.equal(lockout?.key, "a");
});

test("the message counts approvers in words and offers only the fixes that apply", () => {
  const solo = lockoutMessage({ key: "your key", threshold: 1, approversLeft: 0 });
  assert.match(solo, /1 approval would be needed with no approver left/);
  assert.equal(solo.includes("lower the threshold"), false);
  assert.match(solo, /Add another approver, or give a member on another device Recover\.$/);
  const trio = lockoutMessage({ key: "Bob's key", threshold: 3, approversLeft: 2 });
  assert.match(trio, /3 approvals would be needed with 2 approvers left/);
  assert.match(trio, /Add another approver, lower the threshold, or give a member on another device Recover\.$/);
});

test("the automatic veto threshold follows the contract", () => {
  assert.equal(effectiveVetoThreshold({ vetoThreshold: 0, approverVetoers: 3, threshold: 2 }), 2);
  assert.equal(effectiveVetoThreshold({ vetoThreshold: 0, approverVetoers: 1, threshold: 2 }), 1);
  assert.equal(effectiveVetoThreshold({ vetoThreshold: 5, approverVetoers: 1, threshold: 2 }), 5);
});

test("the veto rule names the trade-off for each choice", () => {
  assert.match(vetoRule({ vetoThreshold: 1, vetoers: 3, approverVetoers: 3, threshold: 2 }), /never their own removal/);
  assert.match(vetoRule({ vetoThreshold: 2, vetoers: 3, approverVetoers: 3, threshold: 2 }), /Fewer than 2/);
  assert.match(vetoRule({ vetoThreshold: 0, vetoers: 3, approverVetoers: 3, threshold: 2 }), /Automatic is 2 today/);
  assert.match(vetoRule({ vetoThreshold: 1, vetoers: 0, approverVetoers: 0, threshold: 1 }), /No member holds Veto/);
});

test("a zero config delay warns, and a short recovery delay warns only with a guardian", () => {
  assert.match(delayWarnings({ configDelay: 0, recoveryDelay: 86_400, recoverers: 0 }).configDelay ?? "", /veto never fires/);
  assert.equal(delayWarnings({ configDelay: 86_400, recoveryDelay: 3_600, recoverers: 0 }).recoveryDelay, null);
  assert.match(delayWarnings({ configDelay: 86_400, recoveryDelay: 3_600, recoverers: 1 }).recoveryDelay ?? "", /Under a day/);
  assert.equal(delayWarnings({ configDelay: 86_400, recoveryDelay: 172_800, recoverers: 1 }).recoveryDelay, null);
});

test("synced passkeys count only when they alone can meet a threshold of two or more", () => {
  const synced = { approve: true, synced: true };
  const wallet = { approve: true, synced: null };
  assert.equal(syncedCanMeet([synced, synced], 2), 2);
  assert.equal(syncedCanMeet([synced, wallet], 2), null);
  assert.equal(syncedCanMeet([synced], 1), null);
  assert.equal(syncedCanMeet([{ approve: false, synced: true }, synced], 2), null);
});

test("a key is named for the person, and a passkey for what it is", () => {
  assert.equal(keyName("Me", true), "your key");
  assert.equal(keyName("Bob", false), "Bob's key");
  assert.equal(keyName("Synced passkey", false, "webauthn"), 'the passkey "Synced passkey"');
});
