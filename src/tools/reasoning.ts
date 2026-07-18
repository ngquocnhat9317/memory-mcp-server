import type { DatabaseSync } from "node:sqlite";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ReasoningAddStepInputSchema,
  ReasoningCompleteSessionInputSchema,
  ReasoningGetSessionOutlineInputSchema,
  ReasoningGetTraceInputSchema,
  ReasoningListMilestonesInputSchema,
  ReasoningListSessionsInputSchema,
  ReasoningMarkStepInputSchema,
  ReasoningSearchStepsInputSchema,
  ReasoningStartSessionInputSchema,
  type ReasoningAddStepInput,
  type ReasoningCompleteSessionInput,
  type ReasoningGetSessionOutlineInput,
  type ReasoningGetTraceInput,
  type ReasoningListMilestonesInput,
  type ReasoningListSessionsInput,
  type ReasoningMarkStepInput,
  type ReasoningSearchStepsInput,
  type ReasoningStartSessionInput,
} from "../schemas/reasoning.js";
import type {
  ReasoningMilestoneRecord,
  ReasoningOutlineStepRecord,
  ReasoningSearchStepRecord,
  ReasoningStepMarkRow,
  ReasoningSessionRecord,
  ReasoningSessionRow,
  ReasoningStepRecord,
} from "../types.js";
import { AUTO_RECALL_LIMIT, SESSION_TTL_HOURS, getWorkspace } from "../constants.js";
import {
  handleToolError,
  newId,
  nowIso,
  parseJsonArray,
  parseJsonObject,
  toFtsQuery,
  toRecallTerms,
  toLimitedJson,
} from "../utils.js";
import { recordToolUsageEvent, withTelemetry } from "./telemetry.js";

function sessionRowToRecord(
  row: ReasoningSessionRow,
  stepCount: number
): ReasoningSessionRecord {
  return {
    id: row.id,
    title: row.title,
    agent_id: row.agent_id,
    status: row.status as ReasoningSessionRecord["status"],
    conclusion: row.conclusion,
    created_at: row.created_at,
    updated_at: row.updated_at,
    step_count: stepCount,
  };
}

function getStepCount(database: DatabaseSync, sessionId: string): number {
  const row = database
    .prepare(`SELECT COUNT(*) as c FROM reasoning_steps WHERE session_id = ?`)
    .get(sessionId) as { c: number };
  return row.c;
}

function getNextStepNumber(database: DatabaseSync, sessionId: string): number {
  const row = database
    .prepare(
      `SELECT COALESCE(MAX(step_number), 0) as max_step
       FROM reasoning_steps
       WHERE session_id = ?`
    )
    .get(sessionId) as { max_step: number };
  return row.max_step + 1;
}

function shouldAutoSaveMemory(
  params: ReasoningCompleteSessionInput,
  stepCount: number
): boolean {
  if (params.memory_mode === "never") return false;
  if (params.save_as_memory || params.memory_mode === "always") return true;
  return false;
}

function buildNotSavedReason(
  params: ReasoningCompleteSessionInput,
  stepCount: number
): string | null {
  if (params.memory_mode === "never") {
    return params.not_saved_reason ?? "Skipped by caller request.";
  }
  if (params.status !== "completed") {
    return "Session did not complete successfully.";
  }
  if (stepCount === 0) {
    return "Session has no reasoning steps; skipping durable memory to avoid empty summaries.";
  }
  return null;
}

function runInTransaction<T>(
  database: DatabaseSync,
  work: () => T
): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Ignore rollback errors so the original failure is preserved.
    }
    throw error;
  }
}

type ReasoningSessionListRow = ReasoningSessionRow & { step_count: number };
type ReasoningSearchStepRow = ReasoningStepRecord & { agent_id: string | null };
type ReasoningMilestoneRow = {
  session_id: string;
  step_id: string;
  step_number: number;
  mark_type: string;
  note: string | null;
  created_at: string;
  thought: string | null;
  action: string | null;
  observation: string | null;
};
type ReasoningOutlineMarkedRow = ReasoningStepRecord & {
  mark_type: string;
  note: string | null;
  mark_created_at: string;
};

function compactSnippetText(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > 160 ? `${compact.slice(0, 157)}...` : compact;
}

function queryTokens(query: string): string[] {
  return query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => token.toLowerCase());
}

function buildReasoningSnippet(step: ReasoningStepRecord, query: string): string {
  const fields = [step.thought, step.action, step.observation];
  const tokens = queryTokens(query);

  if (tokens.length > 0) {
    const matchingField = fields.find((field) => {
      if (!field) return false;
      const lower = field.toLowerCase();
      return tokens.some((token) => lower.includes(token));
    });
    if (matchingField) return compactSnippetText(matchingField);
  }

  const source = step.thought ?? step.action ?? step.observation ?? "";
  return compactSnippetText(source);
}

function stepToOutlineRecord(
  step: ReasoningStepRecord,
  mark_type: ReasoningOutlineStepRecord["mark_type"] = null,
  note: string | null = null
): ReasoningOutlineStepRecord {
  const {
    id,
    session_id,
    step_number,
    thought,
    action,
    observation,
    created_at,
  } = step;
  return {
    id,
    session_id,
    step_number,
    thought,
    action,
    observation,
    created_at,
    mark_type,
    note,
  };
}

function selectFallbackOutlineSteps(
  steps: ReasoningStepRecord[]
): ReasoningStepRecord[] {
  if (steps.length <= 2) return steps;

  const middleIndex = Math.floor((steps.length - 1) / 2);
  return [steps[0], steps[middleIndex], steps[steps.length - 1]];
}

let defaultDatabasePromise: Promise<DatabaseSync> | null = null;

async function resolveDatabase(database?: DatabaseSync): Promise<DatabaseSync> {
  if (database) return database;
  defaultDatabasePromise ??= import("../db.js").then((module) => module.db);
  return defaultDatabasePromise;
}

interface RelatedMemoryRecord {
  id: string;
  type: string;
  importance: number;
  tags: string[];
  snippet: string;
  /** Present only for memories persisted from a reasoning session. */
  source?: {
    session_id: string;
    session_title: string;
    created_at: string;
  };
}

function abandonStaleSessions(database: DatabaseSync, now: string): number {
  if (SESSION_TTL_HOURS <= 0) return 0;
  const cutoff = new Date(
    Date.now() - SESSION_TTL_HOURS * 3_600_000
  ).toISOString();
  const result = database
    .prepare(
      `UPDATE reasoning_sessions
       SET status = 'abandoned',
           conclusion = COALESCE(conclusion, 'auto-abandoned: stale session'),
           updated_at = ?
       WHERE status = 'in_progress' AND updated_at < ?`
    )
    .run(now, cutoff);
  return Number(result.changes);
}

/** Candidate pool fetched by BM25 before the floor/re-rank pass. */
const RECALL_CANDIDATE_POOL = 50;

function recallRelatedMemories(
  database: DatabaseSync,
  title: string
): RelatedMemoryRecord[] {
  if (AUTO_RECALL_LIMIT <= 0) return [];
  try {
    const terms = toRecallTerms(title);
    if (terms.length === 0) return [];

    const candidates = database
      .prepare(
        `SELECT m.rowid AS row_id, m.id, m.type, m.content, m.tags,
                m.importance, m.metadata, m.created_at, m.updated_at,
                f.rank AS fts_rank,
                CASE
                  WHEN m.workspace = ?     THEN 2
                  WHEN m.workspace IS NULL THEN 1
                  ELSE 0
                END AS workspace_priority
         FROM memories m
         JOIN (
           SELECT rowid, rank FROM memories_fts WHERE memories_fts MATCH ?
         ) f ON m.rowid = f.rowid
         ORDER BY f.rank ASC
         LIMIT ?`
      )
      .all(getWorkspace(), terms.join(" OR "), RECALL_CANDIDATE_POOL) as Array<{
      row_id: number;
      id: string;
      type: string;
      content: string;
      tags: string | null;
      importance: number;
      metadata: string | null;
      created_at: string;
      updated_at: string;
      fts_rank: number;
      workspace_priority: number;
    }>;
    if (candidates.length === 0) return [];

    // Count how many title terms each candidate matches (one cheap FTS
    // query per term, capped at 8 by toRecallTerms).
    const matchCounts = new Map<number, number>();
    for (const term of terms) {
      const rowIds = database
        .prepare(`SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?`)
        .all(term) as Array<{ rowid: number }>;
      for (const row of rowIds) {
        matchCounts.set(row.rowid, (matchCounts.get(row.rowid) ?? 0) + 1);
      }
    }
    const scored = candidates.map((candidate) => ({
      ...candidate,
      matched: matchCounts.get(candidate.row_id) ?? 1,
    }));

    // Quality floor: multi-term titles require at least two matched terms.
    // When nothing clears it, fall back to the single best-ranked match
    // (serendipity lifeline) instead of padding every slot with junk.
    const required = terms.length >= 3 ? 2 : 1;
    let pool = scored.filter((candidate) => candidate.matched >= required);
    let limit = AUTO_RECALL_LIMIT;
    if (pool.length === 0) {
      pool = scored;
      limit = Math.min(1, AUTO_RECALL_LIMIT);
    }

    pool.sort(
      (a, b) =>
        b.matched - a.matched ||
        b.workspace_priority - a.workspace_priority ||
        a.fts_rank - b.fts_rank ||
        b.importance - a.importance ||
        (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0)
    );

    return pool.slice(0, limit).map((row) => {
      const metadata = parseJsonObject(row.metadata);
      const sourceSessionId = metadata?.source_session_id;
      const sourceSessionTitle = metadata?.session_title;
      return {
        id: row.id,
        type: row.type,
        importance: row.importance,
        tags: parseJsonArray(row.tags),
        snippet: compactSnippetText(row.content),
        ...(typeof sourceSessionId === "string" &&
        typeof sourceSessionTitle === "string"
          ? {
              source: {
                session_id: sourceSessionId,
                session_title: sourceSessionTitle,
                created_at: row.created_at,
              },
            }
          : {}),
      };
    });
  } catch {
    // Recall is best-effort; a bad FTS query must never block session creation.
    return [];
  }
}

export function registerReasoningTools(
  server: McpServer,
  database?: DatabaseSync
): void {
  const databaseProvider = () => resolveDatabase(database);

  server.registerTool(
    "reasoning_start_session",
    {
      title: "Start Reasoning Session",
      description: `Start a new reasoning session to record a multi-step chain of thought for a task or question. Call this once at the start of a non-trivial task, then log each step with reasoning_add_step, and finish with reasoning_complete_session.

Args:
  - title (string, required): Short description of the task/question, e.g. "Diagnose flaky checkout test".
  - agent_id (string, optional): Identifier for the agent/persona running this session.

Returns: JSON with the new session's id (pass it to reasoning_add_step and reasoning_complete_session), plus:
  - related_memories: up to a few saved memories relevant to the title, auto-recalled by the server — ranked by text relevance, softly preferring the current workspace; weak one-word matches are filtered out, so a short or empty list is normal. Review them before starting work; if one helps, report it later via used_memory_ids on reasoning_complete_session. Memories persisted from a past reasoning session carry a 'source' field ({session_id, session_title, created_at}); pass source.session_id to reasoning_get_trace to replay how that conclusion was reached.
  - open_sessions / open_sessions_warning: other in_progress sessions. Close the ones you opened and finished; leave sessions you don't recognize alone (they may belong to another agent or run).
  - auto_abandoned_sessions: count of stale in_progress sessions the server just cleaned up, if any.

Examples:
  - Use when: starting to debug a complex issue, plan a multi-step task, or work through a decision with tradeoffs.
  - Don't use when: the answer is a single simple lookup (just use memory_save/memory_search directly).`,
      inputSchema: ReasoningStartSessionInputSchema.shape,
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
        toolName: "reasoning_start_session",
        operationType: "reasoning",
        accessType: "write",
        buildEvent: (params: ReasoningStartSessionInput, result) => ({
          agentId: params.agent_id ?? null,
          sessionId:
            typeof result.structuredContent?.session_id === "string"
              ? result.structuredContent.session_id
              : null,
          outputShape: {
            session_id: result.structuredContent?.session_id ?? null,
            related_memory_count: Array.isArray(
              result.structuredContent?.related_memories
            )
              ? result.structuredContent.related_memories.length
              : 0,
            open_session_count: Array.isArray(
              result.structuredContent?.open_sessions
            )
              ? result.structuredContent.open_sessions.length
              : 0,
            auto_abandoned_sessions:
              result.structuredContent?.auto_abandoned_sessions ?? 0,
          },
        }),
      },
      async (params: ReasoningStartSessionInput) => {
      try {
        const activeDb = await resolveDatabase(database);
        const id = newId("sess");
        const ts = nowIso();
        const autoAbandoned = abandonStaleSessions(activeDb, ts);
        activeDb
          .prepare(
            `INSERT INTO reasoning_sessions (id, title, agent_id, status, conclusion, created_at, updated_at)
             VALUES (?, ?, ?, 'in_progress', NULL, ?, ?)`
          )
          .run(id, params.title, params.agent_id ?? null, ts, ts);

        const openSessions = activeDb
          .prepare(
            `SELECT id, title, updated_at FROM reasoning_sessions
             WHERE status = 'in_progress' AND id != ?
             ORDER BY updated_at DESC
             LIMIT 5`
          )
          .all(id) as Array<{ id: string; title: string; updated_at: string }>;

        const relatedMemories = recallRelatedMemories(activeDb, params.title);

        const output = {
          session_id: id,
          title: params.title,
          status: "in_progress" as const,
          related_memories: relatedMemories,
          ...(openSessions.length > 0
            ? {
                open_sessions_warning: `You have ${openSessions.length} other in_progress session(s). Close the ones you opened and finished with reasoning_complete_session; leave sessions you don't recognize alone.`,
                open_sessions: openSessions,
              }
            : {}),
          ...(autoAbandoned > 0
            ? { auto_abandoned_sessions: autoAbandoned }
            : {}),
        };
        let recallNote = "";
        if (relatedMemories.length > 0) {
          recallNote = ` Found ${relatedMemories.length} related memories — review them before starting.`;
        } else {
          // One-time cold-start nudge: only while the store is completely
          // empty, so it disappears forever after the first saved memory.
          const anyMemory = activeDb
            .prepare(`SELECT EXISTS(SELECT 1 FROM memories) as e`)
            .get() as { e: number };
          if (anyMemory.e === 0) {
            recallNote =
              " No memories yet — when you complete this session, persist durable conclusions with save_as_memory=true so future sessions can recall them.";
          }
        }
        return {
          content: [
            {
              type: "text" as const,
              text: `Reasoning session started with id ${id}.${recallNote}\n\n${toLimitedJson(output)}`,
            },
          ],
          structuredContent: output as unknown as Record<string, unknown>,
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: handleToolError(error) }],
          isError: true,
        };
      }
      }
    )
  );

  server.registerTool(
    "reasoning_add_step",
    {
      title: "Add Reasoning Step",
      description: `Append one step (thought / action / observation) — or a batch of steps — to an existing reasoning session. Steps are numbered automatically in the order added.

Args:
  - session_id (string, required): Id from reasoning_start_session.
  - thought (string, optional): The reasoning/thinking at this step.
  - action (string, optional): The action taken, if any.
  - observation (string, optional): The result observed, if any.
  - steps (array, optional): Batch mode — log up to 20 steps in one call, each {thought?, action?, observation?} with at least one field. Use INSTEAD of the top-level fields (not together), e.g. to record several steps of finished work at once.
  (Either steps, or at least one of thought/action/observation, is required.)

Returns: single mode — JSON with the new step's id and step_number; batch mode — JSON with steps: [{step_id, step_number}, ...] in insertion order.

Error Handling:
  - Returns an error if session_id does not exist (call reasoning_start_session first, or reasoning_list_sessions to find the right id).
  - Returns an error if the session is already 'completed' or 'abandoned'.`,
      inputSchema: ReasoningAddStepInputSchema.shape,
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
        toolName: "reasoning_add_step",
        operationType: "reasoning",
        accessType: "write",
        buildEvent: async (
          params: ReasoningAddStepInput,
          result,
          activeDb
        ) => {
          const session = activeDb
            .prepare(`SELECT agent_id FROM reasoning_sessions WHERE id = ?`)
            .get(params.session_id) as { agent_id: string | null } | undefined;
          return {
            agentId: session?.agent_id ?? null,
            sessionId: params.session_id,
            stepId:
              typeof result.structuredContent?.step_id === "string"
                ? result.structuredContent.step_id
                : null,
            inputShape: {
              batch: params.steps !== undefined,
              batch_size: params.steps?.length ?? null,
              thought_present: params.thought !== undefined,
              action_present: params.action !== undefined,
              observation_present: params.observation !== undefined,
              thought_length: params.thought?.length ?? 0,
              action_length: params.action?.length ?? 0,
              observation_length: params.observation?.length ?? 0,
            },
            outputShape: {
              step_number: result.structuredContent?.step_number ?? null,
              steps_added: Array.isArray(result.structuredContent?.steps)
                ? result.structuredContent.steps.length
                : result.structuredContent?.step_number !== undefined
                  ? 1
                  : 0,
            },
          };
        },
      },
      async (params: ReasoningAddStepInput) => {
      try {
        const activeDb = await resolveDatabase(database);
        const hasSingleFields =
          params.thought !== undefined ||
          params.action !== undefined ||
          params.observation !== undefined;
        if (params.steps !== undefined && hasSingleFields) {
          return {
            content: [
              {
                type: "text" as const,
                text: "Error: Provide either steps (batch mode) or top-level thought/action/observation (single mode), not both.",
              },
            ],
            isError: true,
          };
        }
        if (params.steps === undefined && !hasSingleFields) {
          return {
            content: [
              {
                type: "text" as const,
                text: "Error: Either steps (batch mode), or at least one of thought, action, or observation, must be provided.",
              },
            ],
            isError: true,
          };
        }
        const entries = params.steps ?? [
          {
            thought: params.thought,
            action: params.action,
            observation: params.observation,
          },
        ];
        const invalidIndex = entries.findIndex(
          (entry) =>
            entry.thought === undefined &&
            entry.action === undefined &&
            entry.observation === undefined
        );
        if (invalidIndex !== -1) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Error: steps[${invalidIndex}] must include at least one of thought, action, or observation.`,
              },
            ],
            isError: true,
          };
        }
        const session = activeDb
          .prepare(`SELECT * FROM reasoning_sessions WHERE id = ?`)
          .get(params.session_id) as unknown as ReasoningSessionRow | undefined;
        if (!session) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Error: Session '${params.session_id}' not found. Use reasoning_start_session to create one, or reasoning_list_sessions to find existing ids.`,
              },
            ],
            isError: true,
          };
        }
        if (session.status !== "in_progress") {
          return {
            content: [
              {
                type: "text" as const,
                text: `Error: Session '${params.session_id}' is already '${session.status}' and cannot accept new steps.`,
              },
            ],
            isError: true,
          };
        }

        const insertedSteps = runInTransaction(activeDb, () => {
          const lockedSession = activeDb
            .prepare(`SELECT * FROM reasoning_sessions WHERE id = ?`)
            .get(params.session_id) as unknown as ReasoningSessionRow | undefined;
          if (!lockedSession) {
            throw new Error(
              `Session '${params.session_id}' not found. Use reasoning_start_session to create one, or reasoning_list_sessions to find existing ids.`
            );
          }
          if (lockedSession.status !== "in_progress") {
            throw new Error(
              `Session '${params.session_id}' is already '${lockedSession.status}' and cannot accept new steps.`
            );
          }

          const firstStepNumber = getNextStepNumber(activeDb, params.session_id);
          const ts = nowIso();
          const insertStep = activeDb.prepare(
            `INSERT INTO reasoning_steps (id, session_id, step_number, thought, action, observation, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          );
          const created = entries.map((entry, index) => {
            const id = newId("step");
            insertStep.run(
              id,
              params.session_id,
              firstStepNumber + index,
              entry.thought ?? null,
              entry.action ?? null,
              entry.observation ?? null,
              ts
            );
            return { step_id: id, step_number: firstStepNumber + index };
          });
          activeDb
            .prepare(`UPDATE reasoning_sessions SET updated_at = ? WHERE id = ?`)
            .run(ts, params.session_id);

          return created;
        });

        const output =
          params.steps !== undefined
            ? {
                session_id: params.session_id,
                steps: insertedSteps,
                step_count: insertedSteps.length,
              }
            : {
                step_id: insertedSteps[0].step_id,
                session_id: params.session_id,
                step_number: insertedSteps[0].step_number,
              };
        return {
          content: [{ type: "text" as const, text: toLimitedJson(output) }],
          structuredContent: output,
        };
      } catch (error) {
        if (error instanceof Error) {
          return {
            content: [{ type: "text" as const, text: `Error: ${error.message}` }],
            isError: true,
          };
        }
        return {
          content: [{ type: "text" as const, text: handleToolError(error) }],
          isError: true,
        };
      }
      }
    )
  );

  server.registerTool(
    "reasoning_get_trace",
    {
      title: "Get Reasoning Trace",
      description: `Retrieve the full ordered trace of steps for a reasoning session, plus its status and conclusion (if completed).

Args:
  - session_id (string, required): The session id.

Returns: JSON with { session: {...}, steps: [{step_number, thought, action, observation, created_at}, ...] }.

Error Handling:
  - Returns "Error: Session '<id>' not found" if the id does not exist.`,
      inputSchema: ReasoningGetTraceInputSchema.shape,
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
        toolName: "reasoning_get_trace",
        operationType: "reasoning",
        accessType: "read",
        buildEvent: (params: ReasoningGetTraceInput, result) => ({
          sessionId: params.session_id,
          outputShape: {
            step_count: Array.isArray(result.structuredContent?.steps)
              ? result.structuredContent.steps.length
              : 0,
          },
        }),
      },
      async (params: ReasoningGetTraceInput) => {
      try {
        const activeDb = await resolveDatabase(database);
        const sessionRow = activeDb
          .prepare(`SELECT * FROM reasoning_sessions WHERE id = ?`)
          .get(params.session_id) as unknown as ReasoningSessionRow | undefined;
        if (!sessionRow) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Error: Session '${params.session_id}' not found.`,
              },
            ],
            isError: true,
          };
        }
        const stepRows = activeDb
          .prepare(
            `SELECT * FROM reasoning_steps WHERE session_id = ? ORDER BY step_number ASC`
          )
          .all(params.session_id) as Array<{
          id: string;
          session_id: string;
          step_number: number;
          thought: string | null;
          action: string | null;
          observation: string | null;
          created_at: string;
        }>;

        const steps: ReasoningStepRecord[] = stepRows.map((row) => ({
          id: row.id,
          session_id: row.session_id,
          step_number: row.step_number,
          thought: row.thought,
          action: row.action,
          observation: row.observation,
          created_at: row.created_at,
        }));

        const session = sessionRowToRecord(sessionRow, steps.length);
        const output = { session, steps };
        return {
          content: [{ type: "text" as const, text: toLimitedJson(output) }],
          structuredContent: output as unknown as Record<string, unknown>,
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: handleToolError(error) }],
          isError: true,
        };
      }
      }
    )
  );

  server.registerTool(
    "reasoning_list_sessions",
    {
      title: "List Reasoning Sessions",
      description: `List reasoning sessions with optional filters, most recently updated first. Use this to find past sessions (e.g. to check if a similar task was already worked through) before retrieving a full trace.

Args:
  - agent_id (optional): Filter by agent.
  - status ('in_progress'|'completed'|'abandoned', optional): Filter by status.
  - limit (1-200, default 20), offset (default 0).

Returns: JSON with { total_returned, has_more, next_offset, sessions: [{id, title, status, step_count, conclusion, ...}] }.`,
      inputSchema: ReasoningListSessionsInputSchema.shape,
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
        toolName: "reasoning_list_sessions",
        operationType: "reasoning",
        accessType: "read",
        buildEvent: (params: ReasoningListSessionsInput, result) => ({
          agentId: params.agent_id ?? null,
          inputShape: {
            has_agent_id: params.agent_id !== undefined,
            status: params.status ?? null,
            limit: params.limit,
            offset: params.offset,
          },
          outputShape: {
            result_count:
              result.structuredContent?.total_returned ?? 0,
            total: result.structuredContent?.total ?? 0,
          },
        }),
      },
      async (params: ReasoningListSessionsInput) => {
      try {
        const activeDb = await resolveDatabase(database);
        const conditions: string[] = ["1=1"];
        const sqlParams: Array<string | number> = [];
        if (params.agent_id) {
          conditions.push("agent_id = ?");
          sqlParams.push(params.agent_id);
        }
        if (params.status) {
          conditions.push("status = ?");
          sqlParams.push(params.status);
        }

        const countRow = activeDb
          .prepare(
            `SELECT COUNT(*) as c FROM reasoning_sessions WHERE ${conditions.join(" AND ")}`
          )
          .get(...sqlParams) as { c: number };

        const rows = activeDb
          .prepare(
            `SELECT
               reasoning_sessions.*,
               COUNT(reasoning_steps.id) AS step_count
             FROM reasoning_sessions
             LEFT JOIN reasoning_steps
               ON reasoning_steps.session_id = reasoning_sessions.id
             WHERE ${conditions.join(" AND ")}
             GROUP BY reasoning_sessions.id
             ORDER BY updated_at DESC LIMIT ? OFFSET ?`
          )
          .all(...sqlParams, params.limit, params.offset) as unknown as ReasoningSessionListRow[];

        const sessions = rows.map((row) =>
          sessionRowToRecord(row, row.step_count)
        );
        const hasMore = countRow.c > params.offset + sessions.length;
        const output = {
          total: countRow.c,
          total_returned: sessions.length,
          offset: params.offset,
          has_more: hasMore,
          ...(hasMore ? { next_offset: params.offset + sessions.length } : {}),
          sessions,
        };
        return {
          content: [{ type: "text" as const, text: toLimitedJson(output) }],
          structuredContent: output as unknown as Record<string, unknown>,
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: handleToolError(error) }],
          isError: true,
        };
      }
      }
    )
  );

  server.registerTool(
    "reasoning_list_milestones",
    {
      title: "List Reasoning Milestones",
      description:
        "List marked reasoning steps for audit review without loading full traces.",
      inputSchema: ReasoningListMilestonesInputSchema.shape,
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
        toolName: "reasoning_list_milestones",
        operationType: "reasoning",
        accessType: "read",
        buildEvent: (params: ReasoningListMilestonesInput, result) => ({
          agentId: params.agent_id ?? null,
          sessionId: params.session_id ?? null,
          inputShape: {
            has_session_id: params.session_id !== undefined,
            has_agent_id: params.agent_id !== undefined,
            mark_type: params.mark_type ?? null,
            limit: params.limit,
            offset: params.offset,
          },
          outputShape: {
            result_count: result.structuredContent?.total_returned ?? 0,
            has_more: result.structuredContent?.has_more === true,
          },
        }),
      },
      async (params: ReasoningListMilestonesInput) => {
      try {
        const activeDb = await resolveDatabase(database);
        const conditions = ["1=1"];
        const sqlParams: Array<string | number> = [];

        if (params.session_id) {
          conditions.push("reasoning_steps.session_id = ?");
          sqlParams.push(params.session_id);
        }
        if (params.agent_id) {
          conditions.push("reasoning_sessions.agent_id = ?");
          sqlParams.push(params.agent_id);
        }
        if (params.mark_type) {
          conditions.push("reasoning_step_marks.mark_type = ?");
          sqlParams.push(params.mark_type);
        }

        const countRow = activeDb
          .prepare(
            `SELECT COUNT(*) as c
             FROM reasoning_step_marks
             JOIN reasoning_steps
               ON reasoning_steps.id = reasoning_step_marks.step_id
             JOIN reasoning_sessions
               ON reasoning_sessions.id = reasoning_steps.session_id
             WHERE ${conditions.join(" AND ")}`
          )
          .get(...sqlParams) as { c: number };

        const rows = activeDb
          .prepare(
            `SELECT
               reasoning_steps.session_id,
               reasoning_steps.id AS step_id,
               reasoning_steps.step_number,
               reasoning_step_marks.mark_type,
               reasoning_step_marks.note,
               reasoning_step_marks.created_at,
               reasoning_steps.thought,
               reasoning_steps.action,
               reasoning_steps.observation
             FROM reasoning_step_marks
             JOIN reasoning_steps
               ON reasoning_steps.id = reasoning_step_marks.step_id
             JOIN reasoning_sessions
               ON reasoning_sessions.id = reasoning_steps.session_id
             WHERE ${conditions.join(" AND ")}
             ORDER BY reasoning_step_marks.created_at ASC, reasoning_steps.step_number ASC
             LIMIT ? OFFSET ?`
          )
          .all(...sqlParams, params.limit, params.offset) as unknown as ReasoningMilestoneRow[];

        const results: ReasoningMilestoneRecord[] = rows.map((row) => ({
          session_id: row.session_id,
          step_id: row.step_id,
          step_number: row.step_number,
          mark_type: row.mark_type as ReasoningMilestoneRecord["mark_type"],
          note: row.note,
          created_at: row.created_at,
          snippet: buildReasoningSnippet(
            {
              id: row.step_id,
              session_id: row.session_id,
              step_number: row.step_number,
              thought: row.thought,
              action: row.action,
              observation: row.observation,
              created_at: row.created_at,
            },
            row.note ?? row.mark_type
          ),
        }));

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
        return {
          content: [{ type: "text" as const, text: handleToolError(error) }],
          isError: true,
        };
      }
      }
    )
  );

  server.registerTool(
    "reasoning_search_steps",
    {
      title: "Search Reasoning Steps",
      description:
        "Search reasoning steps across thought, action, and observation.",
      inputSchema: ReasoningSearchStepsInputSchema.shape,
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
        toolName: "reasoning_search_steps",
        operationType: "reasoning",
        accessType: "read",
        buildEvent: (params: ReasoningSearchStepsInput, result) => ({
          agentId: params.agent_id ?? null,
          sessionId: params.session_id ?? null,
          inputShape: {
            query_length: params.query.length,
            token_count: params.query.trim().split(/\s+/).filter(Boolean).length,
            has_session_id: params.session_id !== undefined,
            has_agent_id: params.agent_id !== undefined,
            mark_type: params.mark_type ?? null,
            limit: params.limit,
            offset: params.offset,
          },
          outputShape: {
            result_count: Array.isArray(result.structuredContent?.results)
              ? result.structuredContent.results.length
              : 0,
          },
        }),
      },
      async (params: ReasoningSearchStepsInput) => {
      try {
        const activeDb = await resolveDatabase(database);
        const conditions = [
          "reasoning_steps.rowid IN (SELECT rowid FROM reasoning_steps_fts WHERE reasoning_steps_fts MATCH ?)",
        ];
        const sqlParams: Array<string | number> = [toFtsQuery(params.query)];

        if (params.session_id) {
          conditions.push("reasoning_steps.session_id = ?");
          sqlParams.push(params.session_id);
        }
        if (params.agent_id) {
          conditions.push("reasoning_sessions.agent_id = ?");
          sqlParams.push(params.agent_id);
        }
        if (params.mark_type) {
          conditions.push(
            "EXISTS (SELECT 1 FROM reasoning_step_marks WHERE reasoning_step_marks.step_id = reasoning_steps.id AND reasoning_step_marks.mark_type = ?)"
          );
          sqlParams.push(params.mark_type);
        }

        const rows = activeDb
          .prepare(
            `SELECT
               reasoning_steps.id,
               reasoning_steps.session_id,
               reasoning_steps.step_number,
               reasoning_steps.thought,
               reasoning_steps.action,
               reasoning_steps.observation,
               reasoning_steps.created_at,
               reasoning_sessions.agent_id
             FROM reasoning_steps
             JOIN reasoning_sessions
               ON reasoning_sessions.id = reasoning_steps.session_id
             WHERE ${conditions.join(" AND ")}
             ORDER BY reasoning_steps.created_at DESC, reasoning_steps.step_number DESC
             LIMIT ? OFFSET ?`
          )
          .all(...sqlParams, params.limit, params.offset) as unknown as ReasoningSearchStepRow[];

        const results: ReasoningSearchStepRecord[] = rows.map((row) => ({
          ...row,
          snippet: buildReasoningSnippet(row, params.query),
        }));
        const output = { results };
        return {
          content: [{ type: "text" as const, text: toLimitedJson(output) }],
          structuredContent: output as unknown as Record<string, unknown>,
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: handleToolError(error) }],
          isError: true,
        };
      }
      }
    )
  );

  server.registerTool(
    "reasoning_get_session_outline",
    {
      title: "Get Reasoning Session Outline",
      description:
        "Return an audit-oriented outline for a session, using marked steps when present and a deterministic fallback otherwise.",
      inputSchema: ReasoningGetSessionOutlineInputSchema.shape,
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
        toolName: "reasoning_get_session_outline",
        operationType: "reasoning",
        accessType: "read",
        buildEvent: (params: ReasoningGetSessionOutlineInput, result) => ({
          sessionId: params.session_id,
          inputShape: {
            session_id_present: true,
          },
          outputShape: {
            used_fallback: result.structuredContent?.used_fallback === true,
            step_count: Array.isArray(result.structuredContent?.steps)
              ? result.structuredContent.steps.length
              : 0,
          },
        }),
      },
      async (params: ReasoningGetSessionOutlineInput) => {
      try {
        const activeDb = await resolveDatabase(database);
        const sessionRow = activeDb
          .prepare(`SELECT * FROM reasoning_sessions WHERE id = ?`)
          .get(params.session_id) as unknown as ReasoningSessionRow | undefined;
        if (!sessionRow) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Error: Session '${params.session_id}' not found.`,
              },
            ],
            isError: true,
          };
        }

        const stepRows = activeDb
          .prepare(
            `SELECT * FROM reasoning_steps WHERE session_id = ? ORDER BY step_number ASC`
          )
          .all(params.session_id) as unknown as ReasoningStepRecord[];

        const markedRows = activeDb
          .prepare(
            `SELECT
               reasoning_steps.id,
               reasoning_steps.session_id,
               reasoning_steps.step_number,
               reasoning_steps.thought,
               reasoning_steps.action,
               reasoning_steps.observation,
               reasoning_steps.created_at,
               reasoning_step_marks.mark_type,
               reasoning_step_marks.note,
               reasoning_step_marks.created_at AS mark_created_at
             FROM reasoning_step_marks
             JOIN reasoning_steps
               ON reasoning_steps.id = reasoning_step_marks.step_id
             WHERE reasoning_steps.session_id = ?
             ORDER BY reasoning_step_marks.created_at ASC, reasoning_steps.step_number ASC`
          )
          .all(params.session_id) as unknown as ReasoningOutlineMarkedRow[];

        const session = sessionRowToRecord(sessionRow, stepRows.length);
        const steps =
          markedRows.length > 0
            ? markedRows.map((row) =>
                stepToOutlineRecord(
                  row,
                  row.mark_type as ReasoningOutlineStepRecord["mark_type"],
                  row.note
                )
              )
            : selectFallbackOutlineSteps(stepRows).map((row) =>
                stepToOutlineRecord(row)
              );

        const output = {
          session,
          used_fallback: markedRows.length === 0,
          steps,
        };
        return {
          content: [{ type: "text" as const, text: toLimitedJson(output) }],
          structuredContent: output as unknown as Record<string, unknown>,
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: handleToolError(error) }],
          isError: true,
        };
      }
      }
    )
  );

  server.registerTool(
    "reasoning_mark_step",
    {
      title: "Mark Reasoning Step",
      description:
        "Attach an audit marker to an existing reasoning step. Repeating the same step_id + mark_type updates the note instead of creating a duplicate mark.",
      inputSchema: ReasoningMarkStepInputSchema.shape,
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
        toolName: "reasoning_mark_step",
        operationType: "reasoning",
        accessType: "write",
        buildEvent: (params: ReasoningMarkStepInput, result) => ({
          stepId: params.step_id,
          inputShape: {
            mark_type: params.mark_type,
            note_present: params.note !== undefined,
            note_length: params.note?.length ?? 0,
          },
          outputShape: {
            step_id: result.structuredContent?.step_id ?? null,
            mark_type: result.structuredContent?.mark_type ?? null,
            note_present: result.structuredContent?.note !== null,
          },
        }),
      },
      async (params: ReasoningMarkStepInput) => {
      try {
        const activeDb = await resolveDatabase(database);
        const step = activeDb
          .prepare(`SELECT id FROM reasoning_steps WHERE id = ?`)
          .get(params.step_id) as { id: string } | undefined;
        if (!step) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Error: Step '${params.step_id}' not found.`,
              },
            ],
            isError: true,
          };
        }

        const ts = nowIso();
        activeDb
          .prepare(
            `INSERT INTO reasoning_step_marks (id, step_id, mark_type, note, created_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(step_id, mark_type)
             DO UPDATE SET note = CASE
               WHEN ? THEN excluded.note
               ELSE reasoning_step_marks.note
             END`
          )
          .run(
            newId("mark"),
            params.step_id,
            params.mark_type,
            params.note ?? null,
            ts,
            params.note !== undefined ? 1 : 0
          );

        const mark = activeDb
          .prepare(
            `SELECT id, step_id, mark_type, note, created_at
             FROM reasoning_step_marks
             WHERE step_id = ? AND mark_type = ?`
          )
          .get(params.step_id, params.mark_type) as unknown as ReasoningStepMarkRow;

        const output = {
          step_id: mark.step_id,
          mark_type: mark.mark_type as ReasoningMarkStepInput["mark_type"],
          note: mark.note,
        };
        return {
          content: [{ type: "text" as const, text: toLimitedJson(output) }],
          structuredContent: output,
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: handleToolError(error) }],
          isError: true,
        };
      }
      }
    )
  );

  server.registerTool(
    "reasoning_complete_session",
    {
      title: "Complete Reasoning Session",
      description: `Mark a reasoning session as finished, recording its final conclusion. Optionally also persist the conclusion as a long-term memory so it can be recalled later without replaying the full trace.

Args:
  - session_id (string, required): The session id.
  - conclusion (string, required): The final answer/decision reached.
  - status ('completed'|'abandoned', default 'completed'): Use 'abandoned' if the task was dropped without a real conclusion.
  - save_as_memory (boolean, default false): If true, also create a memory with this conclusion.
  - memory_mode ('auto'|'always'|'never', optional): 'auto' (default) does NOT save a memory on its own — a memory is only created when save_as_memory=true or memory_mode='always'; 'never' skips saving and requires not_saved_reason.
  - memory_type (optional): Memory type to use when a completion is persisted.
  - memory_importance (optional): Importance to use when a completion is persisted.
  - memory_tags (string[], default []): Tags for the created memory.
  - not_saved_reason (optional): Required when memory_mode='never'.
  - used_memory_ids (string[], default []): Ids of memories that actually helped during this session (e.g. from related_memories returned by reasoning_start_session). The server records a 'used' usage-feedback event for each.

Returns: JSON with the updated session, created memory id if any, usage-feedback count, and skip warnings when memory is not saved.

Error Handling:
  - Returns "Error: Session '<id>' not found" if the id does not exist.
  - Returns an error if the session was already completed/abandoned (finalize only once).`,
      inputSchema: ReasoningCompleteSessionInputSchema.shape,
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
        toolName: "reasoning_complete_session",
        operationType: "reasoning",
        accessType: "write",
        buildEvent: async (
          params: ReasoningCompleteSessionInput,
          result,
          activeDb
        ) => {
          const structured = result.structuredContent;
          const session = activeDb
            .prepare(`SELECT agent_id FROM reasoning_sessions WHERE id = ?`)
            .get(params.session_id) as { agent_id: string | null } | undefined;
          const notSavedReason =
            typeof structured?.not_saved_reason === "string"
              ? structured.not_saved_reason
              : null;
          let reasonCategory: string | null = null;
          if (params.memory_mode === "never") reasonCategory = "caller_request";
          else if (params.status === "abandoned") reasonCategory = "not_completed";
          else if (notSavedReason?.includes("no reasoning steps")) {
            reasonCategory = "zero_step";
          }
          return {
            agentId: session?.agent_id ?? null,
            sessionId: params.session_id,
            memoryId:
              typeof structured?.memory_id === "string" ? structured.memory_id : null,
            inputShape: {
              status: params.status,
              memory_mode: params.memory_mode ?? "auto",
              save_as_memory: params.save_as_memory ?? false,
              memory_type: params.memory_type ?? null,
              memory_importance: params.memory_importance ?? null,
              tag_count: params.memory_tags?.length ?? 0,
              used_memory_count: params.used_memory_ids?.length ?? 0,
            },
            outputShape: {
              memory_id_present: typeof structured?.memory_id === "string",
              not_saved_reason_category: reasonCategory,
              warning_count: Array.isArray(structured?.warnings)
                ? structured.warnings.length
                : 0,
            },
          };
        },
      },
      async (params: ReasoningCompleteSessionInput) => {
      try {
        const activeDb = await resolveDatabase(database);
        const session = activeDb
          .prepare(`SELECT * FROM reasoning_sessions WHERE id = ?`)
          .get(params.session_id) as unknown as ReasoningSessionRow | undefined;
        if (!session) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Error: Session '${params.session_id}' not found.`,
              },
            ],
            isError: true,
          };
        }
        if (session.status !== "in_progress") {
          return {
            content: [
              {
                type: "text" as const,
                text: `Error: Session '${params.session_id}' is already '${session.status}'.`,
              },
            ],
            isError: true,
          };
        }

        const stepCount = getStepCount(activeDb, params.session_id);
        if (params.memory_mode === "never" && !params.not_saved_reason) {
          return {
            content: [
              {
                type: "text" as const,
                text: "Error: not_saved_reason is required when memory_mode='never'.",
              },
            ],
            isError: true,
          };
        }

        const saveMemory = shouldAutoSaveMemory(params, stepCount);
        const notSavedReason = saveMemory
          ? null
          : buildNotSavedReason(params, stepCount);
        const memoryId = runInTransaction(activeDb, () => {
          const ts = nowIso();
          activeDb
            .prepare(
              `UPDATE reasoning_sessions SET status = ?, conclusion = ?, updated_at = ? WHERE id = ?`
            )
            .run(params.status, params.conclusion, ts, params.session_id);

          if (!saveMemory) return null;

          const nextMemoryId = newId("mem");
          activeDb
            .prepare(
              `INSERT INTO memories (id, type, content, tags, agent_id, importance, metadata, workspace, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
              nextMemoryId,
              params.memory_type ?? "reasoning_summary",
              params.conclusion,
              JSON.stringify(params.memory_tags ?? []),
              session.agent_id,
              params.memory_importance ?? 3,
              JSON.stringify({
                source_session_id: params.session_id,
                session_title: session.title,
                auto_saved: !(params.save_as_memory || params.memory_mode === "always"),
                step_count: stepCount,
              }),
              getWorkspace(),
              ts,
              ts
            );
          return nextMemoryId;
        });

        const usedMemoryWarnings: string[] = [];
        let usedMemoryFeedbackRecorded = 0;
        for (const usedMemoryId of new Set(params.used_memory_ids ?? [])) {
          const exists = activeDb
            .prepare(`SELECT id FROM memories WHERE id = ?`)
            .get(usedMemoryId);
          if (!exists) {
            usedMemoryWarnings.push(
              `Memory '${usedMemoryId}' not found; usage feedback skipped.`
            );
            continue;
          }
          const feedbackEventId = await recordToolUsageEvent(activeDb, {
            toolName: "memory_record_usage_feedback",
            operationType: "feedback",
            accessType: "write",
            status: "success",
            agentId: session.agent_id,
            sessionId: params.session_id,
            memoryId: usedMemoryId,
            metadata: {
              usefulness: "used",
              source: "reasoning_complete_session",
            },
          });
          if (feedbackEventId) {
            usedMemoryFeedbackRecorded += 1;
          } else {
            usedMemoryWarnings.push(
              `Usage feedback for '${usedMemoryId}' could not be recorded.`
            );
          }
        }

        const updatedRow = activeDb
          .prepare(`SELECT * FROM reasoning_sessions WHERE id = ?`)
          .get(params.session_id) as unknown as ReasoningSessionRow;
        const record = sessionRowToRecord(updatedRow, stepCount);
        const output = {
          session: record,
          memory_id: memoryId,
          not_saved_reason: notSavedReason,
          used_memory_feedback_recorded: usedMemoryFeedbackRecorded,
          warnings: [
            ...(stepCount === 0 && params.status === "completed"
              ? ["Session completed with zero reasoning steps."]
              : []),
            ...usedMemoryWarnings,
          ],
        };
        return {
          content: [{ type: "text" as const, text: toLimitedJson(output) }],
          structuredContent: output as unknown as Record<string, unknown>,
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: handleToolError(error) }],
          isError: true,
        };
      }
      }
    )
  );
}
