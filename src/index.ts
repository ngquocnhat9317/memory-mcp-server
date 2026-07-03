#!/usr/bin/env node
/**
 * memory-mcp-server
 *
 * An MCP server that gives an agent durable long-term memory and the
 * ability to record/retrieve step-by-step reasoning traces, backed by
 * a local SQLite database (with full-text search over memories).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DB_PATH } from "./constants.js";
import "./db.js"; // ensures schema is created before tools run
import { registerMemoryTools } from "./tools/memory.js";
import { registerReasoningTools } from "./tools/reasoning.js";

const server = new McpServer({
  name: "memory-mcp-server",
  version: "1.0.0",
});

registerMemoryTools(server);
registerReasoningTools(server);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`memory-mcp-server running via stdio (db: ${DB_PATH})`);
}

main().catch((error) => {
  console.error("Fatal error starting memory-mcp-server:", error);
  process.exit(1);
});
