import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getWorkspace, normalizeWorkspace } from "../constants.js";
import { runMigrations } from "../migrations/index.js";
import { migration0001Initial } from "../migrations/0001_initial.js";
import { migration0002ReasoningStepMarks } from "../migrations/0002_reasoning_step_marks.js";
import { migration0003ReasoningStepsFts } from "../migrations/0003_reasoning_steps_fts.js";
import { migration0004ToolUsageEvents } from "../migrations/0004_tool_usage_events.js";
import { migration0005MemoryWorkspace } from "../migrations/0005_memory_workspace.js";
import { toRecallTerms } from "../utils.js";
import { saveConclusion } from "./fixtures/memory-seed.js";

function makeWorkspaceDbPath(name: string): string {
  const dir = fs.mkdtempSync(path.join(process.cwd(), ".tmp-memory-mcp-"));
  return path.join(dir, `${name}.db`);
}

type ToolResult = {
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
};
type RegisteredToolMap = Record<
  string,
  { handler: (params: Record<string, unknown>) => Promise<ToolResult> }
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
  const server = new McpServer({ name: "test-server", version: "1.3.3" });
  registerMemoryTools(server, toolDb);
  registerReasoningTools(server, toolDb);

  const tools = (server as unknown as { _registeredTools: RegisteredToolMap })
    ._registeredTools;
  return { toolDb, toolDir, tools };
}

function cleanup(toolDb: DatabaseSync, toolDir: string): void {
  toolDb.close();
  fs.rmSync(toolDir, { recursive: true, force: true });
}

function insertMemory(
  db: DatabaseSync,
  fields: {
    id: string;
    content: string;
    type?: string;
    workspace?: string | null;
    importance?: number;
    updatedAt?: string;
  }
): void {
  db.prepare(
    `INSERT INTO memories (id, type, content, tags, agent_id, importance, metadata, workspace, created_at, updated_at)
     VALUES (?, ?, ?, '[]', NULL, ?, NULL, ?, ?, ?)`
  ).run(
    fields.id,
    fields.type ?? "fact",
    fields.content,
    fields.importance ?? 3,
    fields.workspace ?? null,
    "2026-07-01T00:00:00.000Z",
    fields.updatedAt ?? "2026-07-01T00:00:00.000Z"
  );
}

async function recall(
  tools: RegisteredToolMap,
  title: string,
  workspace?: string
): Promise<string[]> {
  const started = await tools.reasoning_start_session.handler(
    workspace === undefined ? { title } : { title, workspace }
  );
  assert.equal(started.isError, undefined);
  const payload = started.structuredContent as {
    related_memories: Array<{ id: string }>;
  };
  return payload.related_memories.map((row) => row.id);
}

function withEnv<T>(name: string, value: string | undefined, fn: () => T): T {
  const original = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return fn();
  } finally {
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  }
}

test("normalizeWorkspace treats empty, root and home as unknown (AC-1)", () => {
  assert.equal(normalizeWorkspace(undefined), null);
  assert.equal(normalizeWorkspace(null), null);
  assert.equal(normalizeWorkspace(""), null);
  assert.equal(normalizeWorkspace("   "), null);
  assert.equal(normalizeWorkspace("/"), null);
  assert.equal(normalizeWorkspace(os.homedir()), null);
  assert.equal(normalizeWorkspace(`${os.homedir()}/`), null);
});

test("normalizeWorkspace trims and strips trailing separators (AC-1)", () => {
  assert.equal(normalizeWorkspace("/proj/a"), "/proj/a");
  assert.equal(normalizeWorkspace("/proj/a/"), "/proj/a");
  assert.equal(normalizeWorkspace("  /proj/a//  "), "/proj/a");
});

test("getWorkspace precedence is explicit, then MEMORY_WORKSPACE, then cwd (AC-1)", () => {
  withEnv("MEMORY_WORKSPACE", "/env-ws", () => {
    assert.equal(getWorkspace("/explicit/"), "/explicit");
    assert.equal(getWorkspace(), "/env-ws");
    assert.equal(getWorkspace("   "), "/env-ws");
    assert.equal(getWorkspace("/"), null, "explicit root is unknown, not a fall-through");
  });
  withEnv("MEMORY_WORKSPACE", undefined, () => {
    assert.equal(getWorkspace(), process.cwd());
  });
});

test("a saved conclusion stores the explicit workspace, normalized (AC-10)", async () => {
  const { toolDb, toolDir, tools } = await makeHarness("ws-save-explicit");
  try {
    assert.equal(await saveConclusion(tools, toolDb, "/proj/x/"), "/proj/x");
  } finally {
    cleanup(toolDb, toolDir);
  }
});

test("a saved conclusion stores NULL when the workspace is unknown (AC-10)", async () => {
  const { toolDb, toolDir, tools } = await makeHarness("ws-save-unknown");
  try {
    assert.equal(await saveConclusion(tools, toolDb, "/"), null);
  } finally {
    cleanup(toolDb, toolDir);
  }
});

test("migration 0006 nulls legacy root/home workspaces and adds the session column (AC-2)", () => {
  const dbPath = makeWorkspaceDbPath("ws-migration");
  const dir = path.dirname(dbPath);
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      )
    `);
    for (const migration of [
      migration0001Initial,
      migration0002ReasoningStepMarks,
      migration0003ReasoningStepsFts,
      migration0004ToolUsageEvents,
      migration0005MemoryWorkspace,
    ]) {
      migration.apply(db);
      db.prepare(
        `INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)`
      ).run(migration.version, "2026-07-01T00:00:00.000Z");
    }
    for (const [id, workspace] of [
      ["mem_root", "/"],
      ["mem_home", os.homedir()],
      ["mem_proj", "/proj/a"],
      ["mem_null", null],
    ] as const) {
      insertMemory(db, { id, content: `content ${id}`, workspace });
    }

    runMigrations(db);
    runMigrations(db); // idempotent: second run is a no-op

    const workspaces = Object.fromEntries(
      (
        db.prepare(`SELECT id, workspace FROM memories`).all() as Array<{
          id: string;
          workspace: string | null;
        }>
      ).map((row) => [row.id, row.workspace])
    );
    assert.deepEqual(workspaces, {
      mem_root: null,
      mem_home: null,
      mem_proj: "/proj/a",
      mem_null: null,
    });

    const columns = (
      db.prepare(`PRAGMA table_info(reasoning_sessions)`).all() as Array<{
        name: string;
      }>
    ).map((column) => column.name);
    assert.ok(columns.includes("workspace"));
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("start_session stores and returns the resolved workspace (AC-9)", async () => {
  const { toolDb, toolDir, tools } = await makeHarness("ws-start-stores");
  try {
    const started = await tools.reasoning_start_session.handler({
      title: "inspect checkout flow",
      workspace: "/proj/a/",
    });
    assert.equal(started.isError, undefined);
    const payload = started.structuredContent as {
      session_id: string;
      workspace: string | null;
      workspace_warning?: string;
    };
    assert.equal(payload.workspace, "/proj/a");
    assert.equal(payload.workspace_warning, undefined);
    const row = toolDb
      .prepare(`SELECT workspace FROM reasoning_sessions WHERE id = ?`)
      .get(payload.session_id) as { workspace: string | null };
    assert.equal(row.workspace, "/proj/a");
  } finally {
    cleanup(toolDb, toolDir);
  }
});

test("start_session warns when the workspace is unknown (AC-10)", async () => {
  const { toolDb, toolDir, tools } = await makeHarness("ws-start-unknown");
  try {
    const started = await tools.reasoning_start_session.handler({
      title: "inspect checkout flow",
      workspace: "/",
    });
    assert.equal(started.isError, undefined);
    const payload = started.structuredContent as {
      session_id: string;
      workspace: string | null;
      workspace_warning?: string;
    };
    assert.equal(payload.workspace, null);
    assert.match(payload.workspace_warning ?? "", /pass workspace/i);
    const row = toolDb
      .prepare(`SELECT workspace FROM reasoning_sessions WHERE id = ?`)
      .get(payload.session_id) as { workspace: string | null };
    assert.equal(row.workspace, null);
  } finally {
    cleanup(toolDb, toolDir);
  }
});

test("a session conclusion inherits the session workspace (AC-9)", async () => {
  const { toolDb, toolDir, tools } = await makeHarness("ws-complete-inherits");
  try {
    const started = await tools.reasoning_start_session.handler({
      title: "diagnose checkout retries",
      workspace: "/proj/a",
    });
    const sessionId = (started.structuredContent as { session_id: string })
      .session_id;
    const completed = await tools.reasoning_complete_session.handler({
      session_id: sessionId,
      conclusion: "retries must reopen the connection",
      status: "completed",
      save_as_memory: true,
      memory_tags: [],
      used_memory_ids: [],
    });
    assert.equal(completed.isError, undefined);
    const memoryId = (completed.structuredContent as { memory_id: string })
      .memory_id;
    const row = toolDb
      .prepare(`SELECT workspace FROM memories WHERE id = ?`)
      .get(memoryId) as { workspace: string | null };
    assert.equal(row.workspace, "/proj/a");
  } finally {
    cleanup(toolDb, toolDir);
  }
});

test("toRecallTerms drops generic task and function words (AC-6)", () => {
  assert.deepEqual(toRecallTerms("Fix the bug in recall ranking"), [
    '"recall"*',
    '"ranking"*',
  ]);
  assert.deepEqual(toRecallTerms("Fix, recall"), ['"recall"*']);
});

test("toRecallTerms falls back when every token is generic (AC-6)", () => {
  assert.deepEqual(toRecallTerms("fix bug"), ['"fix"*', '"bug"*']);
});

test("a memory sharing only generic words with the title is not recalled (AC-6)", async () => {
  const { toolDb, toolDir, tools } = await makeHarness("ws-stopwords");
  try {
    // Without the stopword filter the terms are fix/bug/payroll/export
    // (N=4, floor 2), so "fix" + "bug" alone would be enough to match.
    insertMemory(toolDb, {
      id: "mem_generic",
      content: "fix bug in the login page redirect",
    });
    insertMemory(toolDb, {
      id: "mem_topical",
      content: "payroll export format uses fixed width columns",
    });
    assert.deepEqual(await recall(tools, "fix bug payroll export"), [
      "mem_topical",
    ]);
  } finally {
    cleanup(toolDb, toolDir);
  }
});

const TITLE = "payment gateway release checklist"; // 4 terms: floor 2, cross-project floor 3

test("another project's weak match is not recalled; the home one is (AC-3)", async () => {
  const { toolDb, toolDir, tools } = await makeHarness("ws-gate-weak");
  try {
    // Both match 2 of the 4 title terms: enough for home, below the
    // cross-project floor of 3.
    insertMemory(toolDb, {
      id: "mem_home",
      content: "payment gateway ledger notes",
      workspace: "/proj/a",
    });
    insertMemory(toolDb, {
      id: "mem_away",
      content: "payment gateway ledger notes",
      workspace: "/proj/b",
    });
    assert.deepEqual(await recall(tools, TITLE, "/proj/a"), ["mem_home"]);
  } finally {
    cleanup(toolDb, toolDir);
  }
});

test("another project's strong match is still recalled (AC-4)", async () => {
  const { toolDb, toolDir, tools } = await makeHarness("ws-gate-strong");
  try {
    insertMemory(toolDb, {
      id: "mem_home",
      content: "payment gateway release notes",
      workspace: "/proj/a",
    });
    insertMemory(toolDb, {
      id: "mem_away_strong",
      content: "payment gateway release checklist runbook",
      workspace: "/proj/b",
    });
    const ids = await recall(tools, TITLE, "/proj/a");
    assert.deepEqual(ids.sort(), ["mem_away_strong", "mem_home"]);
  } finally {
    cleanup(toolDb, toolDir);
  }
});

test("preference memories bypass the cross-project gate but not the base floor (AC-4b)", async () => {
  const { toolDb, toolDir, tools } = await makeHarness("ws-gate-preference");
  try {
    insertMemory(toolDb, {
      id: "mem_pref_2",
      type: "preference",
      content: "payment gateway conventions",
      workspace: "/proj/b",
    });
    insertMemory(toolDb, {
      id: "mem_fact_2",
      type: "fact",
      content: "payment gateway conventions overview",
      workspace: "/proj/b",
    });
    insertMemory(toolDb, {
      id: "mem_pref_1",
      type: "preference",
      content: "payment conventions",
      workspace: "/proj/b",
    });
    assert.deepEqual(await recall(tools, TITLE, "/proj/a"), ["mem_pref_2"]);
  } finally {
    cleanup(toolDb, toolDir);
  }
});

test("home memories enter the pool even when other projects saturate BM25 (AC-3)", async () => {
  const { toolDb, toolDir, tools } = await makeHarness("ws-pool-tier");
  try {
    for (let i = 0; i < 60; i += 1) {
      insertMemory(toolDb, {
        id: `mem_noise_${i}`,
        content: "payment gateway ledger",
        workspace: "/proj/b",
      });
    }
    const filler = Array.from({ length: 80 }, (_, i) => `filler${i}`).join(" ");
    insertMemory(toolDb, {
      id: "mem_home",
      content: `payment gateway ${filler}`,
      workspace: "/proj/a",
    });
    // The 60 short away memories match 2 of 4 terms (< cross floor 3) and
    // outrank the long home memory on BM25; only a workspace-tiered pool
    // lets the home memory through.
    assert.deepEqual(await recall(tools, TITLE, "/proj/a"), ["mem_home"]);
  } finally {
    cleanup(toolDb, toolDir);
  }
});

test("no lifeline: weak other-project matches return nothing (AC-5)", async () => {
  const { toolDb, toolDir, tools } = await makeHarness("ws-no-lifeline");
  try {
    insertMemory(toolDb, {
      id: "mem_away",
      content: "payment provider rotation schedule",
      workspace: "/proj/b",
    });
    assert.deepEqual(await recall(tools, TITLE, "/proj/a"), []);
  } finally {
    cleanup(toolDb, toolDir);
  }
});

test("unknown workspace keeps the base floor for everyone (AC-5)", async () => {
  const { toolDb, toolDir, tools } = await makeHarness("ws-unknown-floor");
  try {
    insertMemory(toolDb, {
      id: "mem_away",
      content: "payment gateway release notes",
      workspace: "/proj/b",
    });
    assert.deepEqual(await recall(tools, TITLE, "/"), ["mem_away"]);
  } finally {
    cleanup(toolDb, toolDir);
  }
});

test("memories reported stale or unsafe are not recalled; used/ignored do not exclude (AC-7)", async () => {
  const { toolDb, toolDir, tools } = await makeHarness("ws-stale-exclusion");
  try {
    const content = "payment gateway release checklist for staging";
    for (const id of ["mem_stale", "mem_unsafe", "mem_used", "mem_ignored", "mem_clean"]) {
      insertMemory(toolDb, { id, content, workspace: "/proj/a" });
    }
    for (const [memory_id, usefulness] of [
      ["mem_stale", "stale"],
      ["mem_unsafe", "unsafe_to_use"],
      ["mem_used", "used"],
      ["mem_ignored", "ignored"],
    ] as const) {
      const fb = await tools.memory_record_usage_feedback.handler({
        memory_id,
        usefulness,
      });
      assert.equal(fb.isError, undefined);
    }
    const ids = await recall(tools, TITLE, "/proj/a");
    assert.deepEqual(ids.sort(), ["mem_clean", "mem_ignored", "mem_used"]);
  } finally {
    cleanup(toolDb, toolDir);
  }
});

test("a stale memory corrected with memory_update is recalled again", async () => {
  const { toolDb, toolDir, tools } = await makeHarness("ws-stale-corrected");
  try {
    insertMemory(toolDb, {
      id: "mem_fixed",
      content: "payment gateway release checklist for staging",
      workspace: "/proj/a",
    });
    const fb = await tools.memory_record_usage_feedback.handler({
      memory_id: "mem_fixed",
      usefulness: "stale",
    });
    assert.equal(fb.isError, undefined);
    assert.deepEqual(await recall(tools, TITLE, "/proj/a"), []);

    await new Promise((resolve) => setTimeout(resolve, 5));
    const updated = await tools.memory_update.handler({
      id: "mem_fixed",
      content: "payment gateway release checklist for staging, revised",
    });
    assert.equal(updated.isError, undefined);
    assert.deepEqual(await recall(tools, TITLE, "/proj/a"), ["mem_fixed"]);
  } finally {
    cleanup(toolDb, toolDir);
  }
});

test("a memory flagged stale after its last update stays excluded", async () => {
  const { toolDb, toolDir, tools } = await makeHarness("ws-stale-after-update");
  try {
    insertMemory(toolDb, {
      id: "mem_flagged",
      content: "payment gateway release checklist for staging",
      workspace: "/proj/a",
    });
    const updated = await tools.memory_update.handler({
      id: "mem_flagged",
      content: "payment gateway release checklist for staging, revised",
    });
    assert.equal(updated.isError, undefined);

    await new Promise((resolve) => setTimeout(resolve, 5));
    const fb = await tools.memory_record_usage_feedback.handler({
      memory_id: "mem_flagged",
      usefulness: "stale",
    });
    assert.equal(fb.isError, undefined);
    assert.deepEqual(await recall(tools, TITLE, "/proj/a"), []);
  } finally {
    cleanup(toolDb, toolDir);
  }
});

test("a stale flag recorded at the same instant as the last update keeps the memory excluded", async () => {
  const { toolDb, toolDir, tools } = await makeHarness("ws-stale-same-instant");
  try {
    const instant = "2026-09-01T00:00:00.000Z";
    insertMemory(toolDb, {
      id: "mem_tie",
      content: "payment gateway release checklist for staging",
      workspace: "/proj/a",
      updatedAt: instant,
    });
    toolDb
      .prepare(
        `INSERT INTO tool_usage_events (id, created_at, mcp_version, tool_name, operation_type, access_type, status, memory_id, metadata)
         VALUES (?, ?, '1.4.0', 'memory_record_usage_feedback', 'feedback', 'write', 'success', ?, '{"usefulness":"stale"}')`
      )
      .run("evt_tie", instant, "mem_tie");
    assert.deepEqual(await recall(tools, TITLE, "/proj/a"), []);
  } finally {
    cleanup(toolDb, toolDir);
  }
});
