import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  computeInstall,
  extractSnippet,
  installAgents,
} from "../install-agents.js";

const SNIPPET = [
  "<!-- MEMORY_MCP_SERVER_START -->",
  "## Memory MCP Server",
  "",
  "some content",
  "<!-- MEMORY_MCP_SERVER_END -->",
].join("\n");

test("extractSnippet throws when markers are missing", () => {
  assert.throws(() => extractSnippet("# README\n\nno markers here"));
});

test("extractSnippet extracts the block inclusive of both markers", () => {
  const readme = `# README\n\nsome intro\n\n${SNIPPET}\n\nmore text`;
  assert.equal(extractSnippet(readme), SNIPPET);
});

test("computeInstall creates a new file when none exists", () => {
  const { content, action } = computeInstall(null, SNIPPET);
  assert.equal(action, "created");
  assert.equal(content, `${SNIPPET}\n`);
});

test("computeInstall appends when the file exists without markers", () => {
  const existing = "# My AGENTS.md\n\nSome existing rules.\n";
  const { content, action } = computeInstall(existing, SNIPPET);
  assert.equal(action, "appended");
  assert.ok(content.startsWith(existing));
  assert.ok(content.includes(SNIPPET));
});

test("computeInstall appends without a leading blank line when the file is empty", () => {
  const { content, action } = computeInstall("", SNIPPET);
  assert.equal(action, "appended");
  assert.equal(content, `${SNIPPET}\n`);
});

test("computeInstall replaces in place when markers already exist (idempotent)", () => {
  const existing = `# My AGENTS.md\n\nSome existing rules.\n\n${SNIPPET}\n\nMore rules after.\n`;
  const updatedSnippet = SNIPPET.replace("some content", "updated content");
  const { content, action } = computeInstall(existing, updatedSnippet);
  assert.equal(action, "updated");
  assert.ok(content.includes("updated content"));
  assert.ok(!content.includes("some content\n<!-- MEMORY_MCP_SERVER_END -->"));
  assert.ok(content.includes("Some existing rules."));
  assert.ok(content.includes("More rules after."));
  // exactly one occurrence of the start marker -- no duplication on re-run
  assert.equal(
    content.split("<!-- MEMORY_MCP_SERVER_START -->").length - 1,
    1
  );
});

test("installAgents creates, backs up, and writes against injected targets", async () => {
  const dir = mkdtempSync(join(tmpdir(), "install-agents-"));
  const readmePath = join(dir, "README.md");
  writeFileSync(readmePath, `# Fake README\n\nintro text\n\n${SNIPPET}\n`);

  // (a) target whose file and parent directory do not exist yet
  const freshPath = join(dir, "nested", "CLAUDE.md");
  // (b) target that already exists without markers
  const existingPath = join(dir, "AGENTS.md");
  const originalContent = "# My AGENTS.md\n\nSome existing rules.\n";
  writeFileSync(existingPath, originalContent);

  await installAgents({
    targets: [
      { name: "Fresh", path: freshPath },
      { name: "Existing", path: existingPath },
    ],
    readmePath,
  });

  // (a) created: parent dir made, file is exactly the snippet, no backup
  assert.equal(readFileSync(freshPath, "utf8"), `${SNIPPET}\n`);
  assert.ok(!existsSync(`${freshPath}.bak`));

  // (b) appended: original content backed up to .bak, snippet appended
  assert.equal(readFileSync(`${existingPath}.bak`, "utf8"), originalContent);
  const appended = readFileSync(existingPath, "utf8");
  assert.ok(appended.startsWith("# My AGENTS.md"));
  assert.ok(appended.includes(SNIPPET));
});

test("installAgents is idempotent: re-run replaces in place without duplicating", async () => {
  const dir = mkdtempSync(join(tmpdir(), "install-agents-rerun-"));
  const readmePath = join(dir, "README.md");
  writeFileSync(readmePath, `# Fake README\n\n${SNIPPET}\n`);
  const targetPath = join(dir, "CLAUDE.md");
  const target = [{ name: "Target", path: targetPath }];

  await installAgents({ targets: target, readmePath });

  const updatedSnippet = SNIPPET.replace("some content", "updated content");
  writeFileSync(readmePath, `# Fake README\n\n${updatedSnippet}\n`);
  await installAgents({ targets: target, readmePath });

  const content = readFileSync(targetPath, "utf8");
  assert.ok(content.includes("updated content"));
  assert.ok(!content.includes("some content"));
  assert.equal(
    content.split("<!-- MEMORY_MCP_SERVER_START -->").length - 1,
    1
  );
});

test("scripts/install-agent-snippet.sh's embedded snippet matches README.md (drift check)", () => {
  const readme = readFileSync(
    new URL("../../README.md", import.meta.url),
    "utf8"
  );
  const readmeSnippet = extractSnippet(readme);

  const shScript = readFileSync(
    new URL("../../scripts/install-agent-snippet.sh", import.meta.url),
    "utf8"
  );
  const heredocMatch = shScript.match(/^cat <<'EOF'.*\n([\s\S]*?)^EOF$/m);
  assert.ok(
    heredocMatch,
    "expected a <<'EOF' ... EOF heredoc in scripts/install-agent-snippet.sh"
  );
  const shSnippet = heredocMatch![1].trim();

  assert.equal(
    shSnippet,
    readmeSnippet,
    "scripts/install-agent-snippet.sh's embedded snippet has drifted from README.md's -- update both together"
  );
});
