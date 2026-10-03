import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

// The console was once a route inside another application, at /olien. Here it is served
// at the root, and a link to the old prefix is a 404 that the build cannot see: Next
// does not resolve hrefs, so a wrong one compiles. That shipped twice. This reads the
// source instead.

function sources(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return name === "node_modules" || name === ".next" ? [] : sources(path);
    return /\.tsx?$/.test(name) && !name.endsWith(".test.ts") ? [path] : [];
  });
}

test("no link or redirect points at the old /olien prefix", () => {
  const root = join(import.meta.dirname, "..");
  const offenders: string[] = [];
  for (const file of [...sources(join(root, "components")), ...sources(join(root, "app"))]) {
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, index) => {
        // A path that starts with /olien in a string or template, which an import of
        // "@/components/olien/..." is not.
        if (/["'`]\/olien(?:[/"'`?$]|$)/.test(line)) offenders.push(`${file.slice(root.length + 1)}:${index + 1}`);
      });
  }
  assert.deepEqual(offenders, []);
});
