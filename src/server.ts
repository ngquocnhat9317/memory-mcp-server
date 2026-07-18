import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DB_PATH, MCP_VERSION } from "./constants.js";
import "./db.js"; // ensures schema is created before tools run
import { registerMemoryTools } from "./tools/memory.js";
import { registerReasoningTools } from "./tools/reasoning.js";
import { registerUsageGuideTool } from "./tools/usage-guide.js";

export const SERVER_INSTRUCTIONS = [
  "Memory MCP: durable memory (memory_*) plus reasoning traces (reasoning_*).",
  "Call get_usage_guide for the full policy guide before first use.",
  "Core loop: reasoning_start_session at task start (skip for trivial one-step lookups); log pivotal steps with reasoning_add_step; always finish with reasoning_complete_session (conclusion + used_memory_ids).",
  "Every reasoning_add_step/complete_session call requires the session_id returned by reasoning_start_session; reasoning_mark_step takes the step_id returned by reasoning_add_step.",
  "Saving a conclusion as memory is opt-in (save_as_memory=true); memory_mode='never' requires not_saved_reason.",
  "Tool schemas are the source of truth for parameter contracts. Never store secrets, tokens, or credentials.",
].join(" ");

export async function runServer(): Promise<void> {
  const server = new McpServer(
    {
      name: "memory-mcp-server",
      version: MCP_VERSION,
    },
    {
      instructions: SERVER_INSTRUCTIONS,
    }
  );

  registerMemoryTools(server);
  registerReasoningTools(server);
  registerUsageGuideTool(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`memory-mcp-server running via stdio (db: ${DB_PATH})`);
}
