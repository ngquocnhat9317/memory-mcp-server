import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runMigrations } from "../migrations/index.js";
import { migration0001Initial } from "../migrations/0001_initial.js";
import { migration0002ReasoningStepMarks } from "../migrations/0002_reasoning_step_marks.js";
import { migration0003ReasoningStepsFts } from "../migrations/0003_reasoning_steps_fts.js";
import { migration0004ToolUsageEvents } from "../migrations/0004_tool_usage_events.js";

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
    workspace?: string | null;
    importance?: number;
    updatedAt?: string;
  }
): void {
  db.prepare(
    `INSERT INTO memories (id, type, content, tags, agent_id, importance, metadata, workspace, created_at, updated_at)
     VALUES (?, 'fact', ?, '[]', NULL, ?, NULL, ?, ?, ?)`
  ).run(
    fields.id,
    fields.content,
    fields.importance ?? 3,
    fields.workspace ?? null,
    "2026-07-01T00:00:00.000Z",
    fields.updatedAt ?? "2026-07-01T00:00:00.000Z"
  );
}

async function recall(
  tools: RegisteredToolMap,
  title: string
): Promise<string[]> {
  const started = await tools.reasoning_start_session.handler({ title });
  assert.equal(started.isError, undefined);
  const payload = started.structuredContent as {
    related_memories: Array<{ id: string }>;
  };
  return payload.related_memories.map((row) => row.id);
}

test("short titles keep single-term matching (AC-8.2)", async () => {
  const { toolDb, toolDir, tools } = await makeHarness("scoping-short-title");

  try {
    insertMemory(toolDb, {
      id: "mem_single",
      content: "grafana dashboards overview and conventions",
    });
    assert.deepEqual(await recall(tools, "grafana tuning"), ["mem_single"]);
  } finally {
    toolDb.close();
    fs.rmSync(toolDir, { recursive: true, force: true });
  }
});

test("floor miss falls back to exactly one best match (AC-8.3)", async () => {
  const { toolDb, toolDir, tools } = await makeHarness("scoping-fallback");

  try {
    // Each candidate matches exactly one different term of a 5-term title.
    insertMemory(toolDb, {
      id: "mem_one",
      content: "payment provider rotation schedule",
    });
    insertMemory(toolDb, {
      id: "mem_two",
      content: "gateway hardware inventory list",
    });

    const ids = await recall(
      tools,
      "resolve checkout timeout payment gateway"
    );
    assert.equal(ids.length, 1, "fallback must return a single lifeline");
    assert.ok(["mem_one", "mem_two"].includes(ids[0]));
  } finally {
    toolDb.close();
    fs.rmSync(toolDir, { recursive: true, force: true });
  }
});

test("repeated title words neither raise the floor nor double-count", async () => {
  const { toolDb, toolDir, tools } = await makeHarness("scoping-dedupe");

  try {
    // Distinct significant terms: step, migration, guide (3) → floor = 2.
    // A memory matching only 'step' must NOT clear the floor even though
    // the word appears twice in the title.
    insertMemory(toolDb, {
      id: "mem_step_only",
      content: "step counter widget for the fitness dashboard",
    });
    insertMemory(toolDb, {
      id: "mem_real",
      content: "migration guide covering each step of the rollout",
    });

    assert.deepEqual(await recall(tools, "step by step migration guide"), [
      "mem_real",
    ]);
  } finally {
    toolDb.close();
    fs.rmSync(toolDir, { recursive: true, force: true });
  }
});

test("same-workspace memories win among equal matches (AC-9.1)", async () => {
  const { toolDb, toolDir, tools } = await makeHarness("scoping-ws-tie");

  try {
    const content = "release checklist for payment gateway deployments";
    insertMemory(toolDb, {
      id: "mem_other_ws",
      content,
      workspace: "/somewhere/else",
    });
    insertMemory(toolDb, {
      id: "mem_same_ws",
      content,
      workspace: process.cwd(),
    });

    assert.deepEqual(
      await recall(tools, "payment gateway release checklist"),
      ["mem_same_ws", "mem_other_ws"]
    );
  } finally {
    toolDb.close();
    fs.rmSync(toolDir, { recursive: true, force: true });
  }
});

test("workspace preference is soft: stronger cross-workspace match wins (AC-9.2)", async () => {
  const { toolDb, toolDir, tools } = await makeHarness("scoping-ws-soft");

  try {
    insertMemory(toolDb, {
      id: "mem_home_weak",
      content: "payment gateway maintenance window",
      workspace: process.cwd(),
    });
    insertMemory(toolDb, {
      id: "mem_away_strong",
      content: "payment gateway release checklist for staging",
      workspace: "/somewhere/else",
    });

    assert.deepEqual(
      await recall(tools, "payment gateway release checklist"),
      ["mem_away_strong", "mem_home_weak"]
    );
  } finally {
    toolDb.close();
    fs.rmSync(toolDir, { recursive: true, force: true });
  }
});

test("legacy NULL workspace ranks between same and other (AC-9.3)", async () => {
  const { toolDb, toolDir, tools } = await makeHarness("scoping-ws-tiers");

  try {
    const content = "database vacuum policy for analytics warehouse";
    insertMemory(toolDb, { id: "mem_away", content, workspace: "/elsewhere" });
    insertMemory(toolDb, { id: "mem_legacy", content, workspace: null });
    insertMemory(toolDb, { id: "mem_home", content, workspace: process.cwd() });

    assert.deepEqual(
      await recall(tools, "analytics warehouse vacuum policy"),
      ["mem_home", "mem_legacy", "mem_away"]
    );
  } finally {
    toolDb.close();
    fs.rmSync(toolDir, { recursive: true, force: true });
  }
});

test("MEMORY_WORKSPACE pins the stamped workspace (AC-9.4)", async () => {
  const originalWorkspace = process.env.MEMORY_WORKSPACE;
  process.env.MEMORY_WORKSPACE = "/pinned-ws";

  const { toolDb, toolDir, tools } = await makeHarness("scoping-ws-pin");

  try {
    const saved = await tools.memory_save.handler({
      content: "stamped under a pinned workspace",
      type: "fact",
      importance: 3,
    });
    assert.equal(saved.isError, undefined);
    const id = (saved.structuredContent as { id: string }).id;
    const row = toolDb
      .prepare(`SELECT workspace FROM memories WHERE id = ?`)
      .get(id) as { workspace: string | null };
    assert.equal(row.workspace, "/pinned-ws");
  } finally {
    if (originalWorkspace === undefined) {
      delete process.env.MEMORY_WORKSPACE;
    } else {
      process.env.MEMORY_WORKSPACE = originalWorkspace;
    }
    toolDb.close();
    fs.rmSync(toolDir, { recursive: true, force: true });
  }
});

test("pre-0005 databases upgrade in place with data intact (AC-9.5)", () => {
  const dbPath = makeWorkspaceDbPath("scoping-upgrade");
  const dir = path.dirname(dbPath);
  const db = new DatabaseSync(dbPath);

  try {
    // Recreate a database exactly as 1.2.x shipped it: migrations 0001-0004
    // applied and recorded, one memory saved without a workspace column.
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
    ]) {
      migration.apply(db);
      db.prepare(
        `INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)`
      ).run(migration.version, "2026-07-01T00:00:00.000Z");
    }
    db.prepare(
      `INSERT INTO memories (id, type, content, tags, agent_id, importance, metadata, created_at, updated_at)
       VALUES ('mem_old', 'fact', 'pre-upgrade memory', '[]', NULL, 3, NULL, ?, ?)`
    ).run("2026-07-01T00:00:00.000Z", "2026-07-01T00:00:00.000Z");

    runMigrations(db);

    const versions = (
      db.prepare(`SELECT version FROM schema_migrations ORDER BY version`).all() as Array<{
        version: string;
      }>
    ).map((row) => row.version);
    assert.ok(versions.includes("0005_memory_workspace"));

    const row = db
      .prepare(`SELECT content, workspace FROM memories WHERE id = 'mem_old'`)
      .get() as { content: string; workspace: string | null };
    assert.equal(row.content, "pre-upgrade memory");
    assert.equal(row.workspace, null);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
