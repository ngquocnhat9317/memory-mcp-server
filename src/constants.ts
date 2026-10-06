import path from "node:path";
import os from "node:os";

/** Max characters returned in a single tool response before truncation. */
export const CHARACTER_LIMIT = 25000;
export const MCP_VERSION = "1.4.0";
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

function stripTrailingSeparators(value: string): string {
  let result = value.trim();
  while (result.length > 1 && /[\\/]$/.test(result)) {
    result = result.slice(0, -1);
  }
  return result;
}

/**
 * Normalizes a workspace path: trims it and strips trailing separators.
 * Returns null ("unknown") for values that cannot identify a project —
 * empty, "/", and the home directory. Desktop clients launch the server
 * from those, and treating them as a project merges unrelated projects.
 */
export function normalizeWorkspace(
  raw: string | null | undefined
): string | null {
  if (!raw) return null;
  const value = stripTrailingSeparators(raw);
  if (value === "" || value === "/") return null;
  if (value === stripTrailingSeparators(os.homedir())) return null;
  return value;
}

/**
 * Workspace identity for memory scoping, or null when unknown. Precedence:
 * an explicit value passed by the agent (it always knows its project),
 * then MEMORY_WORKSPACE, then process.cwd() — Claude Code/Codex launch the
 * server inside the project, desktop apps often do not. Read at call time
 * (same pattern as isTelemetryEnabled) for testability.
 */
export function getWorkspace(explicit?: string): string | null {
  return normalizeWorkspace(
    explicit?.trim() || process.env.MEMORY_WORKSPACE || process.cwd()
  );
}

export const DEFAULT_LIST_LIMIT = 20;
export const MAX_LIST_LIMIT = 200;

/**
 * Blended auto-recall score weights — see
 * docs/design/2026-10-05-spec-recall-workspace-identity.md §3.4.
 * Relevance (coverage + bm25) is the largest block; workspace only orders
 * candidates that already passed the cross-project gate.
 */
export const RECALL_WEIGHTS = {
  coverage: 0.45,
  bm25: 0.2,
  workspace: 0.3,
  recency: 0.05,
} as const;

/** recency = 1 / (1 + age_days / RECALL_RECENCY_DAYS). */
export const RECALL_RECENCY_DAYS = 60;
