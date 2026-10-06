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

test("Add Reasoning Step uses the maximum existing step number when allocating the next step", async () => {
  const toolDbPath = makeWorkspaceDbPath("reasoning-add-step-max");
  const toolDir = path.dirname(toolDbPath);
  const toolDb = new DatabaseSync(toolDbPath);
  runMigrations(toolDb);

  const { registerReasoningTools } = await import("../tools/reasoning.js");

  const server = new McpServer({ name: "test-server", version: "1.1.5" });
  registerReasoningTools(server, toolDb);

  const registeredTools = (server as unknown as { _registeredTools: RegisteredToolMap })
    ._registeredTools;
  const addStep = registeredTools.reasoning_add_step?.handler;
  assert.ok(addStep, "reasoning_add_step should be registered");

  try {
    toolDb.exec(`
      DELETE FROM reasoning_steps;
      DELETE FROM reasoning_sessions;
    `);

    toolDb.prepare(
      "INSERT INTO reasoning_sessions (id, title, status, created_at, updated_at) VALUES (?, ?, 'in_progress', ?, ?)"
    ).run(
      "sess_add_gap",
      "add step max",
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z"
    );

    toolDb.prepare(
      "INSERT INTO reasoning_steps (id, session_id, step_number, thought, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run("step_gap_1", "sess_add_gap", 1, "first", "2026-01-01T00:00:00.000Z");
    toolDb.prepare(
      "INSERT INTO reasoning_steps (id, session_id, step_number, thought, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run("step_gap_3", "sess_add_gap", 3, "third", "2026-01-01T00:00:02.000Z");

    const result = await addStep({
      session_id: "sess_add_gap",
      thought: "new step",
    });
    const payload = result.structuredContent as {
      step_id: string;
      session_id: string;
      step_number: number;
    };

    assert.equal(result.isError, undefined);
    assert.deepEqual(payload, {
      step_id: payload.step_id,
      session_id: "sess_add_gap",
      step_number: 4,
    });

    const inserted = toolDb
      .prepare(
        "SELECT step_number FROM reasoning_steps WHERE id = ?"
      )
      .get(payload.step_id) as { step_number: number };
    assert.equal(inserted.step_number, 4);
  } finally {
    toolDb.close();
    fs.rmSync(toolDir, { recursive: true, force: true });
  }
});

test("Complete Reasoning Session rolls back the session update if memory save fails", async () => {
  const toolDbPath = makeWorkspaceDbPath("reasoning-complete-rollback");
  const toolDir = path.dirname(toolDbPath);
  const toolDb = new DatabaseSync(toolDbPath);
  runMigrations(toolDb);

  const { registerReasoningTools } = await import("../tools/reasoning.js");

  const server = new McpServer({ name: "test-server", version: "1.1.5" });
  registerReasoningTools(server, toolDb);

  const registeredTools = (server as unknown as { _registeredTools: RegisteredToolMap })
    ._registeredTools;
  const completeSession = registeredTools.reasoning_complete_session?.handler;
  assert.ok(completeSession, "reasoning_complete_session should be registered");

  try {
    toolDb.exec(`
      DELETE FROM reasoning_steps;
      DELETE FROM reasoning_sessions;
      DELETE FROM memories;
    `);

    toolDb.prepare(
      "INSERT INTO reasoning_sessions (id, title, status, created_at, updated_at) VALUES (?, ?, 'in_progress', ?, ?)"
    ).run(
      "sess_complete_fail",
      "complete fail",
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z"
    );
    toolDb.prepare(
      "INSERT INTO reasoning_steps (id, session_id, step_number, thought, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run(
      "step_complete_fail",
      "sess_complete_fail",
      1,
      "step",
      "2026-01-01T00:00:00.000Z"
    );

    toolDb.exec(`
      CREATE TRIGGER fail_memory_insert
      BEFORE INSERT ON memories
      BEGIN
        SELECT RAISE(ABORT, 'memory insert blocked');
      END;
    `);

    const result = await completeSession({
      session_id: "sess_complete_fail",
      conclusion: "done",
      save_as_memory: true,
      status: "completed",
      memory_tags: [],
    });

    assert.equal(result.isError, true);

    const session = toolDb
      .prepare(
        "SELECT status, conclusion FROM reasoning_sessions WHERE id = ?"
      )
      .get("sess_complete_fail") as {
      status: string;
      conclusion: string | null;
    };
    assert.equal(session.status, "in_progress");
    assert.equal(session.conclusion, null);

    const memoryCount = toolDb
      .prepare("SELECT COUNT(*) as c FROM memories")
      .get() as { c: number };
    assert.equal(memoryCount.c, 0);
  } finally {
    toolDb.close();
    fs.rmSync(toolDir, { recursive: true, force: true });
  }
});

test("Complete Reasoning Session does not emit a completed warning for abandoned zero-step sessions", async () => {
  const toolDbPath = makeWorkspaceDbPath("reasoning-complete-abandoned-warning");
  const toolDir = path.dirname(toolDbPath);
  const toolDb = new DatabaseSync(toolDbPath);
  runMigrations(toolDb);

  const { registerReasoningTools } = await import("../tools/reasoning.js");

  const server = new McpServer({ name: "test-server", version: "1.1.5" });
  registerReasoningTools(server, toolDb);

  const registeredTools = (server as unknown as { _registeredTools: RegisteredToolMap })
    ._registeredTools;
  const completeSession = registeredTools.reasoning_complete_session?.handler;
  assert.ok(completeSession, "reasoning_complete_session should be registered");

  try {
    toolDb.exec(`
      DELETE FROM reasoning_steps;
      DELETE FROM reasoning_sessions;
      DELETE FROM memories;
    `);

    toolDb.prepare(
      "INSERT INTO reasoning_sessions (id, title, status, created_at, updated_at) VALUES (?, ?, 'in_progress', ?, ?)"
    ).run(
      "sess_abandoned_zero",
      "abandoned zero",
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z"
    );

    const result = await completeSession({
      session_id: "sess_abandoned_zero",
      conclusion: "stopped",
      status: "abandoned",
      memory_mode: "never",
      not_saved_reason: "task abandoned",
    });
    const payload = result.structuredContent as {
      session: {
        id: string;
        title: string;
        agent_id: string | null;
        status: string;
        conclusion: string | null;
        created_at: string;
        updated_at: string;
        step_count: number;
      };
      memory_id: string | null;
      not_saved_reason: string | null;
      warnings: string[];
    };

    assert.equal(result.isError, undefined);
    assert.deepEqual(payload, {
      session: {
        id: "sess_abandoned_zero",
        title: "abandoned zero",
        agent_id: null,
        status: "abandoned",
        conclusion: "stopped",
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: payload.session.updated_at,
        step_count: 0,
      },
      memory_id: null,
      not_saved_reason: "task abandoned",
      used_memory_feedback_recorded: 0,
      warnings: [],
    });
  } finally {
    toolDb.close();
    fs.rmSync(toolDir, { recursive: true, force: true });
  }
});

test("Complete Reasoning Session does not auto-save memory by default", async () => {
  const toolDbPath = makeWorkspaceDbPath("reasoning-complete-default-no-save");
  const toolDir = path.dirname(toolDbPath);
  const toolDb = new DatabaseSync(toolDbPath);
  runMigrations(toolDb);

  const { registerReasoningTools } = await import("../tools/reasoning.js");

  const server = new McpServer({ name: "test-server", version: "1.1.5" });
  registerReasoningTools(server, toolDb);

  const registeredTools = (server as unknown as { _registeredTools: RegisteredToolMap })
    ._registeredTools;
  const completeSession = registeredTools.reasoning_complete_session?.handler;
  assert.ok(completeSession, "reasoning_complete_session should be registered");

  try {
    toolDb.exec(`
      DELETE FROM reasoning_steps;
      DELETE FROM reasoning_sessions;
      DELETE FROM memories;
    `);

    toolDb.prepare(
      "INSERT INTO reasoning_sessions (id, title, status, created_at, updated_at) VALUES (?, ?, 'in_progress', ?, ?)"
    ).run(
      "sess_default_no_save",
      "default no save",
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z"
    );
    toolDb.prepare(
      "INSERT INTO reasoning_steps (id, session_id, step_number, thought, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run(
      "step_default_no_save",
      "sess_default_no_save",
      1,
      "step",
      "2026-01-01T00:00:00.000Z"
    );

    const result = await completeSession({
      session_id: "sess_default_no_save",
      conclusion: "done",
      status: "completed",
    });
    assert.equal(result.isError, undefined);

    const payload = result.structuredContent as {
      memory_id: string | null;
      not_saved_reason: string | null;
    };
    assert.equal(payload.memory_id, null);
    assert.equal(payload.not_saved_reason, null);

    const memoryCount = toolDb
      .prepare("SELECT COUNT(*) as c FROM memories")
      .get() as { c: number };
    assert.equal(memoryCount.c, 0);
  } finally {
    toolDb.close();
    fs.rmSync(toolDir, { recursive: true, force: true });
  }
});

test("get_usage_guide returns a stable versioned guide and records telemetry", async () => {
  const toolDbPath = makeWorkspaceDbPath("memory-guide");
  const toolDir = path.dirname(toolDbPath);
  const toolDb = new DatabaseSync(toolDbPath);
  runMigrations(toolDb);

  const { registerMemoryTools } = await import("../tools/memory.js");
  const { registerUsageGuideTool } = await import("../tools/usage-guide.js");

  const server = new McpServer({ name: "test-server", version: "1.1.5" });
  registerMemoryTools(server, toolDb);
  registerUsageGuideTool(server, toolDb);

  const registeredTools = (server as unknown as { _registeredTools: RegisteredToolMap })
    ._registeredTools;
  const getGuide = registeredTools.get_usage_guide?.handler;
  assert.ok(getGuide, "get_usage_guide should be registered");

  try {
    toolDb.prepare("DELETE FROM tool_usage_events").run();
    const expectedGuide = fs.readFileSync(
      new URL("../../GUIDELINES.md", import.meta.url),
      "utf8"
    );

    const result = await getGuide({
      agent_id: "agent-guide",
      client_name: "codex",
      client_version: "1.1.5",
    });

    assert.equal(result.isError, undefined);
    assert.equal(result.content[0]?.text, expectedGuide);
    // AC-9.6: the tag-hygiene rule must be part of the served guide.
    assert.match(
      expectedGuide,
      /tags describe topics[^.]*,\s+not projects/i
    );
    assert.deepEqual(result.structuredContent, {
      guide_version: "2026-10-06.v9",
      mcp_version: "1.3.3",
      path: "GUIDELINES.md",
      format: "markdown",
      content: expectedGuide,
    });

    const event = toolDb
      .prepare(
        `SELECT tool_name, operation_type, access_type, guidance_version, agent_id, client_name
         FROM tool_usage_events
         WHERE tool_name = 'get_usage_guide'`
      )
      .get() as {
      tool_name: string;
      operation_type: string;
      access_type: string;
      guidance_version: string | null;
      agent_id: string | null;
      client_name: string | null;
    };

    assert.equal(event.tool_name, "get_usage_guide");
    assert.equal(event.operation_type, "guidance");
    assert.equal(event.access_type, "derived");
    assert.equal(event.guidance_version, "2026-10-06.v9");
    assert.equal(event.agent_id, "agent-guide");
    assert.equal(event.client_name, "codex");
  } finally {
    toolDb.close();
    fs.rmSync(toolDir, { recursive: true, force: true });
  }
});

test("memory_record_usage_feedback rejects invalid related events and records telemetry errors", async () => {
  const toolDbPath = makeWorkspaceDbPath("memory-feedback-validation");
  const toolDir = path.dirname(toolDbPath);
  const toolDb = new DatabaseSync(toolDbPath);
  runMigrations(toolDb);

  const { registerMemoryTools } = await import("../tools/memory.js");

  const server = new McpServer({ name: "test-server", version: "1.1.5" });
  registerMemoryTools(server, toolDb);

  const registeredTools = (server as unknown as { _registeredTools: RegisteredToolMap })
    ._registeredTools;
  const recordFeedback = registeredTools.memory_record_usage_feedback?.handler;
  assert.ok(recordFeedback, "memory_record_usage_feedback should be registered");

  try {
    toolDb.exec(`
      DELETE FROM tool_usage_events;
      DELETE FROM memories;
    `);
    toolDb.prepare(
      `INSERT INTO memories (id, type, content, tags, agent_id, importance, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "mem_feedback",
      "fact",
      "feedback target",
      "[]",
      null,
      3,
      null,
      "2026-07-07T00:00:00.000Z",
      "2026-07-07T00:00:00.000Z"
    );

    const result = await recordFeedback({
      memory_id: "mem_feedback",
      event_id: "evt_missing",
      usefulness: "used",
      reason: "bad link",
    });
    assert.equal(result.isError, true);
    assert.match(
      result.content[0]?.text ?? "",
      /cannot be verified/
    );

    const errorEvent = toolDb
      .prepare(
        `SELECT status, related_event_id, memory_id
         FROM tool_usage_events
         WHERE tool_name = 'memory_record_usage_feedback'`
      )
      .get() as {
      status: string;
      related_event_id: string | null;
      memory_id: string | null;
    };

    assert.equal(errorEvent.status, "error");
    assert.equal(errorEvent.related_event_id, "evt_missing");
    assert.equal(errorEvent.memory_id, "mem_feedback");
  } finally {
    toolDb.close();
    fs.rmSync(toolDir, { recursive: true, force: true });
  }
});

test("memory_record_usage_feedback rejects unverifiable multi-memory recall events", async () => {
  const toolDbPath = makeWorkspaceDbPath("memory-feedback-multi-recall");
  const toolDir = path.dirname(toolDbPath);
  const toolDb = new DatabaseSync(toolDbPath);
  runMigrations(toolDb);

  const { registerMemoryTools } = await import("../tools/memory.js");

  const server = new McpServer({ name: "test-server", version: "1.1.5" });
  registerMemoryTools(server, toolDb);

  const registeredTools = (server as unknown as { _registeredTools: RegisteredToolMap })
    ._registeredTools;
  const recordFeedback = registeredTools.memory_record_usage_feedback?.handler;
  assert.ok(recordFeedback, "memory_record_usage_feedback should be registered");

  try {
    toolDb.exec(`
      DELETE FROM tool_usage_events;
      DELETE FROM memories;
    `);
    toolDb.prepare(
      `INSERT INTO memories (id, type, content, tags, agent_id, importance, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "mem_feedback",
      "fact",
      "feedback target",
      "[]",
      null,
      3,
      null,
      "2026-07-07T00:00:00.000Z",
      "2026-07-07T00:00:00.000Z"
    );
    toolDb.prepare(
      `INSERT INTO tool_usage_events (
         id, created_at, agent_id, client_name, client_version, mcp_version,
         guidance_version, tool_name, operation_type, access_type, status,
         error_code, latency_ms, session_id, step_id, memory_id, related_event_id,
         input_shape, output_shape, metadata
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "evt_multi_recall",
      "2026-07-07T00:00:00.000Z",
      null,
      null,
      null,
      "1.1.5",
      null,
      "memory_search",
      "memory",
      "read",
      "success",
      null,
      5,
      null,
      null,
      null,
      null,
      JSON.stringify({ query_length: 5 }),
      JSON.stringify({ result_count: 2 }),
      null
    );

    const result = await recordFeedback({
      memory_id: "mem_feedback",
      event_id: "evt_multi_recall",
      usefulness: "used",
      reason: "cannot prove which result was used",
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0]?.text ?? "", /cannot be verified/i);
  } finally {
    toolDb.close();
    fs.rmSync(toolDir, { recursive: true, force: true });
  }
});

test("usage feedback is persisted even when telemetry is disabled, while other events stay gated", async () => {
  const originalTelemetry = process.env.MEMORY_TELEMETRY;
  process.env.MEMORY_TELEMETRY = "off";

  const toolDbPath = makeWorkspaceDbPath("memory-feedback-telemetry-off");
  const toolDir = path.dirname(toolDbPath);
  const toolDb = new DatabaseSync(toolDbPath);
  runMigrations(toolDb);

  try {
    // Plain import: the telemetry gate reads MEMORY_TELEMETRY at call time,
    // so no cache-busting re-import is needed to flip it.
    const { registerMemoryTools } = await import("../tools/memory.js");

    const server = new McpServer({ name: "test-server", version: "1.1.5" });
    registerMemoryTools(server, toolDb);

    const registeredTools = (server as unknown as { _registeredTools: RegisteredToolMap })
      ._registeredTools;
    const recordFeedback = registeredTools.memory_record_usage_feedback?.handler;
    assert.ok(recordFeedback, "memory_record_usage_feedback should be registered");
    const searchMemory = registeredTools.memory_search?.handler;
    assert.ok(searchMemory, "memory_search should be registered");

    toolDb.exec(`
      DELETE FROM tool_usage_events;
      DELETE FROM memories;
    `);
    toolDb.prepare(
      `INSERT INTO memories (id, type, content, tags, agent_id, importance, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "mem_feedback",
      "fact",
      "feedback target",
      "[]",
      null,
      3,
      null,
      "2026-07-07T00:00:00.000Z",
      "2026-07-07T00:00:00.000Z"
    );

    const result = await recordFeedback({
      memory_id: "mem_feedback",
      usefulness: "used",
      reason: "learning signal must persist without telemetry",
    });
    assert.equal(result.isError, undefined);
    const payload = result.structuredContent as {
      recorded: boolean;
      memory_id: string;
    };
    assert.equal(payload.recorded, true);
    assert.equal(payload.memory_id, "mem_feedback");

    const feedbackEvents = toolDb
      .prepare(
        `SELECT operation_type, memory_id FROM tool_usage_events
         WHERE operation_type = 'feedback'`
      )
      .all() as Array<{ operation_type: string; memory_id: string | null }>;
    assert.equal(feedbackEvents.length, 1);
    assert.equal(feedbackEvents[0].memory_id, "mem_feedback");

    // Non-feedback events must stay gated: a memory_search records nothing.
    const searched = await searchMemory({ query: "anything", limit: 20, offset: 0 });
    assert.equal(searched.isError, undefined);
    const nonFeedbackCount = toolDb
      .prepare(
        `SELECT COUNT(*) as c FROM tool_usage_events
         WHERE operation_type != 'feedback'`
      )
      .get() as { c: number };
    assert.equal(nonFeedbackCount.c, 0);

    // Validation errors must still be real errors even with telemetry off.
    const missing = await recordFeedback({
      memory_id: "mem_does_not_exist",
      usefulness: "used",
    });
    assert.equal(missing.isError, true);
    assert.match(missing.content[0]?.text ?? "", /not found/);
  } finally {
    if (originalTelemetry === undefined) {
      delete process.env.MEMORY_TELEMETRY;
    } else {
      process.env.MEMORY_TELEMETRY = originalTelemetry;
    }
    toolDb.close();
    fs.rmSync(toolDir, { recursive: true, force: true });
  }
});
