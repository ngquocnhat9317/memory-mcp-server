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
  const { registerMemoryTools } = await import("../tools/memory.js");
  const server = new McpServer({ name: "test-server", version: "1.2.0" });
  registerReasoningTools(server, toolDb);
  registerMemoryTools(server, toolDb);

  const tools = (server as unknown as { _registeredTools: RegisteredToolMap })
    ._registeredTools;
  return { toolDb, toolDir, tools };
}

function insertMemory(
  toolDb: DatabaseSync,
  id: string,
  content: string,
  importance = 3
): void {
  toolDb
    .prepare(
      `INSERT INTO memories (id, type, content, tags, agent_id, importance, metadata, created_at, updated_at)
       VALUES (?, 'fact', ?, '[]', NULL, ?, NULL, ?, ?)`
    )
    .run(id, content, importance, new Date().toISOString(), new Date().toISOString());
}

test("reasoning_start_session auto-recalls related memories, warns about open sessions, and abandons stale ones", async () => {
  const { toolDb, toolDir, tools } = await makeHarness("wave1-start");

  try {
    insertMemory(
      toolDb,
      "mem_deploy",
      "Deploy pipeline uses blue-green rollout strategy",
      5
    );

    const now = new Date().toISOString();
    toolDb
      .prepare(
        `INSERT INTO reasoning_sessions (id, title, agent_id, status, conclusion, created_at, updated_at)
         VALUES (?, ?, NULL, 'in_progress', NULL, ?, ?)`
      )
      .run("sess_stale", "old forgotten task", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    toolDb
      .prepare(
        `INSERT INTO reasoning_sessions (id, title, agent_id, status, conclusion, created_at, updated_at)
         VALUES (?, ?, NULL, 'in_progress', NULL, ?, ?)`
      )
      .run("sess_recent", "still active task", now, now);

    const started = await tools.reasoning_start_session.handler({
      title: "Improve deploy pipeline rollout",
    });
    assert.equal(started.isError, undefined);
    const payload = started.structuredContent as {
      session_id: string;
      related_memories: Array<{ id: string; snippet: string; importance: number }>;
      open_sessions_warning?: string;
      open_sessions?: Array<{ id: string }>;
      auto_abandoned_sessions?: number;
    };

    assert.equal(payload.related_memories.length, 1);
    assert.equal(payload.related_memories[0].id, "mem_deploy");
    assert.match(payload.related_memories[0].snippet, /blue-green/);

    assert.equal(payload.auto_abandoned_sessions, 1);
    const stale = toolDb
      .prepare(`SELECT status, conclusion FROM reasoning_sessions WHERE id = 'sess_stale'`)
      .get() as { status: string; conclusion: string | null };
    assert.equal(stale.status, "abandoned");
    assert.equal(stale.conclusion, "auto-abandoned: stale session");

    assert.ok(payload.open_sessions_warning);
    const openIds = (payload.open_sessions ?? []).map((row) => row.id);
    assert.ok(openIds.includes("sess_recent"));
    assert.ok(!openIds.includes("sess_stale"));
    assert.ok(!openIds.includes(payload.session_id));

    const startEvent = toolDb
      .prepare(
        `SELECT output_shape FROM tool_usage_events
         WHERE tool_name = 'reasoning_start_session'
         ORDER BY created_at DESC LIMIT 1`
      )
      .get() as { output_shape: string };
    const outputShape = JSON.parse(startEvent.output_shape) as {
      related_memory_count: number;
      auto_abandoned_sessions: number;
    };
    assert.equal(outputShape.related_memory_count, 1);
    assert.equal(outputShape.auto_abandoned_sessions, 1);
  } finally {
    toolDb.close();
    fs.rmSync(toolDir, { recursive: true, force: true });
  }
});

test("reasoning_start_session returns empty recall for unmatched or punctuation-heavy titles", async () => {
  const { toolDb, toolDir, tools } = await makeHarness("wave1-recall-empty");

  try {
    const started = await tools.reasoning_start_session.handler({
      title: "??? !!! *** (nothing saved yet)",
    });
    assert.equal(started.isError, undefined);
    const payload = started.structuredContent as {
      related_memories: unknown[];
      open_sessions_warning?: string;
    };
    assert.deepEqual(payload.related_memories, []);
    assert.equal(payload.open_sessions_warning, undefined);
  } finally {
    toolDb.close();
    fs.rmSync(toolDir, { recursive: true, force: true });
  }
});

test("reasoning_complete_session records usage feedback for used_memory_ids and reports count it", async () => {
  const { toolDb, toolDir, tools } = await makeHarness("wave1-complete-feedback");

  try {
    insertMemory(toolDb, "mem_helpful", "A memory that helped");

    const started = await tools.reasoning_start_session.handler({
      title: "Task that reuses a memory",
    });
    const sessionId = (started.structuredContent as { session_id: string }).session_id;

    await tools.reasoning_add_step.handler({
      session_id: sessionId,
      thought: "Applied the remembered approach",
    });

    const completed = await tools.reasoning_complete_session.handler({
      session_id: sessionId,
      conclusion: "Done using the remembered approach",
      status: "completed",
      save_as_memory: false,
      memory_tags: [],
      used_memory_ids: ["mem_helpful", "mem_missing", "mem_helpful"],
    });
    assert.equal(completed.isError, undefined);
    const payload = completed.structuredContent as {
      used_memory_feedback_recorded: number;
      warnings: string[];
    };
    assert.equal(payload.used_memory_feedback_recorded, 1);
    assert.ok(
      payload.warnings.some((warning) => warning.includes("mem_missing")),
      "unknown memory id should produce a warning"
    );

    const feedbackEvents = toolDb
      .prepare(
        `SELECT memory_id, session_id, metadata FROM tool_usage_events
         WHERE operation_type = 'feedback' AND status = 'success'`
      )
      .all() as Array<{ memory_id: string; session_id: string; metadata: string }>;
    assert.equal(feedbackEvents.length, 1);
    assert.equal(feedbackEvents[0].memory_id, "mem_helpful");
    assert.equal(feedbackEvents[0].session_id, sessionId);
    const metadata = JSON.parse(feedbackEvents[0].metadata) as {
      usefulness: string;
      source: string;
    };
    assert.equal(metadata.usefulness, "used");
    assert.equal(metadata.source, "reasoning_complete_session");

    const adoption = await tools.memory_adoption_report.handler({
      limit: 20,
    });
    assert.equal(adoption.isError, undefined);
    const funnel = (adoption.structuredContent as {
      funnel: { feedback_used: number };
    }).funnel;
    assert.equal(funnel.feedback_used, 1);
  } finally {
    toolDb.close();
    fs.rmSync(toolDir, { recursive: true, force: true });
  }
});

test("memory_record_usage_feedback accepts a search event that recalled the memory", async () => {
  const { toolDb, toolDir, tools } = await makeHarness("wave1-feedback-search");

  try {
    const saved = await tools.memory_save.handler({
      content: "Rollback procedure documented in runbook",
      type: "fact",
      tags: [],
      importance: 3,
    });
    const memoryId = (saved.structuredContent as { id: string }).id;

    const searched = await tools.memory_search.handler({
      query: "rollback runbook",
      limit: 20,
      offset: 0,
    });
    assert.equal(searched.isError, undefined);

    const searchEvent = toolDb
      .prepare(
        `SELECT id, output_shape FROM tool_usage_events
         WHERE tool_name = 'memory_search'
         ORDER BY created_at DESC LIMIT 1`
      )
      .get() as { id: string; output_shape: string };
    const recalledIds = (JSON.parse(searchEvent.output_shape) as {
      memory_ids: string[];
    }).memory_ids;
    assert.ok(recalledIds.includes(memoryId), "search telemetry should record returned ids");

    const feedback = await tools.memory_record_usage_feedback.handler({
      memory_id: memoryId,
      event_id: searchEvent.id,
      usefulness: "used",
      reason: "applied the runbook",
    });
    assert.equal(feedback.isError, undefined);
    const payload = feedback.structuredContent as {
      recorded: boolean;
      memory_id: string;
    };
    assert.equal(payload.recorded, true);
    assert.equal(payload.memory_id, memoryId);
  } finally {
    toolDb.close();
    fs.rmSync(toolDir, { recursive: true, force: true });
  }
});
