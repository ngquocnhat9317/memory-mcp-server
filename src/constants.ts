import path from "node:path";
import os from "node:os";

/** Max characters returned in a single tool response before truncation. */
export const CHARACTER_LIMIT = 25000;
export const MCP_VERSION = "1.1.0";
export const TELEMETRY_ENABLED = process.env.MEMORY_TELEMETRY !== "off";

/**
 * Location of the SQLite database file.
 * Override with the MEMORY_DB_PATH environment variable, e.g. to keep
 * per-project memory stores instead of one global store.
 */
export const DB_PATH =
  process.env.MEMORY_DB_PATH ??
  path.join(os.homedir(), ".memory-mcp-server", "memory.db");

export const DEFAULT_LIST_LIMIT = 20;
export const MAX_LIST_LIMIT = 200;
