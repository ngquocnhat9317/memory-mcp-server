import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runMigrations } from "../migrations/index.js";
import {
  MemoryUsageReportInputSchema,
} from "../schemas/memory.js";

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

function insertEvent(
  db: DatabaseSync,
  fields: {
    id: string;
    agentId?: string | null;
    toolName: string;
    operationType: string;
    status?: string;
    outputShape?: string | null;
    metadata?: string | null;
    createdAt?: string;
    clientName?: string | null;
  }
): void {
  db.prepare(
    `INSERT INTO tool_usage_events (
      id, created_at, agent_id, client_name, client_version, mcp_version,
      guidance_version, tool_name, operation_type, access_type, status,
      error_code, latency_ms, session_id, step_id, memory_id,
      related_event_id, input_shape, output_shape, metadata
    ) VALUES (?, ?, ?, ?, NULL, '1.3.0', NULL, ?, ?, 'read', ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`
  ).run(
    fields.id,
    fields.createdAt ?? "2026-07-10T12:00:00.000Z",
    fields.agentId ?? null,
    fields.clientName ?? null,
    fields.toolName,
    fields.operationType,
    fields.status ?? "success",
    fields.outputShape ?? null,
    fields.metadata ?? null
  );
}

function insertSession(
  db: DatabaseSync,
  fields: {
    id: string;
    agentId?: string | null;
    status?: string;
    createdAt?: string;
  }
): void {
  db.prepare(
    `INSERT INTO reasoning_sessions (id, title, agent_id, status, conclusion, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?)`
  ).run(
    fields.id,
    `session ${fields.id}`,
    fields.agentId ?? null,
    fields.status ?? "in_progress",
    fields.createdAt ?? "2026-07-10T12:00:00.000Z",
    fields.createdAt ?? "2026-07-10T12:00:00.000Z"
  );
}

test("memory_update covers replace, patch, merge, and error branches", async () => {
  const { toolDb, toolDir, tools } = await makeHarness("cov-update");

  try {
    const saved = await tools.memory_save.handler({
      content: "original content",
      type: "fact",
      tags: ["keep", "drop"],
      importance: 2,
      metadata: { a: 1, b: 2 },
    });
    const id = (saved.structuredContent as { id: string }).id;

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
  } finally {
    toolDb.close();
    fs.rmSync(toolDir, { recursive: true, force: true });
  }
});

test("memory_delete and memory_get cover success and not-found branches", async () => {
  const { toolDb, toolDir, tools } = await makeHarness("cov-delete-get");

  try {
    const saved = await tools.memory_save.handler({
      content: "to be deleted",
      type: "fact",
      importance: 3,
    });
    const id = (saved.structuredContent as { id: string }).id;

    const deleted = await tools.memory_delete.handler({ id });
    assert.equal(deleted.isError, undefined);
    assert.match(deleted.content[0]?.text ?? "", /deleted/);

    const deleteMissing = await tools.memory_delete.handler({ id });
    assert.equal(deleteMissing.isError, true);
    assert.match(deleteMissing.content[0]?.text ?? "", /not found/);

    const getMissing = await tools.memory_get.handler({ id });
    assert.equal(getMissing.isError, true);
    assert.match(getMissing.content[0]?.text ?? "", /not found/);
  } finally {
    toolDb.close();
    fs.rmSync(toolDir, { recursive: true, force: true });
  }
});

test("memory_list covers filters, importance sort, and pagination", async () => {
  const { toolDb, toolDir, tools } = await makeHarness("cov-list");

  try {
    for (let i = 1; i <= 5; i += 1) {
      await tools.memory_save.handler({
        content: `note number ${i}`,
        type: i % 2 === 0 ? "decision" : "fact",
        tags: i <= 3 ? ["alpha"] : ["beta"],
        importance: i,
        agent_id: i <= 2 ? "agent-x" : "agent-y",
      });
    }

    const paged = await tools.memory_list.handler({
      sort_by: "importance",
      limit: 2,
      offset: 0,
    });
    const pagedPayload = paged.structuredContent as {
      total: number;
      has_more: boolean;
      next_offset: number;
      results: Array<{ importance: number }>;
    };
    assert.equal(pagedPayload.total, 5);
    assert.equal(pagedPayload.has_more, true);
    assert.equal(pagedPayload.next_offset, 2);
    assert.equal(pagedPayload.results[0].importance, 5);

    const filtered = await tools.memory_list.handler({
      type: "fact",
      agent_id: "agent-y",
      min_importance: 3,
      tags: ["alpha"],
      sort_by: "created_at",
      limit: 20,
      offset: 0,
    });
    const filteredPayload = filtered.structuredContent as {
      total: number;
      has_more: boolean;
      results: Array<{ content: string }>;
    };
    assert.equal(filteredPayload.total, 1);
    assert.equal(filteredPayload.has_more, false);
    assert.match(filteredPayload.results[0].content, /note number 3/);
  } finally {
    toolDb.close();
    fs.rmSync(toolDir, { recursive: true, force: true });
  }
});

test("memory_search covers agent filter and offset pagination", async () => {
  const { toolDb, toolDir, tools } = await makeHarness("cov-search");

  try {
    await tools.memory_save.handler({
      content: "grafana dashboard tuning",
      type: "fact",
      importance: 3,
      agent_id: "agent-a",
    });
    await tools.memory_save.handler({
      content: "grafana alert rules",
      type: "fact",
      importance: 3,
      agent_id: "agent-b",
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

test("memory_usage_report covers group-bys, filters, errors, and empty stores", async () => {
  const { toolDb, toolDir, tools } = await makeHarness("cov-usage-report");

  try {
    // Generate one real error event (memory_get miss) plus synthetic rows.
    await tools.memory_get.handler({ id: "mem_nope" });
    insertEvent(toolDb, {
      id: "evt_s1",
      agentId: "agent-a",
      toolName: "memory_search",
      operationType: "memory",
      clientName: "client-one",
      createdAt: "2026-07-09T08:00:00.000Z",
    });
    insertEvent(toolDb, {
      id: "evt_s2",
      agentId: null,
      toolName: "memory_save",
      operationType: "memory",
      createdAt: "2026-07-10T09:00:00.000Z",
    });

    const byTool = await tools.memory_usage_report.handler({
      group_by: "tool_name",
      limit: 50,
    });
    const byToolPayload = byTool.structuredContent as {
      summary: { total_events: number; error_events: number };
      groups: Array<{ key: string }>;
      top_errors: Array<{ error_code: string }>;
    };
    assert.ok(byToolPayload.summary.total_events >= 3);
    assert.ok(byToolPayload.summary.error_events >= 1);
    assert.ok(byToolPayload.top_errors.length >= 1);

    for (const groupBy of [
      "agent_id",
      "client_name",
      "mcp_version",
      "operation_type",
      "status",
      "day",
    ]) {
      const grouped = await tools.memory_usage_report.handler({
        group_by: groupBy,
        limit: 50,
      });
      assert.equal(grouped.isError, undefined, `group_by ${groupBy}`);
    }

    // Filters: date-only boundaries, datetime boundaries, client, version.
    const filtered = await tools.memory_usage_report.handler({
      group_by: "tool_name",
      limit: 50,
      agent_id: "agent-a",
      client_name: "client-one",
      mcp_version: "1.3.0",
      date_from: "2026-07-09",
      date_to: "2026-07-11T23:59:59.000Z",
    });
    const filteredPayload = filtered.structuredContent as {
      summary: { total_events: number };
    };
    assert.equal(filteredPayload.summary.total_events, 1);

    // Invalid date must surface as a tool error, not a crash.
    const badDate = await tools.memory_usage_report.handler({
      group_by: "tool_name",
      limit: 50,
      date_from: "definitely-not-a-date",
    });
    assert.equal(badDate.isError, true);
    assert.match(badDate.content[0]?.text ?? "", /Invalid date/);

    // Empty result set: zero-division guards return rate 0.
    const emptyReport = await tools.memory_usage_report.handler({
      group_by: "tool_name",
      limit: 50,
      agent_id: "agent-that-never-was",
    });
    const emptyPayload = emptyReport.structuredContent as {
      summary: { total_events: number; success_rate: number; error_rate: number };
    };
    assert.equal(emptyPayload.summary.total_events, 0);
    assert.equal(emptyPayload.summary.success_rate, 0);
    assert.equal(emptyPayload.summary.error_rate, 0);
  } finally {
    toolDb.close();
    fs.rmSync(toolDir, { recursive: true, force: true });
  }
});

test("memory_adoption_report raises risk flags on degenerate usage", async () => {
  const { toolDb, toolDir, tools } = await makeHarness("cov-adoption");

  try {
    // Two zero-step sessions, one completed with no memory saved.
    insertSession(toolDb, { id: "sess_z1", status: "completed" });
    insertSession(toolDb, { id: "sess_z2", status: "abandoned" });
    insertEvent(toolDb, {
      id: "evt_complete",
      toolName: "reasoning_complete_session",
      operationType: "reasoning",
      outputShape: JSON.stringify({ memory_id_present: 0 }),
    });
    // Searches happened but nothing was ever marked used.
    insertEvent(toolDb, {
      id: "evt_search",
      toolName: "memory_search",
      operationType: "memory",
      outputShape: JSON.stringify({ memory_ids: [] }),
    });

    const report = await tools.memory_adoption_report.handler({ limit: 50 });
    assert.equal(report.isError, undefined);
    const payload = report.structuredContent as {
      funnel: Record<string, number>;
      risk_flags: string[];
      agent_breakdown: unknown[];
      version_breakdown: unknown[];
    };
    assert.ok(payload.risk_flags.includes("high_zero_step_session_rate"));
    assert.ok(payload.risk_flags.includes("low_completion_to_memory_rate"));
    assert.ok(payload.risk_flags.includes("no_positive_feedback_recorded"));
    assert.equal(payload.funnel.reasoning_started, 2);
    assert.equal(payload.funnel.reasoning_abandoned, 1);

    // Agent-filtered variant exercises the filtered WHERE paths.
    const filtered = await tools.memory_adoption_report.handler({
      limit: 50,
      agent_id: "agent-that-never-was",
      date_from: "2026-07-01",
      date_to: "2026-07-31",
    });
    assert.equal(filtered.isError, undefined);
    const filteredPayload = filtered.structuredContent as {
      funnel: Record<string, number>;
    };
    assert.equal(filteredPayload.funnel.reasoning_started, 0);
  } finally {
    toolDb.close();
    fs.rmSync(toolDir, { recursive: true, force: true });
  }
});

test("memory_agent_scorecard classifies dominant behaviors", async () => {
  const { toolDb, toolDir, tools } = await makeHarness("cov-scorecard");

  try {
    // memory-light: sessions but no memory activity at all.
    insertSession(toolDb, { id: "sess_l1", agentId: "light", status: "completed" });

    // search-only: searches but zero used-feedback.
    insertSession(toolDb, { id: "sess_s1", agentId: "searcher", status: "completed" });
    insertEvent(toolDb, {
      id: "evt_so1",
      agentId: "searcher",
      toolName: "memory_search",
      operationType: "memory",
    });
    insertEvent(toolDb, {
      id: "evt_so2",
      agentId: "searcher",
      toolName: "memory_search",
      operationType: "memory",
    });

    // noisy-writer: more saves than completions, nothing reused.
    insertSession(toolDb, { id: "sess_n1", agentId: "noisy", status: "completed" });
    insertEvent(toolDb, {
      id: "evt_nw1",
      agentId: "noisy",
      toolName: "memory_save",
      operationType: "memory",
    });
    insertEvent(toolDb, {
      id: "evt_nw2",
      agentId: "noisy",
      toolName: "memory_save",
      operationType: "memory",
    });

    // error-prone: high error rate dominates every other signal.
    insertSession(toolDb, { id: "sess_e1", agentId: "flaky", status: "completed" });
    insertEvent(toolDb, {
      id: "evt_e1",
      agentId: "flaky",
      toolName: "memory_get",
      operationType: "memory",
      status: "error",
    });
    insertEvent(toolDb, {
      id: "evt_e2",
      agentId: "flaky",
      toolName: "memory_get",
      operationType: "memory",
      status: "error",
    });
    insertEvent(toolDb, {
      id: "evt_e3",
      agentId: "flaky",
      toolName: "memory_search",
      operationType: "memory",
    });

    // unknown agent bucket: events with NULL agent_id.
    insertEvent(toolDb, {
      id: "evt_u1",
      agentId: null,
      toolName: "memory_search",
      operationType: "memory",
    });

    const scorecard = await tools.memory_agent_scorecard.handler({ limit: 20 });
    assert.equal(scorecard.isError, undefined);
    const results = (scorecard.structuredContent as {
      results: Array<{ agent_id: string; dominant_behavior: string; recommendations: string }>;
    }).results;
    const byAgent = Object.fromEntries(
      results.map((row) => [row.agent_id, row.dominant_behavior])
    );
    assert.equal(byAgent.light, "memory-light");
    assert.equal(byAgent.searcher, "search-only");
    assert.equal(byAgent.noisy, "noisy-writer");
    assert.equal(byAgent.flaky, "error-prone");
    assert.ok(byAgent.unknown, "null agent ids roll up into the unknown bucket");
    assert.ok(results.every((row) => row.recommendations.length > 0));

    // Single-agent filter path.
    const only = await tools.memory_agent_scorecard.handler({
      limit: 20,
      agent_id: "noisy",
      date_from: "2026-07-01",
      date_to: "2026-07-31",
    });
    const onlyResults = (only.structuredContent as {
      results: Array<{ agent_id: string }>;
    }).results;
    assert.deepEqual(onlyResults.map((row) => row.agent_id), ["noisy"]);
  } finally {
    toolDb.close();
    fs.rmSync(toolDir, { recursive: true, force: true });
  }
});

test("memory_record_usage_feedback accepts direct memory-id feedback via wrapper", async () => {
  const { toolDb, toolDir, tools } = await makeHarness("cov-feedback-direct");

  try {
    const saved = await tools.memory_save.handler({
      content: "feedback subject",
      type: "fact",
      importance: 3,
    });
    const id = (saved.structuredContent as { id: string }).id;

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
    const big = "x".repeat(30000);
    const saved = await tools.memory_save.handler({
      content: big,
      type: "fact",
      importance: 3,
    });
    assert.equal(saved.isError, undefined);
    assert.match(saved.content[0]?.text ?? "", /truncated/);
  } finally {
    toolDb.close();
    fs.rmSync(toolDir, { recursive: true, force: true });
  }
});

test("constraint violations map to a readable error message", async () => {
  const { toolDb, toolDir, tools } = await makeHarness("cov-constraint");

  try {
    // Direct handler call bypasses zod, so the DB CHECK fires.
    const bad = await tools.memory_save.handler({
      content: "impossible importance",
      type: "fact",
      importance: 42,
    });
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
    const saved = await tools.memory_save.handler({
      content: "survives telemetry outage",
      type: "fact",
      importance: 3,
    });
    assert.equal(saved.isError, undefined);
    assert.match(saved.content[0]?.text ?? "", /Memory saved/);
  } finally {
    toolDb.close();
    fs.rmSync(toolDir, { recursive: true, force: true });
  }
});

test("report date schema accepts date-only and datetime, rejects garbage", () => {
  const dateOnly = MemoryUsageReportInputSchema.parse({
    date_from: "2026-07-01",
  });
  assert.equal(dateOnly.date_from, "2026-07-01");

  const dateTime = MemoryUsageReportInputSchema.parse({
    date_to: "2026-07-01T10:00:00.000Z",
  });
  assert.equal(dateTime.date_to, "2026-07-01T10:00:00.000Z");

  assert.throws(() =>
    MemoryUsageReportInputSchema.parse({ date_from: "not-a-date" })
  );
});

test("reasoning tools cover error branches and lifecycle variants", async () => {
  const { toolDb, toolDir, tools } = await makeHarness("cov-reasoning");

  try {
    // get_trace / outline / milestones on a missing session.
    const missingTrace = await tools.reasoning_get_trace.handler({
      session_id: "sess_missing",
    });
    assert.equal(missingTrace.isError, true);
    const missingOutline = await tools.reasoning_get_session_outline.handler({
      session_id: "sess_missing",
    });
    assert.equal(missingOutline.isError, true);
    // Milestones is a filter, not a lookup: unknown session yields empty.
    const missingMilestones = await tools.reasoning_list_milestones.handler({
      session_id: "sess_missing",
      limit: 20,
      offset: 0,
    });
    assert.equal(missingMilestones.isError, undefined);
    assert.equal(
      (missingMilestones.structuredContent as { total_returned: number })
        .total_returned,
      0
    );

    // mark_step on a missing step.
    const missingMark = await tools.reasoning_mark_step.handler({
      step_id: "step_missing",
      mark_type: "decision",
    });
    assert.equal(missingMark.isError, true);

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

    // list_sessions with status + agent filters and pagination.
    const listed = await tools.reasoning_list_sessions.handler({
      status: "completed",
      agent_id: "agent-cov",
      limit: 10,
      offset: 0,
    });
    assert.equal(listed.isError, undefined);
    const listedPayload = listed.structuredContent as {
      sessions: Array<{ id: string; status: string }>;
    };
    assert.ok(listedPayload.sessions.some((row) => row.id === sessionId));
    assert.ok(
      listedPayload.sessions.every((row) => row.status === "completed")
    );

    // get_trace happy path.
    const trace = await tools.reasoning_get_trace.handler({
      session_id: sessionId,
    });
    assert.equal(trace.isError, undefined);
    const tracePayload = trace.structuredContent as {
      steps: Array<{ step_number: number }>;
    };
    assert.equal(tracePayload.steps.length, 1);

    // mark a real step, then read outline + milestones + search.
    const stepId = (
      toolDb
        .prepare(`SELECT id FROM reasoning_steps WHERE session_id = ?`)
        .get(sessionId) as { id: string }
    ).id;
    await tools.reasoning_mark_step.handler({
      step_id: stepId,
      mark_type: "milestone",
      note: "pivotal",
    });

    const outline = await tools.reasoning_get_session_outline.handler({
      session_id: sessionId,
    });
    assert.equal(outline.isError, undefined);

    const milestones = await tools.reasoning_list_milestones.handler({
      session_id: sessionId,
      limit: 20,
      offset: 0,
    });
    assert.equal(milestones.isError, undefined);
    assert.equal(
      (milestones.structuredContent as { total_returned: number })
        .total_returned,
      1
    );

    const found = await tools.reasoning_search_steps.handler({
      query: "inspect",
      limit: 10,
      offset: 0,
    });
    assert.equal(found.isError, undefined);

    const notFound = await tools.reasoning_search_steps.handler({
      query: "zzzunmatchedtoken",
      limit: 10,
      offset: 0,
    });
    assert.equal(notFound.isError, undefined);
  } finally {
    toolDb.close();
    fs.rmSync(toolDir, { recursive: true, force: true });
  }
});
