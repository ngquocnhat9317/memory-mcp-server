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
  assert.match(guide, /`memory_mode='never'` \(requires\s+`not_saved_reason`\)/);
  assert.doesNotMatch(guide, /optionally with `memory_mode='never'`/);

  assert.match(guide, /requires the\s+`session_id` returned by/);

  // Schemas are declared the source of truth for parameter contracts.
  assert.match(guide, /schemas and descriptions are the source of truth/i);
});

const REMOVED_TOOL_NAMES = [
  "memory_save", "memory_list", "memory_delete",
  "memory_usage_report", "memory_adoption_report", "memory_agent_scorecard",
  "reasoning_get_trace", "reasoning_list_sessions", "reasoning_search_steps",
  "reasoning_list_milestones", "reasoning_get_session_outline", "reasoning_mark_step",
];

test("GUIDELINES.md names no removed tool (AC-16.2)", () => {
  const guide = fs.readFileSync(GUIDELINES_PATH, "utf8");
  for (const name of REMOVED_TOOL_NAMES) assert.ok(!guide.includes(name), `guide still names ${name}`);
});

test("README.md and the snippet script name no removed tool (AC-16.3)", () => {
  const readme = fs.readFileSync(fileURLToPath(new URL("../../README.md", import.meta.url)), "utf8");
  const script = fs.readFileSync(
    fileURLToPath(new URL("../../scripts/install-agent-snippet.sh", import.meta.url)),
    "utf8"
  );
  // README may mention removed names only inside its "Removed in 1.4.0" note.
  const readmeOutsideNote = readme.replace(/<!-- REMOVED_1_4_0_START -->[\s\S]*?<!-- REMOVED_1_4_0_END -->/, "");
  for (const name of REMOVED_TOOL_NAMES) {
    assert.ok(!readmeOutsideNote.includes(name), `README still names ${name}`);
    assert.ok(!script.includes(name), `snippet script still names ${name}`);
  }
});

test("GUIDELINES.md v9 carries the behavior rules and stays within budget (AC-16.10, AC-20.9)", () => {
  const guide = fs.readFileSync(GUIDELINES_PATH, "utf8");
  const required: Array<[string, RegExp]> = [
    ["trace question 1", /what did you\s+check/],
    ["trace question 2", /what did you\s+find/],
    ["trace question 3", /what did you\s+decide and why/],
    ["checkpoint: before asking", /before you ask the user to choose or\s+confirm/],
    ["checkpoint: presenting", /when you present a plan or\s+result/],
    ["checkpoint: before completing", /before\s+`reasoning_complete_session`/],
    ["late opening", /open the session\s+then/],
    ["pending answer is a new task", /starts a new\s+task/],
    ["pending memory update", /pending memory/],
    ["first sentence", /first\s+sentence states the subject and the outcome/],
    ["rejected options", /options you rejected/],
    ["preference default", /`memory_type='preference'`/],
    ["stale trigger 1", /contradicts what you just verified/],
    ["stale trigger 2", /supersedes an older or pending memory/],
    ["reasoning_find trigger", /refers to earlier work/],
  ];
  for (const [label, pattern] of required) assert.match(guide, pattern, `missing: ${label}`);
  assert.doesNotMatch(guide, /1–5 scale/, "importance scale must be gone");
  assert.doesNotMatch(guide, /`ignored`, `irrelevant`/, "feedback taxonomy must be gone");
  assert.ok(guide.length <= 8787, `guide is ${guide.length} chars; budget is 8787`);
});
