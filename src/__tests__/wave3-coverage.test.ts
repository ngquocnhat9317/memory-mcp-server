import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runMigrations } from "../migrations/index.js";
import { insertMemory } from "./fixtures/memory-seed.js";

function makeWorkspaceDbPath(name: string): string {
  const dir = fs.mkdtempSync(path.join(process.cwd(), ".tmp-memory-mcp-"));
  return path.join(dir, `${name}.db`);
}

type RegisteredToolMap = Record<
  string,
  {
    handler: (params: Record<string, unknown>) => Promise<{
      structuredContent?: Record<string, unknown>;
      isError?: boolean;
      content: Array<{ type: "text"; text: string }>;
    }>;
  }
>;

async function makeHarness(name: string): Promise<{
  toolDb: DatabaseSync;
  toolDir: string;
  tools: RegisteredToolMap;
}> {
  const toolDbPath = makeWorkspaceDbPath(name);
  const toolDir = path.dirname(toolDbPath);
  const toolDb = new DatabaseSync(toolDbPath);
  runMigrations(toolDb);
  // Second run must be a no-op (already-applied fast path).
  runMigrations(toolDb);

  const { registerMemoryTools } = await import("../tools/memory.js");
  const { registerReasoningTools } = await import("../tools/reasoning.js");
  const server = new McpServer({ name: "test-server", version: "1.3.0" });
  registerMemoryTools(server, toolDb);
  registerReasoningTools(server, toolDb);

  const tools = (server as unknown as { _registeredTools: RegisteredToolMap })
    ._registeredTools;
  return { toolDb, toolDir, tools };
}

test("memory_update covers replace, patch, merge, and error branches", async () => {
  const { toolDb, toolDir, tools } = await makeHarness("cov-update");

  try {
    const id = insertMemory(toolDb, {
      content: "original content",
      type: "fact",
      tags: ["keep", "drop"],
      importance: 2,
      metadata: { a: 1, b: 2 },
    });

    // tags_append/tags_remove merge path + metadata_patch merge path.
    const patched = await tools.memory_update.handler({
      id,
      tags_append: ["new"],
      tags_remove: ["drop"],
      metadata_patch: { b: 3, c: 4 },
      importance: 5,
      type: "decision",
    });
    assert.equal(patched.isError, undefined);
    const patchedPayload = patched.structuredContent as {
      tags: string[];
      metadata: Record<string, unknown>;
      importance: number;
      type: string;
    };
    assert.deepEqual(patchedPayload.tags.sort(), ["keep", "new"]);
    assert.deepEqual(patchedPayload.metadata, { a: 1, b: 3, c: 4 });
    assert.equal(patchedPayload.importance, 5);
    assert.equal(patchedPayload.type, "decision");

    // Full replace path for tags/metadata/content.
    const replaced = await tools.memory_update.handler({
      id,
      content: "rewritten content",
      tags: ["only"],
      metadata: { fresh: true },
    });
    assert.equal(replaced.isError, undefined);
    const replacedPayload = replaced.structuredContent as {
      content: string;
      tags: string[];
      metadata: Record<string, unknown>;
    };
    assert.equal(replacedPayload.content, "rewritten content");
    assert.deepEqual(replacedPayload.tags, ["only"]);
    assert.deepEqual(replacedPayload.metadata, { fresh: true });

    // Error: no updatable field provided.
    const empty = await tools.memory_update.handler({ id });
    assert.equal(empty.isError, true);
    assert.match(empty.content[0]?.text ?? "", /At least one field/);

    // Error: unknown id.
    const missing = await tools.memory_update.handler({
      id: "mem_missing",
      content: "x",
    });
    assert.equal(missing.isError, true);
    assert.match(missing.content[0]?.text ?? "", /not found/);

    // memory_get: unknown id.
    const getMissing = await tools.memory_get.handler({ id: "mem_missing" });
    assert.equal(getMissing.isError, true);
    assert.match(getMissing.content[0]?.text ?? "", /not found/);
  } finally {
    toolDb.close();
    fs.rmSync(toolDir, { recursive: true, force: true });
  }
});

test("memory_search covers agent filter and offset pagination", async () => {
  const { toolDb, toolDir, tools } = await makeHarness("cov-search");

  try {
    insertMemory(toolDb, {
      content: "grafana dashboard tuning",
      type: "fact",
      agentId: "agent-a",
    });
    insertMemory(toolDb, {
      content: "grafana alert rules",
      type: "fact",
      agentId: "agent-b",
    });

    const filtered = await tools.memory_search.handler({
      query: "grafana",
      agent_id: "agent-a",
      limit: 20,
      offset: 0,
    });
    const filteredPayload = filtered.structuredContent as {
      results: Array<{ agent_id: string }>;
    };
    assert.equal(filteredPayload.results.length, 1);
    assert.equal(filteredPayload.results[0].agent_id, "agent-a");

    const offsetPast = await tools.memory_search.handler({
      query: "grafana",
      limit: 20,
      offset: 10,
    });
    assert.match(offsetPast.content[0]?.text ?? "", /No memories found/);
  } finally {
    toolDb.close();
    fs.rmSync(toolDir, { recursive: true, force: true });
  }
});

test("memory_record_usage_feedback accepts direct memory-id feedback via wrapper", async () => {
  const { toolDb, toolDir, tools } = await makeHarness("cov-feedback-direct");

  try {
    const id = insertMemory(toolDb, { content: "feedback subject", type: "fact" });

    const feedback = await tools.memory_record_usage_feedback.handler({
      memory_id: id,
      usefulness: "stale",
      reason: "superseded by newer decision",
      agent_id: "agent-a",
    });
    assert.equal(feedback.isError, undefined);
    const payload = feedback.structuredContent as {
      recorded: boolean;
      usefulness: string;
    };
    assert.equal(payload.recorded, true);
    assert.equal(payload.usefulness, "stale");
  } finally {
    toolDb.close();
    fs.rmSync(toolDir, { recursive: true, force: true });
  }
});

test("oversized responses truncate instead of overflowing", async () => {
  const { toolDb, toolDir, tools } = await makeHarness("cov-truncate");

  try {
    const id = insertMemory(toolDb, { content: "x".repeat(30000) });
    const got = await tools.memory_get.handler({ id });
    assert.equal(got.isError, undefined);
    assert.match(got.content[0]?.text ?? "", /truncated/);
  } finally {
    toolDb.close();
    fs.rmSync(toolDir, { recursive: true, force: true });
  }
});

test("constraint violations map to a readable error message", async () => {
  const { toolDb, toolDir, tools } = await makeHarness("cov-constraint");

  try {
    const id = insertMemory(toolDb, { content: "valid memory" });
    // Direct handler call bypasses zod, so the DB CHECK fires.
    const bad = await tools.memory_update.handler({ id, importance: 42 });
    assert.equal(bad.isError, true);
    assert.match(bad.content[0]?.text ?? "", /Invalid value provided/);
  } finally {
    toolDb.close();
    fs.rmSync(toolDir, { recursive: true, force: true });
  }
});

test("telemetry recording failures never break the tool call", async () => {
  const { toolDb, toolDir, tools } = await makeHarness("cov-telemetry-fail");

  try {
    toolDb.exec(`DROP TABLE tool_usage_events`);
    const started = await tools.reasoning_start_session.handler({
      title: "survives telemetry outage",
    });
    assert.equal(started.isError, undefined);
    assert.match(started.content[0]?.text ?? "", /Reasoning session started/);
  } finally {
    toolDb.close();
    fs.rmSync(toolDir, { recursive: true, force: true });
  }
});

test("reasoning tools cover error branches and lifecycle variants", async () => {
  const { toolDb, toolDir, tools } = await makeHarness("cov-reasoning");

  try {
    // reading a missing session.
    const unknownRead = await tools.reasoning_find.handler({ session_id: "sess_missing" });
    assert.equal(unknownRead.isError, true);

    // add_step to a missing session.
    const missingAdd = await tools.reasoning_add_step.handler({
      session_id: "sess_missing",
      thought: "orphan",
    });
    assert.equal(missingAdd.isError, true);

    // Full lifecycle with memory_mode 'always' persisting the conclusion.
    const started = await tools.reasoning_start_session.handler({
      title: "coverage lifecycle session",
      agent_id: "agent-cov",
    });
    const sessionId = (started.structuredContent as { session_id: string })
      .session_id;
    await tools.reasoning_add_step.handler({
      session_id: sessionId,
      thought: "only step",
      action: "inspect",
      observation: "fine",
    });
    const completed = await tools.reasoning_complete_session.handler({
      session_id: sessionId,
      conclusion: "durable conclusion worth keeping",
      status: "completed",
      memory_mode: "always",
      memory_tags: ["cov"],
      memory_type: "decision",
      memory_importance: 4,
      used_memory_ids: [],
    });
    assert.equal(completed.isError, undefined);
    const memoryId = (completed.structuredContent as { memory_id: string })
      .memory_id;
    assert.match(memoryId, /^mem_/);

    // Completing again must error.
    const again = await tools.reasoning_complete_session.handler({
      session_id: sessionId,
      conclusion: "double complete",
      status: "completed",
      save_as_memory: false,
      memory_tags: [],
      used_memory_ids: [],
    });
    assert.equal(again.isError, true);

    // Adding a step to a completed session must error.
    const lateStep = await tools.reasoning_add_step.handler({
      session_id: sessionId,
      thought: "too late",
    });
    assert.equal(lateStep.isError, true);

    // memory_mode 'never' with a reason records the skip.
    const started2 = await tools.reasoning_start_session.handler({
      title: "throwaway investigation",
      agent_id: "agent-cov",
    });
    const session2 = (started2.structuredContent as { session_id: string })
      .session_id;
    await tools.reasoning_add_step.handler({
      session_id: session2,
      thought: "nothing durable here",
    });
    const skipped = await tools.reasoning_complete_session.handler({
      session_id: session2,
      conclusion: "one-off noise",
      status: "abandoned",
      memory_mode: "never",
      not_saved_reason: "transient debugging detail",
      memory_tags: [],
      used_memory_ids: [],
    });
    assert.equal(skipped.isError, undefined);
    const skippedPayload = skipped.structuredContent as {
      memory_id: string | null;
      not_saved_reason: string | null;
    };
    assert.equal(skippedPayload.memory_id, null);
    assert.ok(skippedPayload.not_saved_reason);
  } finally {
    toolDb.close();
    fs.rmSync(toolDir, { recursive: true, force: true });
  }
});
