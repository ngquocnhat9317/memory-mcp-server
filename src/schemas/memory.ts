import { z } from "zod";

export const MemoryTypeEnum = z.enum([
  "fact",
  "preference",
  "episodic",
  "decision",
  "reasoning_summary",
]);

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
