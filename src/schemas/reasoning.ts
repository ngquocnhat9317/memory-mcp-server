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
  })
  .strict();
export type ReasoningStartSessionInput = z.infer<
  typeof ReasoningStartSessionInputSchema
>;

// NOTE: kept as a plain ZodObject (no .refine()) so `.shape` stays available
// for registerTool's inputSchema. The "at least one field" rule is enforced
// in the tool handler instead.
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
  })
  .strict();
export type ReasoningAddStepInput = z.infer<typeof ReasoningAddStepInputSchema>;

export const ReasoningGetTraceInputSchema = z
  .object({
    session_id: z.string().min(1).describe("The session id to retrieve the full trace for."),
  })
  .strict();
export type ReasoningGetTraceInput = z.infer<typeof ReasoningGetTraceInputSchema>;

export const ReasoningListSessionsInputSchema = z
  .object({
    agent_id: z.string().max(100).optional().describe("Filter by agent_id."),
    status: z
      .enum(["in_progress", "completed", "abandoned"])
      .optional()
      .describe("Filter by session status."),
    limit: z.number().int().min(1).max(200).default(20),
    offset: z.number().int().min(0).default(0),
  })
  .strict();
export type ReasoningListSessionsInput = z.infer<
  typeof ReasoningListSessionsInputSchema
>;

export const ReasoningMarkTypeEnum = z.enum([
  "milestone",
  "decision",
  "conflict",
  "important",
  "hypothesis",
]);
export type ReasoningMarkType = z.infer<typeof ReasoningMarkTypeEnum>;

export const ReasoningMarkStepInputSchema = z
  .object({
    step_id: z.string().min(1).describe("The reasoning step id to mark."),
    mark_type: ReasoningMarkTypeEnum.describe(
      "Audit marker type for the step."
    ),
    note: z
      .string()
      .max(1000)
      .optional()
      .describe("Optional note attached to the mark."),
  })
  .strict();
export type ReasoningMarkStepInput = z.infer<
  typeof ReasoningMarkStepInputSchema
>;

export const ReasoningSearchStepsInputSchema = z
  .object({
    query: z
      .string()
      .min(1)
      .max(200)
      .describe("Full-text query across thought, action, and observation."),
    session_id: z
      .string()
      .min(1)
      .optional()
      .describe("Optional session id filter."),
    agent_id: z.string().max(100).optional().describe("Optional agent_id filter."),
    mark_type: ReasoningMarkTypeEnum.optional().describe(
      "Optional mark filter."
    ),
    limit: z.number().int().min(1).max(200).default(20),
    offset: z.number().int().min(0).default(0),
  })
  .strict();
export type ReasoningSearchStepsInput = z.infer<
  typeof ReasoningSearchStepsInputSchema
>;

export const ReasoningListMilestonesInputSchema = z
  .object({
    session_id: z
      .string()
      .min(1)
      .optional()
      .describe("Optional session id filter."),
    agent_id: z.string().max(100).optional().describe("Optional agent_id filter."),
    mark_type: ReasoningMarkTypeEnum.optional().describe(
      "Optional mark filter."
    ),
    limit: z.number().int().min(1).max(200).default(20),
    offset: z.number().int().min(0).default(0),
  })
  .strict();
export type ReasoningListMilestonesInput = z.infer<
  typeof ReasoningListMilestonesInputSchema
>;

export const ReasoningGetSessionOutlineInputSchema = z
  .object({
    session_id: z
      .string()
      .min(1)
      .describe("The session id to summarize into an audit outline."),
  })
  .strict();
export type ReasoningGetSessionOutlineInput = z.infer<
  typeof ReasoningGetSessionOutlineInputSchema
>;

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
        "Preferred memory persistence mode. 'auto' saves durable completed conclusions by default, 'always' forces a save, and 'never' skips saving."
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
  })
  .strict();
export type ReasoningCompleteSessionInput = z.infer<
  typeof ReasoningCompleteSessionInputSchema
>;
