import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runMigrations } from "../migrations/index.js";
import { registerMemoryTools } from "../tools/memory.js";
import { registerReasoningTools } from "../tools/reasoning.js";
import { registerUsageGuideTool } from "../tools/usage-guide.js";

const GUIDELINES_PATH = fileURLToPath(
  new URL("../../GUIDELINES.md", import.meta.url)
);

function makeTempDbPath(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-mcp-"));
  return path.join(dir, `${name}.db`);
}

test("every registered tool is mentioned in GUIDELINES.md", () => {
  const dbPath = makeTempDbPath("docs-consistency");
  const tempDir = path.dirname(dbPath);
  const db = new DatabaseSync(dbPath);

  try {
    runMigrations(db);

    const server = new McpServer({ name: "test-server", version: "0.0.0" });
    registerMemoryTools(server, db);
    registerReasoningTools(server, db);
    registerUsageGuideTool(server, db);

    const registeredTools = (
      server as unknown as { _registeredTools: Record<string, unknown> }
    )._registeredTools;
    const toolNames = Object.keys(registeredTools);
    assert.ok(toolNames.length > 0, "expected registered tools");

    const guide = fs.readFileSync(GUIDELINES_PATH, "utf8");
    const missing = toolNames.filter((name) => !guide.includes(name));
    assert.deepEqual(
      missing,
      [],
      `GUIDELINES.md must mention every registered tool; missing: ${missing.join(", ")}`
    );
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("GUIDELINES.md states the key contract rules it must not contradict", () => {
  const guide = fs.readFileSync(GUIDELINES_PATH, "utf8");

  // not_saved_reason is required with memory_mode='never' (schema contract);
  // the guide must say "requires", never "optionally".
  assert.match(guide, /`memory_mode='never'` \(requires `not_saved_reason`\)/);
  assert.doesNotMatch(guide, /optionally with `memory_mode='never'`/);

  // add_step/complete_session need the session_id from start_session, while
  // mark_step is addressed by step_id — the guide must not conflate the two.
  assert.match(guide, /requires the\s+`session_id` returned by/);
  assert.match(guide, /`reasoning_mark_step`[\s\S]{0,100}`step_id`/);

  // Schemas are declared the source of truth for parameter contracts.
  assert.match(guide, /schemas and descriptions are the source of truth/i);
});
