import path from "node:path";
import os from "node:os";

/** Max characters returned in a single tool response before truncation. */
export const CHARACTER_LIMIT = 25000;
export const MCP_VERSION = "1.3.1";
/**
 * Diagnostics-event recording is opt-in: set MEMORY_TELEMETRY=on to enable.
 * Read at call time so tests and long-lived processes can toggle it.
 * Usage-feedback events are a first-party learning signal and are always
 * recorded regardless of this flag (see recordToolUsageEvent).
 */
export function isTelemetryEnabled(): boolean {
  return process.env.MEMORY_TELEMETRY === "on";
}

/**
 * Hours after which an untouched in_progress reasoning session is
 * auto-abandoned on the next reasoning_start_session call.
 * Override with MEMORY_SESSION_TTL_HOURS; set to 0 (or negative) to disable.
 */
export const SESSION_TTL_HOURS = Number(
  process.env.MEMORY_SESSION_TTL_HOURS ?? 24
);

/**
 * Max related memories auto-recalled in the reasoning_start_session response.
 * Override with MEMORY_AUTO_RECALL_LIMIT; set to 0 to disable auto-recall.
 */
export const AUTO_RECALL_LIMIT = Number(
  process.env.MEMORY_AUTO_RECALL_LIMIT ?? 3
);

/**
 * Location of the SQLite database file.
 * Override with the MEMORY_DB_PATH environment variable, e.g. to keep
 * per-project memory stores instead of one global store.
 */
export const DB_PATH =
  process.env.MEMORY_DB_PATH ??
  path.join(os.homedir(), ".memory-mcp-server", "memory.db");

/**
 * Workspace identity for memory scoping. Claude Code/Codex launch the MCP
 * server inside the project directory, so cwd identifies the project;
 * MEMORY_WORKSPACE pins it explicitly when a client launches elsewhere.
 * Read at call time (same pattern as isTelemetryEnabled) for testability.
 */
export function getWorkspace(): string {
  return process.env.MEMORY_WORKSPACE ?? process.cwd();
}

export const DEFAULT_LIST_LIMIT = 20;
export const MAX_LIST_LIMIT = 200;
