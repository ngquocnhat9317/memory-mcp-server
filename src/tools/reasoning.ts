import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { db } from "../db.js";
import {
  ReasoningAddStepInputSchema,
  ReasoningCompleteSessionInputSchema,
  ReasoningGetTraceInputSchema,
  ReasoningListSessionsInputSchema,
  ReasoningStartSessionInputSchema,
  type ReasoningAddStepInput,
  type ReasoningCompleteSessionInput,
  type ReasoningGetTraceInput,
  type ReasoningListSessionsInput,
  type ReasoningStartSessionInput,
} from "../schemas/reasoning.js";
import type {
  ReasoningSessionRecord,
  ReasoningSessionRow,
  ReasoningStepRecord,
} from "../types.js";
import { handleToolError, newId, nowIso, toLimitedJson } from "../utils.js";

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

function getStepCount(sessionId: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) as c FROM reasoning_steps WHERE session_id = ?`)
    .get(sessionId) as { c: number };
  return row.c;
}

export function registerReasoningTools(server: McpServer): void {
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
        const id = newId("sess");
        const ts = nowIso();
        db.prepare(
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
        const session = db
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

        const nextStepNumber = getStepCount(params.session_id) + 1;
        const id = newId("step");
        const ts = nowIso();
        db.prepare(
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
        db.prepare(`UPDATE reasoning_sessions SET updated_at = ? WHERE id = ?`).run(
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
        const sessionRow = db
          .prepare(`SELECT * FROM reasoning_sessions WHERE id = ?`)
          .get(params.session_id) as unknown as ReasoningSessionRow | undefined;
        if (!sessionRow) {
          return {
            content: [{ type: "text" as const, text: `Error: Session '${params.session_id}' not found.` }],
            isError: true,
          };
        }
        const stepRows = db
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

        const countRow = db
          .prepare(`SELECT COUNT(*) as c FROM reasoning_sessions WHERE ${conditions.join(" AND ")}`)
          .get(...sqlParams) as { c: number };

        const rows = db
          .prepare(
            `SELECT * FROM reasoning_sessions WHERE ${conditions.join(" AND ")}
             ORDER BY updated_at DESC LIMIT ? OFFSET ?`
          )
          .all(...sqlParams, params.limit, params.offset) as unknown as ReasoningSessionRow[];

        const sessions = rows.map((r) => sessionRowToRecord(r, getStepCount(r.id)));
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
        const session = db
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
        db.prepare(
          `UPDATE reasoning_sessions SET status = ?, conclusion = ?, updated_at = ? WHERE id = ?`
        ).run(params.status, params.conclusion, ts, params.session_id);

        let memoryId: string | null = null;
        if (params.save_as_memory) {
          memoryId = newId("mem");
          db.prepare(
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

        const updatedRow = db
          .prepare(`SELECT * FROM reasoning_sessions WHERE id = ?`)
          .get(params.session_id) as unknown as ReasoningSessionRow;
        const record = sessionRowToRecord(updatedRow, getStepCount(params.session_id));
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
