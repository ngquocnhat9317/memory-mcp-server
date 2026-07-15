import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DB_PATH, MCP_VERSION } from "./constants.js";
import "./db.js"; // ensures schema is created before tools run
import { registerMemoryTools } from "./tools/memory.js";
import { registerReasoningTools } from "./tools/reasoning.js";
import { registerUsageGuideTool } from "./tools/usage-guide.js";

export async function runServer(): Promise<void> {
  const server = new McpServer({
    name: "memory-mcp-server",
    version: MCP_VERSION,
  });

  registerMemoryTools(server);
  registerReasoningTools(server);
  registerUsageGuideTool(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`memory-mcp-server running via stdio (db: ${DB_PATH})`);
}
