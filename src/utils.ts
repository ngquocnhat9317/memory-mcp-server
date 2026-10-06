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

/** Splits raw text into quoted-prefix FTS5 terms so punctuation cannot break MATCH. */
function ftsTerms(raw: string): string[] {
  return raw
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}"*`);
}

/**
 * memory_search terms: quoted-prefix FTS terms, deduped
 * case-insensitively so a repeated word cannot inflate the coverage floor.
 * Punctuation-only tokens ("-", "–", "/") never match anything, so they are
 * dropped rather than counted toward the floor. No stopword or length
 * filtering — an explicit query is the caller's intent.
 */
export function toSearchTerms(raw: string): string[] {
  const seen = new Set<string>();
  const words = raw
    .trim()
    .split(/\s+/)
    .filter((token) => /[\p{L}\p{N}]/u.test(token))
    .join(" ");
  return ftsTerms(words).filter((term) => {
    const key = term.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Generic task words and function words. They match nearly every memory,
 * so counting them toward the recall floor lets unrelated memories in.
 * Includes a few common Vietnamese words (titles are often mixed-language).
 */
const RECALL_STOPWORDS = new Set([
  "fix", "fixes", "fixing", "add", "adds", "adding", "update", "updates",
  "updating", "improve", "improves", "improving", "implement",
  "implementing", "review", "investigate", "investigating", "debug",
  "debugging", "bug", "bugs", "issue", "issues", "task", "tasks",
  "the", "and", "for", "with", "from", "into", "that", "this", "are", "not",
  "không", "của", "cho", "với", "các", "những", "một", "cải", "tiến",
  "sửa", "lỗi", "thêm",
]);

function bareToken(token: string): string {
  return token.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

/**
 * Term preparation for auto-recall only. Drops noise tokens (<=2 chars,
 * the main source of one-word junk matches) and generic stopwords, and caps
 * the count so long titles stay cheap. If filtering would leave nothing, it
 * falls back to the unfiltered tokens. memory_search uses toSearchTerms (no
 * filtering) — an explicit query is the caller's intent.
 */
export function toRecallTerms(raw: string): string[] {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  const significant = tokens.filter((token) => token.length > 2);
  const topical = significant.filter(
    (token) => !RECALL_STOPWORDS.has(bareToken(token))
  );
  const base =
    topical.length > 0 ? topical : significant.length > 0 ? significant : tokens;
  // Dedupe case-insensitively: a repeated word must not raise the
  // match floor or double-count as two matched terms.
  const seen = new Set<string>();
  const chosen = base
    .filter((token) => {
      const key = token.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 8);
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
      return "Error: Referenced session_id does not exist. Use reasoning_start_session first, or reasoning_find to look up an existing session.";
    }
    if (error.message.includes("UNIQUE constraint failed")) {
      return "Error: A record with this identifier already exists.";
    }
    return `Error: ${error.message}`;
  }
  return `Error: Unexpected error occurred: ${String(error)}`;
}

/** Whitespace-collapsed text cut to `max` chars (default 160; "..." when cut). */
export function compactSnippetText(text: string, max = 160): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > max ? `${compact.slice(0, max - 3)}...` : compact;
}

/** Escapes LIKE wildcards; pair with `ESCAPE '\'`. */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/** Reverses the FTS quoting of toRecallTerms/toSearchTerms: `"to""k"*` -> `to"k`. */
export function unquoteFtsTerm(term: string): string {
  return term.replace(/^"/, "").replace(/"\*?$/, "").replace(/""/g, '"');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Earliest case-insensitive word-prefix match of any word. Literal only:
 * FTS folds diacritics, this does not, so an FTS hit can return null here.
 */
export function findFirstMatch(
  text: string,
  words: string[]
): { index: number; length: number } | null {
  let best: { index: number; length: number } | null = null;
  for (const word of words) {
    if (!word) continue;
    const match = new RegExp(`(^|[^\\p{L}\\p{N}])(${escapeRegExp(word)})`, "iu").exec(text);
    if (!match) continue;
    const index = match.index + match[1].length;
    if (!best || index < best.index) best = { index, length: match[2].length };
  }
  return best;
}

/**
 * Slices [start, end) and trims partial words at both edges (within 20
 * chars), never cutting into `keep`.
 */
function sliceToWords(
  text: string,
  start: number,
  end: number,
  keep?: { index: number; length: number }
): string {
  let s = Math.max(0, start);
  let e = Math.min(text.length, end);
  if (s > 0) {
    const space = text.indexOf(" ", s);
    if (space !== -1 && space < s + 20 && (!keep || space < keep.index)) s = space + 1;
  }
  if (e < text.length) {
    const space = text.lastIndexOf(" ", e);
    if (space > s && space > e - 20 && (!keep || space >= keep.index + keep.length)) e = space;
  }
  return text.slice(s, e).trim();
}

/** A `size`-bounded excerpt centred on the first match; head cut when none. */
export function buildMatchExcerpt(text: string, words: string[], size = 160): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= size) return compact;
  const match = findFirstMatch(compact, words);
  if (!match) return `${compact.slice(0, size - 3)}...`;
  const room = size - 6; // leading and trailing "..."
  const start = Math.max(0, match.index - Math.floor(room / 3));
  const end = start + room;
  const body = sliceToWords(compact, start, end, match);
  return `${start > 0 ? "..." : ""}${body}${end < compact.length ? "..." : ""}`;
}
