import { z } from "zod";

export const ReasoningStartSessionInputSchema = z
  .object({
    title: z
      .string()
      .min(1)
      .max(300)
      .describe(
        "Short description of the task/question this reasoning session is about, e.g. 'Diagnose flaky checkout test'."
      ),
    agent_id: z
      .string()
      .max(100)
      .optional()
      .describe("Optional identifier for the agent/persona running this session."),
    workspace: z
      .string()
      .max(500)
      .optional()
      .describe(
        "Absolute path of the project directory you are working in. Pass it so recall prefers this project's memories and your conclusion is saved under it. If omitted the server uses its own working directory; '/' and the home directory count as unknown."
      ),
  })
  .strict();
export type ReasoningStartSessionInput = z.infer<
  typeof ReasoningStartSessionInputSchema
>;

export const ReasoningStepEntrySchema = z
  .object({
    thought: z
      .string()
      .max(4000)
      .optional()
      .describe("The agent's reasoning/thinking at this step."),
    action: z
      .string()
      .max(2000)
      .optional()
      .describe("The action taken at this step, if any (e.g. a tool call description)."),
    observation: z
      .string()
      .max(4000)
      .optional()
      .describe("The result/observation from the action, if any."),
  })
  .strict();
export type ReasoningStepEntry = z.infer<typeof ReasoningStepEntrySchema>;

// NOTE: kept as a plain ZodObject (no .refine()) so `.shape` stays available
// for registerTool's inputSchema. The "at least one field" and "single vs
// batch" rules are enforced in the tool handler instead.
export const ReasoningAddStepInputSchema = z
  .object({
    session_id: z
      .string()
      .min(1)
      .describe("The session id returned by reasoning_start_session."),
    thought: z
      .string()
      .max(4000)
      .optional()
      .describe("The agent's reasoning/thinking at this step."),
    action: z
      .string()
      .max(2000)
      .optional()
      .describe("The action taken at this step, if any (e.g. a tool call description)."),
    observation: z
      .string()
      .max(4000)
      .optional()
      .describe("The result/observation from the action, if any."),
    steps: z
      .array(ReasoningStepEntrySchema)
      .min(1)
      .max(20)
      .optional()
      .describe(
        "Batch mode: log several steps in one call (each entry needs at least one of thought/action/observation). Use INSTEAD of the top-level thought/action/observation fields, e.g. to record the trace of work you just finished without one call per step."
      ),
  })
  .strict();
export type ReasoningAddStepInput = z.infer<typeof ReasoningAddStepInputSchema>;

export const ReasoningCompleteSessionInputSchema = z
  .object({
    session_id: z.string().min(1).describe("The session id to complete."),
    conclusion: z
      .string()
      .min(1)
      .max(4000)
      .describe("The final conclusion/decision reached by this reasoning session."),
    status: z
      .enum(["completed", "abandoned"])
      .default("completed")
      .describe("Final status: 'completed' if a conclusion was reached, 'abandoned' if the task was dropped."),
    save_as_memory: z
      .boolean()
      .default(false)
      .describe(
        "If true, also create a long-term memory (type='reasoning_summary') containing the conclusion, so it can be recalled later via memory_search."
      ),
    memory_mode: z
      .enum(["auto", "always", "never"])
      .optional()
      .describe(
        "Preferred memory persistence mode. 'auto' (default) does not save on its own — a memory is only created when save_as_memory=true or memory_mode='always'; 'never' skips saving and requires not_saved_reason."
      ),
    memory_type: z
      .enum(["fact", "preference", "episodic", "decision", "reasoning_summary"])
      .optional()
      .describe("Memory type to use when a completion is persisted."),
    memory_importance: z
      .number()
      .int()
      .min(1)
      .max(5)
      .optional()
      .describe("Importance to use when a completion is persisted as memory."),
    memory_tags: z
      .array(z.string().min(1).max(50))
      .max(20)
      .default([])
      .describe("Tags to attach to the created memory, only used when save_as_memory is true."),
    not_saved_reason: z
      .string()
      .min(1)
      .max(500)
      .optional()
      .describe(
        "Required when memory_mode='never' to explain why the conclusion should not be kept as durable memory."
      ),
    used_memory_ids: z
      .array(z.string().min(1))
      .max(50)
      .default([])
      .describe(
        "Ids of memories that were actually used/helpful during this session (e.g. ones returned in related_memories by reasoning_start_session). The server records a 'used' usage-feedback event for each, so recall usefulness can be measured."
      ),
  })
  .strict();
export type ReasoningCompleteSessionInput = z.infer<
  typeof ReasoningCompleteSessionInputSchema
>;

// Plain ZodObject so `.shape` works for registerTool; "exactly one of
// query / session_id" is enforced in the handler.
export const ReasoningFindInputSchema = z
  .object({
    query: z
      .string()
      .min(1)
      .max(300)
      .optional()
      .describe("Find mode: words to look for in past sessions' titles, conclusions and steps."),
    session_id: z
      .string()
      .min(1)
      .optional()
      .describe("Read mode: a session id (from a find result or a memory's source.session_id)."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(10)
      .default(5)
      .describe("Find mode: max sessions returned."),
  })
  .strict();
export type ReasoningFindInput = z.infer<typeof ReasoningFindInputSchema>;
