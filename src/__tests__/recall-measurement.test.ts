import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runMigrations } from "../migrations/index.js";
import { insertMemory } from "./fixtures/memory-seed.js";

export const RECALL_USED_RATE_SQL = `
WITH s AS (
  SELECT id, recalled_memory_ids
  FROM reasoning_sessions
  WHERE status = 'completed'
    AND recalled_memory_ids IS NOT NULL
    AND created_at >= :window_start
),
recalled AS (
  SELECT s.id AS session_id, j.value AS memory_id
  FROM s, json_each(s.recalled_memory_ids) AS j
),
used AS (
  SELECT DISTINCT session_id, memory_id
  FROM tool_usage_events
  WHERE operation_type = 'feedback' AND status = 'success'
    AND json_extract(metadata, '$.usefulness') = 'used'
    AND session_id IS NOT NULL AND memory_id IS NOT NULL
)
SELECT COUNT(*)                                     AS recalled,
       SUM(u.memory_id IS NOT NULL)                 AS used,
       ROUND(100.0 * SUM(u.memory_id IS NOT NULL) / COUNT(*), 1) AS used_rate_pct,
       COUNT(DISTINCT r.session_id)                 AS sessions,
       COUNT(DISTINCT CASE WHEN u.memory_id IS NOT NULL THEN r.session_id END)
                                                    AS sessions_with_a_used
FROM recalled r
LEFT JOIN used u
  ON u.session_id = r.session_id AND u.memory_id = r.memory_id;`;

type Tools = Record<
  string,
  {
    handler: (p: Record<string, unknown>) => Promise<{
      structuredContent?: Record<string, unknown>;
      isError?: boolean;
      content: Array<{ type: "text"; text: string }>;
    }>;
  }
>;

async function makeHarness(name: string) {
  const dir = fs.mkdtempSync(path.join(process.cwd(), ".tmp-memory-mcp-"));
  const db = new DatabaseSync(path.join(dir, `${name}.db`));
  runMigrations(db);
  const { registerReasoningTools } = await import("../tools/reasoning.js");
  const server = new McpServer({ name: "test-server", version: "0.0.0" });
  registerReasoningTools(server, db);
  const tools = (server as unknown as { _registeredTools: Tools })._registeredTools;
  return { db, dir, tools };
}

function recalledIds(db: DatabaseSync, sessionId: string): string | null {
  return (db.prepare("SELECT recalled_memory_ids AS r FROM reasoning_sessions WHERE id = ?").get(sessionId) as { r: string | null }).r;
}

test("0008 adds recalled_memory_ids and old rows read NULL (AC-18.1)", async () => {
  const { db, dir } = await makeHarness("m-col");
  try {
    db.prepare("INSERT INTO reasoning_sessions (id, title, status, created_at, updated_at) VALUES ('old', 't', 'completed', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')").run();
    assert.equal(recalledIds(db, "old"), null);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("start_session stores exactly the recalled ids, in order (AC-18.2, AC-18.5)", async () => {
  const original = process.env.MEMORY_WORKSPACE;
  process.env.MEMORY_WORKSPACE = "/m/home";
  const { db, dir, tools } = await makeHarness("m-store");
  try {
    insertMemory(db, { id: "mem_a", content: "okapi grazing pattern notes", workspace: "/m/home" });
    const res = await tools.reasoning_start_session.handler({ title: "okapi grazing" });
    const out = res.structuredContent as { session_id: string; related_memories: Array<{ id: string }> };
    assert.ok(out.related_memories.length > 0);
    assert.equal(recalledIds(db, out.session_id), JSON.stringify(out.related_memories.map((m) => m.id)));
    assert.ok(!JSON.stringify(out).includes("recalled_memory_ids"));
  } finally {
    if (original === undefined) delete process.env.MEMORY_WORKSPACE;
    else process.env.MEMORY_WORKSPACE = original;
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("start_session leaves the column NULL when nothing is recalled (AC-18.3)", async () => {
  const { db, dir, tools } = await makeHarness("m-empty");
  try {
    const res = await tools.reasoning_start_session.handler({ title: "nothing matches this" });
    const id = (res.structuredContent as { session_id: string }).session_id;
    assert.equal(recalledIds(db, id), null);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed recalled-id write never breaks start_session (AC-18.4)", async () => {
  const original = process.env.MEMORY_WORKSPACE;
  process.env.MEMORY_WORKSPACE = "/m/home";
  const { db, dir, tools } = await makeHarness("m-fail");
  try {
    insertMemory(db, { id: "mem_b", content: "tapir trail survey", workspace: "/m/home" });
    db.exec("ALTER TABLE reasoning_sessions DROP COLUMN recalled_memory_ids");
    const res = await tools.reasoning_start_session.handler({ title: "tapir trail" });
    assert.equal(res.isError, undefined);
    assert.equal((res.structuredContent as { related_memories: unknown[] }).related_memories.length, 1);
  } finally {
    if (original === undefined) delete process.env.MEMORY_WORKSPACE;
    else process.env.MEMORY_WORKSPACE = original;
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the used-rate query counts completed sessions only (AC-18.6)", async () => {
  const { db, dir } = await makeHarness("m-query");
  try {
    const ins = db.prepare(
      "INSERT INTO reasoning_sessions (id, title, status, recalled_memory_ids, created_at, updated_at) VALUES (?, 't', ?, ?, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')"
    );
    ins.run("s_used", "completed", JSON.stringify(["m1", "m2"]));
    ins.run("s_none", "completed", JSON.stringify(["m3"]));
    ins.run("s_abandoned", "abandoned", JSON.stringify(["m4"]));
    db.prepare(
      `INSERT INTO tool_usage_events (id, created_at, mcp_version, tool_name, operation_type, access_type, status, session_id, memory_id, metadata)
       VALUES ('e1', '2026-10-01T00:00:00.000Z', '1.4.0', 'memory_record_usage_feedback', 'feedback', 'write', 'success', 's_used', 'm1', '{"usefulness":"used"}')`
    ).run();
    const row = db.prepare(RECALL_USED_RATE_SQL).get({ window_start: "2026-01-01" }) as {
      recalled: number; used: number; sessions: number; sessions_with_a_used: number;
    };
    assert.deepEqual(
      { recalled: row.recalled, used: row.used, sessions: row.sessions, hit: row.sessions_with_a_used },
      { recalled: 3, used: 1, sessions: 2, hit: 1 }
    );
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
