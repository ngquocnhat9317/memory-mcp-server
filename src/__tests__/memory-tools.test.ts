import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runMigrations } from "../migrations/index.js";

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

test("memory_save then memory_get round-trips all fields", async () => {
  const { toolDb, toolDir, tools } = await makeMemoryToolHarness("memory-roundtrip");

  try {
    const saved = await tools.memory_save.handler({
      content: "User prefers TypeScript for backend services",
      type: "preference",
      tags: ["backend", "typescript"],
      importance: 4,
      agent_id: "agent-a",
      metadata: { source: "review" },
    });
    assert.equal(saved.isError, undefined);
    const savedPayload = saved.structuredContent as {
      id: string;
      type: string;
      content: string;
      tags: string[];
      importance: number;
      agent_id: string | null;
      metadata: Record<string, unknown> | null;
    };
    assert.match(savedPayload.id, /^mem_/);

    const fetched = await tools.memory_get.handler({ id: savedPayload.id });
    assert.equal(fetched.isError, undefined);
    const fetchedPayload = fetched.structuredContent as typeof savedPayload;
    assert.equal(fetchedPayload.content, "User prefers TypeScript for backend services");
    assert.equal(fetchedPayload.type, "preference");
    assert.deepEqual(fetchedPayload.tags, ["backend", "typescript"]);
    assert.equal(fetchedPayload.importance, 4);
    assert.equal(fetchedPayload.agent_id, "agent-a");
    assert.deepEqual(fetchedPayload.metadata, { source: "review" });
  } finally {
    toolDb.close();
    fs.rmSync(toolDir, { recursive: true, force: true });
  }
});

test("memory_search matches content via FTS and honors type filter", async () => {
  const { toolDb, toolDir, tools } = await makeMemoryToolHarness("memory-search");

  try {
    await tools.memory_save.handler({
      content: "Checkout flow uses optimistic locking",
      type: "fact",
      tags: [],
      importance: 3,
    });
    await tools.memory_save.handler({
      content: "Decided to keep optimistic locking after the incident",
      type: "decision",
      tags: [],
      importance: 3,
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

test("tag filters treat LIKE wildcards literally", async () => {
  const { toolDb, toolDir, tools } = await makeMemoryToolHarness("memory-tags");

  try {
    await tools.memory_save.handler({
      content: "memory tagged with a literal percent tag",
      type: "fact",
      tags: ["a%b"],
      importance: 3,
    });
    await tools.memory_save.handler({
      content: "memory tagged with a plain tag",
      type: "fact",
      tags: ["aXb"],
      importance: 3,
    });

    const listed = await tools.memory_list.handler({
      tags: ["a%b"],
      sort_by: "updated_at",
      limit: 20,
      offset: 0,
    });
    assert.equal(listed.isError, undefined);
    const listedPayload = listed.structuredContent as {
      total: number;
      results: Array<{ tags: string[] }>;
    };
    assert.equal(listedPayload.total, 1);
    assert.deepEqual(listedPayload.results[0].tags, ["a%b"]);

    const underscore = await tools.memory_list.handler({
      tags: ["a_b"],
      sort_by: "updated_at",
      limit: 20,
      offset: 0,
    });
    const underscorePayload = underscore.structuredContent as { total: number };
    assert.equal(underscorePayload.total, 0);
  } finally {
    toolDb.close();
    fs.rmSync(toolDir, { recursive: true, force: true });
  }
});

test("memory_list filters by importance and paginates deterministically", async () => {
  const { toolDb, toolDir, tools } = await makeMemoryToolHarness("memory-list");

  try {
    for (let i = 1; i <= 5; i += 1) {
      await tools.memory_save.handler({
        content: `list item ${i}`,
        type: "fact",
        tags: [],
        importance: i,
      });
    }

    const important = await tools.memory_list.handler({
      min_importance: 4,
      sort_by: "importance",
      limit: 20,
      offset: 0,
    });
    const importantPayload = important.structuredContent as {
      total: number;
      results: Array<{ importance: number }>;
    };
    assert.equal(importantPayload.total, 2);
    assert.deepEqual(
      importantPayload.results.map((row) => row.importance),
      [5, 4]
    );

    const firstPage = await tools.memory_list.handler({
      sort_by: "importance",
      limit: 2,
      offset: 0,
    });
    const firstPayload = firstPage.structuredContent as {
      total: number;
      total_returned: number;
      has_more: boolean;
      next_offset?: number;
    };
    assert.equal(firstPayload.total, 5);
    assert.equal(firstPayload.total_returned, 2);
    assert.equal(firstPayload.has_more, true);
    assert.equal(firstPayload.next_offset, 2);

    const lastPage = await tools.memory_list.handler({
      sort_by: "importance",
      limit: 2,
      offset: 4,
    });
    const lastPayload = lastPage.structuredContent as {
      total_returned: number;
      has_more: boolean;
      next_offset?: number;
    };
    assert.equal(lastPayload.total_returned, 1);
    assert.equal(lastPayload.has_more, false);
    assert.equal(lastPayload.next_offset, undefined);
  } finally {
    toolDb.close();
    fs.rmSync(toolDir, { recursive: true, force: true });
  }
});

test("memory_update patches tags and metadata without clobbering other fields", async () => {
  const { toolDb, toolDir, tools } = await makeMemoryToolHarness("memory-update");

  try {
    const saved = await tools.memory_save.handler({
      content: "original content",
      type: "fact",
      tags: ["keep", "drop"],
      importance: 2,
      metadata: { a: 1, b: 2 },
    });
    const memoryId = (saved.structuredContent as { id: string }).id;

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

test("memory_delete removes the row and reports missing ids", async () => {
  const { toolDb, toolDir, tools } = await makeMemoryToolHarness("memory-delete");

  try {
    const saved = await tools.memory_save.handler({
      content: "to be deleted",
      type: "fact",
      tags: [],
      importance: 3,
    });
    const memoryId = (saved.structuredContent as { id: string }).id;

    const deleted = await tools.memory_delete.handler({ id: memoryId });
    assert.equal(deleted.isError, undefined);
    assert.match(deleted.content[0].text, /deleted/);

    const fetched = await tools.memory_get.handler({ id: memoryId });
    assert.equal(fetched.isError, true);
    assert.match(fetched.content[0].text, /not found/);

    const again = await tools.memory_delete.handler({ id: memoryId });
    assert.equal(again.isError, true);
    assert.match(again.content[0].text, /not found/);
  } finally {
    toolDb.close();
    fs.rmSync(toolDir, { recursive: true, force: true });
  }
});
