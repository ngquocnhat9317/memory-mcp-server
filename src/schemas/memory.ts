import { z } from "zod";

const REPORT_DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidReportDate(value: string): boolean {
  if (REPORT_DATE_ONLY_RE.test(value)) return true;
  return !Number.isNaN(Date.parse(value));
}

const ReportDateInputSchema = z
  .string()
  .max(50)
  .refine(isValidReportDate, {
    message: "Expected YYYY-MM-DD or a valid date-time string.",
  });

export const MemoryTypeEnum = z.enum([
  "fact",
  "preference",
  "episodic",
  "decision",
  "reasoning_summary",
]);

export const MemorySaveInputSchema = z
  .object({
    content: z
      .string()
      .min(1, "content is required")
      .max(8000, "content must not exceed 8000 characters")
      .describe(
        "The memory text to store, written as a self-contained statement (e.g. 'User prefers TypeScript over Python for new services')."
      ),
    type: MemoryTypeEnum.default("fact").describe(
      "Category of memory: 'fact' (durable info), 'preference' (user/agent preference), 'episodic' (something that happened), 'decision' (a choice that was made and why), 'reasoning_summary' (distilled conclusion from a reasoning session)."
    ),
    tags: z
      .array(z.string().min(1).max(50))
      .max(20)
      .default([])
      .describe(
        "Short lowercase topic labels for filtering/search, e.g. ['sqlite','backend'] — topics, not workspace or project names."
      ),
    importance: z
      .number()
      .int()
      .min(1)
      .max(5)
      .default(3)
      .describe(
        "Priority from 1 (trivial) to 5 (critical). Use to rank recall when many memories match."
      ),
    agent_id: z
      .string()
      .max(100)
      .optional()
      .describe(
        "Optional identifier for the agent/persona this memory belongs to, for multi-agent setups."
      ),
    metadata: z
      .record(z.unknown())
      .optional()
      .describe(
        "Optional free-form JSON object for extra structured context (e.g. {\"source_url\": \"...\"})."
      ),
  })
  .strict();
export type MemorySaveInput = z.infer<typeof MemorySaveInputSchema>;

export const MemorySearchInputSchema = z
  .object({
    query: z
      .string()
      .min(1, "query must be at least 1 character")
      .max(300)
      .describe("Free-text search query, matched against content and tags."),
    type: MemoryTypeEnum.optional().describe(
      "Restrict results to a single memory type."
    ),
    agent_id: z.string().max(100).optional().describe("Filter by agent_id."),
    tags: z
      .array(z.string())
      .max(20)
      .optional()
      .describe("Only return memories that contain ALL of these tags."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .default(20)
      .describe("Maximum results to return (default 20, max 200)."),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe("Number of results to skip, for pagination."),
  })
  .strict();
export type MemorySearchInput = z.infer<typeof MemorySearchInputSchema>;

export const MemoryListInputSchema = z
  .object({
    type: MemoryTypeEnum.optional().describe("Filter by memory type."),
    agent_id: z.string().max(100).optional().describe("Filter by agent_id."),
    tags: z
      .array(z.string())
      .max(20)
      .optional()
      .describe("Only return memories that contain ALL of these tags."),
    min_importance: z
      .number()
      .int()
      .min(1)
      .max(5)
      .optional()
      .describe("Only return memories with importance >= this value."),
    sort_by: z
      .enum(["created_at", "updated_at", "importance"])
      .default("updated_at")
      .describe("Field to sort by (default: updated_at, newest first)."),
    limit: z.number().int().min(1).max(200).default(20),
    offset: z.number().int().min(0).default(0),
  })
  .strict();
export type MemoryListInput = z.infer<typeof MemoryListInputSchema>;

export const MemoryGetInputSchema = z
  .object({
    id: z.string().min(1).describe("The memory id, e.g. 'mem_...'."),
  })
  .strict();
export type MemoryGetInput = z.infer<typeof MemoryGetInputSchema>;

// NOTE: kept as a plain ZodObject (no .refine()) so `.shape` stays available
// for registerTool's inputSchema. The "at least one field" rule is enforced
// in the tool handler instead.
export const MemoryUpdateInputSchema = z
  .object({
    id: z.string().min(1).describe("The memory id to update."),
    content: z
      .string()
      .min(1)
      .max(8000)
      .optional()
      .describe("New content text, if changing it."),
    type: MemoryTypeEnum.optional().describe("New memory type, if changing it."),
    tags: z
      .array(z.string().min(1).max(50))
      .max(20)
      .optional()
      .describe("Replaces the full tag list (not merged), if provided."),
    tags_append: z
      .array(z.string().min(1).max(50))
      .max(20)
      .optional()
      .describe("Tags to append when not replacing the full tag list."),
    tags_remove: z
      .array(z.string().min(1).max(50))
      .max(20)
      .optional()
      .describe("Tags to remove when not replacing the full tag list."),
    importance: z.number().int().min(1).max(5).optional().describe("New importance, if changing it."),
    metadata: z
      .record(z.unknown())
      .optional()
      .describe("Replaces the full metadata object (not merged), if provided."),
    metadata_patch: z
      .record(z.unknown())
      .optional()
      .describe("Shallow metadata patch to merge when not replacing the full metadata object."),
  })
  .strict();
export type MemoryUpdateInput = z.infer<typeof MemoryUpdateInputSchema>;

export const MemoryDeleteInputSchema = z
  .object({
    id: z.string().min(1).describe("The memory id to delete."),
  })
  .strict();
export type MemoryDeleteInput = z.infer<typeof MemoryDeleteInputSchema>;

export const MemoryGetUsageGuideInputSchema = z
  .object({
    agent_id: z.string().max(100).optional(),
    client_name: z.string().max(100).optional(),
    client_version: z.string().max(100).optional(),
  })
  .strict();
export type MemoryGetUsageGuideInput = z.infer<
  typeof MemoryGetUsageGuideInputSchema
>;

export const MemoryUsageReportGroupByEnum = z.enum([
  "tool_name",
  "agent_id",
  "client_name",
  "mcp_version",
  "operation_type",
  "status",
  "day",
]);

export const MemoryUsageReportInputSchema = z
  .object({
    agent_id: z.string().max(100).optional(),
    client_name: z.string().max(100).optional(),
    mcp_version: z.string().max(50).optional(),
    date_from: ReportDateInputSchema.optional(),
    date_to: ReportDateInputSchema.optional(),
    group_by: MemoryUsageReportGroupByEnum.default("tool_name"),
    limit: z.number().int().min(1).max(200).default(50),
  })
  .strict();
export type MemoryUsageReportInput = z.infer<
  typeof MemoryUsageReportInputSchema
>;

export const MemoryAdoptionReportInputSchema = z
  .object({
    agent_id: z.string().max(100).optional(),
    date_from: ReportDateInputSchema.optional(),
    date_to: ReportDateInputSchema.optional(),
    limit: z.number().int().min(1).max(200).default(50),
  })
  .strict();
export type MemoryAdoptionReportInput = z.infer<
  typeof MemoryAdoptionReportInputSchema
>;

export const MemoryAgentScorecardInputSchema = z
  .object({
    agent_id: z.string().max(100).optional(),
    date_from: ReportDateInputSchema.optional(),
    date_to: ReportDateInputSchema.optional(),
    limit: z.number().int().min(1).max(200).default(20),
  })
  .strict();
export type MemoryAgentScorecardInput = z.infer<
  typeof MemoryAgentScorecardInputSchema
>;

export const MemoryFeedbackUsefulnessEnum = z.enum([
  "used",
  "ignored",
  "irrelevant",
  "stale",
  "unsafe_to_use",
]);

export const MemoryRecordUsageFeedbackInputSchema = z
  .object({
    memory_id: z.string().min(1),
    event_id: z.string().min(1).optional(),
    agent_id: z.string().max(100).optional(),
    usefulness: MemoryFeedbackUsefulnessEnum,
    reason: z.string().min(1).max(500).optional(),
  })
  .strict();
export type MemoryRecordUsageFeedbackInput = z.infer<
  typeof MemoryRecordUsageFeedbackInputSchema
>;
