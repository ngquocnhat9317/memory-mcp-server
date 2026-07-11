import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runMigrations } from "../migrations/index.js";

function makeTempDbPath(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-mcp-"));
  return path.join(dir, `${name}.db`);
}

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

test("reasoning_step_marks enforces one row per step and mark type", () => {
  const dbPath = makeTempDbPath("marks");
  const tempDir = path.dirname(dbPath);
  const tempDb = new DatabaseSync(dbPath);

  try {
    runMigrations(tempDb);

    const versions = tempDb
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all() as Array<{ version: string }>;

    assert.deepEqual(
      versions.map((row) => row.version),
      [
        "0001_initial",
        "0002_reasoning_step_marks",
        "0003_reasoning_steps_fts",
        "0004_tool_usage_events",
      ]
    );

    tempDb
      .prepare(
        "INSERT INTO reasoning_sessions (id, title, status, created_at, updated_at) VALUES (?, ?, 'in_progress', ?, ?)"
      )
      .run("sess_1", "test", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");

    tempDb
      .prepare(
        "INSERT INTO reasoning_steps (id, session_id, step_number, thought, created_at) VALUES (?, ?, ?, ?, ?)"
      )
      .run("step_1", "sess_1", 1, "first", "2026-01-01T00:00:00.000Z");

    tempDb
      .prepare(
        "INSERT INTO reasoning_step_marks (id, step_id, mark_type, note, created_at) VALUES (?, ?, ?, ?, ?)"
      )
      .run("mark_1", "step_1", "decision", null, "2026-01-01T00:00:00.000Z");

    assert.throws(() => {
      tempDb
        .prepare(
          "INSERT INTO reasoning_step_marks (id, step_id, mark_type, note, created_at) VALUES (?, ?, ?, ?, ?)"
        )
        .run(
          "mark_2",
          "step_1",
          "decision",
          "updated",
          "2026-01-01T00:00:01.000Z"
        );
    });
  } finally {
    tempDb.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Mark Reasoning Step updates the existing mark for the same step and type", async () => {
  const toolDbPath = makeWorkspaceDbPath("reasoning-tools");
  const toolDir = path.dirname(toolDbPath);
  const toolDb = new DatabaseSync(toolDbPath);
  runMigrations(toolDb);

  const { registerReasoningTools } = await import("../tools/reasoning.js");

  const server = new McpServer({ name: "test-server", version: "1.1.5" });
  registerReasoningTools(server, toolDb);

  const registeredTools = (server as unknown as { _registeredTools: RegisteredToolMap })
    ._registeredTools;
  const markStep = registeredTools.reasoning_mark_step?.handler;
  assert.ok(markStep, "reasoning_mark_step should be registered");

  try {
    toolDb.exec(`
      DELETE FROM reasoning_step_marks;
      DELETE FROM reasoning_steps;
      DELETE FROM reasoning_sessions;
    `);

    toolDb.prepare(
      "INSERT INTO reasoning_sessions (id, title, status, created_at, updated_at) VALUES (?, ?, 'in_progress', ?, ?)"
    ).run("sess_tool", "tool test", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");

    toolDb.prepare(
      "INSERT INTO reasoning_steps (id, session_id, step_number, thought, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run("step_tool", "sess_tool", 1, "first", "2026-01-01T00:00:00.000Z");

    const first = await markStep({
      step_id: "step_tool",
      mark_type: "decision",
      note: "first note",
    });
    assert.equal(first.isError, undefined);
    assert.deepEqual(first.structuredContent, {
      step_id: "step_tool",
      mark_type: "decision",
      note: "first note",
    });

    const inserted = toolDb
      .prepare(
        "SELECT id, step_id, mark_type, note, created_at FROM reasoning_step_marks WHERE step_id = ? AND mark_type = ?"
      )
      .get("step_tool", "decision") as {
      id: string;
      step_id: string;
      mark_type: string;
      note: string | null;
      created_at: string;
    };

    const second = await markStep({
      step_id: "step_tool",
      mark_type: "decision",
      note: "updated note",
    });
    assert.equal(second.isError, undefined);
    assert.deepEqual(second.structuredContent, {
      step_id: "step_tool",
      mark_type: "decision",
      note: "updated note",
    });

    const rows = toolDb
      .prepare(
        "SELECT id, step_id, mark_type, note, created_at FROM reasoning_step_marks WHERE step_id = ? AND mark_type = ?"
      )
      .all("step_tool", "decision") as Array<{
      id: string;
      step_id: string;
      mark_type: string;
      note: string | null;
      created_at: string;
    }>;

    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, inserted.id);
    assert.equal(rows[0].note, "updated note");
    assert.equal(rows[0].created_at, inserted.created_at);
  } finally {
    toolDb.close();
    fs.rmSync(toolDir, { recursive: true, force: true });
  }
});

test("Mark Reasoning Step keeps the existing note when a repeated write omits note", async () => {
  const toolDbPath = makeWorkspaceDbPath("reasoning-tools-omit-note");
  const toolDir = path.dirname(toolDbPath);
  const toolDb = new DatabaseSync(toolDbPath);
  runMigrations(toolDb);

  const { registerReasoningTools } = await import("../tools/reasoning.js");

  const server = new McpServer({ name: "test-server", version: "1.1.5" });
  registerReasoningTools(server, toolDb);

  const registeredTools = (server as unknown as { _registeredTools: RegisteredToolMap })
    ._registeredTools;
  const markStep = registeredTools.reasoning_mark_step?.handler;
  assert.ok(markStep, "reasoning_mark_step should be registered");

  try {
    toolDb.exec(`
      DELETE FROM reasoning_step_marks;
      DELETE FROM reasoning_steps;
      DELETE FROM reasoning_sessions;
    `);

    toolDb.prepare(
      "INSERT INTO reasoning_sessions (id, title, status, created_at, updated_at) VALUES (?, ?, 'in_progress', ?, ?)"
    ).run("sess_keep", "tool test", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");

    toolDb.prepare(
      "INSERT INTO reasoning_steps (id, session_id, step_number, thought, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run("step_keep", "sess_keep", 1, "first", "2026-01-01T00:00:00.000Z");

    const first = await markStep({
      step_id: "step_keep",
      mark_type: "decision",
      note: "keep me",
    });
    assert.equal(first.isError, undefined);

    const second = await markStep({
      step_id: "step_keep",
      mark_type: "decision",
    });
    assert.equal(second.isError, undefined);
    assert.deepEqual(second.structuredContent, {
      step_id: "step_keep",
      mark_type: "decision",
      note: "keep me",
    });

    const row = toolDb
      .prepare(
        "SELECT id, step_id, mark_type, note, created_at FROM reasoning_step_marks WHERE step_id = ? AND mark_type = ?"
      )
      .get("step_keep", "decision") as {
      id: string;
      step_id: string;
      mark_type: string;
      note: string | null;
      created_at: string;
    };

    assert.equal(row.note, "keep me");
  } finally {
    toolDb.close();
    fs.rmSync(toolDir, { recursive: true, force: true });
  }
});

test("Search Reasoning Steps prefers snippet text from the field matching the query", async () => {
  const toolDbPath = makeWorkspaceDbPath("reasoning-search-tools");
  const toolDir = path.dirname(toolDbPath);
  const toolDb = new DatabaseSync(toolDbPath);
  runMigrations(toolDb);

  const { registerReasoningTools } = await import("../tools/reasoning.js");

  const server = new McpServer({ name: "test-server", version: "1.1.5" });
  registerReasoningTools(server, toolDb);

  const registeredTools = (server as unknown as { _registeredTools: RegisteredToolMap })
    ._registeredTools;
  const searchSteps = registeredTools.reasoning_search_steps?.handler;
  assert.ok(searchSteps, "reasoning_search_steps should be registered");

  try {
    toolDb.exec(`
      DELETE FROM reasoning_step_marks;
      DELETE FROM reasoning_steps;
      DELETE FROM reasoning_sessions;
    `);

    toolDb.prepare(
      "INSERT INTO reasoning_sessions (id, title, agent_id, status, created_at, updated_at) VALUES (?, ?, ?, 'in_progress', ?, ?)"
    ).run(
      "sess_search",
      "tool test",
      "agent-search",
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z"
    );

    toolDb.prepare(
      "INSERT INTO reasoning_steps (id, session_id, step_number, thought, action, observation, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(
      "step_search",
      "sess_search",
      1,
      "background note",
      "inspect trace",
      null,
      "2026-01-01T00:00:00.000Z"
    );

    toolDb.prepare(
      "INSERT INTO reasoning_step_marks (id, step_id, mark_type, note, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run(
      "mark_search",
      "step_search",
      "decision",
      "important choice",
      "2026-01-01T00:00:01.000Z"
    );

    const result = await searchSteps({
      query: "inspect",
      agent_id: "agent-search",
      mark_type: "decision",
      limit: 10,
      offset: 0,
    });

    assert.equal(result.isError, undefined);
    assert.deepEqual(result.structuredContent, {
      results: [
        {
          id: "step_search",
          session_id: "sess_search",
          step_number: 1,
          snippet: "inspect trace",
          thought: "background note",
          action: "inspect trace",
          observation: null,
          created_at: "2026-01-01T00:00:00.000Z",
          agent_id: "agent-search",
        },
      ],
    });
  } finally {
    toolDb.close();
    fs.rmSync(toolDir, { recursive: true, force: true });
  }
});

test("List Reasoning Sessions reports grouped step counts", async () => {
  const toolDbPath = makeWorkspaceDbPath("reasoning-list-sessions");
  const toolDir = path.dirname(toolDbPath);
  const toolDb = new DatabaseSync(toolDbPath);
  runMigrations(toolDb);

  const { registerReasoningTools } = await import("../tools/reasoning.js");

  const server = new McpServer({ name: "test-server", version: "1.1.5" });
  registerReasoningTools(server, toolDb);

  const registeredTools = (server as unknown as { _registeredTools: RegisteredToolMap })
    ._registeredTools;
  const listSessions = registeredTools.reasoning_list_sessions?.handler;
  assert.ok(listSessions, "reasoning_list_sessions should be registered");

  try {
    toolDb.exec(`
      DELETE FROM reasoning_step_marks;
      DELETE FROM reasoning_steps;
      DELETE FROM reasoning_sessions;
    `);

    toolDb.prepare(
      "INSERT INTO reasoning_sessions (id, title, agent_id, status, created_at, updated_at) VALUES (?, ?, ?, 'in_progress', ?, ?)"
    ).run(
      "sess_counts",
      "count test",
      "agent-counts",
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z"
    );

    toolDb.prepare(
      "INSERT INTO reasoning_steps (id, session_id, step_number, thought, action, observation, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(
      "step_count_1",
      "sess_counts",
      1,
      "first",
      null,
      null,
      "2026-01-01T00:00:00.000Z"
    );
    toolDb.prepare(
      "INSERT INTO reasoning_steps (id, session_id, step_number, thought, action, observation, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(
      "step_count_2",
      "sess_counts",
      2,
      "second",
      null,
      null,
      "2026-01-01T00:00:01.000Z"
    );

    const result = await listSessions({
      agent_id: "agent-counts",
      limit: 10,
      offset: 0,
    });

    assert.equal(result.isError, undefined);
    assert.deepEqual(result.structuredContent, {
      total: 1,
      total_returned: 1,
      offset: 0,
      has_more: false,
      sessions: [
        {
          id: "sess_counts",
          title: "count test",
          agent_id: "agent-counts",
          status: "in_progress",
          conclusion: null,
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
          step_count: 2,
        },
      ],
    });
  } finally {
    toolDb.close();
    fs.rmSync(toolDir, { recursive: true, force: true });
  }
});

test("List Reasoning Milestones returns marked steps in deterministic order", async () => {
  const toolDbPath = makeWorkspaceDbPath("reasoning-list-milestones");
  const toolDir = path.dirname(toolDbPath);
  const toolDb = new DatabaseSync(toolDbPath);
  runMigrations(toolDb);

  const { registerReasoningTools } = await import("../tools/reasoning.js");

  const server = new McpServer({ name: "test-server", version: "1.1.5" });
  registerReasoningTools(server, toolDb);

  const registeredTools = (server as unknown as { _registeredTools: RegisteredToolMap })
    ._registeredTools;
  const listMilestones = registeredTools.reasoning_list_milestones?.handler;
  assert.ok(listMilestones, "reasoning_list_milestones should be registered");

  try {
    toolDb.exec(`
      DELETE FROM reasoning_step_marks;
      DELETE FROM reasoning_steps;
      DELETE FROM reasoning_sessions;
    `);

    toolDb.prepare(
      "INSERT INTO reasoning_sessions (id, title, agent_id, status, created_at, updated_at) VALUES (?, ?, ?, 'in_progress', ?, ?)"
    ).run(
      "sess_milestones",
      "milestone test",
      "agent-milestones",
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z"
    );

    toolDb.prepare(
      "INSERT INTO reasoning_steps (id, session_id, step_number, thought, action, observation, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(
      "step_m2",
      "sess_milestones",
      2,
      "middle context",
      "middle action",
      null,
      "2026-01-01T00:00:02.000Z"
    );
    toolDb.prepare(
      "INSERT INTO reasoning_steps (id, session_id, step_number, thought, action, observation, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(
      "step_m1",
      "sess_milestones",
      1,
      "first context",
      "first action",
      null,
      "2026-01-01T00:00:01.000Z"
    );

    toolDb.prepare(
      "INSERT INTO reasoning_step_marks (id, step_id, mark_type, note, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run(
      "mark_m2",
      "step_m2",
      "milestone",
      "second milestone",
      "2026-01-01T00:00:02.000Z"
    );
    toolDb.prepare(
      "INSERT INTO reasoning_step_marks (id, step_id, mark_type, note, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run(
      "mark_m1",
      "step_m1",
      "milestone",
      "first milestone",
      "2026-01-01T00:00:01.000Z"
    );

    const result = await listMilestones({
      agent_id: "agent-milestones",
      mark_type: "milestone",
      limit: 10,
      offset: 0,
    });

    assert.equal(result.isError, undefined);
    assert.deepEqual(result.structuredContent, {
      total: 2,
      total_returned: 2,
      offset: 0,
      has_more: false,
      results: [
        {
          session_id: "sess_milestones",
          step_id: "step_m1",
          step_number: 1,
          mark_type: "milestone",
          note: "first milestone",
          created_at: "2026-01-01T00:00:01.000Z",
          snippet: "first context",
        },
        {
          session_id: "sess_milestones",
          step_id: "step_m2",
          step_number: 2,
          mark_type: "milestone",
          note: "second milestone",
          created_at: "2026-01-01T00:00:02.000Z",
          snippet: "middle context",
        },
      ],
    });
  } finally {
    toolDb.close();
    fs.rmSync(toolDir, { recursive: true, force: true });
  }
});

test("reasoning_get_session_outline falls back to first middle last deterministically", async () => {
  const toolDbPath = makeWorkspaceDbPath("reasoning-session-outline-fallback");
  const toolDir = path.dirname(toolDbPath);
  const toolDb = new DatabaseSync(toolDbPath);
  runMigrations(toolDb);

  const { registerReasoningTools } = await import("../tools/reasoning.js");

  const server = new McpServer({ name: "test-server", version: "1.1.5" });
  registerReasoningTools(server, toolDb);

  const registeredTools = (server as unknown as { _registeredTools: RegisteredToolMap })
    ._registeredTools;
  const getSessionOutline = registeredTools.reasoning_get_session_outline?.handler;
  assert.ok(getSessionOutline, "reasoning_get_session_outline should be registered");

  try {
    toolDb.exec(`
      DELETE FROM reasoning_step_marks;
      DELETE FROM reasoning_steps;
      DELETE FROM reasoning_sessions;
    `);

    toolDb.prepare(
      "INSERT INTO reasoning_sessions (id, title, agent_id, status, conclusion, created_at, updated_at) VALUES (?, ?, ?, 'completed', ?, ?, ?)"
    ).run(
      "sess_outline_fallback",
      "outline fallback test",
      "agent-outline",
      "done",
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:03.000Z"
    );

    [
      ["step_o1", 1, "first", "2026-01-01T00:00:00.000Z"],
      ["step_o2", 2, "second", "2026-01-01T00:00:01.000Z"],
      ["step_o3", 3, "third", "2026-01-01T00:00:02.000Z"],
      ["step_o4", 4, "fourth", "2026-01-01T00:00:03.000Z"],
    ].forEach(([id, stepNumber, thought, createdAt]) => {
      toolDb.prepare(
        "INSERT INTO reasoning_steps (id, session_id, step_number, thought, action, observation, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run(
        id,
        "sess_outline_fallback",
        stepNumber,
        thought,
        null,
        null,
        createdAt
      );
    });

    const result = await getSessionOutline({
      session_id: "sess_outline_fallback",
    });

    assert.equal(result.isError, undefined);
    assert.deepEqual(result.structuredContent, {
      session: {
        id: "sess_outline_fallback",
        title: "outline fallback test",
        agent_id: "agent-outline",
        status: "completed",
        conclusion: "done",
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:03.000Z",
        step_count: 4,
      },
      used_fallback: true,
      steps: [
        {
          id: "step_o1",
          session_id: "sess_outline_fallback",
          step_number: 1,
          thought: "first",
          action: null,
          observation: null,
          created_at: "2026-01-01T00:00:00.000Z",
          mark_type: null,
          note: null,
        },
        {
          id: "step_o2",
          session_id: "sess_outline_fallback",
          step_number: 2,
          thought: "second",
          action: null,
          observation: null,
          created_at: "2026-01-01T00:00:01.000Z",
          mark_type: null,
          note: null,
        },
        {
          id: "step_o4",
          session_id: "sess_outline_fallback",
          step_number: 4,
          thought: "fourth",
          action: null,
          observation: null,
          created_at: "2026-01-01T00:00:03.000Z",
          mark_type: null,
          note: null,
        },
      ],
    });
  } finally {
    toolDb.close();
    fs.rmSync(toolDir, { recursive: true, force: true });
  }
});

test("reasoning_get_session_outline prefers marked steps ordered by mark time then step number", async () => {
  const toolDbPath = makeWorkspaceDbPath("reasoning-session-outline-marked");
  const toolDir = path.dirname(toolDbPath);
  const toolDb = new DatabaseSync(toolDbPath);
  runMigrations(toolDb);

  const { registerReasoningTools } = await import("../tools/reasoning.js");

  const server = new McpServer({ name: "test-server", version: "1.1.5" });
  registerReasoningTools(server, toolDb);

  const registeredTools = (server as unknown as { _registeredTools: RegisteredToolMap })
    ._registeredTools;
  const getSessionOutline = registeredTools.reasoning_get_session_outline?.handler;
  assert.ok(getSessionOutline, "reasoning_get_session_outline should be registered");

  try {
    toolDb.exec(`
      DELETE FROM reasoning_step_marks;
      DELETE FROM reasoning_steps;
      DELETE FROM reasoning_sessions;
    `);

    toolDb.prepare(
      "INSERT INTO reasoning_sessions (id, title, agent_id, status, conclusion, created_at, updated_at) VALUES (?, ?, ?, 'completed', ?, ?, ?)"
    ).run(
      "sess_outline_marked",
      "outline marked test",
      "agent-outline",
      "wrapped",
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:03.000Z"
    );

    toolDb.prepare(
      "INSERT INTO reasoning_steps (id, session_id, step_number, thought, action, observation, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(
      "step_mark_2",
      "sess_outline_marked",
      2,
      "marked second",
      null,
      null,
      "2026-01-01T00:00:02.000Z"
    );
    toolDb.prepare(
      "INSERT INTO reasoning_steps (id, session_id, step_number, thought, action, observation, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(
      "step_mark_1",
      "sess_outline_marked",
      1,
      "marked first",
      null,
      null,
      "2026-01-01T00:00:01.000Z"
    );

    toolDb.prepare(
      "INSERT INTO reasoning_step_marks (id, step_id, mark_type, note, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run(
      "mark_outline_1",
      "step_mark_1",
      "milestone",
      "first mark",
      "2026-01-01T00:00:01.000Z"
    );
    toolDb.prepare(
      "INSERT INTO reasoning_step_marks (id, step_id, mark_type, note, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run(
      "mark_outline_2",
      "step_mark_2",
      "decision",
      "second mark",
      "2026-01-01T00:00:02.000Z"
    );

    const result = await getSessionOutline({
      session_id: "sess_outline_marked",
    });

    assert.equal(result.isError, undefined);
    assert.deepEqual(result.structuredContent, {
      session: {
        id: "sess_outline_marked",
        title: "outline marked test",
        agent_id: "agent-outline",
        status: "completed",
        conclusion: "wrapped",
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:03.000Z",
        step_count: 2,
      },
      used_fallback: false,
      steps: [
        {
          id: "step_mark_1",
          session_id: "sess_outline_marked",
          step_number: 1,
          thought: "marked first",
          action: null,
          observation: null,
          created_at: "2026-01-01T00:00:01.000Z",
          mark_type: "milestone",
          note: "first mark",
        },
        {
          id: "step_mark_2",
          session_id: "sess_outline_marked",
          step_number: 2,
          thought: "marked second",
          action: null,
          observation: null,
          created_at: "2026-01-01T00:00:02.000Z",
          mark_type: "decision",
          note: "second mark",
        },
      ],
    });
  } finally {
    toolDb.close();
    fs.rmSync(toolDir, { recursive: true, force: true });
  }
});

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
      DELETE FROM reasoning_step_marks;
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
      DELETE FROM reasoning_step_marks;
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
      DELETE FROM reasoning_step_marks;
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
      DELETE FROM reasoning_step_marks;
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
    assert.deepEqual(result.structuredContent, {
      guide_version: "2026-07-11.v1",
      mcp_version: "1.2.5",
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
    assert.equal(event.guidance_version, "2026-07-11.v1");
    assert.equal(event.agent_id, "agent-guide");
    assert.equal(event.client_name, "codex");
  } finally {
    toolDb.close();
    fs.rmSync(toolDir, { recursive: true, force: true });
  }
});

test("usage and adoption reports reflect telemetry from memory and reasoning tools", async () => {
  const toolDbPath = makeWorkspaceDbPath("memory-telemetry-reports");
  const toolDir = path.dirname(toolDbPath);
  const toolDb = new DatabaseSync(toolDbPath);
  runMigrations(toolDb);

  const { registerMemoryTools } = await import("../tools/memory.js");
  const { registerReasoningTools } = await import("../tools/reasoning.js");

  const server = new McpServer({ name: "test-server", version: "1.1.5" });
  registerMemoryTools(server, toolDb);
  registerReasoningTools(server, toolDb);

  const registeredTools = (server as unknown as { _registeredTools: RegisteredToolMap })
    ._registeredTools;
  const startSession = registeredTools.reasoning_start_session?.handler;
  const addStep = registeredTools.reasoning_add_step?.handler;
  const completeSession = registeredTools.reasoning_complete_session?.handler;
  const searchMemory = registeredTools.memory_search?.handler;
  const getMemory = registeredTools.memory_get?.handler;
  const recordFeedback = registeredTools.memory_record_usage_feedback?.handler;
  const usageReport = registeredTools.memory_usage_report?.handler;
  const adoptionReport = registeredTools.memory_adoption_report?.handler;
  assert.ok(startSession, "reasoning_start_session should be registered");
  assert.ok(addStep, "reasoning_add_step should be registered");
  assert.ok(completeSession, "reasoning_complete_session should be registered");
  assert.ok(searchMemory, "memory_search should be registered");
  assert.ok(getMemory, "memory_get should be registered");
  assert.ok(recordFeedback, "memory_record_usage_feedback should be registered");
  assert.ok(usageReport, "memory_usage_report should be registered");
  assert.ok(adoptionReport, "memory_adoption_report should be registered");

  try {
    toolDb.exec(`
      DELETE FROM tool_usage_events;
      DELETE FROM reasoning_step_marks;
      DELETE FROM reasoning_steps;
      DELETE FROM reasoning_sessions;
      DELETE FROM memories;
    `);

    const started = await startSession({
      title: "report flow",
      agent_id: "agent-report",
    });
    assert.equal(started.isError, undefined);
    const sessionId = (started.structuredContent as { session_id: string }).session_id;

    const step = await addStep({
      session_id: sessionId,
      thought: "durable conclusion",
    });
    assert.equal(step.isError, undefined);

    const completed = await completeSession({
      session_id: sessionId,
      conclusion: "durable conclusion",
      status: "completed",
      save_as_memory: true,
      memory_tags: ["report"],
    });
    assert.equal(completed.isError, undefined);
    const completionPayload = completed.structuredContent as {
      memory_id: string | null;
    };
    assert.ok(completionPayload.memory_id);

    const searched = await searchMemory({
      query: "durable",
      agent_id: "agent-report",
      limit: 10,
      offset: 0,
    });
    assert.equal(searched.isError, undefined);

    const fetched = await getMemory({
      id: completionPayload.memory_id as string,
    });
    assert.equal(fetched.isError, undefined);
    const feedbackEventId = (
      toolDb
        .prepare(
          `SELECT id
           FROM tool_usage_events
           WHERE tool_name = 'memory_get'
             AND memory_id = ?
           ORDER BY created_at DESC
           LIMIT 1`
        )
        .get(completionPayload.memory_id as string) as { id: string }
    ).id;

    const feedback = await recordFeedback({
      memory_id: completionPayload.memory_id as string,
      event_id: feedbackEventId,
      agent_id: "agent-report",
      usefulness: "used",
      reason: "helpful",
    });
    assert.equal(feedback.isError, undefined);

    const usage = await usageReport({
      agent_id: "agent-report",
      group_by: "tool_name",
      limit: 20,
    });
    assert.equal(usage.isError, undefined);
    const usagePayload = usage.structuredContent as {
      summary: { total_events: number };
      groups: Array<{ key: string; event_count: number }>;
    };
    assert.equal(usagePayload.summary.total_events, 5);
    assert.deepEqual(
      usagePayload.groups.map((row) => row.key),
      [
        "memory_record_usage_feedback",
        "memory_search",
        "reasoning_add_step",
        "reasoning_complete_session",
        "reasoning_start_session",
      ]
    );

    const adoption = await adoptionReport({
      agent_id: "agent-report",
      limit: 20,
    });
    assert.equal(adoption.isError, undefined);
    const adoptionPayload = adoption.structuredContent as {
      funnel: {
        reasoning_started: number;
        reasoning_completed: number;
        reasoning_abandoned: number;
        zero_step_sessions: number;
        completed_with_memory: number;
        completed_without_memory: number;
        skip_reason_count: Array<{ reason: string; count: number }>;
        memory_saved: number;
        memory_searched: number;
        memory_recalled: number;
        memory_updated: number;
        feedback_used: number;
      };
      risk_flags: string[];
    };

    assert.deepEqual(adoptionPayload.funnel, {
      reasoning_started: 1,
      reasoning_completed: 1,
      reasoning_abandoned: 0,
      zero_step_sessions: 0,
      completed_with_memory: 1,
      completed_without_memory: 0,
      skip_reason_count: [],
      memory_saved: 1,
      memory_searched: 1,
      memory_recalled: 1,
      memory_updated: 0,
      feedback_used: 1,
    });
    assert.deepEqual(adoptionPayload.risk_flags, []);
  } finally {
    toolDb.close();
    fs.rmSync(toolDir, { recursive: true, force: true });
  }
});

test("memory_usage_report treats date_to as end-of-day for YYYY-MM-DD filters", async () => {
  const toolDbPath = makeWorkspaceDbPath("memory-usage-date-filter");
  const toolDir = path.dirname(toolDbPath);
  const toolDb = new DatabaseSync(toolDbPath);
  runMigrations(toolDb);

  const { registerMemoryTools } = await import("../tools/memory.js");

  const server = new McpServer({ name: "test-server", version: "1.1.5" });
  registerMemoryTools(server, toolDb);

  const registeredTools = (server as unknown as { _registeredTools: RegisteredToolMap })
    ._registeredTools;
  const usageReport = registeredTools.memory_usage_report?.handler;
  assert.ok(usageReport, "memory_usage_report should be registered");

  try {
    toolDb.exec("DELETE FROM tool_usage_events");
    toolDb.prepare(
      `INSERT INTO tool_usage_events (
         id, created_at, agent_id, client_name, client_version, mcp_version,
         guidance_version, tool_name, operation_type, access_type, status,
         error_code, latency_ms, session_id, step_id, memory_id, related_event_id,
         input_shape, output_shape, metadata
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "evt_usage_same_day",
      "2026-07-07T12:34:56.000Z",
      "agent-a",
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
      null,
      JSON.stringify({ result_count: 1 }),
      null
    );

    const result = await usageReport({
      date_to: "2026-07-07",
      group_by: "tool_name",
      limit: 10,
    });
    assert.equal(result.isError, undefined);
    assert.equal(
      (result.structuredContent as { summary: { total_events: number } }).summary
        .total_events,
      1
    );
  } finally {
    toolDb.close();
    fs.rmSync(toolDir, { recursive: true, force: true });
  }
});

test("memory_agent_scorecard keeps unknown-agent rows scoped to NULL agents and ignores report-only telemetry", async () => {
  const toolDbPath = makeWorkspaceDbPath("memory-agent-scorecard");
  const toolDir = path.dirname(toolDbPath);
  const toolDb = new DatabaseSync(toolDbPath);
  runMigrations(toolDb);

  const { registerMemoryTools } = await import("../tools/memory.js");

  const server = new McpServer({ name: "test-server", version: "1.1.5" });
  registerMemoryTools(server, toolDb);

  const registeredTools = (server as unknown as { _registeredTools: RegisteredToolMap })
    ._registeredTools;
  const scorecard = registeredTools.memory_agent_scorecard?.handler;
  assert.ok(scorecard, "memory_agent_scorecard should be registered");

  try {
    toolDb.exec(`
      DELETE FROM tool_usage_events;
      DELETE FROM reasoning_steps;
      DELETE FROM reasoning_sessions;
    `);

    toolDb.prepare(
      "INSERT INTO reasoning_sessions (id, title, agent_id, status, created_at, updated_at) VALUES (?, ?, ?, 'completed', ?, ?)"
    ).run("sess_unknown", "unknown", null, "2026-07-07T00:00:00.000Z", "2026-07-07T00:00:00.000Z");
    toolDb.prepare(
      "INSERT INTO reasoning_sessions (id, title, agent_id, status, created_at, updated_at) VALUES (?, ?, ?, 'completed', ?, ?)"
    ).run("sess_named", "named", "agent-named", "2026-07-07T00:00:00.000Z", "2026-07-07T00:00:00.000Z");

    toolDb.prepare(
      `INSERT INTO tool_usage_events (
         id, created_at, agent_id, client_name, client_version, mcp_version,
         guidance_version, tool_name, operation_type, access_type, status,
         error_code, latency_ms, session_id, step_id, memory_id, related_event_id,
         input_shape, output_shape, metadata
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "evt_unknown_start",
      "2026-07-07T00:00:01.000Z",
      null,
      null,
      null,
      "1.1.5",
      null,
      "reasoning_start_session",
      "reasoning",
      "write",
      "success",
      null,
      5,
      "sess_unknown",
      null,
      null,
      null,
      null,
      JSON.stringify({ session_id: "sess_unknown" }),
      null
    );
    toolDb.prepare(
      `INSERT INTO tool_usage_events (
         id, created_at, agent_id, client_name, client_version, mcp_version,
         guidance_version, tool_name, operation_type, access_type, status,
         error_code, latency_ms, session_id, step_id, memory_id, related_event_id,
         input_shape, output_shape, metadata
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "evt_named_report_only",
      "2026-07-07T00:00:02.000Z",
      "agent-report-only",
      null,
      null,
      "1.1.5",
      null,
      "memory_usage_report",
      "report",
      "derived",
      "success",
      null,
      5,
      null,
      null,
      null,
      null,
      null,
      JSON.stringify({ row_count: 1 }),
      null
    );

    const result = await scorecard({ limit: 10 });
    assert.equal(result.isError, undefined);

    const rows = (result.structuredContent as {
      results: Array<{ agent_id: string; sessions_started: number }>;
    }).results;

    assert.equal(rows.some((row) => row.agent_id === "agent-report-only"), false);
    const unknownRow = rows.find((row) => row.agent_id === "unknown");
    assert.ok(unknownRow);
    assert.equal(unknownRow.sessions_started, 1);
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

test("memory_record_usage_feedback fails clearly when telemetry persistence is disabled", async () => {
  const originalTelemetry = process.env.MEMORY_TELEMETRY;
  process.env.MEMORY_TELEMETRY = "off";

  const toolDbPath = makeWorkspaceDbPath("memory-feedback-telemetry-off");
  const toolDir = path.dirname(toolDbPath);
  const toolDb = new DatabaseSync(toolDbPath);
  runMigrations(toolDb);

  try {
    const { registerMemoryTools } = await import(`../tools/memory.js?telemetry-off=${Date.now()}`);

    const server = new McpServer({ name: "test-server", version: "1.1.5" });
    registerMemoryTools(server, toolDb);

    const registeredTools = (server as unknown as { _registeredTools: RegisteredToolMap })
      ._registeredTools;
    const recordFeedback = registeredTools.memory_record_usage_feedback?.handler;
    assert.ok(recordFeedback, "memory_record_usage_feedback should be registered");

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
      reason: "should fail without persistence",
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0]?.text ?? "", /telemetry.*disabled/i);
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
