#!/usr/bin/env node
/**
 * memory-mcp-server
 *
 * An MCP server that gives an agent durable long-term memory and the
 * ability to record/retrieve step-by-step reasoning traces, backed by
 * a local SQLite database (with full-text search over memories).
 *
 * CLI subcommands (checked via argv before anything else loads, so
 * `install-agents` never triggers the server's DB initialization):
 *   - (none)          -> starts the MCP server over stdio
 *   - install-agents  -> installs the README snippet into global agent config
 */

async function main(): Promise<void> {
  const subcommand = process.argv[2];

  if (subcommand === "install-agents") {
    const { installAgents } = await import("./install-agents.js");
    await installAgents();
  } else {
    const { runServer } = await import("./server.js");
    await runServer();
  }
}

main().catch((error) => {
  const label =
    process.argv[2] === "install-agents"
      ? "Fatal error running install-agents"
      : "Fatal error starting memory-mcp-server";
  console.error(`${label}:`, error);
  process.exit(1);
});
