import type { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MCP_VERSION } from "../constants.js";
import {
  MemoryGetUsageGuideInputSchema,
  type MemoryGetUsageGuideInput,
} from "../schemas/memory.js";
import { withTelemetry } from "./telemetry.js";

type ToolResponse = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};
const GUIDELINES_PATH = "GUIDELINES.md";
const GUIDELINES_URL = new URL(`../../${GUIDELINES_PATH}`, import.meta.url);


function extractStructuredContent(result: ToolResponse): Record<string, unknown> | null {
  return result.structuredContent ?? null;
}

function parseGuideVersion(content: string): string {
  const match = content.match(/^Version:\s*(.+)$/m);
  if (!match) {
    throw new Error(`${GUIDELINES_PATH} is missing a Version line.`);
  }
  return match[1].trim();
}

async function readGuidelines(): Promise<{
  content: string;
  guideVersion: string;
}> {
  const content = await readFile(GUIDELINES_URL, "utf8");
  return {
    content,
    guideVersion: parseGuideVersion(content),
  };
}

let defaultDatabasePromise: Promise<DatabaseSync> | null = null;

async function resolveDatabase(database?: DatabaseSync): Promise<DatabaseSync> {
  if (database) return database;
  defaultDatabasePromise ??= import("../db.js").then((module) => module.db);
  return defaultDatabasePromise;
}

export function registerUsageGuideTool(
  server: McpServer,
  database?: DatabaseSync
): void {
  const databaseProvider = () => resolveDatabase(database);

  server.registerTool(
    "get_usage_guide",
    {
      title: "Get Usage Guide",
      description:
        `Return the versioned ${GUIDELINES_PATH} file that defines how an agent should use this MCP.`,
      inputSchema: MemoryGetUsageGuideInputSchema.shape,
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
        toolName: "get_usage_guide",
        operationType: "guidance",
        accessType: "derived",
        buildEvent: (params: MemoryGetUsageGuideInput, result) => {
          const structured = extractStructuredContent(result);
          return {
            agentId: params.agent_id ?? null,
            clientName: params.client_name ?? null,
            clientVersion: params.client_version ?? null,
            guidanceVersion:
              typeof structured?.guide_version === "string"
                ? structured.guide_version
                : null,
            outputShape: structured
              ? {
                  guide_version: structured.guide_version,
                  format: structured.format,
                  content_length:
                    typeof structured.content === "string"
                      ? structured.content.length
                      : 0,
                }
              : null,
          };
        },
      },
      async (_params: MemoryGetUsageGuideInput) => {
        const guidelines = await readGuidelines();
        const output = {
          guide_version: guidelines.guideVersion,
          mcp_version: MCP_VERSION,
          path: GUIDELINES_PATH,
          format: "markdown",
          content: guidelines.content,
        };
        return {
          content: [{ type: "text" as const, text: guidelines.content }],
          structuredContent: output,
        };
      }
    )
  );
}
