import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runMigrations } from "../migrations/index.js";
import { registerMemoryTools } from "../tools/memory.js";
import { registerReasoningTools } from "../tools/reasoning.js";
import { registerUsageGuideTool } from "../tools/usage-guide.js";
import { SERVER_INSTRUCTIONS } from "../server.js";
import { insertMemory } from "./fixtures/memory-seed.js";

export const KEPT_TOOL_NAMES = [
  "get_usage_guide",
  "memory_get",
  "memory_record_usage_feedback",
  "memory_search",
  "memory_update",
  "reasoning_add_step",
  "reasoning_complete_session",
  "reasoning_find",
  "reasoning_start_session",
];

export const REMOVED_TOOL_NAMES = [
  "memory_save", "memory_list", "memory_delete",
  "memory_usage_report", "memory_adoption_report", "memory_agent_scorecard",
  "reasoning_get_trace", "reasoning_list_sessions", "reasoning_search_steps",
  "reasoning_list_milestones", "reasoning_get_session_outline", "reasoning_mark_step",
];

type Registered = Record<
  string,
  {
    description?: string;
    handler: (params: Record<string, unknown>) => Promise<{
      structuredContent?: Record<string, unknown>;
      isError?: boolean;
      content: Array<{ type: "text"; text: string }>;
    }>;
  }
>;

function makeServer() {
  const dir = fs.mkdtempSync(path.join(process.cwd(), ".tmp-memory-mcp-"));
  const db = new DatabaseSync(path.join(dir, "surface.db"));
  runMigrations(db);
  const server = new McpServer({ name: "memory-mcp-server", version: "0.0.0" });
  registerMemoryTools(server, db);
  registerReasoningTools(server, db);
  registerUsageGuideTool(server, db);
  const tools = (server as unknown as { _registeredTools: Registered })._registeredTools;
  return { db, dir, server, tools };
}

test("exactly the 9 kept tools are registered (AC-16.1)", () => {
  const { db, dir, tools } = makeServer();
  try {
    assert.deepEqual(Object.keys(tools).sort(), [...KEPT_TOOL_NAMES].sort());
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("no tool description or server instruction names a removed tool (AC-16.4)", () => {
  const { db, dir, tools } = makeServer();
  try {
    const texts = [SERVER_INSTRUCTIONS, ...Object.values(tools).map((t) => t.description ?? "")];
    for (const name of REMOVED_TOOL_NAMES) {
      for (const text of texts) assert.ok(!text.includes(name), `${name} still named in: ${text.slice(0, 80)}`);
    }
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("feedback still verifies a historical memory_list event (AC-16.8)", async () => {
  const { db, dir, tools } = makeServer();
  try {
    const memoryId = insertMemory(db, { content: "listed long ago" });
    db.prepare(
      `INSERT INTO tool_usage_events (id, created_at, mcp_version, tool_name, operation_type, access_type, status, output_shape)
       VALUES ('evt_list', '2026-08-01T00:00:00.000Z', '1.3.3', 'memory_list', 'memory', 'read', 'success', ?)`
    ).run(JSON.stringify({ memory_ids: [memoryId] }));
    const res = await tools.memory_record_usage_feedback.handler({
      memory_id: memoryId,
      usefulness: "used",
      event_id: "evt_list",
    });
    assert.equal(res.isError, undefined, res.content[0]?.text);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("reasoning_find description states its trigger (AC-20.9)", () => {
  const { db, dir, tools } = makeServer();
  try {
    assert.match(tools.reasoning_find.description ?? "", /refers to earlier work/);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
