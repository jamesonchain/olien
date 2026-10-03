import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

// Every screen that signs builds what it signs in lib/signing.ts, from what it shows.
// These are the ways each screen used to take it from the service instead. They compile
// and they work, which is why they shipped; each one let the service choose what a key
// approved. A match here is a way back in.
const FORBIDDEN: [RegExp, string][] = [
  [/\.intent\??\.recipients/, "recipients are read from the calldata, not from the proposal's intent"],
  [/\bview\.decoded\b|\brow\.decoded\b|\bproposal\.decoded\b/, "the service's decoded text is not shown; the console decodes"],
  [/signWithPasskey\(\s*(view|cheque|prepared|plan)\b[^,]*\.(txHash|messageHash|hash)\b/, "a passkey signs a hash computed here, not one handed over"],
  [/cheque\.typedData/, "a cheque's typed data is built here from the row"],
  [/plan\.call\.(to|data)/, "a spend is encoded here from what was typed"],
  [/vetoCall\.data\.(to|data)\s+as\s+Hex/, "a veto is encoded here"],
  [/signMessageAsync\(\{\s*message:\s*challenge\.message/, "the sign-in text is built here from the nonce"],
  [/typedData\.domain/, "the domain is this console's chain and the account in the address bar"],
];

test("no screen signs or shows what the service supplied", () => {
  const directory = join(import.meta.dirname, "..", "components", "olien");
  const offenders: string[] = [];
  for (const name of readdirSync(directory).filter((file) => file.endsWith(".tsx"))) {
    readFileSync(join(directory, name), "utf8")
      .split("\n")
      .forEach((line, index) => {
        for (const [pattern, why] of FORBIDDEN) if (pattern.test(line)) offenders.push(`${name}:${index + 1}: ${why}`);
      });
  }
  assert.deepEqual(offenders, []);
});
