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
    memory_tags: z
      .array(z.string().min(1).max(50))
      .max(20)
      .default([])
      .describe("Tags to attach to the created memory, only used when save_as_memory is true."),
  })
  .strict();
export type ReasoningCompleteSessionInput = z.infer<
  typeof ReasoningCompleteSessionInputSchema
>;
