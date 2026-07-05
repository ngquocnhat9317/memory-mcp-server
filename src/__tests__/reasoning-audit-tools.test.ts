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

  const server = new McpServer({ name: "test-server", version: "1.0.0" });
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

  const server = new McpServer({ name: "test-server", version: "1.0.0" });
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

  const server = new McpServer({ name: "test-server", version: "1.0.0" });
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

  const server = new McpServer({ name: "test-server", version: "1.0.0" });
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

  const server = new McpServer({ name: "test-server", version: "1.0.0" });
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

  const server = new McpServer({ name: "test-server", version: "1.0.0" });
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

  const server = new McpServer({ name: "test-server", version: "1.0.0" });
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
