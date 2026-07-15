import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("docs/architecture.md Version line matches package.json version", () => {
  const pkg = JSON.parse(
    fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")
  ) as { version: string };

  const architectureDoc = fs.readFileSync(
    new URL("../../docs/architecture.md", import.meta.url),
    "utf8"
  );

  const match = architectureDoc.match(/^Version:\s*(\S+)/m);
  assert.ok(match, "docs/architecture.md must contain a 'Version: X' line");
  assert.equal(
    match?.[1],
    pkg.version,
    "docs/architecture.md Version line must match package.json version — bump both together on every release"
  );
});
