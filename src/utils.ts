import { randomUUID } from "node:crypto";
import { CHARACTER_LIMIT } from "./constants.js";

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function parseJsonArray(text: string | null): string[] {
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export function parseJsonObject(
  text: string | null
): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

/** FTS5 MATCH queries break on raw punctuation; wrap terms as a safe prefix query. */
export function toFtsQuery(raw: string): string {
  const terms = ftsTerms(raw);
  return terms.length ? terms.join(" ") : '""';
}

function ftsTerms(raw: string): string[] {
  return raw
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}"*`);
}

/**
 * Term preparation for auto-recall only. Drops noise tokens (<=2 chars,
 * the main source of one-word junk matches) and caps the count so long
 * titles stay cheap. memory_search keeps raw ftsTerms behavior — an
 * explicit query is the caller's intent.
 */
export function toRecallTerms(raw: string): string[] {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  const significant = tokens.filter((token) => token.length > 2);
  const chosen = (significant.length > 0 ? significant : tokens).slice(0, 8);
  return chosen.map((t) => `"${t.replace(/"/g, '""')}"*`);
}

/** Serialize a value to text, truncating with a clear message if it exceeds CHARACTER_LIMIT. */
export function toLimitedJson(value: unknown): string {
  const text = JSON.stringify(value, null, 2);
  if (text.length <= CHARACTER_LIMIT) return text;
  return JSON.stringify(
    {
      truncated: true,
      truncation_message: `Response exceeded ${CHARACTER_LIMIT} characters and was truncated. Narrow your query (add filters, reduce limit) to see full results.`,
      partial_text: text.slice(0, CHARACTER_LIMIT),
    },
    null,
    2
  );
}

export function handleToolError(error: unknown): string {
  if (error instanceof Error) {
    // node:sqlite constraint violations
    if (error.message.includes("CHECK constraint failed")) {
      return `Error: Invalid value provided (${error.message}). Check allowed ranges/enums in the tool description.`;
    }
    if (error.message.includes("FOREIGN KEY constraint failed")) {
      return "Error: Referenced session_id does not exist. Use reasoning_start_session first, or check reasoning_list_sessions for valid IDs.";
    }
    if (error.message.includes("UNIQUE constraint failed")) {
      return "Error: A record with this identifier already exists.";
    }
    return `Error: ${error.message}`;
  }
  return `Error: Unexpected error occurred: ${String(error)}`;
}
