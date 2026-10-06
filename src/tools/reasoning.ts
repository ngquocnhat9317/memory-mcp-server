import type { DatabaseSync } from "node:sqlite";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ReasoningAddStepInputSchema,
  ReasoningCompleteSessionInputSchema,
  ReasoningFindInputSchema,
  ReasoningStartSessionInputSchema,
  type ReasoningAddStepInput,
  type ReasoningCompleteSessionInput,
  type ReasoningFindInput,
  type ReasoningStartSessionInput,
} from "../schemas/reasoning.js";
import type {
  ReasoningSessionRecord,
  ReasoningSessionRow,
  ReasoningStepRecord,
} from "../types.js";
import {
  AUTO_RECALL_LIMIT,
  RECALL_RECENCY_DAYS,
  RECALL_WEIGHTS,
  SESSION_TTL_HOURS,
  getWorkspace,
} from "../constants.js";
import {
  buildMatchExcerpt,
  buildRecallSnippet,
  compactSnippetText,
  escapeLikePattern,
  handleToolError,
  newId,
  nowIso,
  parseJsonArray,
  parseJsonObject,
  toRecallTerms,
  toLimitedJson,
  unquoteFtsTerm,
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

const FIND_DEFAULT_LIMIT = 5;
const FIND_CONCLUSION_CHARS = 300;
const FIND_EXCERPTS_PER_SESSION = 2;

/** Candidate pool fetched by BM25 before the gate/score pass. */
const RECALL_CANDIDATE_POOL = 50;

function recallRelatedMemories(
  database: DatabaseSync,
  title: string,
  workspace: string | null
): RelatedMemoryRecord[] {
  if (AUTO_RECALL_LIMIT <= 0) return [];
  try {
    const terms = toRecallTerms(title);
    if (terms.length === 0) return [];

    // workspace_priority: 2 = current workspace, 1 = unknown (NULL) or a
    // user preference (cross-project by nature), 0 = another project. With
    // a known workspace the pool is ordered by it first so home memories are
    // never crowded out of the candidate pool by other projects' BM25 hits.
    // Memories reported stale/unsafe are excluded until they are updated
    // after the report.
    const candidates = database
      .prepare(
        `SELECT m.rowid AS row_id, m.id, m.type, m.content, m.tags,
                m.importance, m.metadata, m.created_at, m.updated_at,
                f.rank AS fts_rank,
                CASE
                  WHEN m.workspace = ?                              THEN 2
                  WHEN m.workspace IS NULL OR m.type = 'preference' THEN 1
                  ELSE 0
                END AS workspace_priority
         FROM memories m
         JOIN (
           SELECT rowid, rank FROM memories_fts WHERE memories_fts MATCH ?
         ) f ON m.rowid = f.rowid
         WHERE NOT EXISTS (
           SELECT 1 FROM tool_usage_events e
           WHERE e.memory_id = m.id
             AND e.operation_type = 'feedback' AND e.status = 'success'
             AND json_extract(e.metadata, '$.usefulness') IN ('stale', 'unsafe_to_use')
             AND e.created_at >= m.updated_at
         )
         ORDER BY ${workspace === null ? "" : "workspace_priority DESC, "}f.rank ASC
         LIMIT ?`
      )
      .all(workspace, terms.join(" OR "), RECALL_CANDIDATE_POOL) as Array<{
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

    // Eligibility gate. Other projects' non-preference memories must match
    // nearly the whole title; everyone else needs the base floor. Nothing
    // eligible means nothing returned — no best-effort lifeline.
    const total = terms.length;
    const baseFloor = total >= 3 ? 2 : 1;
    const crossProjectFloor = Math.max(2, Math.ceil(0.75 * total));
    const eligible = candidates
      .map((candidate) => ({
        ...candidate,
        matched: matchCounts.get(candidate.row_id) ?? 1,
      }))
      .filter((candidate) => {
        const crossProject =
          workspace !== null && candidate.workspace_priority === 0;
        return candidate.matched >= (crossProject ? crossProjectFloor : baseFloor);
      });
    if (eligible.length === 0) return [];

    // Blended score. bm25 rank is negative (more negative = better), so
    // min-max normalize within the eligible set; all-equal counts as best.
    const ranks = eligible.map((candidate) => candidate.fts_rank);
    const bestRank = Math.min(...ranks);
    const worstRank = Math.max(...ranks);
    const now = Date.now();
    const scored = eligible.map((candidate) => {
      const bm25 =
        worstRank === bestRank
          ? 1
          : (worstRank - candidate.fts_rank) / (worstRank - bestRank);
      const workspaceTerm =
        workspace === null ? 0.5 : candidate.workspace_priority / 2;
      const updatedMs = Date.parse(candidate.updated_at);
      const ageDays = Number.isFinite(updatedMs)
        ? Math.max(0, (now - updatedMs) / 86_400_000)
        : Infinity;
      const recency = 1 / (1 + ageDays / RECALL_RECENCY_DAYS);
      return {
        ...candidate,
        score:
          RECALL_WEIGHTS.coverage * (candidate.matched / total) +
          RECALL_WEIGHTS.bm25 * bm25 +
          RECALL_WEIGHTS.workspace * workspaceTerm +
          RECALL_WEIGHTS.recency * recency,
      };
    });

    scored.sort(
      (a, b) =>
        b.score - a.score ||
        b.importance - a.importance ||
        (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0)
    );

    return scored.slice(0, AUTO_RECALL_LIMIT).map((row) => {
      const metadata = parseJsonObject(row.metadata);
      const sourceSessionId = metadata?.source_session_id;
      const sourceSessionTitle = metadata?.session_title;
      return {
        id: row.id,
        type: row.type,
        importance: row.importance,
        tags: parseJsonArray(row.tags),
        snippet: buildRecallSnippet(row.content, terms),
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
  - workspace (string, optional): Absolute path of the project directory you are working in. Pass it: the server's own working directory is often "/" or your home directory, which counts as unknown.

Returns: JSON with the new session's id (pass it to reasoning_add_step and reasoning_complete_session), plus:
  - workspace: the resolved project workspace for this session, or null when unknown (then workspace_warning explains how to fix it).
  - related_memories: up to a few saved memories relevant to the title, auto-recalled by the server — ranked by a blend of term coverage, text relevance, workspace and recency; memories from other projects appear only when they match nearly the whole title (user preferences excepted); weak matches are filtered out, so a short or empty list is normal. Review them before starting work; if one helps, report it later via used_memory_ids on reasoning_complete_session. Memories persisted from a past reasoning session carry a 'source' field ({session_id, session_title, created_at}); the source says which session produced the memory and when; read that session with reasoning_find(session_id) when the snippet is not enough.
  - open_sessions / open_sessions_warning: other in_progress sessions. Close the ones you opened and finished; leave sessions you don't recognize alone (they may belong to another agent or run).
  - auto_abandoned_sessions: count of stale in_progress sessions the server just cleaned up, if any.

Examples:
  - Use when: starting to debug a complex issue, plan a multi-step task, or work through a decision with tradeoffs.
  - Don't use when: the answer is a single simple lookup (use memory_search directly).`,
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
        const workspace = getWorkspace(params.workspace);
        activeDb
          .prepare(
            `INSERT INTO reasoning_sessions (id, title, agent_id, status, conclusion, workspace, created_at, updated_at)
             VALUES (?, ?, ?, 'in_progress', NULL, ?, ?, ?)`
          )
          .run(id, params.title, params.agent_id ?? null, workspace, ts, ts);

        const openSessions = activeDb
          .prepare(
            `SELECT id, title, updated_at FROM reasoning_sessions
             WHERE status = 'in_progress' AND id != ?
             ORDER BY updated_at DESC
             LIMIT 5`
          )
          .all(id) as Array<{ id: string; title: string; updated_at: string }>;

        const relatedMemories = recallRelatedMemories(
          activeDb,
          params.title,
          workspace
        );
        if (relatedMemories.length > 0) {
          try {
            activeDb
              .prepare(`UPDATE reasoning_sessions SET recalled_memory_ids = ? WHERE id = ?`)
              .run(JSON.stringify(relatedMemories.map((memory) => memory.id)), id);
          } catch {
            // Measurement is best-effort; it must never block session creation.
          }
        }

        const output = {
          session_id: id,
          title: params.title,
          status: "in_progress" as const,
          workspace,
          ...(workspace === null
            ? {
                workspace_warning:
                  "Project workspace could not be determined (the server's working directory is '/', your home directory, or unset), so recall cannot prefer this project's memories. Pass workspace=<absolute project path> to reasoning_start_session.",
              }
            : {}),
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
  - Returns an error if session_id does not exist (call reasoning_start_session first, or reasoning_find to look up an existing session).
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
                text: `Error: Session '${params.session_id}' not found. Use reasoning_start_session to create one, or reasoning_find to look up an existing session.`,
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
              `Session '${params.session_id}' not found. Use reasoning_start_session to create one, or reasoning_find to look up an existing session.`
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
    "reasoning_find",
    {
      title: "Find Past Reasoning",
      description: `Find past work that your current context does not contain, then read it.

Call it when the user refers to earlier work, a past decision or a previous conversation you don't have ("last time…", "continue the unfinished…", "I already discussed…"), or when a recalled memory's source is not enough to know why that conclusion was reached.

Pass exactly one of:
  - query: searches past sessions' titles, conclusions and step text. Returns up to limit sessions (default 5), best match first, each with its conclusion and up to 2 matching step excerpts.
  - session_id: returns that session's full ordered trace.

Find first, then read only the session that matters.`,
      inputSchema: ReasoningFindInputSchema.shape,
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
        toolName: "reasoning_find",
        operationType: "reasoning",
        accessType: "read",
        buildEvent: (params: ReasoningFindInput, result) => ({
          sessionId: params.session_id ?? null,
          inputShape: {
            mode: params.session_id !== undefined ? "read" : "find",
            query_length: params.query?.length ?? 0,
            limit: params.limit ?? FIND_DEFAULT_LIMIT,
          },
          outputShape: {
            result_count: Array.isArray(result.structuredContent?.results)
              ? result.structuredContent.results.length
              : 0,
            step_count: Array.isArray(result.structuredContent?.steps)
              ? result.structuredContent.steps.length
              : 0,
          },
        }),
      },
      async (params: ReasoningFindInput) => {
        const activeDb = await resolveDatabase(database);
        if ((params.query === undefined) === (params.session_id === undefined)) {
          return {
            content: [
              {
                type: "text" as const,
                text: "Error: Pass exactly one of query (find past sessions) or session_id (read one session).",
              },
            ],
            isError: true,
          };
        }

        if (params.session_id !== undefined) {
          const sessionRow = activeDb
            .prepare(`SELECT * FROM reasoning_sessions WHERE id = ?`)
            .get(params.session_id) as unknown as ReasoningSessionRow | undefined;
          if (!sessionRow) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Error: Session '${params.session_id}' not found. Call reasoning_find with a query to look sessions up.`,
                },
              ],
              isError: true,
            };
          }
          const steps = activeDb
            .prepare(
              `SELECT id, session_id, step_number, thought, action, observation, created_at
               FROM reasoning_steps WHERE session_id = ? ORDER BY step_number ASC`
            )
            .all(params.session_id) as unknown as ReasoningStepRecord[];
          const output = {
            mode: "read" as const,
            session: {
              ...sessionRowToRecord(sessionRow, steps.length),
              workspace: sessionRow.workspace,
            },
            steps,
          };
          return {
            content: [{ type: "text" as const, text: toLimitedJson(output) }],
            structuredContent: output as unknown as Record<string, unknown>,
          };
        }

        const query = params.query as string;
        const terms = toRecallTerms(query);
        const words = terms.map(unquoteFtsTerm);
        const matched = new Map<string, Set<number>>();
        const markMatch = (sessionId: string, termIndex: number) => {
          const set = matched.get(sessionId) ?? new Set<number>();
          set.add(termIndex);
          matched.set(sessionId, set);
        };
        const stepMatches = activeDb.prepare(
          `SELECT DISTINCT session_id FROM reasoning_steps
           WHERE rowid IN (SELECT rowid FROM reasoning_steps_fts WHERE reasoning_steps_fts MATCH ?)`
        );
        const textMatches = activeDb.prepare(
          `SELECT id FROM reasoning_sessions
           WHERE title LIKE ? ESCAPE '\\' OR conclusion LIKE ? ESCAPE '\\'`
        );
        terms.forEach((term, index) => {
          for (const row of stepMatches.all(term) as Array<{ session_id: string }>) {
            markMatch(row.session_id, index);
          }
          const like = `%${escapeLikePattern(words[index])}%`;
          for (const row of textMatches.all(like, like) as Array<{ id: string }>) {
            markMatch(row.id, index);
          }
        });

        let results: Array<Record<string, unknown>> = [];
        if (matched.size > 0) {
          const ids = [...matched.keys()];
          const rows = activeDb
            .prepare(
              `SELECT reasoning_sessions.*, COUNT(reasoning_steps.id) AS step_count
               FROM reasoning_sessions
               LEFT JOIN reasoning_steps ON reasoning_steps.session_id = reasoning_sessions.id
               WHERE reasoning_sessions.id IN (SELECT value FROM json_each(?))
               GROUP BY reasoning_sessions.id`
            )
            .all(JSON.stringify(ids)) as unknown as ReasoningSessionListRow[];
          const limit = params.limit ?? FIND_DEFAULT_LIMIT;
          const excerptRows = activeDb.prepare(
            `SELECT step_number, thought, action, observation FROM reasoning_steps
             WHERE session_id = ?
               AND rowid IN (SELECT rowid FROM reasoning_steps_fts WHERE reasoning_steps_fts MATCH ?)
             ORDER BY step_number ASC LIMIT ?`
          );
          const anyTerm = terms.join(" OR ");
          results = rows
            .sort(
              (a, b) =>
                Number(a.step_count === 0 && !a.conclusion) -
                  Number(b.step_count === 0 && !b.conclusion) ||
                matched.get(b.id)!.size - matched.get(a.id)!.size ||
                (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0) ||
                (a.id < b.id ? -1 : 1)
            )
            .slice(0, limit)
            .map((row) => {
              const steps = excerptRows.all(row.id, anyTerm, FIND_EXCERPTS_PER_SESSION) as Array<{
                step_number: number;
                thought: string | null;
                action: string | null;
                observation: string | null;
              }>;
              return {
                session_id: row.id,
                title: row.title,
                status: row.status,
                workspace: row.workspace,
                created_at: row.created_at,
                updated_at: row.updated_at,
                step_count: row.step_count,
                matched_terms: matched.get(row.id)!.size,
                conclusion: row.conclusion
                  ? compactSnippetText(row.conclusion, FIND_CONCLUSION_CHARS)
                  : null,
                excerpts: steps.map((step) => ({
                  step_number: step.step_number,
                  excerpt: buildMatchExcerpt(
                    [step.thought, step.action, step.observation].filter(Boolean).join(" "),
                    words
                  ),
                })),
              };
            });
        }

        const output = { mode: "find" as const, query, total_matched: matched.size, results };
        return {
          content: [{ type: "text" as const, text: toLimitedJson(output) }],
          structuredContent: output as unknown as Record<string, unknown>,
        };
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
              session.workspace ?? null,
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
