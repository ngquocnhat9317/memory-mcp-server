import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { db } from "../db.js";
import {
  MemoryDeleteInputSchema,
  MemoryGetInputSchema,
  MemoryListInputSchema,
  MemorySaveInputSchema,
  MemorySearchInputSchema,
  MemoryUpdateInputSchema,
  type MemoryDeleteInput,
  type MemoryGetInput,
  type MemoryListInput,
  type MemorySaveInput,
  type MemorySearchInput,
  type MemoryUpdateInput,
} from "../schemas/memory.js";
import type { MemoryRecord, MemoryRow } from "../types.js";
import {
  handleToolError,
  newId,
  nowIso,
  parseJsonArray,
  parseJsonObject,
  toFtsQuery,
  toLimitedJson,
} from "../utils.js";

function rowToRecord(row: MemoryRow): MemoryRecord {
  return {
    id: row.id,
    type: row.type as MemoryRecord["type"],
    content: row.content,
    tags: parseJsonArray(row.tags),
    agent_id: row.agent_id,
    importance: row.importance,
    metadata: parseJsonObject(row.metadata),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** Build a `tags LIKE` filter fragment that requires ALL given tags to be present. */
function tagsFilterClauses(tags: string[] | undefined): {
  clause: string;
  params: string[];
} {
  if (!tags || tags.length === 0) return { clause: "", params: [] };
  const clause = tags.map(() => `tags LIKE ?`).join(" AND ");
  const params = tags.map((t) => `%"${t}"%`);
  return { clause: ` AND ${clause}`, params };
}

export function registerMemoryTools(server: McpServer): void {
  server.registerTool(
    "memory_save",
    {
      title: "Save Memory",
      description: `Persist a piece of long-term memory (a fact, preference, episodic event, decision, or reasoning summary) so it can be recalled in future sessions.

Args:
  - content (string, required): The memory text, 1-8000 chars. Write it as a self-contained statement that makes sense without extra context.
  - type ('fact'|'preference'|'episodic'|'decision'|'reasoning_summary', default 'fact'): Category of memory.
  - tags (string[], default []): Lowercase labels for later filtering, e.g. ["project-x","backend"].
  - importance (1-5, default 3): Use 5 for critical/must-not-forget info, 1 for trivial notes.
  - agent_id (string, optional): Identifier for the agent/persona this memory belongs to (multi-agent setups).
  - metadata (object, optional): Arbitrary extra structured data, e.g. {"source_url": "..."}.

Returns: JSON with the created memory record including its generated id.

Examples:
  - Use when: "Remember that the user prefers concise commit messages" -> content="User prefers concise, imperative-mood commit messages", type="preference"
  - Use when: after finishing a task, storing what was learned -> type="episodic" or "decision"
  - Don't use when: storing a multi-step reasoning trace (use reasoning_start_session / reasoning_add_step instead), then optionally reasoning_complete_session with save_as_memory=true to persist just the conclusion.`,
      inputSchema: MemorySaveInputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (params: MemorySaveInput) => {
      try {
        const id = newId("mem");
        const ts = nowIso();
        db.prepare(
          `INSERT INTO memories (id, type, content, tags, agent_id, importance, metadata, created_at, updated_at)
           VALUES (@id, @type, @content, @tags, @agent_id, @importance, @metadata, @created_at, @updated_at)`
        ).run({
          id,
          type: params.type,
          content: params.content,
          tags: JSON.stringify(params.tags ?? []),
          agent_id: params.agent_id ?? null,
          importance: params.importance,
          metadata: params.metadata ? JSON.stringify(params.metadata) : null,
          created_at: ts,
          updated_at: ts,
        });
        const row = db
          .prepare(`SELECT * FROM memories WHERE id = ?`)
          .get(id) as unknown as MemoryRow;
        const record = rowToRecord(row);
        return {
          content: [
            { type: "text" as const, text: `Memory saved with id ${id}.\n\n${toLimitedJson(record)}` },
          ],
          structuredContent: record as unknown as Record<string, unknown>,
        };
      } catch (error) {
        return { content: [{ type: "text" as const, text: handleToolError(error) }], isError: true };
      }
    }
  );

  server.registerTool(
    "memory_search",
    {
      title: "Search Memories",
      description: `Full-text search over saved memories (content and tags), ranked by relevance. Use this instead of memory_list when you have a specific topic/keyword to look up.

Args:
  - query (string, required): Free-text search terms, matched against content and tags (prefix matching, e.g. "auth" matches "authentication").
  - type (optional): Restrict to one memory type.
  - agent_id (optional): Restrict to one agent.
  - tags (string[], optional): Only return memories containing ALL given tags.
  - limit (1-200, default 20), offset (default 0): Pagination.

Returns: JSON with { total_returned, results: [{id, type, content, tags, importance, ...}] } ordered by search relevance.

Examples:
  - Use when: "What do we know about the user's deployment setup?" -> query="deployment setup"
  - Don't use when: you just want the most recent memories with no topic (use memory_list instead).

Error Handling:
  - Returns "No memories found matching '<query>'" if search returns empty; try broader/fewer terms.`,
      inputSchema: MemorySearchInputSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params: MemorySearchInput) => {
      try {
        const { clause: tagClause, params: tagParams } = tagsFilterClauses(params.tags);
        const conditions: string[] = ["m.rowid IN (SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?)"];
        const sqlParams: (string | number)[] = [toFtsQuery(params.query)];

        if (params.type) {
          conditions.push("m.type = ?");
          sqlParams.push(params.type);
        }
        if (params.agent_id) {
          conditions.push("m.agent_id = ?");
          sqlParams.push(params.agent_id);
        }

        const sql = `
          SELECT m.* FROM memories m
          WHERE ${conditions.join(" AND ")}${tagClause}
          ORDER BY m.importance DESC, m.updated_at DESC
          LIMIT ? OFFSET ?`;

        const rows = db
          .prepare(sql)
          .all(...sqlParams, ...tagParams, params.limit, params.offset) as unknown as MemoryRow[];

        if (rows.length === 0) {
          return {
            content: [
              { type: "text" as const, text: `No memories found matching '${params.query}'.` },
            ],
          };
        }

        const results = rows.map(rowToRecord);
        const output = { total_returned: results.length, offset: params.offset, results };
        return {
          content: [{ type: "text" as const, text: toLimitedJson(output) }],
          structuredContent: output as unknown as Record<string, unknown>,
        };
      } catch (error) {
        return { content: [{ type: "text" as const, text: handleToolError(error) }], isError: true };
      }
    }
  );

  server.registerTool(
    "memory_list",
    {
      title: "List Memories",
      description: `List saved memories with optional filters, sorted chronologically or by importance. Use this to browse recent memories or dump everything for one agent/type, without a search query.

Args:
  - type (optional): Filter by memory type.
  - agent_id (optional): Filter by agent.
  - tags (string[], optional): Only return memories containing ALL given tags.
  - min_importance (1-5, optional): Only return memories at or above this importance.
  - sort_by ('created_at'|'updated_at'|'importance', default 'updated_at'): newest/highest first.
  - limit (1-200, default 20), offset (default 0).

Returns: JSON with { total_returned, has_more, next_offset, results: [...] }.

Examples:
  - Use when: "What have we saved about project-x?" -> tags=["project-x"]
  - Use when: "Show the most important things to remember" -> sort_by="importance", min_importance=4
  - Don't use when: you have specific search terms (use memory_search for relevance ranking).`,
      inputSchema: MemoryListInputSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params: MemoryListInput) => {
      try {
        const { clause: tagClause, params: tagParams } = tagsFilterClauses(params.tags);
        const conditions: string[] = ["1=1"];
        const sqlParams: (string | number)[] = [];

        if (params.type) {
          conditions.push("type = ?");
          sqlParams.push(params.type);
        }
        if (params.agent_id) {
          conditions.push("agent_id = ?");
          sqlParams.push(params.agent_id);
        }
        if (params.min_importance !== undefined) {
          conditions.push("importance >= ?");
          sqlParams.push(params.min_importance);
        }

        const countRow = db
          .prepare(`SELECT COUNT(*) as c FROM memories WHERE ${conditions.join(" AND ")}${tagClause}`)
          .get(...sqlParams, ...tagParams) as { c: number };

        const rows = db
          .prepare(
            `SELECT * FROM memories WHERE ${conditions.join(" AND ")}${tagClause}
             ORDER BY ${params.sort_by} DESC LIMIT ? OFFSET ?`
          )
          .all(...sqlParams, ...tagParams, params.limit, params.offset) as unknown as MemoryRow[];

        const results = rows.map(rowToRecord);
        const hasMore = countRow.c > params.offset + results.length;
        const output = {
          total: countRow.c,
          total_returned: results.length,
          offset: params.offset,
          has_more: hasMore,
          ...(hasMore ? { next_offset: params.offset + results.length } : {}),
          results,
        };
        return {
          content: [{ type: "text" as const, text: toLimitedJson(output) }],
          structuredContent: output as unknown as Record<string, unknown>,
        };
      } catch (error) {
        return { content: [{ type: "text" as const, text: handleToolError(error) }], isError: true };
      }
    }
  );

  server.registerTool(
    "memory_get",
    {
      title: "Get Memory",
      description: `Retrieve a single memory by its id.

Args:
  - id (string, required): The memory id (e.g. "mem_...") as returned by memory_save, memory_search, or memory_list.

Returns: JSON of the full memory record.

Error Handling:
  - Returns "Error: Memory '<id>' not found" if the id does not exist.`,
      inputSchema: MemoryGetInputSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params: MemoryGetInput) => {
      try {
        const row = db.prepare(`SELECT * FROM memories WHERE id = ?`).get(params.id) as
          | MemoryRow
          | undefined;
        if (!row) {
          return { content: [{ type: "text" as const, text: `Error: Memory '${params.id}' not found.` }], isError: true };
        }
        const record = rowToRecord(row);
        return {
          content: [{ type: "text" as const, text: toLimitedJson(record) }],
          structuredContent: record as unknown as Record<string, unknown>,
        };
      } catch (error) {
        return { content: [{ type: "text" as const, text: handleToolError(error) }], isError: true };
      }
    }
  );

  server.registerTool(
    "memory_update",
    {
      title: "Update Memory",
      description: `Update one or more fields of an existing memory (e.g. correct its content, re-tag it, or change its importance). Fields not provided are left unchanged.

Args:
  - id (string, required): The memory id to update.
  - content (string, optional): New content text.
  - type (optional): New memory type.
  - tags (string[], optional): Replaces the full tag list (not merged).
  - importance (1-5, optional): New importance.
  - metadata (object, optional): Replaces the full metadata object (not merged).

Returns: JSON of the updated memory record.

Error Handling:
  - Returns "Error: Memory '<id>' not found" if the id does not exist.
  - Requires at least one field besides id.`,
      inputSchema: MemoryUpdateInputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params: MemoryUpdateInput) => {
      try {
        if (
          params.content === undefined &&
          params.type === undefined &&
          params.tags === undefined &&
          params.importance === undefined &&
          params.metadata === undefined
        ) {
          return {
            content: [
              { type: "text" as const, text: "Error: At least one field to update (content, type, tags, importance, metadata) must be provided." },
            ],
            isError: true,
          };
        }
        const existing = db.prepare(`SELECT * FROM memories WHERE id = ?`).get(params.id) as
          | MemoryRow
          | undefined;
        if (!existing) {
          return { content: [{ type: "text" as const, text: `Error: Memory '${params.id}' not found.` }], isError: true };
        }

        const updated = {
          content: params.content ?? existing.content,
          type: params.type ?? existing.type,
          tags: params.tags !== undefined ? JSON.stringify(params.tags) : existing.tags,
          importance: params.importance ?? existing.importance,
          metadata:
            params.metadata !== undefined ? JSON.stringify(params.metadata) : existing.metadata,
          updated_at: nowIso(),
        };

        db.prepare(
          `UPDATE memories SET content=@content, type=@type, tags=@tags, importance=@importance, metadata=@metadata, updated_at=@updated_at WHERE id=@id`
        ).run({ ...updated, id: params.id });

        const row = db.prepare(`SELECT * FROM memories WHERE id = ?`).get(params.id) as unknown as MemoryRow;
        const record = rowToRecord(row);
        return {
          content: [{ type: "text" as const, text: toLimitedJson(record) }],
          structuredContent: record as unknown as Record<string, unknown>,
        };
      } catch (error) {
        return { content: [{ type: "text" as const, text: handleToolError(error) }], isError: true };
      }
    }
  );

  server.registerTool(
    "memory_delete",
    {
      title: "Delete Memory",
      description: `Permanently delete a memory by id. This cannot be undone.

Args:
  - id (string, required): The memory id to delete.

Returns: Confirmation text.

Error Handling:
  - Returns "Error: Memory '<id>' not found" if the id does not exist (no-op, nothing deleted).`,
      inputSchema: MemoryDeleteInputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params: MemoryDeleteInput) => {
      try {
        const result = db.prepare(`DELETE FROM memories WHERE id = ?`).run(params.id);
        if (result.changes === 0) {
          return { content: [{ type: "text" as const, text: `Error: Memory '${params.id}' not found.` }], isError: true };
        }
        return { content: [{ type: "text" as const, text: `Memory '${params.id}' deleted.` }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: handleToolError(error) }], isError: true };
      }
    }
  );
}
