import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runMigrations } from "../migrations/index.js";
import { insertMemory } from "./fixtures/memory-seed.js";

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

async function makeMemoryToolHarness(name: string): Promise<{
  toolDb: DatabaseSync;
  toolDir: string;
  tools: RegisteredToolMap;
}> {
  const toolDbPath = makeWorkspaceDbPath(name);
  const toolDir = path.dirname(toolDbPath);
  const toolDb = new DatabaseSync(toolDbPath);
  runMigrations(toolDb);

  const { registerMemoryTools } = await import("../tools/memory.js");
  const server = new McpServer({ name: "test-server", version: "1.1.5" });
  registerMemoryTools(server, toolDb);

  const tools = (server as unknown as { _registeredTools: RegisteredToolMap })
    ._registeredTools;
  return { toolDb, toolDir, tools };
}

test("memory_get returns every stored field", async () => {
  const { toolDb, toolDir, tools } = await makeMemoryToolHarness("get-fields");

  try {
    const id = insertMemory(toolDb, {
      content: "Round trip content",
      type: "decision",
      tags: ["alpha", "beta"],
      agentId: "agent-x",
      importance: 4,
      metadata: { source: "test" },
    });
    const got = await tools.memory_get.handler({ id });
    assert.equal(got.isError, undefined);
    const record = got.structuredContent as Record<string, unknown>;
    assert.equal(record.id, id);
    assert.equal(record.content, "Round trip content");
    assert.equal(record.type, "decision");
    assert.deepEqual(record.tags, ["alpha", "beta"]);
    assert.equal(record.agent_id, "agent-x");
    assert.equal(record.importance, 4);
    assert.deepEqual(record.metadata, { source: "test" });
  } finally {
    toolDb.close();
    fs.rmSync(toolDir, { recursive: true, force: true });
  }
});

test("memory_search matches content via FTS and honors type filter", async () => {
  const { toolDb, toolDir, tools } = await makeMemoryToolHarness("memory-search");

  try {
    insertMemory(toolDb, {
      content: "Checkout flow uses optimistic locking",
      type: "fact",
    });
    insertMemory(toolDb, {
      content: "Decided to keep optimistic locking after the incident",
      type: "decision",
    });

    const all = await tools.memory_search.handler({
      query: "optimistic locking",
      limit: 20,
      offset: 0,
    });
    assert.equal(all.isError, undefined);
    const allPayload = all.structuredContent as {
      total_returned: number;
      results: Array<{ type: string }>;
    };
    assert.equal(allPayload.total_returned, 2);

    const decisionsOnly = await tools.memory_search.handler({
      query: "optimistic locking",
      type: "decision",
      limit: 20,
      offset: 0,
    });
    const decisionsPayload = decisionsOnly.structuredContent as {
      total_returned: number;
      results: Array<{ type: string }>;
    };
    assert.equal(decisionsPayload.total_returned, 1);
    assert.equal(decisionsPayload.results[0].type, "decision");

    const none = await tools.memory_search.handler({
      query: "pessimistic",
      limit: 20,
      offset: 0,
    });
    assert.equal(none.isError, undefined);
    assert.equal(none.structuredContent, undefined);
    assert.match(none.content[0].text, /No memories found/);
  } finally {
    toolDb.close();
    fs.rmSync(toolDir, { recursive: true, force: true });
  }
});

test("memory_search tag filters treat LIKE wildcards literally", async () => {
  const { toolDb, toolDir, tools } = await makeMemoryToolHarness("memory-tags");

  try {
    insertMemory(toolDb, { content: "memory tagged with a literal percent tag", tags: ["a%b"] });
    insertMemory(toolDb, { content: "memory tagged with a plain tag", tags: ["aXb"] });

    const percent = await tools.memory_search.handler({
      query: "memory tagged",
      tags: ["a%b"],
      limit: 20,
      offset: 0,
    });
    assert.equal(percent.isError, undefined);
    const percentPayload = percent.structuredContent as {
      total_returned: number;
      results: Array<{ tags: string[] }>;
    };
    assert.equal(percentPayload.total_returned, 1);
    assert.deepEqual(percentPayload.results[0].tags, ["a%b"]);

    const underscore = await tools.memory_search.handler({
      query: "memory tagged",
      tags: ["a_b"],
      limit: 20,
      offset: 0,
    });
    assert.equal(underscore.structuredContent, undefined);
    assert.match(underscore.content[0]?.text ?? "", /No memories found/);
  } finally {
    toolDb.close();
    fs.rmSync(toolDir, { recursive: true, force: true });
  }
});

test("memory_update patches tags and metadata without clobbering other fields", async () => {
  const { toolDb, toolDir, tools } = await makeMemoryToolHarness("memory-update");

  try {
    const memoryId = insertMemory(toolDb, {
      content: "original content",
      type: "fact",
      tags: ["keep", "drop"],
      importance: 2,
      metadata: { a: 1, b: 2 },
    });

    const noFields = await tools.memory_update.handler({ id: memoryId });
    assert.equal(noFields.isError, true);
    assert.match(noFields.content[0].text, /At least one field/);

    const patched = await tools.memory_update.handler({
      id: memoryId,
      tags_append: ["added"],
      tags_remove: ["drop"],
      metadata_patch: { b: 3, c: 4 },
      importance: 5,
    });
    assert.equal(patched.isError, undefined);
    const patchedPayload = patched.structuredContent as {
      content: string;
      type: string;
      tags: string[];
      importance: number;
      metadata: Record<string, unknown>;
    };
    assert.equal(patchedPayload.content, "original content");
    assert.equal(patchedPayload.type, "fact");
    assert.deepEqual(patchedPayload.tags, ["keep", "added"]);
    assert.equal(patchedPayload.importance, 5);
    assert.deepEqual(patchedPayload.metadata, { a: 1, b: 3, c: 4 });

    const replaced = await tools.memory_update.handler({
      id: memoryId,
      tags: ["only"],
      metadata: { fresh: true },
    });
    const replacedPayload = replaced.structuredContent as {
      tags: string[];
      metadata: Record<string, unknown>;
    };
    assert.deepEqual(replacedPayload.tags, ["only"]);
    assert.deepEqual(replacedPayload.metadata, { fresh: true });

    const missing = await tools.memory_update.handler({
      id: "mem_missing",
      content: "does not matter",
    });
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /not found/);
  } finally {
    toolDb.close();
    fs.rmSync(toolDir, { recursive: true, force: true });
  }
});
