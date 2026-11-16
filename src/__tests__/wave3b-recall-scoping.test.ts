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
import { saveConclusion } from "./fixtures/memory-seed.js";

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
    type?: string;
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
    fields.workspace === undefined ? process.cwd() : fields.workspace,
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

test("floor miss returns nothing: the lifeline is gone (spec 2026-10-05 G-4)", async () => {
  const { toolDb, toolDir, tools } = await makeHarness("scoping-no-fallback");

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

    assert.deepEqual(
      await recall(tools, "resolve checkout timeout payment gateway"),
      []
    );
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
    assert.equal(await saveConclusion(tools, toolDb), "/pinned-ws");
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

test("unknown-project recall excludes weak matches but preserves manual access and recorded ids", async () => {
  const { toolDb, toolDir, tools } = await makeHarness("scoping-unknown-project");
  try {
    insertMemory(toolDb, {
      id: "mem_weak",
      content: "payment gateway ledger notes",
      workspace: null,
    });
    insertMemory(toolDb, {
      id: "mem_strong",
      content: "payment gateway release notes",
      workspace: null,
    });
    const started = await tools.reasoning_start_session.handler({
      title: "payment gateway release checklist",
      workspace: process.cwd(),
    });
    assert.equal(started.isError, undefined);
    const output = started.structuredContent as {
      session_id: string;
      related_memories: Array<{ id: string }>;
    };
    assert.deepEqual(output.related_memories.map((row) => row.id), ["mem_strong"]);
    const stored = toolDb.prepare(
      "SELECT recalled_memory_ids FROM reasoning_sessions WHERE id = ?"
    ).get(output.session_id) as { recalled_memory_ids: string };
    assert.deepEqual(JSON.parse(stored.recalled_memory_ids), ["mem_strong"]);

    const got = await tools.memory_get.handler({ id: "mem_weak" });
    assert.equal(got.isError, undefined);
    assert.equal(got.structuredContent?.id, "mem_weak");
    const searched = await tools.memory_search.handler({
      query: "ledger", limit: 20, offset: 0,
    });
    assert.equal(searched.isError, undefined);
    const results = searched.structuredContent?.results as Array<{ id: string }>;
    assert.deepEqual(results.map((row) => row.id), ["mem_weak"]);
  } finally {
    toolDb.close();
    fs.rmSync(toolDir, { recursive: true, force: true });
  }
});

const thresholdWords = [
  "payment", "gateway", "release", "checklist",
  "analytics", "warehouse", "vacuum", "policy",
];

for (const [termCount, required] of [
  [1, 2], [2, 2], [3, 3], [4, 3], [5, 4], [6, 5], [7, 6], [8, 6],
] as const) {
  test(`unknown-project recall requires ${required} matches for ${termCount} title terms`, async () => {
    const { toolDb, toolDir, tools } = await makeHarness(`scoping-unknown-${termCount}`);
    try {
      insertMemory(toolDb, {
        id: "mem_below",
        content: thresholdWords.slice(0, required - 1).join(" "),
        workspace: null,
      });
      if (required <= termCount) {
        insertMemory(toolDb, {
          id: "mem_at",
          content: thresholdWords.slice(0, required).join(" "),
          workspace: null,
        });
      }
      assert.deepEqual(
        await recall(tools, thresholdWords.slice(0, termCount).join(" ")),
        required <= termCount ? ["mem_at"] : []
      );
    } finally {
      toolDb.close();
      fs.rmSync(toolDir, { recursive: true, force: true });
    }
  });
}

for (const [label, type, workspace] of [
  ["home fact", "fact", process.cwd()],
  ["home preference", "preference", process.cwd()],
  ["unknown preference", "preference", null],
  ["other preference", "preference", "/other/project"],
] as const) {
  test(`${label} keeps the base recall floor for short and long titles`, async () => {
    const { toolDb, toolDir, tools } = await makeHarness("scoping-base-floor");
    try {
      insertMemory(toolDb, { id: "mem_base", content: "payment gateway", type, workspace });
      assert.deepEqual(await recall(tools, "payment"), ["mem_base"]);
      assert.deepEqual(await recall(tools, "payment gateway release checklist"), ["mem_base"]);
      assert.deepEqual(await recall(tools, "payment release checklist analytics"), []);
    } finally {
      toolDb.close();
      fs.rmSync(toolDir, { recursive: true, force: true });
    }
  });
}

test("an unknown current workspace keeps the base floor for all memory workspaces", async () => {
  const { toolDb, toolDir, tools } = await makeHarness("scoping-unknown-session");
  try {
    insertMemory(toolDb, { id: "mem_null", content: "payment gateway", workspace: null });
    insertMemory(toolDb, { id: "mem_other", content: "payment gateway", workspace: "/other/project" });
    const started = await tools.reasoning_start_session.handler({
      title: "payment gateway release checklist", workspace: "/",
    });
    assert.equal(started.isError, undefined);
    const output = started.structuredContent as {
      workspace: string | null;
      workspace_warning: string;
      related_memories: Array<{ id: string }>;
    };
    assert.equal(output.workspace, null);
    assert.match(output.workspace_warning, /pass workspace/i);
    assert.deepEqual(output.related_memories.map((row) => row.id).sort(), ["mem_null", "mem_other"]);
  } finally {
    toolDb.close();
    fs.rmSync(toolDir, { recursive: true, force: true });
  }
});

test("strong unknown-project memories still obey stale and unsafe feedback", async () => {
  const { toolDb, toolDir, tools } = await makeHarness("scoping-unknown-stale");
  try {
    for (const usefulness of ["stale", "unsafe_to_use"] as const) {
      const id = `mem_${usefulness}`;
      insertMemory(toolDb, { id, content: "payment gateway release checklist", workspace: null });
      const feedback = await tools.memory_record_usage_feedback.handler({ memory_id: id, usefulness });
      assert.equal(feedback.isError, undefined);
    }
    assert.deepEqual(await recall(tools, "payment gateway release checklist"), []);
  } finally {
    toolDb.close();
    fs.rmSync(toolDir, { recursive: true, force: true });
  }
});

test("an FTS failure does not block session creation", async () => {
  const { toolDb, toolDir, tools } = await makeHarness("scoping-fts-failure");
  try {
    toolDb.exec("DROP TABLE memories_fts");
    const started = await tools.reasoning_start_session.handler({ title: "payment gateway" });
    assert.equal(started.isError, undefined);
    const output = started.structuredContent as { session_id: string; related_memories: unknown[] };
    assert.deepEqual(output.related_memories, []);
    assert.ok(toolDb.prepare("SELECT id FROM reasoning_sessions WHERE id = ?").get(output.session_id));
  } finally {
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
