import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runMigrations } from "../migrations/index.js";

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

  const { registerReasoningTools } = await import("../tools/reasoning.js");
  const server = new McpServer({ name: "test-server", version: "1.2.5" });
  registerReasoningTools(server, toolDb);

  const tools = (server as unknown as { _registeredTools: RegisteredToolMap })
    ._registeredTools;
  return { toolDb, toolDir, tools };
}

test("reasoning_add_step batch mode inserts steps atomically with sequential numbers", async () => {
  const { toolDb, toolDir, tools } = await makeHarness("wave2-batch");

  try {
    const started = await tools.reasoning_start_session.handler({
      title: "Batch logging task",
    });
    const sessionId = (started.structuredContent as { session_id: string })
      .session_id;

    // One single-mode step first, so batch numbering must continue from 2.
    const single = await tools.reasoning_add_step.handler({
      session_id: sessionId,
      thought: "first, logged singly",
    });
    assert.equal(single.isError, undefined);
    assert.equal(
      (single.structuredContent as { step_number: number }).step_number,
      1
    );

    const batch = await tools.reasoning_add_step.handler({
      session_id: sessionId,
      steps: [
        { thought: "second" },
        { action: "third action", observation: "third result" },
        { observation: "fourth" },
      ],
    });
    assert.equal(batch.isError, undefined);
    const payload = batch.structuredContent as {
      session_id: string;
      step_count: number;
      steps: Array<{ step_id: string; step_number: number }>;
    };
    assert.equal(payload.step_count, 3);
    assert.deepEqual(
      payload.steps.map((step) => step.step_number),
      [2, 3, 4]
    );

    const rows = toolDb
      .prepare(
        `SELECT step_number, thought, action, observation FROM reasoning_steps
         WHERE session_id = ? ORDER BY step_number`
      )
      .all(sessionId) as Array<{
      step_number: number;
      thought: string | null;
      action: string | null;
      observation: string | null;
    }>;
    assert.equal(rows.length, 4);
    assert.equal(rows[2].action, "third action");
    assert.equal(rows[2].observation, "third result");

    const event = toolDb
      .prepare(
        `SELECT input_shape, output_shape FROM tool_usage_events
         WHERE tool_name = 'reasoning_add_step'
         ORDER BY created_at DESC LIMIT 1`
      )
      .get() as { input_shape: string; output_shape: string };
    const inputShape = JSON.parse(event.input_shape) as {
      batch: boolean;
      batch_size: number;
    };
    assert.equal(inputShape.batch, true);
    assert.equal(inputShape.batch_size, 3);
    const outputShape = JSON.parse(event.output_shape) as {
      steps_added: number;
    };
    assert.equal(outputShape.steps_added, 3);
  } finally {
    toolDb.close();
    fs.rmSync(toolDir, { recursive: true, force: true });
  }
});

test("reasoning_add_step batch mode validates input and rejects mixed modes", async () => {
  const { toolDb, toolDir, tools } = await makeHarness("wave2-batch-validation");

  try {
    const started = await tools.reasoning_start_session.handler({
      title: "Validation task",
    });
    const sessionId = (started.structuredContent as { session_id: string })
      .session_id;

    const mixed = await tools.reasoning_add_step.handler({
      session_id: sessionId,
      thought: "top-level",
      steps: [{ thought: "batch" }],
    });
    assert.equal(mixed.isError, true);
    assert.match(mixed.content[0].text, /not both/);

    const emptyEntry = await tools.reasoning_add_step.handler({
      session_id: sessionId,
      steps: [{ thought: "ok" }, {}],
    });
    assert.equal(emptyEntry.isError, true);
    assert.match(emptyEntry.content[0].text, /steps\[1\]/);

    const nothing = await tools.reasoning_add_step.handler({
      session_id: sessionId,
    });
    assert.equal(nothing.isError, true);

    // Failed batches must not have inserted anything (atomicity).
    const count = toolDb
      .prepare(`SELECT COUNT(*) as c FROM reasoning_steps WHERE session_id = ?`)
      .get(sessionId) as { c: number };
    assert.equal(count.c, 0);

    await tools.reasoning_complete_session.handler({
      session_id: sessionId,
      conclusion: "done",
      status: "completed",
      save_as_memory: false,
      memory_tags: [],
      used_memory_ids: [],
    });
    const closed = await tools.reasoning_add_step.handler({
      session_id: sessionId,
      steps: [{ thought: "too late" }],
    });
    assert.equal(closed.isError, true);
    assert.match(closed.content[0].text, /cannot accept new steps/);
  } finally {
    toolDb.close();
    fs.rmSync(toolDir, { recursive: true, force: true });
  }
});
