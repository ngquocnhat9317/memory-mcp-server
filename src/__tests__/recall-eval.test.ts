import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runMigrations } from "../migrations/index.js";
import {
  HOME_WORKSPACE,
  RECALL_EVAL_CASES,
  type RecallEvalCase,
} from "./fixtures/recall-eval-cases.js";

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

async function makeHarness(): Promise<{
  db: DatabaseSync;
  dir: string;
  tools: RegisteredToolMap;
}> {
  const dir = fs.mkdtempSync(path.join(process.cwd(), ".tmp-memory-mcp-"));
  const db = new DatabaseSync(path.join(dir, "recall-eval.db"));
  runMigrations(db);

  const { registerMemoryTools } = await import("../tools/memory.js");
  const { registerReasoningTools } = await import("../tools/reasoning.js");
  const server = new McpServer({ name: "test-server", version: "0.0.0" });
  registerMemoryTools(server, db);
  registerReasoningTools(server, db);
  const tools = (server as unknown as { _registeredTools: RegisteredToolMap })
    ._registeredTools;
  return { db, dir, tools };
}

function seedMemories(db: DatabaseSync, evalCase: RecallEvalCase): void {
  const insert = db.prepare(
    `INSERT INTO memories (id, type, content, tags, agent_id, importance, metadata, workspace, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`
  );
  for (const memory of evalCase.seedMemories) {
    insert.run(
      memory.id,
      memory.type,
      memory.content,
      JSON.stringify(memory.tags),
      memory.importance,
      memory.metadata ? JSON.stringify(memory.metadata) : null,
      memory.workspace,
      memory.updatedAt,
      memory.updatedAt
    );
  }
}

interface RecalledRow {
  id: string;
  source?: { session_id: string; session_title: string };
  snippet?: string;
}

async function runRecall(
  tools: RegisteredToolMap,
  evalCase: RecallEvalCase
): Promise<RecalledRow[]> {
  const started = await tools.reasoning_start_session.handler({
    title: evalCase.query,
  });
  assert.equal(started.isError, undefined);
  return (
    started.structuredContent as { related_memories: RecalledRow[] }
  ).related_memories;
}

async function runSearch(
  tools: RegisteredToolMap,
  evalCase: RecallEvalCase,
  overrides: { limit?: number; offset?: number } = {}
): Promise<string[]> {
  const result = await tools.memory_search.handler({
    query: evalCase.query,
    ...(evalCase.type ? { type: evalCase.type } : {}),
    ...(evalCase.tags ? { tags: evalCase.tags } : {}),
    limit: overrides.limit ?? evalCase.limit ?? 20,
    offset: overrides.offset ?? evalCase.offset ?? 0,
  });
  assert.equal(result.isError, undefined);
  if (!result.structuredContent) {
    assert.match(result.content[0].text, /^No memories found/);
    return [];
  }
  return (
    result.structuredContent as { results: Array<{ id: string }> }
  ).results.map((row) => row.id);
}

for (const evalCase of RECALL_EVAL_CASES) {
  test(`recall-eval ${evalCase.description}`, async () => {
    const originalWorkspace = process.env.MEMORY_WORKSPACE;
    process.env.MEMORY_WORKSPACE = evalCase.workspace ?? HOME_WORKSPACE;
    const { db, dir, tools } = await makeHarness();

    try {
      seedMemories(db, evalCase);
      const expected = evalCase.expected;

      let rows: RecalledRow[];
      if (evalCase.tool === "recall") {
        rows = await runRecall(tools, evalCase);
      } else {
        rows = (await runSearch(tools, evalCase)).map((id) => ({ id }));
      }
      const ids = rows.map((row) => row.id);

      if (expected.empty) assert.deepEqual(ids, []);
      if (expected.order) assert.deepEqual(ids, expected.order);
      if (expected.top) assert.equal(ids[0], expected.top);
      for (const id of expected.includes ?? []) {
        assert.ok(ids.includes(id), `expected ${id} in ${JSON.stringify(ids)}`);
      }
      for (const id of expected.excludes ?? []) {
        assert.ok(!ids.includes(id), `expected ${id} absent from ${JSON.stringify(ids)}`);
      }
      if (expected.source) {
        const row = rows.find((r) => r.id === expected.source!.memoryId);
        assert.equal(row?.source?.session_id, expected.source.sessionId);
        assert.equal(row?.source?.session_title, expected.source.sessionTitle);
      }
      if (expected.snippetContains) {
        const row = rows.find((r) => r.id === expected.snippetContains!.memoryId);
        assert.ok(row?.snippet?.includes(expected.snippetContains.text), `snippet: ${row?.snippet}`);
      }
      if (expected.paginationStableWithPageSize) {
        const size = expected.paginationStableWithPageSize;
        assert.ok(ids.length > size, "pagination case needs more results than one page");
        const paged: string[] = [];
        for (let offset = 0; offset < ids.length + size; offset += size) {
          paged.push(...(await runSearch(tools, evalCase, { limit: size, offset })));
        }
        assert.deepEqual(paged, ids);
      }
    } finally {
      if (originalWorkspace === undefined) {
        delete process.env.MEMORY_WORKSPACE;
      } else {
        process.env.MEMORY_WORKSPACE = originalWorkspace;
      }
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
