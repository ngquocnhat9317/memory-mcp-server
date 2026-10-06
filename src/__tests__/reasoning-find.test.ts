import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runMigrations } from "../migrations/index.js";

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

async function makeHarness(name: string) {
  const dir = fs.mkdtempSync(path.join(process.cwd(), ".tmp-memory-mcp-"));
  const db = new DatabaseSync(path.join(dir, `${name}.db`));
  runMigrations(db);
  const { registerReasoningTools } = await import("../tools/reasoning.js");
  const server = new McpServer({ name: "test-server", version: "0.0.0" });
  registerReasoningTools(server, db);
  const tools = (server as unknown as { _registeredTools: RegisteredToolMap })
    ._registeredTools;
  return { db, dir, tools };
}

function insertSession(
  db: DatabaseSync,
  id: string,
  fields: {
    title: string;
    conclusion?: string | null;
    status?: string;
    workspace?: string | null;
    updatedAt: string;
  }
): void {
  db.prepare(
    `INSERT INTO reasoning_sessions (id, title, agent_id, status, conclusion, workspace, created_at, updated_at)
     VALUES (?, ?, NULL, ?, ?, ?, ?, ?)`
  ).run(
    id,
    fields.title,
    fields.status ?? "completed",
    fields.conclusion ?? null,
    fields.workspace ?? null,
    fields.updatedAt,
    fields.updatedAt
  );
}

function insertStep(
  db: DatabaseSync,
  sessionId: string,
  stepNumber: number,
  thought: string
): void {
  db.prepare(
    `INSERT INTO reasoning_steps (id, session_id, step_number, thought, action, observation, created_at)
     VALUES (?, ?, ?, ?, NULL, NULL, ?)`
  ).run(`step_${sessionId}_${stepNumber}`, sessionId, stepNumber, thought, "2026-10-01T00:00:00.000Z");
}

type FindResult = {
  session_id: string;
  workspace: string | null;
  matched_terms: number;
  conclusion: string | null;
  excerpts: Array<{ step_number: number; excerpt: string }>;
};

async function find(tools: RegisteredToolMap, query: string, limit?: number) {
  const res = await tools.reasoning_find.handler({ query, ...(limit ? { limit } : {}) });
  assert.equal(res.isError, undefined, res.content[0]?.text);
  return (res.structuredContent as { results: FindResult[] }).results;
}

test("reasoning_find matches step text, title and conclusion separately (AC-20.1, AC-20.2)", async () => {
  const { db, dir, tools } = await makeHarness("find-sources");
  try {
    insertSession(db, "sess_step", { title: "unrelated alpha", updatedAt: "2026-10-01T00:00:00.000Z" });
    insertStep(db, "sess_step", 1, "we measured the flamingo latency");
    insertSession(db, "sess_title", { title: "flamingo rollout plan", updatedAt: "2026-10-02T00:00:00.000Z" });
    insertSession(db, "sess_concl", {
      title: "unrelated beta",
      conclusion: "Chose the flamingo cache because it was cheaper.",
      updatedAt: "2026-10-03T00:00:00.000Z",
    });
    insertSession(db, "sess_none", { title: "nothing here", updatedAt: "2026-10-04T00:00:00.000Z" });
    const ids = (await find(tools, "flamingo")).map((r) => r.session_id);
    assert.deepEqual([...ids].sort(), ["sess_concl", "sess_step", "sess_title"]);
    // None of these sessions saved a memory: find works on sessions alone (AC-20.2).
    assert.equal((db.prepare("SELECT COUNT(*) AS c FROM memories").get() as { c: number }).c, 0);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("reasoning_find ranks by distinct terms matched, then recency (AC-20.3)", async () => {
  const { db, dir, tools } = await makeHarness("find-rank");
  try {
    insertSession(db, "sess_two", { title: "walrus migration", conclusion: "kept the narwhal index", updatedAt: "2026-09-01T00:00:00.000Z" });
    insertSession(db, "sess_one_old", { title: "walrus notes", updatedAt: "2026-09-02T00:00:00.000Z" });
    insertSession(db, "sess_one_new", { title: "walrus summary", updatedAt: "2026-09-03T00:00:00.000Z" });
    const results = await find(tools, "walrus narwhal");
    assert.deepEqual(results.map((r) => r.session_id), ["sess_two", "sess_one_new", "sess_one_old"]);
    assert.equal(results[0].matched_terms, 2);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("reasoning_find results carry the session workspace", async () => {
  const { db, dir, tools } = await makeHarness("find-workspace");
  try {
    insertSession(db, "sess_ws", { title: "tapir plan", workspace: "/proj/a", updatedAt: "2026-10-02T00:00:00.000Z" });
    insertSession(db, "sess_nows", { title: "tapir notes", updatedAt: "2026-10-01T00:00:00.000Z" });
    const byId = new Map((await find(tools, "tapir")).map((r) => [r.session_id, r]));
    assert.equal(byId.get("sess_ws")?.workspace, "/proj/a");
    assert.equal(byId.get("sess_nows")?.workspace, null);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("reasoning_find ranks empty sessions after sessions with content", async () => {
  const { db, dir, tools } = await makeHarness("find-empty-last");
  try {
    insertSession(db, "sess_content", { title: "ocelot rollout", updatedAt: "2026-09-01T00:00:00.000Z" });
    insertStep(db, "sess_content", 1, "ocelot rollout measured");
    insertSession(db, "sess_empty", {
      title: "ocelot rollout",
      status: "in_progress",
      updatedAt: "2026-10-05T00:00:00.000Z",
    });
    const results = await find(tools, "ocelot rollout");
    assert.deepEqual(results.map((r) => r.session_id), ["sess_content", "sess_empty"]);
    assert.equal(results[0].matched_terms, results[1].matched_terms);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("reasoning_find returns at most 2 bounded step excerpts per session (AC-20.4)", async () => {
  const { db, dir, tools } = await makeHarness("find-excerpts");
  try {
    insertSession(db, "sess_x", { title: "excerpt test", updatedAt: "2026-10-01T00:00:00.000Z" });
    const filler = "lorem ipsum dolor sit amet ".repeat(20);
    for (let n = 1; n <= 4; n++) insertStep(db, "sess_x", n, `${filler} pelican finding ${n} ${filler}`);
    const [result] = await find(tools, "pelican");
    assert.equal(result.excerpts.length, 2);
    for (const e of result.excerpts) {
      assert.match(e.excerpt, /pelican/);
      assert.ok(e.excerpt.length <= 160, `excerpt too long: ${e.excerpt.length}`);
    }
    assert.deepEqual(result.excerpts.map((e) => e.step_number), [1, 2]);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("reasoning_find read mode returns the full ordered trace; unknown id names find mode (AC-20.5)", async () => {
  const { db, dir, tools } = await makeHarness("find-read");
  try {
    insertSession(db, "sess_r", { title: "read me", conclusion: "done", updatedAt: "2026-10-01T00:00:00.000Z" });
    insertStep(db, "sess_r", 2, "second");
    insertStep(db, "sess_r", 1, "first");
    const res = await tools.reasoning_find.handler({ session_id: "sess_r" });
    assert.equal(res.isError, undefined);
    const out = res.structuredContent as {
      mode: string;
      session: { id: string; conclusion: string; step_count: number };
      steps: Array<{ step_number: number; thought: string }>;
    };
    assert.equal(out.mode, "read");
    assert.equal(out.session.conclusion, "done");
    assert.equal(out.session.step_count, 2);
    assert.ok("workspace" in out.session);
    assert.deepEqual(out.steps.map((s) => s.thought), ["first", "second"]);

    const missing = await tools.reasoning_find.handler({ session_id: "sess_nope" });
    assert.equal(missing.isError, true);
    assert.match(missing.content[0]?.text ?? "", /not found[\s\S]*query/);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("reasoning_find rejects both or neither of query and session_id (AC-20.6)", async () => {
  const { db, dir, tools } = await makeHarness("find-args");
  try {
    const both = await tools.reasoning_find.handler({ query: "x", session_id: "y" });
    assert.equal(both.isError, true);
    assert.match(both.content[0]?.text ?? "", /exactly one/);
    const neither = await tools.reasoning_find.handler({});
    assert.equal(neither.isError, true);
    assert.match(neither.content[0]?.text ?? "", /exactly one/);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("reasoning_find handles Vietnamese queries (AC-20.7)", async () => {
  const { db, dir, tools } = await makeHarness("find-vi");
  try {
    insertSession(db, "sess_vi", { title: "khảo sát", updatedAt: "2026-10-01T00:00:00.000Z" });
    insertStep(db, "sess_vi", 1, "Chủ dự án chọn cách tiếp cận thứ nhất cho recall");
    const results = await find(tools, "tiếp cận");
    assert.deepEqual(results.map((r) => r.session_id), ["sess_vi"]);
    assert.match(results[0].excerpts[0].excerpt, /tiếp cận/);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("reasoning_find read mode truncates oversized traces (AC-20.8)", async () => {
  const { db, dir, tools } = await makeHarness("find-truncate");
  try {
    insertSession(db, "sess_big", { title: "big", updatedAt: "2026-10-01T00:00:00.000Z" });
    for (let n = 1; n <= 10; n++) insertStep(db, "sess_big", n, "y".repeat(3000));
    const res = await tools.reasoning_find.handler({ session_id: "sess_big" });
    assert.equal(res.isError, undefined);
    assert.match(res.content[0]?.text ?? "", /truncated/);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("reasoning_find honors limit", async () => {
  const { db, dir, tools } = await makeHarness("find-limit");
  try {
    for (let n = 1; n <= 4; n++) {
      insertSession(db, `sess_${n}`, { title: `tapir note ${n}`, updatedAt: `2026-10-0${n}T00:00:00.000Z` });
    }
    const results = await find(tools, "tapir", 2);
    assert.deepEqual(results.map((r) => r.session_id), ["sess_4", "sess_3"]);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("reasoning_find cuts long conclusions to 300 characters", async () => {
  const { db, dir, tools } = await makeHarness("find-conclusion");
  try {
    insertSession(db, "sess_long", {
      title: "ocelot review",
      conclusion: `ocelot ${"verdict ".repeat(80)}`,
      updatedAt: "2026-10-01T00:00:00.000Z",
    });
    insertSession(db, "sess_short", {
      title: "ocelot summary",
      conclusion: "short  verdict",
      updatedAt: "2026-10-02T00:00:00.000Z",
    });
    const results = await find(tools, "ocelot");
    const long = results.find((r) => r.session_id === "sess_long");
    assert.equal(long?.conclusion?.length, 300);
    assert.ok(long?.conclusion?.endsWith("..."));
    assert.equal(results.find((r) => r.session_id === "sess_short")?.conclusion, "short verdict");
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("reasoning_find returns no results without error when nothing matches", async () => {
  const { db, dir, tools } = await makeHarness("find-none");
  try {
    insertSession(db, "sess_a", { title: "something else", updatedAt: "2026-10-01T00:00:00.000Z" });
    const res = await tools.reasoning_find.handler({ query: "zzyzx" });
    assert.equal(res.isError, undefined);
    const out = res.structuredContent as { results: unknown[]; total_matched: number };
    assert.deepEqual(out.results, []);
    assert.equal(out.total_matched, 0);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("reasoning_find handles more matching sessions than SQLite bind variables", async () => {
  const { db, dir, tools } = await makeHarness("find-many");
  try {
    const total = 33000;
    const insert = db.prepare(
      `INSERT INTO reasoning_sessions (id, title, agent_id, status, conclusion, workspace, created_at, updated_at)
       VALUES (?, ?, NULL, 'completed', NULL, NULL, ?, ?)`
    );
    db.exec("BEGIN");
    for (let n = 0; n < total; n++) {
      const stamp = `2026-10-01T00:00:00.${String(n % 1000).padStart(3, "0")}Z`;
      insert.run(`sess_many_${n}`, `quokka batch ${n}`, stamp, stamp);
    }
    db.exec("COMMIT");
    const res = await tools.reasoning_find.handler({ query: "quokka", limit: 3 });
    assert.equal(res.isError, undefined, res.content[0]?.text);
    const out = res.structuredContent as { results: unknown[]; total_matched: number };
    assert.equal(out.results.length, 3);
    assert.equal(out.total_matched, total);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
