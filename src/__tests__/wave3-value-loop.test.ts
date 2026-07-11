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

  const { registerMemoryTools } = await import("../tools/memory.js");
  const { registerReasoningTools } = await import("../tools/reasoning.js");
  const server = new McpServer({ name: "test-server", version: "1.3.0" });
  registerMemoryTools(server, toolDb);
  registerReasoningTools(server, toolDb);

  const tools = (server as unknown as { _registeredTools: RegisteredToolMap })
    ._registeredTools;
  return { toolDb, toolDir, tools };
}

function insertMemory(
  db: DatabaseSync,
  fields: {
    id: string;
    content: string;
    importance?: number;
    type?: string;
    tags?: string;
    metadata?: string | null;
    createdAt?: string;
    updatedAt?: string;
  }
): void {
  db.prepare(
    `INSERT INTO memories (id, type, content, tags, agent_id, importance, metadata, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)`
  ).run(
    fields.id,
    fields.type ?? "fact",
    fields.content,
    fields.tags ?? "[]",
    fields.importance ?? 3,
    fields.metadata ?? null,
    fields.createdAt ?? "2026-07-01T00:00:00.000Z",
    fields.updatedAt ?? "2026-07-01T00:00:00.000Z"
  );
}

test("auto-recall ranks by text relevance before importance", async () => {
  const { toolDb, toolDir, tools } = await makeHarness("wave3-recall-relevance");

  try {
    // Deliberately separated fixture: comparable lengths, clearly different
    // term overlap with the session title, importance inverted vs relevance.
    insertMemory(toolDb, {
      id: "mem_noise",
      content: "payment provider rotation schedule for the operations team",
      importance: 5,
    });
    insertMemory(toolDb, {
      id: "mem_match",
      content: "checkout timeout root cause: payment gateway pool exhaustion",
      importance: 2,
    });

    const started = await tools.reasoning_start_session.handler({
      title: "resolve checkout timeout in payment gateway",
    });
    assert.equal(started.isError, undefined);
    const payload = started.structuredContent as {
      related_memories: Array<{ id: string; importance: number }>;
    };
    assert.equal(payload.related_memories.length, 2);
    assert.equal(payload.related_memories[0].id, "mem_match");
    assert.equal(payload.related_memories[1].id, "mem_noise");
  } finally {
    toolDb.close();
    fs.rmSync(toolDir, { recursive: true, force: true });
  }
});

test("auto-recall breaks equal-relevance ties by importance then recency", async () => {
  const { toolDb, toolDir, tools } = await makeHarness("wave3-recall-ties");

  try {
    // Identical content = identical bm25 rank, so only tie-breaks decide.
    const content = "deploy pipeline rollback procedure for staging";
    insertMemory(toolDb, {
      id: "mem_old_low",
      content,
      importance: 4,
      updatedAt: "2026-07-01T00:00:00.000Z",
    });
    insertMemory(toolDb, {
      id: "mem_top",
      content,
      importance: 5,
      updatedAt: "2026-07-01T00:00:00.000Z",
    });
    insertMemory(toolDb, {
      id: "mem_new_low",
      content,
      importance: 4,
      updatedAt: "2026-07-05T00:00:00.000Z",
    });

    const started = await tools.reasoning_start_session.handler({
      title: "deploy pipeline rollback staging",
    });
    assert.equal(started.isError, undefined);
    const payload = started.structuredContent as {
      related_memories: Array<{ id: string }>;
    };
    assert.deepEqual(
      payload.related_memories.map((row) => row.id),
      ["mem_top", "mem_new_low", "mem_old_low"]
    );
  } finally {
    toolDb.close();
    fs.rmSync(toolDir, { recursive: true, force: true });
  }
});

test("memory_search orders by relevance and keeps type/tag filters working", async () => {
  const { toolDb, toolDir, tools } = await makeHarness("wave3-search-relevance");

  try {
    insertMemory(toolDb, {
      id: "mem_strong",
      content: "sqlite fts5 rank tuning notes covering sqlite fts5 queries",
      importance: 1,
      tags: '["db"]',
    });
    insertMemory(toolDb, {
      id: "mem_weak",
      content: "sqlite upgrade mentioned in roadmap meeting notes",
      importance: 5,
      tags: '["db"]',
    });

    const searched = await tools.memory_search.handler({
      query: "sqlite fts5",
      limit: 20,
      offset: 0,
    });
    assert.equal(searched.isError, undefined);
    const payload = searched.structuredContent as {
      results: Array<{ id: string }>;
    };
    assert.equal(payload.results[0].id, "mem_strong");

    const tagged = await tools.memory_search.handler({
      query: "sqlite",
      tags: ["db"],
      limit: 20,
      offset: 0,
    });
    assert.equal(tagged.isError, undefined);
    const taggedPayload = tagged.structuredContent as {
      results: Array<{ id: string }>;
    };
    assert.equal(taggedPayload.results.length, 2);

    const noTagMatch = await tools.memory_search.handler({
      query: "sqlite",
      tags: ["nope"],
      limit: 20,
      offset: 0,
    });
    assert.equal(noTagMatch.isError, undefined);
    assert.match(noTagMatch.content[0]?.text ?? "", /No memories found/);

    const typed = await tools.memory_search.handler({
      query: "sqlite",
      type: "decision",
      limit: 20,
      offset: 0,
    });
    assert.equal(typed.isError, undefined);
    assert.match(typed.content[0]?.text ?? "", /No memories found/);
  } finally {
    toolDb.close();
    fs.rmSync(toolDir, { recursive: true, force: true });
  }
});

test("auto-recall surfaces provenance for memories persisted from a session", async () => {
  const { toolDb, toolDir, tools } = await makeHarness("wave3-provenance");

  try {
    // Session A reaches a conclusion and persists it as memory.
    const started = await tools.reasoning_start_session.handler({
      title: "diagnose flaky checkout retry logic",
    });
    const sessionA = (started.structuredContent as { session_id: string })
      .session_id;
    await tools.reasoning_add_step.handler({
      session_id: sessionA,
      thought: "Retries were reusing a closed connection",
    });
    const completed = await tools.reasoning_complete_session.handler({
      session_id: sessionA,
      conclusion: "checkout retry logic must reopen the connection before retrying",
      status: "completed",
      save_as_memory: true,
      memory_tags: [],
      used_memory_ids: [],
    });
    assert.equal(completed.isError, undefined);
    const memoryId = (completed.structuredContent as { memory_id: string })
      .memory_id;
    assert.match(memoryId, /^mem_/);

    // A manually saved memory on the same topic has no session provenance.
    insertMemory(toolDb, {
      id: "mem_manual",
      content: "checkout retry budget is three attempts",
    });

    // Session B on a related title recalls both; only A's carries source.
    const startedB = await tools.reasoning_start_session.handler({
      title: "checkout retry connection follow-up",
    });
    assert.equal(startedB.isError, undefined);
    const payload = startedB.structuredContent as {
      related_memories: Array<{
        id: string;
        source?: {
          session_id: string;
          session_title: string;
          created_at: string;
        };
      }>;
    };
    const fromSession = payload.related_memories.find(
      (row) => row.id === memoryId
    );
    assert.ok(fromSession, "persisted conclusion should be recalled");
    assert.ok(fromSession.source, "session-persisted memory must carry source");
    assert.equal(fromSession.source.session_id, sessionA);
    assert.equal(
      fromSession.source.session_title,
      "diagnose flaky checkout retry logic"
    );
    assert.ok(fromSession.source.created_at.length > 0);

    const manual = payload.related_memories.find(
      (row) => row.id === "mem_manual"
    );
    assert.ok(manual, "manual memory should be recalled");
    assert.equal(manual.source, undefined);
  } finally {
    toolDb.close();
    fs.rmSync(toolDir, { recursive: true, force: true });
  }
});

test("corrupt metadata is ignored silently during recall", async () => {
  const { toolDb, toolDir, tools } = await makeHarness("wave3-corrupt-meta");

  try {
    insertMemory(toolDb, {
      id: "mem_corrupt",
      content: "elasticsearch reindex checklist for production",
      metadata: "{definitely-not-json",
      tags: "also-not-json",
    });

    const started = await tools.reasoning_start_session.handler({
      title: "elasticsearch reindex production",
    });
    assert.equal(started.isError, undefined);
    const payload = started.structuredContent as {
      related_memories: Array<{ id: string; tags: string[]; source?: unknown }>;
    };
    assert.equal(payload.related_memories.length, 1);
    assert.equal(payload.related_memories[0].id, "mem_corrupt");
    assert.deepEqual(payload.related_memories[0].tags, []);
    assert.equal(payload.related_memories[0].source, undefined);
  } finally {
    toolDb.close();
    fs.rmSync(toolDir, { recursive: true, force: true });
  }
});

test("empty-store nudge appears only while no memories exist", async () => {
  const { toolDb, toolDir, tools } = await makeHarness("wave3-nudge");

  try {
    const cold = await tools.reasoning_start_session.handler({
      title: "first task ever",
    });
    assert.equal(cold.isError, undefined);
    assert.match(cold.content[0]?.text ?? "", /No memories yet/);

    insertMemory(toolDb, {
      id: "mem_first",
      content: "an unrelated saved conclusion about deployments",
    });

    // Store is non-empty now: no nudge, even when recall finds nothing.
    const warm = await tools.reasoning_start_session.handler({
      title: "zzz quantum entanglement basket weaving",
    });
    assert.equal(warm.isError, undefined);
    const warmPayload = warm.structuredContent as {
      related_memories: unknown[];
    };
    assert.equal(warmPayload.related_memories.length, 0);
    assert.doesNotMatch(warm.content[0]?.text ?? "", /No memories yet/);
  } finally {
    toolDb.close();
    fs.rmSync(toolDir, { recursive: true, force: true });
  }
});

test("used_memory_ids feedback persists when telemetry is disabled", async () => {
  const originalTelemetry = process.env.MEMORY_TELEMETRY;
  process.env.MEMORY_TELEMETRY = "off";

  const { toolDb, toolDir, tools } = await makeHarness("wave3-feedback-off");

  try {
    insertMemory(toolDb, {
      id: "mem_helped",
      content: "connection pool size fix that solved the timeout",
    });

    const started = await tools.reasoning_start_session.handler({
      title: "connection pool timeout follow-up",
    });
    const sessionId = (started.structuredContent as { session_id: string })
      .session_id;

    await tools.reasoning_add_step.handler({
      session_id: sessionId,
      thought: "Applied the remembered pool size fix",
    });

    const completed = await tools.reasoning_complete_session.handler({
      session_id: sessionId,
      conclusion: "Reused the pool size fix",
      status: "completed",
      save_as_memory: false,
      memory_tags: [],
      used_memory_ids: ["mem_helped"],
    });
    assert.equal(completed.isError, undefined);
    const payload = completed.structuredContent as {
      used_memory_feedback_recorded: number;
      warnings: string[];
    };
    assert.equal(payload.used_memory_feedback_recorded, 1);
    assert.deepEqual(payload.warnings, []);

    const events = toolDb
      .prepare(`SELECT operation_type FROM tool_usage_events`)
      .all() as Array<{ operation_type: string }>;
    assert.deepEqual(
      events.map((row) => row.operation_type),
      ["feedback"],
      "only the feedback event may be recorded with telemetry off"
    );

    // Failed feedback attempts are diagnostics, not learning signal: gated.
    const failed = await tools.memory_record_usage_feedback.handler({
      memory_id: "mem_never_existed",
      usefulness: "used",
    });
    assert.equal(failed.isError, true);
    const eventCount = toolDb
      .prepare(`SELECT COUNT(*) as c FROM tool_usage_events`)
      .get() as { c: number };
    assert.equal(eventCount.c, 1, "error feedback event must not be recorded");

    // Reports must self-describe the telemetry gap in their output.
    const report = await tools.memory_usage_report.handler({
      group_by: "tool_name",
      limit: 50,
    });
    assert.equal(report.isError, undefined);
    assert.match(
      (report.structuredContent as { telemetry_note: string }).telemetry_note,
      /MEMORY_TELEMETRY/
    );
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
