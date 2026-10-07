import type { DatabaseSync } from "node:sqlite";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  MemoryGetInputSchema,
  MemoryRecordUsageFeedbackInputSchema,
  MemorySearchInputSchema,
  MemoryUpdateInputSchema,
  type MemoryGetInput,
  type MemoryRecordUsageFeedbackInput,
  type MemorySearchInput,
  type MemoryUpdateInput,
} from "../schemas/memory.js";
import { RECALL_RECENCY_DAYS, RECALL_WEIGHTS } from "../constants.js";
import type { MemoryRecord, MemoryRow } from "../types.js";
import {
  escapeLikePattern,
  nowIso,
  parseJsonArray,
  parseJsonObject,
  toLimitedJson,
  toSearchTerms,
} from "../utils.js";
import {
  withTelemetry,
  type ToolResponse,
} from "./telemetry.js";

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

function tagsFilterClauses(tags: string[] | undefined): {
  clause: string;
  params: string[];
} {
  if (!tags || tags.length === 0) return { clause: "", params: [] };
  const clause = tags.map(() => `tags LIKE ? ESCAPE '\\'`).join(" AND ");
  const params = tags.map((tag) => `%"${escapeLikePattern(tag)}"%`);
  return { clause: ` AND ${clause}`, params };
}

function extractStructuredContent(result: ToolResponse): Record<string, unknown> | null {
  return result.structuredContent ?? null;
}

function resultCount(result: ToolResponse): number {
  const structured = extractStructuredContent(result);
  if (structured?.total_returned !== undefined) {
    return Number(structured.total_returned);
  }
  if (Array.isArray(structured?.results)) return structured.results.length;
  return result.content[0]?.text.startsWith("No memories found") ? 0 : 1;
}

/** Ids of memories returned by a search call, bounded so telemetry rows stay small. */
function returnedMemoryIds(result: ToolResponse): string[] {
  const structured = extractStructuredContent(result);
  if (!Array.isArray(structured?.results)) return [];
  return (structured.results as Array<{ id?: unknown }>)
    .slice(0, 20)
    .map((row) => String(row.id))
    .filter((id) => id !== "undefined");
}


let defaultDatabasePromise: Promise<DatabaseSync> | null = null;

async function resolveDatabase(database?: DatabaseSync): Promise<DatabaseSync> {
  if (database) return database;
  defaultDatabasePromise ??= import("../db.js").then((module) => module.db);
  return defaultDatabasePromise;
}

export function registerMemoryTools(
  server: McpServer,
  database?: DatabaseSync
): void {
  const databaseProvider = () => resolveDatabase(database);

  server.registerTool(
    "memory_search",
    {
      title: "Search Memories",
      description:
        "Recall saved memories on a topic other than your session title (reasoning_start_session already recalls the title). Any query term may match; queries with 3+ terms need at least 2. Ranked by term coverage, relevance and recency.",
      inputSchema: MemorySearchInputSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    withTelemetry(
      {
        database: databaseProvider,
        toolName: "memory_search",
        operationType: "memory",
        accessType: "read",
        buildEvent: (params: MemorySearchInput, result) => ({
          agentId: params.agent_id ?? null,
          inputShape: {
            query_length: params.query.length,
            query_term_count: params.query.trim().split(/\s+/).filter(Boolean).length,
            has_type: params.type !== undefined,
            has_agent_id: params.agent_id !== undefined,
            has_tags: (params.tags?.length ?? 0) > 0,
            limit: params.limit,
          },
          outputShape: {
            result_count: resultCount(result),
            memory_ids: returnedMemoryIds(result),
          },
        }),
      },
      async (params: MemorySearchInput) => {
        const activeDb = await resolveDatabase(database);
        const { clause: tagClause, params: tagParams } = tagsFilterClauses(params.tags);
        const terms = toSearchTerms(params.query);
        const conditions: string[] = [];

        if (params.type) {
          conditions.push("m.type = ?");
        }
        if (params.agent_id) {
          conditions.push("m.agent_id = ?");
        }
        if (tagClause) {
          // tagClause is " AND <clauses>"; strip the prefix to compose here.
          conditions.push(tagClause.slice(" AND ".length));
        }
        const filterParams: Array<string | number> = [];
        if (params.type) filterParams.push(params.type);
        if (params.agent_id) filterParams.push(params.agent_id);

        // Any term may match (OR). `hits` counts how many distinct terms each
        // memory matches (one FTS query per term); the same floor as
        // auto-recall applies: 3+ terms need >= 2 matches, otherwise >= 1.
        // The blended score (same weights as auto-recall, minus the workspace
        // term) is computed here, not in JS, so LIMIT/OFFSET paginate over a
        // stable total order. Window aggregates normalize bm25 within the
        // final eligible set; rank is negative (more negative = better) and
        // all-equal counts as best.
        const floor = terms.length >= 3 ? 2 : 1;
        const rows =
          terms.length === 0
            ? []
            : (activeDb
                .prepare(
                  `WITH hits AS (
                     SELECT row_id, COUNT(*) AS matched FROM (
                       ${terms
                         .map(
                           () =>
                             "SELECT rowid AS row_id FROM memories_fts WHERE memories_fts MATCH ?"
                         )
                         .join(" UNION ALL ")}
                     ) GROUP BY row_id
                   ),
                   eligible AS (
                     SELECT m.*, f.rank AS fts_rank, h.matched AS matched_terms
                     FROM memories m
                     JOIN (
                       SELECT rowid, rank FROM memories_fts WHERE memories_fts MATCH ?
                     ) f ON m.rowid = f.rowid
                     JOIN hits h ON h.row_id = m.rowid
                     WHERE h.matched >= ?${
                       conditions.length > 0 ? ` AND ${conditions.join(" AND ")}` : ""
                     }
                   )
                   SELECT * FROM eligible
                   ORDER BY
                     ${RECALL_WEIGHTS.coverage} * (matched_terms * 1.0 / ${terms.length})
                     + ${RECALL_WEIGHTS.bm25} * COALESCE(
                         (MAX(fts_rank) OVER () - fts_rank)
                           / NULLIF(MAX(fts_rank) OVER () - MIN(fts_rank) OVER (), 0),
                         1.0)
                     + ${RECALL_WEIGHTS.recency} * COALESCE(
                         1.0 / (1.0 + MAX(0.0, julianday('now') - julianday(updated_at))
                                      / ${RECALL_RECENCY_DAYS}),
                         0.0) DESC,
                     importance DESC, updated_at DESC, id ASC
                   LIMIT ? OFFSET ?`
                )
                .all(
                  ...terms,
                  terms.join(" OR "),
                  floor,
                  ...filterParams,
                  ...tagParams,
                  params.limit,
                  params.offset
                ) as unknown as MemoryRow[]);

        if (rows.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No memories found matching '${params.query}'.`,
              },
            ],
          };
        }

        const results = rows.map(rowToRecord);
        const output = {
          total_returned: results.length,
          offset: params.offset,
          results,
        };
        return {
          content: [{ type: "text" as const, text: toLimitedJson(output) }],
          structuredContent: output as unknown as Record<string, unknown>,
        };
      }
    )
  );

  server.registerTool(
    "memory_get",
    {
      title: "Get Memory",
      description: "Retrieve a single memory by its id.",
      inputSchema: MemoryGetInputSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    withTelemetry(
      {
        database: databaseProvider,
        toolName: "memory_get",
        operationType: "memory",
        accessType: "read",
        buildEvent: (params: MemoryGetInput, result) => {
          const structured = extractStructuredContent(result);
          return {
            memoryId: params.id,
            outputShape: {
              found: structured !== null && result.isError !== true,
            },
          };
        },
      },
      async (params: MemoryGetInput) => {
        const activeDb = await resolveDatabase(database);
        const row = activeDb.prepare(`SELECT * FROM memories WHERE id = ?`).get(params.id) as
          | MemoryRow
          | undefined;
        if (!row) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Error: Memory '${params.id}' not found.`,
              },
            ],
            isError: true,
          };
        }
        const record = rowToRecord(row);
        return {
          content: [{ type: "text" as const, text: toLimitedJson(record) }],
          structuredContent: record as unknown as Record<string, unknown>,
        };
      }
    )
  );

  server.registerTool(
    "memory_update",
    {
      title: "Update Memory",
      description:
        "Correct a recalled memory that turned out wrong or outdated. Only the fields you pass change. `tags`/`metadata` replace the whole value; `tags_append`/`tags_remove`/`metadata_patch` change it incrementally. Pass at least one field.",
      inputSchema: MemoryUpdateInputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    withTelemetry(
      {
        database: databaseProvider,
        toolName: "memory_update",
        operationType: "memory",
        accessType: "write",
        buildEvent: (params: MemoryUpdateInput, result) => {
          const structured = extractStructuredContent(result);
          const updatedFields = [
            "content",
            "type",
            "tags",
            "tags_append",
            "tags_remove",
            "importance",
            "metadata",
            "metadata_patch",
          ].filter((field) => field in params && params[field as keyof MemoryUpdateInput] !== undefined);
          return {
            memoryId: params.id,
            inputShape: {
              updated_fields: updatedFields,
              tag_replace: params.tags !== undefined,
              tag_patch:
                params.tags_append !== undefined || params.tags_remove !== undefined,
              metadata_replace: params.metadata !== undefined,
              metadata_patch: params.metadata_patch !== undefined,
            },
            outputShape: structured
              ? {
                  memory_id: structured.id,
                  type: structured.type,
                  tag_count: Array.isArray(structured.tags) ? structured.tags.length : 0,
                }
              : null,
          };
        },
      },
      async (params: MemoryUpdateInput) => {
        const activeDb = await resolveDatabase(database);
        if (
          params.content === undefined &&
          params.type === undefined &&
          params.tags === undefined &&
          params.tags_append === undefined &&
          params.tags_remove === undefined &&
          params.importance === undefined &&
          params.metadata === undefined &&
          params.metadata_patch === undefined
        ) {
          return {
            content: [
              {
                type: "text" as const,
                text: "Error: At least one field to update (content, type, tags, tags_append, tags_remove, importance, metadata, metadata_patch) must be provided.",
              },
            ],
            isError: true,
          };
        }

        const existing = activeDb.prepare(`SELECT * FROM memories WHERE id = ?`).get(params.id) as
          | MemoryRow
          | undefined;
        if (!existing) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Error: Memory '${params.id}' not found.`,
              },
            ],
            isError: true,
          };
        }

        const existingTags = parseJsonArray(existing.tags);
        const mergedTags =
          params.tags !== undefined
            ? params.tags
            : [
                ...new Set(
                  existingTags
                    .filter((tag) => !(params.tags_remove ?? []).includes(tag))
                    .concat(params.tags_append ?? [])
                ),
              ];
        const existingMetadata = parseJsonObject(existing.metadata) ?? {};
        const mergedMetadata =
          params.metadata !== undefined
            ? params.metadata
            : params.metadata_patch !== undefined
              ? { ...existingMetadata, ...params.metadata_patch }
              : existingMetadata;

        activeDb
          .prepare(
            `UPDATE memories
             SET content=@content, type=@type, tags=@tags, importance=@importance, metadata=@metadata, updated_at=@updated_at
             WHERE id=@id`
          )
          .run({
            id: params.id,
            content: params.content ?? existing.content,
            type: params.type ?? existing.type,
            tags: JSON.stringify(mergedTags),
            importance: params.importance ?? existing.importance,
            metadata: JSON.stringify(mergedMetadata),
            updated_at: nowIso(),
          });

        const row = activeDb
          .prepare(`SELECT * FROM memories WHERE id = ?`)
          .get(params.id) as unknown as MemoryRow;
        const record = rowToRecord(row);
        return {
          content: [{ type: "text" as const, text: toLimitedJson(record) }],
          structuredContent: record as unknown as Record<string, unknown>,
        };
      }
    )
  );

  server.registerTool(
    "memory_record_usage_feedback",
    {
      title: "Record Memory Usage Feedback",
      description:
        "Record how a recalled memory turned out — usefulness is one of: used, ignored, irrelevant, stale, unsafe_to_use. For the common 'used' case, prefer used_memory_ids on reasoning_complete_session; call this tool directly for tasks without a session, or the moment a recalled memory turns out stale or wrong. Feedback is a first-party learning signal for recall quality and is always persisted locally, regardless of the MEMORY_TELEMETRY setting.",
      inputSchema: MemoryRecordUsageFeedbackInputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    withTelemetry(
      {
        database: databaseProvider,
        toolName: "memory_record_usage_feedback",
        operationType: "feedback",
        accessType: "write",
        buildEvent: (params: MemoryRecordUsageFeedbackInput, result) => ({
          agentId: params.agent_id ?? null,
          memoryId: params.memory_id,
          relatedEventId: params.event_id ?? null,
          inputShape: {
            has_event_id: params.event_id !== undefined,
            usefulness: params.usefulness,
            reason_length: params.reason?.length ?? 0,
          },
          outputShape: {
            recorded: result.structuredContent?.recorded === true,
          },
          metadata: {
            usefulness: params.usefulness,
            reason: params.reason ?? null,
          },
        }),
      },
      async (params: MemoryRecordUsageFeedbackInput) => {
        const activeDb = await resolveDatabase(database);
        const existing = activeDb
          .prepare(`SELECT id FROM memories WHERE id = ?`)
          .get(params.memory_id) as { id: string } | undefined;
        if (!existing) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Error: Memory '${params.memory_id}' not found.`,
              },
            ],
            isError: true,
          };
        }

        if (params.event_id) {
          const relatedEvent = activeDb
            .prepare(
              `SELECT id, memory_id, output_shape
               FROM tool_usage_events
               WHERE id = ?`
            )
            .get(params.event_id) as
            | { id: string; memory_id: string | null; output_shape: string | null }
            | undefined;
          const recalledIds = relatedEvent
            ? (parseJsonObject(relatedEvent.output_shape)?.memory_ids as
                | unknown[]
                | undefined)
            : undefined;
          const verified =
            relatedEvent !== undefined &&
            (relatedEvent.memory_id === params.memory_id ||
              (Array.isArray(recalledIds) &&
                recalledIds.includes(params.memory_id)));
          if (!verified) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Error: Related event '${params.event_id}' cannot be verified for memory '${params.memory_id}'. Use an event that recalled this memory (memory_get or memory_search).`,
                },
              ],
              isError: true,
            };
          }
        }

        const output = {
          recorded: true,
          memory_id: params.memory_id,
          usefulness: params.usefulness,
        };
        return {
          content: [{ type: "text" as const, text: toLimitedJson(output) }],
          structuredContent: output,
        };
      }
    )
  );
}
