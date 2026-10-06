import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runMigrations } from "../migrations/index.js";
import { registerMemoryTools } from "../tools/memory.js";
import { registerReasoningTools } from "../tools/reasoning.js";
import { registerUsageGuideTool } from "../tools/usage-guide.js";
import { SERVER_INSTRUCTIONS } from "../server.js";
import { handleToolError } from "../utils.js";
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

test("error text points to reasoning_find and names no removed tool", async () => {
  const { db, dir, tools } = makeServer();
  try {
    const res = await tools.reasoning_add_step.handler({
      session_id: "sess_missing",
      thought: "x",
    });
    assert.equal(res.isError, true);
    const texts = [
      res.content[0]?.text ?? "",
      handleToolError(new Error("FOREIGN KEY constraint failed")),
    ];
    for (const text of texts) {
      assert.match(text, /reasoning_find/);
      for (const name of REMOVED_TOOL_NAMES) assert.ok(!text.includes(name), `${name} named in: ${text}`);
    }
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function listTools() {
  const { db, dir, server } = makeServer();
  const client = new Client({ name: "measure", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const { tools } = await client.listTools();
  await client.close();
  await server.close();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
  return tools;
}

test("memory_update + memory_search entries fit the WI-17 budget (AC-17.1)", async () => {
  const tools = await listTools();
  const size = tools
    .filter((t) => t.name === "memory_update" || t.name === "memory_search")
    .reduce((sum, t) => sum + JSON.stringify(t).length, 0);
  assert.ok(size <= 2983, `memory_update + memory_search = ${size} chars; budget 2983`);
});

test("memory_update still explains replace vs incremental fields (AC-17.3)", async () => {
  const tools = await listTools();
  const desc = tools.find((t) => t.name === "memory_update")?.description ?? "";
  assert.match(desc, /`tags`\/`metadata` replace the whole value/);
  assert.match(desc, /tags_append/);
  assert.match(desc, /metadata_patch/);
});

test("tools/list fits the 1.4.0 budget (AC-16.9)", async () => {
  const tools = await listTools();
  const size = JSON.stringify(tools).length;
  assert.ok(size <= 16700, `tools/list = ${size} chars; budget 16700`);
});
