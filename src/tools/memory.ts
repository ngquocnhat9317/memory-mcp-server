import type { DatabaseSync } from "node:sqlite";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  MemoryAdoptionReportInputSchema,
  MemoryAgentScorecardInputSchema,
  MemoryDeleteInputSchema,
  MemoryGetInputSchema,
  MemoryListInputSchema,
  MemoryRecordUsageFeedbackInputSchema,
  MemorySaveInputSchema,
  MemorySearchInputSchema,
  MemoryUpdateInputSchema,
  MemoryUsageReportInputSchema,
  type MemoryAdoptionReportInput,
  type MemoryAgentScorecardInput,
  type MemoryDeleteInput,
  type MemoryGetInput,
  type MemoryListInput,
  type MemoryRecordUsageFeedbackInput,
  type MemorySaveInput,
  type MemorySearchInput,
  type MemoryUpdateInput,
  type MemoryUsageReportInput,
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
  const clause = tags.map(() => `tags LIKE ?`).join(" AND ");
  const params = tags.map((tag) => `%"${tag}"%`);
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

function telemetryPersistenceEnabled(): boolean {
  return process.env.MEMORY_TELEMETRY !== "off";
}

function normalizeTextDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.trim();
}

function normalizeDateBoundary(
  value: string | undefined,
  boundary: "start" | "end"
): string | undefined {
  const normalized = normalizeTextDate(value);
  if (!normalized) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    return `${normalized}${boundary === "start" ? "T00:00:00.000Z" : "T23:59:59.999Z"}`;
  }

  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(
      `Invalid date '${normalized}'. Expected YYYY-MM-DD or a valid date-time string.`
    );
  }
  return parsed.toISOString();
}

function appendAgentFilter(
  conditions: string[],
  args: Array<string | number>,
  fieldName: string,
  agentId: string | null | undefined
): void {
  if (agentId === null) {
    conditions.push(`${fieldName} IS NULL`);
    return;
  }
  if (agentId) {
    conditions.push(`${fieldName} = ?`);
    args.push(agentId);
  }
}

function buildTelemetryWhere(params: {
  agent_id?: string | null;
  client_name?: string;
  mcp_version?: string;
  date_from?: string;
  date_to?: string;
}): {
  clause: string;
  args: Array<string | number>;
} {
  const conditions = ["1=1"];
  const args: Array<string | number> = [];

  appendAgentFilter(conditions, args, "agent_id", params.agent_id);
  if (params.client_name) {
    conditions.push("client_name = ?");
    args.push(params.client_name);
  }
  if (params.mcp_version) {
    conditions.push("mcp_version = ?");
    args.push(params.mcp_version);
  }
  const dateFrom = normalizeDateBoundary(params.date_from, "start");
  if (dateFrom) {
    conditions.push("created_at >= ?");
    args.push(dateFrom);
  }
  const dateTo = normalizeDateBoundary(params.date_to, "end");
  if (dateTo) {
    conditions.push("created_at <= ?");
    args.push(dateTo);
  }

  return { clause: conditions.join(" AND "), args };
}

function buildSessionWhere(params: {
  agent_id?: string | null;
  date_from?: string;
  date_to?: string;
}): {
  clause: string;
  args: Array<string | number>;
} {
  const conditions = ["1=1"];
  const args: Array<string | number> = [];

  appendAgentFilter(conditions, args, "agent_id", params.agent_id);
  const dateFrom = normalizeDateBoundary(params.date_from, "start");
  if (dateFrom) {
    conditions.push("created_at >= ?");
    args.push(dateFrom);
  }
  const dateTo = normalizeDateBoundary(params.date_to, "end");
  if (dateTo) {
    conditions.push("created_at <= ?");
    args.push(dateTo);
  }

  return { clause: conditions.join(" AND "), args };
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
    "memory_save",
    {
      title: "Save Memory",
      description:
        "Persist a piece of long-term memory so it can be recalled in future sessions.",
      inputSchema: MemorySaveInputSchema.shape,
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
        toolName: "memory_save",
        operationType: "memory",
        accessType: "write",
        buildEvent: (params: MemorySaveInput, result) => {
          const structured = extractStructuredContent(result);
          return {
            agentId: params.agent_id ?? null,
            memoryId: typeof structured?.id === "string" ? structured.id : null,
            inputShape: {
              content_length: params.content.length,
              type: params.type,
              tag_count: params.tags?.length ?? 0,
              importance: params.importance,
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
      async (params: MemorySaveInput) => {
        const activeDb = await resolveDatabase(database);
        const id = newId("mem");
        const ts = nowIso();
        activeDb
          .prepare(
            `INSERT INTO memories (id, type, content, tags, agent_id, importance, metadata, created_at, updated_at)
             VALUES (@id, @type, @content, @tags, @agent_id, @importance, @metadata, @created_at, @updated_at)`
          )
          .run({
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
        const row = activeDb
          .prepare(`SELECT * FROM memories WHERE id = ?`)
          .get(id) as unknown as MemoryRow;
        const record = rowToRecord(row);
        return {
          content: [
            {
              type: "text" as const,
              text: `Memory saved with id ${id}.\n\n${toLimitedJson(record)}`,
            },
          ],
          structuredContent: record as unknown as Record<string, unknown>,
        };
      }
    )
  );

  server.registerTool(
    "memory_search",
    {
      title: "Search Memories",
      description:
        "Full-text search over saved memories (content and tags), ranked by relevance.",
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
            has_more:
              extractStructuredContent(result)?.has_more === true,
          },
        }),
      },
      async (params: MemorySearchInput) => {
        const activeDb = await resolveDatabase(database);
        const { clause: tagClause, params: tagParams } = tagsFilterClauses(params.tags);
        const conditions: string[] = [
          "m.rowid IN (SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?)",
        ];
        const sqlParams: Array<string | number> = [toFtsQuery(params.query)];

        if (params.type) {
          conditions.push("m.type = ?");
          sqlParams.push(params.type);
        }
        if (params.agent_id) {
          conditions.push("m.agent_id = ?");
          sqlParams.push(params.agent_id);
        }

        const rows = activeDb
          .prepare(
            `SELECT m.* FROM memories m
             WHERE ${conditions.join(" AND ")}${tagClause}
             ORDER BY m.importance DESC, m.updated_at DESC
             LIMIT ? OFFSET ?`
          )
          .all(
            ...sqlParams,
            ...tagParams,
            params.limit,
            params.offset
          ) as unknown as MemoryRow[];

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
    "memory_list",
    {
      title: "List Memories",
      description:
        "List saved memories with optional filters, sorted chronologically or by importance.",
      inputSchema: MemoryListInputSchema.shape,
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
        toolName: "memory_list",
        operationType: "memory",
        accessType: "read",
        buildEvent: (params: MemoryListInput, result) => ({
          agentId: params.agent_id ?? null,
          inputShape: {
            has_type: params.type !== undefined,
            has_agent_id: params.agent_id !== undefined,
            has_tags: (params.tags?.length ?? 0) > 0,
            min_importance: params.min_importance ?? null,
            sort_by: params.sort_by,
            limit: params.limit,
          },
          outputShape: {
            result_count: resultCount(result),
            has_more:
              extractStructuredContent(result)?.has_more === true,
          },
        }),
      },
      async (params: MemoryListInput) => {
        const activeDb = await resolveDatabase(database);
        const { clause: tagClause, params: tagParams } = tagsFilterClauses(params.tags);
        const conditions: string[] = ["1=1"];
        const sqlParams: Array<string | number> = [];

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

        const countRow = activeDb
          .prepare(
            `SELECT COUNT(*) as c FROM memories WHERE ${conditions.join(" AND ")}${tagClause}`
          )
          .get(...sqlParams, ...tagParams) as { c: number };

        const rows = activeDb
          .prepare(
            `SELECT * FROM memories WHERE ${conditions.join(" AND ")}${tagClause}
             ORDER BY ${params.sort_by} DESC LIMIT ? OFFSET ?`
          )
          .all(
            ...sqlParams,
            ...tagParams,
            params.limit,
            params.offset
          ) as unknown as MemoryRow[];

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
      description: "Update one or more fields of an existing memory.",
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
    "memory_delete",
    {
      title: "Delete Memory",
      description: "Permanently delete a memory by id.",
      inputSchema: MemoryDeleteInputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    withTelemetry(
      {
        database: databaseProvider,
        toolName: "memory_delete",
        operationType: "memory",
        accessType: "delete",
        buildEvent: (params: MemoryDeleteInput) => ({
          memoryId: params.id,
          outputShape: { deleted: true },
        }),
      },
      async (params: MemoryDeleteInput) => {
        const activeDb = await resolveDatabase(database);
        const result = activeDb.prepare(`DELETE FROM memories WHERE id = ?`).run(params.id);
        if (result.changes === 0) {
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
        return {
          content: [
            {
              type: "text" as const,
              text: `Memory '${params.id}' deleted.`,
            },
          ],
        };
      }
    )
  );

  server.registerTool(
    "memory_usage_report",
    {
      title: "Memory Usage Report",
      description:
        "Aggregate tool usage events by tool, agent, client, version, operation type, status, or day.",
      inputSchema: MemoryUsageReportInputSchema.shape,
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
        toolName: "memory_usage_report",
        operationType: "report",
        accessType: "derived",
        buildEvent: (_params: MemoryUsageReportInput, result) => ({
          outputShape: {
            row_count: Array.isArray(extractStructuredContent(result)?.groups)
              ? (extractStructuredContent(result)?.groups as unknown[]).length
              : 0,
          },
        }),
      },
      async (params: MemoryUsageReportInput) => {
        const activeDb = await resolveDatabase(database);
        const { clause, args } = buildTelemetryWhere(params);
        const groupBySql: Record<MemoryUsageReportInput["group_by"], string> = {
          tool_name: "tool_name",
          agent_id: "COALESCE(agent_id, 'unknown')",
          client_name: "COALESCE(client_name, 'unknown')",
          mcp_version: "mcp_version",
          operation_type: "operation_type",
          status: "status",
          day: "substr(created_at, 1, 10)",
        };

        const summaryRow = activeDb
          .prepare(
            `SELECT
               COUNT(*) as total_events,
               SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success_events,
               SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error_events
             FROM tool_usage_events
             WHERE ${clause}`
          )
          .get(...args) as {
          total_events: number;
          success_events: number | null;
          error_events: number | null;
        };

        const groups = activeDb
          .prepare(
            `SELECT
               ${groupBySql[params.group_by]} as key,
               COUNT(*) as event_count,
               SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success_count,
               SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error_count
             FROM tool_usage_events
             WHERE ${clause}
             GROUP BY key
             ORDER BY event_count DESC, key ASC
             LIMIT ?`
          )
          .all(...args, params.limit) as Array<{
          key: string;
          event_count: number;
          success_count: number | null;
          error_count: number | null;
        }>;

        const topErrors = activeDb
          .prepare(
            `SELECT
               COALESCE(error_code, 'unknown') as error_code,
               COUNT(*) as count
             FROM tool_usage_events
             WHERE ${clause} AND status = 'error'
             GROUP BY error_code
             ORDER BY count DESC, error_code ASC
             LIMIT 10`
          )
          .all(...args) as Array<{ error_code: string; count: number }>;

        const totalEvents = summaryRow.total_events ?? 0;
        const successEvents = summaryRow.success_events ?? 0;
        const errorEvents = summaryRow.error_events ?? 0;
        const output = {
          summary: {
            total_events: totalEvents,
            success_events: successEvents,
            error_events: errorEvents,
            success_rate: totalEvents === 0 ? 0 : successEvents / totalEvents,
            error_rate: totalEvents === 0 ? 0 : errorEvents / totalEvents,
          },
          groups,
          top_errors: topErrors,
          time_range: {
            date_from: params.date_from ?? null,
            date_to: params.date_to ?? null,
          },
        };
        return {
          content: [{ type: "text" as const, text: toLimitedJson(output) }],
          structuredContent: output,
        };
      }
    )
  );

  server.registerTool(
    "memory_adoption_report",
    {
      title: "Memory Adoption Report",
      description:
        "Summarize reasoning and memory adoption behavior using telemetry plus core session tables.",
      inputSchema: MemoryAdoptionReportInputSchema.shape,
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
        toolName: "memory_adoption_report",
        operationType: "report",
        accessType: "derived",
        buildEvent: (_params: MemoryAdoptionReportInput, result) => ({
          outputShape: {
            row_count: Array.isArray(extractStructuredContent(result)?.agent_breakdown)
              ? (extractStructuredContent(result)?.agent_breakdown as unknown[]).length
              : 0,
          },
        }),
      },
      async (params: MemoryAdoptionReportInput) => {
        const activeDb = await resolveDatabase(database);
        const sessionFilter = buildSessionWhere(params);
        const eventFilter = buildTelemetryWhere(params);

        const sessionSummary = activeDb
          .prepare(
            `SELECT
               COUNT(*) as reasoning_started,
               SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as reasoning_completed,
               SUM(CASE WHEN status = 'abandoned' THEN 1 ELSE 0 END) as reasoning_abandoned
             FROM reasoning_sessions
             WHERE ${sessionFilter.clause}`
          )
          .get(...sessionFilter.args) as {
          reasoning_started: number;
          reasoning_completed: number | null;
          reasoning_abandoned: number | null;
        };

        const zeroStepRow = activeDb
          .prepare(
            `SELECT COUNT(*) as zero_step_sessions
             FROM reasoning_sessions
             LEFT JOIN reasoning_steps
               ON reasoning_steps.session_id = reasoning_sessions.id
             WHERE ${sessionFilter.clause}
             GROUP BY reasoning_sessions.id
             HAVING COUNT(reasoning_steps.id) = 0`
          )
          .all(...sessionFilter.args) as Array<{ zero_step_sessions: number }>;

        const completionEvents = activeDb
          .prepare(
            `SELECT
               COUNT(*) as total,
               SUM(CASE WHEN json_extract(output_shape, '$.memory_id_present') = 1 THEN 1 ELSE 0 END) as with_memory,
               SUM(CASE WHEN json_extract(output_shape, '$.memory_id_present') = 0 THEN 1 ELSE 0 END) as without_memory
             FROM tool_usage_events
             WHERE ${eventFilter.clause}
               AND tool_name = 'reasoning_complete_session'
               AND status = 'success'`
          )
          .get(...eventFilter.args) as {
          total: number;
          with_memory: number | null;
          without_memory: number | null;
        };

        const skipReasonRows = activeDb
          .prepare(
            `SELECT
               COALESCE(json_extract(output_shape, '$.not_saved_reason_category'), 'none') as reason,
               COUNT(*) as count
             FROM tool_usage_events
             WHERE ${eventFilter.clause}
               AND tool_name = 'reasoning_complete_session'
               AND status = 'success'
               AND json_extract(output_shape, '$.not_saved_reason_category') IS NOT NULL
             GROUP BY reason
             ORDER BY count DESC, reason ASC`
          )
          .all(...eventFilter.args) as Array<{ reason: string; count: number }>;

        const eventSummary = activeDb
          .prepare(
            `SELECT
               SUM(CASE WHEN tool_name = 'memory_save' AND status = 'success' THEN 1 ELSE 0 END) as direct_memory_saved,
               SUM(CASE WHEN tool_name IN ('memory_search', 'memory_list', 'memory_get') AND status = 'success' THEN 1 ELSE 0 END) as memory_searched,
               SUM(CASE WHEN tool_name = 'memory_update' AND status = 'success' THEN 1 ELSE 0 END) as memory_updated,
               SUM(CASE
                     WHEN tool_name = 'memory_search' AND status = 'success'
                     THEN COALESCE(json_extract(output_shape, '$.result_count'), 0)
                     WHEN tool_name = 'memory_list' AND status = 'success'
                     THEN COALESCE(json_extract(output_shape, '$.result_count'), 0)
                     WHEN tool_name = 'memory_get' AND status = 'success'
                          AND COALESCE(json_extract(output_shape, '$.found'), 0) = 1
                     THEN 1
                     ELSE 0
                   END) as memory_recalled
             FROM tool_usage_events
             WHERE ${eventFilter.clause}`
          )
          .get(...eventFilter.args) as {
          direct_memory_saved: number | null;
          memory_searched: number | null;
          memory_updated: number | null;
          memory_recalled: number | null;
        };

        const feedbackSummary = activeDb
          .prepare(
            `SELECT
               SUM(CASE WHEN json_extract(metadata, '$.usefulness') = 'used' THEN 1 ELSE 0 END) as used_count
             FROM tool_usage_events
             WHERE ${eventFilter.clause}
               AND operation_type = 'feedback'
               AND related_event_id IS NOT NULL
               AND status = 'success'`
          )
          .get(...eventFilter.args) as { used_count: number | null };

        const agentBreakdown = activeDb
          .prepare(
            `SELECT
               COALESCE(agent_id, 'unknown') as agent_id,
               COUNT(*) as event_count
             FROM tool_usage_events
             WHERE ${eventFilter.clause}
             GROUP BY agent_id
             ORDER BY event_count DESC, agent_id ASC
             LIMIT ?`
          )
          .all(...eventFilter.args, params.limit) as Array<{
          agent_id: string;
          event_count: number;
        }>;

        const versionBreakdown = activeDb
          .prepare(
            `SELECT
               mcp_version,
               COUNT(*) as event_count
             FROM tool_usage_events
             WHERE ${eventFilter.clause}
             GROUP BY mcp_version
             ORDER BY event_count DESC, mcp_version ASC`
          )
          .all(...eventFilter.args) as Array<{
          mcp_version: string;
          event_count: number;
        }>;

        const reasoningStarted = sessionSummary.reasoning_started ?? 0;
        const reasoningCompleted = sessionSummary.reasoning_completed ?? 0;
        const zeroStepSessions = zeroStepRow.length;
        const completedWithMemory = completionEvents.with_memory ?? 0;
        const completedWithoutMemory = completionEvents.without_memory ?? 0;
        const memorySaved =
          (eventSummary.direct_memory_saved ?? 0) + completedWithMemory;

        const riskFlags: string[] = [];
        if (reasoningStarted > 0 && zeroStepSessions / reasoningStarted > 0.25) {
          riskFlags.push("high_zero_step_session_rate");
        }
        if (reasoningCompleted > 0 && completedWithMemory / reasoningCompleted < 0.3) {
          riskFlags.push("low_completion_to_memory_rate");
        }
        if ((eventSummary.memory_searched ?? 0) > 0 && (feedbackSummary.used_count ?? 0) === 0) {
          riskFlags.push("no_positive_feedback_recorded");
        }

        const output = {
          funnel: {
            reasoning_started: reasoningStarted,
            reasoning_completed: reasoningCompleted,
            reasoning_abandoned: sessionSummary.reasoning_abandoned ?? 0,
            zero_step_sessions: zeroStepSessions,
            completed_with_memory: completedWithMemory,
            completed_without_memory: completedWithoutMemory,
            skip_reason_count: skipReasonRows,
            memory_saved: memorySaved,
            memory_searched: eventSummary.memory_searched ?? 0,
            memory_recalled: eventSummary.memory_recalled ?? 0,
            memory_updated: eventSummary.memory_updated ?? 0,
            feedback_used: feedbackSummary.used_count ?? 0,
          },
          agent_breakdown: agentBreakdown,
          version_breakdown: versionBreakdown,
          risk_flags: riskFlags,
        };
        return {
          content: [{ type: "text" as const, text: toLimitedJson(output) }],
          structuredContent: output,
        };
      }
    )
  );

  server.registerTool(
    "memory_agent_scorecard",
    {
      title: "Memory Agent Scorecard",
      description:
        "Compare how different agents use memory and reasoning tools in practice.",
      inputSchema: MemoryAgentScorecardInputSchema.shape,
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
        toolName: "memory_agent_scorecard",
        operationType: "report",
        accessType: "derived",
        buildEvent: (_params: MemoryAgentScorecardInput, result) => ({
          outputShape: {
            row_count: Array.isArray(extractStructuredContent(result)?.results)
              ? (extractStructuredContent(result)?.results as unknown[]).length
              : 0,
          },
        }),
      },
      async (params: MemoryAgentScorecardInput) => {
        const activeDb = await resolveDatabase(database);
        const sessionFilter = buildSessionWhere(params);
        const telemetryFilter = buildTelemetryWhere({
          agent_id: params.agent_id,
          date_from: params.date_from,
          date_to: params.date_to,
        });

        const rows = activeDb
          .prepare(
            `SELECT DISTINCT COALESCE(agent_id, 'unknown') as agent_id
             FROM tool_usage_events
             WHERE ${telemetryFilter.clause}
               AND operation_type IN ('memory', 'reasoning', 'feedback')
             UNION
             SELECT DISTINCT COALESCE(agent_id, 'unknown') as agent_id
             FROM reasoning_sessions
             WHERE ${sessionFilter.clause}
             LIMIT ?`
          )
          .all(...telemetryFilter.args, ...sessionFilter.args, params.limit) as Array<{
          agent_id: string;
        }>;

        const results = rows.map((row) => {
          const agentId = row.agent_id === "unknown" ? null : row.agent_id;
          const agentSessionFilter = buildSessionWhere({
            agent_id: agentId,
            date_from: params.date_from,
            date_to: params.date_to,
          });
          const agentEventFilter = buildTelemetryWhere({
            agent_id: agentId,
            date_from: params.date_from,
            date_to: params.date_to,
          });

          const sessionSummary = activeDb
            .prepare(
              `SELECT
                 COUNT(*) as started,
                 SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed
               FROM reasoning_sessions
               WHERE ${agentSessionFilter.clause}`
            )
            .get(...agentSessionFilter.args) as {
            started: number;
            completed: number | null;
          };

          const avgStepsRow = activeDb
            .prepare(
              `SELECT AVG(step_count) as avg_steps
               FROM (
                 SELECT reasoning_sessions.id, COUNT(reasoning_steps.id) as step_count
                 FROM reasoning_sessions
                 LEFT JOIN reasoning_steps
                   ON reasoning_steps.session_id = reasoning_sessions.id
                 WHERE ${agentSessionFilter.clause}
                 GROUP BY reasoning_sessions.id
               )`
            )
            .get(...agentSessionFilter.args) as { avg_steps: number | null };

          const eventSummary = activeDb
            .prepare(
              `SELECT
                 COUNT(*) as total_events,
                 SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error_events,
                 SUM(CASE WHEN tool_name IN ('memory_search', 'memory_list', 'memory_get') AND status = 'success' THEN 1 ELSE 0 END) as search_events,
                 SUM(CASE WHEN tool_name = 'memory_save' AND status = 'success' THEN 1 ELSE 0 END) as direct_save_events,
                 SUM(CASE WHEN tool_name = 'reasoning_complete_session' AND status = 'success' AND json_extract(output_shape, '$.memory_id_present') = 1 THEN 1 ELSE 0 END) as completion_memory_events
               FROM tool_usage_events
               WHERE ${agentEventFilter.clause}
                 AND operation_type IN ('memory', 'reasoning', 'feedback')`
            )
            .get(...agentEventFilter.args) as {
            total_events: number;
            error_events: number | null;
            search_events: number | null;
            direct_save_events: number | null;
            completion_memory_events: number | null;
          };

          const feedbackUsed = activeDb
            .prepare(
              `SELECT COUNT(*) as count
               FROM tool_usage_events
               WHERE ${agentEventFilter.clause}
                 AND operation_type = 'feedback'
                 AND related_event_id IS NOT NULL
                 AND status = 'success'
                 AND json_extract(metadata, '$.usefulness') = 'used'`
            )
            .get(...agentEventFilter.args) as { count: number };

          const sessionsStarted = sessionSummary.started ?? 0;
          const sessionsCompleted = sessionSummary.completed ?? 0;
          const saves =
            (eventSummary.direct_save_events ?? 0) +
            (eventSummary.completion_memory_events ?? 0);
          const searchRate =
            sessionsStarted === 0
              ? 0
              : (eventSummary.search_events ?? 0) / sessionsStarted;
          const saveRate =
            sessionsCompleted === 0 ? 0 : saves / sessionsCompleted;
          const reuseRate = saves === 0 ? 0 : feedbackUsed.count / saves;
          const errorRate =
            eventSummary.total_events === 0
              ? 0
              : (eventSummary.error_events ?? 0) / eventSummary.total_events;

          let dominantBehavior = "balanced";
          if (sessionsStarted > 0 && saveRate < 0.3) dominantBehavior = "reasoning-heavy";
          if ((eventSummary.search_events ?? 0) === 0 && saves === 0) {
            dominantBehavior = "memory-light";
          }
          if (searchRate > 1 && feedbackUsed.count === 0) {
            dominantBehavior = "search-only";
          }
          if (saves > sessionsCompleted && reuseRate < 0.2) {
            dominantBehavior = "noisy-writer";
          }
          if (errorRate > 0.2) dominantBehavior = "error-prone";

          const recommendationMap: Record<string, string> = {
            balanced: "Current usage is balanced; keep validating save quality with feedback.",
            "reasoning-heavy": "Persist more durable conclusions after completed sessions.",
            "memory-light": "Use memory_search or memory_save when prior context or durable outcomes matter.",
            "search-only": "Record feedback on recalled memories to measure usefulness.",
            "noisy-writer": "Tighten save criteria and favor durable summaries over raw notes.",
            "error-prone": "Audit failing tool calls and validate inputs before writes.",
          };

          return {
            agent_id: row.agent_id,
            sessions_started: sessionsStarted,
            sessions_completed: sessionsCompleted,
            avg_steps_per_session: avgStepsRow.avg_steps ?? 0,
            save_rate: saveRate,
            search_rate: searchRate,
            reuse_rate: reuseRate,
            error_rate: errorRate,
            dominant_behavior: dominantBehavior,
            recommendations: recommendationMap[dominantBehavior],
          };
        });

        const output = { results };
        return {
          content: [{ type: "text" as const, text: toLimitedJson(output) }],
          structuredContent: output,
        };
      }
    )
  );

  server.registerTool(
    "memory_record_usage_feedback",
    {
      title: "Record Memory Usage Feedback",
      description:
        "Record whether a recalled memory was used, ignored, stale, or unsafe to use.",
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
            recorded: result.isError !== true,
            event_id:
              typeof result.structuredContent?.event_id === "string"
                ? result.structuredContent.event_id
                : null,
          },
          metadata: {
            usefulness: params.usefulness,
            reason: params.reason ?? null,
          },
        }),
      },
      async (params: MemoryRecordUsageFeedbackInput) => {
        if (!telemetryPersistenceEnabled()) {
          return {
            content: [
              {
                type: "text" as const,
                text: "Error: Telemetry persistence is disabled; memory feedback cannot be recorded.",
              },
            ],
            isError: true,
          };
        }

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
              `SELECT id
               FROM tool_usage_events
               WHERE id = ?
                 AND tool_name = 'memory_get'
                 AND memory_id = ?`
            )
            .get(params.event_id, params.memory_id) as { id: string } | undefined;
          if (!relatedEvent) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Error: Related event '${params.event_id}' cannot be verified for memory '${params.memory_id}'. Use a matching memory_get event.`,
                },
              ],
              isError: true,
            };
          }
        }

        const output = {
          event_id: null,
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
