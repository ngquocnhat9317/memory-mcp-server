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
import {
  handleToolError,
  newId,
  nowIso,
  toFtsQuery,
  toLimitedJson,
} from "../utils.js";

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

async function resolveDatabase(
  database?: DatabaseSync
): Promise<DatabaseSync> {
  if (database) return database;
  defaultDatabasePromise ??= import("../db.js").then((module) => module.db);
  return defaultDatabasePromise;
}

export function registerReasoningTools(
  server: McpServer,
  database?: DatabaseSync
): void {
  server.registerTool(
    "reasoning_start_session",
    {
      title: "Start Reasoning Session",
      description: `Start a new reasoning session to record a multi-step chain of thought for a task or question. Call this once at the start of a non-trivial task, then log each step with reasoning_add_step, and finish with reasoning_complete_session.

Args:
  - title (string, required): Short description of the task/question, e.g. "Diagnose flaky checkout test".
  - agent_id (string, optional): Identifier for the agent/persona running this session.

Returns: JSON with the new session's id, which must be passed to reasoning_add_step and reasoning_complete_session.

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
    async (params: ReasoningStartSessionInput) => {
      try {
        const activeDb = await resolveDatabase(database);
        const id = newId("sess");
        const ts = nowIso();
        activeDb.prepare(
          `INSERT INTO reasoning_sessions (id, title, agent_id, status, conclusion, created_at, updated_at)
           VALUES (?, ?, ?, 'in_progress', NULL, ?, ?)`
        ).run(id, params.title, params.agent_id ?? null, ts, ts);
        const output = { session_id: id, title: params.title, status: "in_progress" as const };
        return {
          content: [
            { type: "text" as const, text: `Reasoning session started with id ${id}.\n\n${toLimitedJson(output)}` },
          ],
          structuredContent: output,
        };
      } catch (error) {
        return { content: [{ type: "text" as const, text: handleToolError(error) }], isError: true };
      }
    }
  );

  server.registerTool(
    "reasoning_add_step",
    {
      title: "Add Reasoning Step",
      description: `Append one step (thought / action / observation) to an existing reasoning session. Steps are numbered automatically in the order added. Call this repeatedly as the agent works through a task.

Args:
  - session_id (string, required): Id from reasoning_start_session.
  - thought (string, optional): The reasoning/thinking at this step.
  - action (string, optional): The action taken, if any.
  - observation (string, optional): The result observed, if any.
  (At least one of thought/action/observation is required.)

Returns: JSON with the new step's id and step_number.

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
    async (params: ReasoningAddStepInput) => {
      try {
        const activeDb = await resolveDatabase(database);
        if (
          params.thought === undefined &&
          params.action === undefined &&
          params.observation === undefined
        ) {
          return {
            content: [
              { type: "text" as const, text: "Error: At least one of thought, action, or observation must be provided." },
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

        const nextStepNumber = getStepCount(activeDb, params.session_id) + 1;
        const id = newId("step");
        const ts = nowIso();
        activeDb.prepare(
          `INSERT INTO reasoning_steps (id, session_id, step_number, thought, action, observation, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(
          id,
          params.session_id,
          nextStepNumber,
          params.thought ?? null,
          params.action ?? null,
          params.observation ?? null,
          ts
        );
        activeDb.prepare(`UPDATE reasoning_sessions SET updated_at = ? WHERE id = ?`).run(
          ts,
          params.session_id
        );

        const output = { step_id: id, session_id: params.session_id, step_number: nextStepNumber };
        return {
          content: [{ type: "text" as const, text: toLimitedJson(output) }],
          structuredContent: output,
        };
      } catch (error) {
        return { content: [{ type: "text" as const, text: handleToolError(error) }], isError: true };
      }
    }
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
    async (params: ReasoningGetTraceInput) => {
      try {
        const activeDb = await resolveDatabase(database);
        const sessionRow = activeDb
          .prepare(`SELECT * FROM reasoning_sessions WHERE id = ?`)
          .get(params.session_id) as unknown as ReasoningSessionRow | undefined;
        if (!sessionRow) {
          return {
            content: [{ type: "text" as const, text: `Error: Session '${params.session_id}' not found.` }],
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

        const steps: ReasoningStepRecord[] = stepRows.map((r) => ({
          id: r.id,
          session_id: r.session_id,
          step_number: r.step_number,
          thought: r.thought,
          action: r.action,
          observation: r.observation,
          created_at: r.created_at,
        }));

        const session = sessionRowToRecord(sessionRow, steps.length);
        const output = { session, steps };
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
    async (params: ReasoningListSessionsInput) => {
      try {
        const activeDb = await resolveDatabase(database);
        const conditions: string[] = ["1=1"];
        const sqlParams: (string | number)[] = [];
        if (params.agent_id) {
          conditions.push("agent_id = ?");
          sqlParams.push(params.agent_id);
        }
        if (params.status) {
          conditions.push("status = ?");
          sqlParams.push(params.status);
        }

        const countRow = activeDb
          .prepare(`SELECT COUNT(*) as c FROM reasoning_sessions WHERE ${conditions.join(" AND ")}`)
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
          .all(
            ...sqlParams,
            params.limit,
            params.offset
          ) as unknown as ReasoningSessionListRow[];

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
        return { content: [{ type: "text" as const, text: handleToolError(error) }], isError: true };
      }
    }
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
          .all(
            ...sqlParams,
            params.limit,
            params.offset
          ) as unknown as ReasoningMilestoneRow[];

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
          .all(
            ...sqlParams,
            params.limit,
            params.offset
          ) as unknown as ReasoningSearchStepRow[];

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
          content: [
            { type: "text" as const, text: handleToolError(error) },
          ],
          isError: true,
        };
      }
    }
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
    async (params: ReasoningGetSessionOutlineInput) => {
      try {
        const activeDb = await resolveDatabase(database);
        const sessionRow = activeDb
          .prepare(`SELECT * FROM reasoning_sessions WHERE id = ?`)
          .get(params.session_id) as unknown as ReasoningSessionRow | undefined;
        if (!sessionRow) {
          return {
            content: [{ type: "text" as const, text: `Error: Session '${params.session_id}' not found.` }],
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
    async (params: ReasoningMarkStepInput) => {
      try {
        const activeDb = await resolveDatabase(database);
        const step = activeDb
          .prepare(`SELECT id FROM reasoning_steps WHERE id = ?`)
          .get(params.step_id) as { id: string } | undefined;
        if (!step) {
          return {
            content: [{ type: "text" as const, text: `Error: Step '${params.step_id}' not found.` }],
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
        return { content: [{ type: "text" as const, text: handleToolError(error) }], isError: true };
      }
    }
  );

  server.registerTool(
    "reasoning_complete_session",
    {
      title: "Complete Reasoning Session",
      description: `Mark a reasoning session as finished, recording its final conclusion. Optionally also persist the conclusion as a long-term memory (type='reasoning_summary') so it's recallable via memory_search without replaying the whole trace.

Args:
  - session_id (string, required): The session id.
  - conclusion (string, required): The final answer/decision reached.
  - status ('completed'|'abandoned', default 'completed'): Use 'abandoned' if the task was dropped without a real conclusion.
  - save_as_memory (boolean, default false): If true, also create a memory with this conclusion.
  - memory_tags (string[], default []): Tags for the created memory, only used when save_as_memory=true.

Returns: JSON with the updated session, and the created memory id if save_as_memory was used.

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
    async (params: ReasoningCompleteSessionInput) => {
      try {
        const activeDb = await resolveDatabase(database);
        const session = activeDb
          .prepare(`SELECT * FROM reasoning_sessions WHERE id = ?`)
          .get(params.session_id) as unknown as ReasoningSessionRow | undefined;
        if (!session) {
          return {
            content: [{ type: "text" as const, text: `Error: Session '${params.session_id}' not found.` }],
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

        const ts = nowIso();
        activeDb.prepare(
          `UPDATE reasoning_sessions SET status = ?, conclusion = ?, updated_at = ? WHERE id = ?`
        ).run(params.status, params.conclusion, ts, params.session_id);

        let memoryId: string | null = null;
        if (params.save_as_memory) {
          memoryId = newId("mem");
          activeDb.prepare(
            `INSERT INTO memories (id, type, content, tags, agent_id, importance, metadata, created_at, updated_at)
             VALUES (?, 'reasoning_summary', ?, ?, ?, 3, ?, ?, ?)`
          ).run(
            memoryId,
            params.conclusion,
            JSON.stringify(params.memory_tags ?? []),
            session.agent_id,
            JSON.stringify({ source_session_id: params.session_id, session_title: session.title }),
            ts,
            ts
          );
        }

        const updatedRow = activeDb
          .prepare(`SELECT * FROM reasoning_sessions WHERE id = ?`)
          .get(params.session_id) as unknown as ReasoningSessionRow;
        const record = sessionRowToRecord(
          updatedRow,
          getStepCount(activeDb, params.session_id)
        );
        const output = { session: record, memory_id: memoryId };
        return {
          content: [{ type: "text" as const, text: toLimitedJson(output) }],
          structuredContent: output as unknown as Record<string, unknown>,
        };
      } catch (error) {
        return { content: [{ type: "text" as const, text: handleToolError(error) }], isError: true };
      }
    }
  );
}
