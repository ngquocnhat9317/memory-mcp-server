# Architecture

Version: 1.3.1

This document describes how `memory-mcp-server` is built, for contributors
working inside this repository. For install/usage instructions see
[`README.md`](../README.md). For the runtime rules an agent follows when
calling this MCP, see [`GUIDELINES.md`](../GUIDELINES.md).

**Keep this file in sync.** Any change that affects the module map, data
flow, storage model, or tool surface must update this document in the same
change — see the sync rule in Section 6. The `Version:` line above must
always match `version` in `package.json`; this is enforced by
`src/__tests__/architecture-doc-version.test.ts` and must be bumped on
every release, even a release with no architectural change (see Section 6
and the Release Process in `CLAUDE.md`/`AGENTS.md`).

## 1. Overview

`memory-mcp-server` is a local Model Context Protocol (MCP) server that runs
over stdio — there is no network listener and no separate service process.
It gives an agent two capabilities backed by a single local SQLite database:

- **Durable memory**: facts, decisions, and summaries that persist across
  tasks and sessions, retrievable by full-text search.
- **Reasoning traces**: per-task, step-by-step records of what an agent did,
  with auto-recall of related memories at session start and auto-cleanup of
  abandoned sessions.

Storage uses Node's built-in `node:sqlite` (stable enough for this server's
needs as of Node 22), which means **no native addon build step** — the
package installs and runs with plain `npm install`. Node 22 still marks
`node:sqlite` as experimental, so the server prints an `ExperimentalWarning`
to stderr at startup; this is expected and does not indicate a problem.

## 2. Layering

Requests flow through four layers, each with one responsibility:

```
index.ts             CLI dispatcher: routes argv to server.ts or install-agents.ts
   |
server.ts            tool registration + MCP transport wiring
   |
tools/*.ts           tool handlers: validate → do the work → shape the response
   |
schemas/*.ts          zod input contracts consumed by tools/*.ts
   |
db.ts                 opens the SQLite database, runs pending migrations
```

`src/index.ts` is the package's bin entry point, but it does no MCP work
itself: it reads `process.argv[2]` and dynamically `import()`s exactly one
of two modules, so loading one never triggers the other's side effects —
critically, the `install-agents` path must never import `./db.js`. With no
subcommand (the default, used by every existing client config), it loads
`src/server.ts`, which constructs the `McpServer`, calls each
`register*Tools(server)` function, and connects a `StdioServerTransport` —
this is the code that used to live directly in `index.ts`. With the
`install-agents` subcommand, it loads `src/install-agents.ts` instead (see
below), which never touches the MCP/database path at all.

Importing `src/db.ts` (from `server.ts`) has a side effect — it opens (or
creates) the SQLite file at `DB_PATH`, sets `PRAGMA journal_mode = WAL` and
`PRAGMA foreign_keys = ON`, and runs `runMigrations(db)` — so the schema is
always current before any tool handler runs. `src/server.ts` imports
`./db.js` purely for this side effect, before registering tools.

`src/install-agents.ts` is a separate, one-shot setup utility, not part of
the MCP-serving path above: invoked via `memory-mcp-server install-agents`
(or independently via `scripts/install-agent-snippet.sh` for users who
haven't installed the package yet), it reads the pasteable snippet out of
`README.md` (between `<!-- MEMORY_MCP_SERVER_START/END -->` markers) and
idempotently writes it into a user's global `~/.claude/CLAUDE.md` and
`~/.codex/AGENTS.md`. It never touches the MCP server, the database, or any
project-scoped file.

Each `register*Tools` function accepts an optional `DatabaseSync` parameter
that defaults to the module-level `db` singleton from `db.ts`. Production
code (`index.ts`) always uses the default; tests pass an isolated in-memory
or temp-file database instead, so tests never share state with each other or
with a developer's real `~/.memory-mcp-server/memory.db`.

Supporting modules used across layers:

- `src/constants.ts` — `MCP_VERSION`, `DB_PATH`, environment-variable
  defaults (`MEMORY_SESSION_TTL_HOURS`, `MEMORY_AUTO_RECALL_LIMIT`,
  `MEMORY_WORKSPACE`, `MEMORY_TELEMETRY`), and `isTelemetryEnabled()`.
- `src/types.ts` — shared TypeScript types for rows and tool payloads.
- `src/utils.ts` — small shared helpers (id generation, timestamps, error
  shaping).

## 3. Module Map

| File | Responsibility |
| --- | --- |
| `src/index.ts` | Bin entry point / CLI dispatcher: routes argv to `server.ts` (default) or `install-agents.ts` (`install-agents` subcommand) |
| `src/server.ts` | Constructs the `McpServer`, registers all tool groups, connects the stdio transport (moved out of `index.ts`) |
| `src/install-agents.ts` | `install-agents` CLI subcommand: installs the README's agent-guidance snippet into global Claude Code / Codex CLI config |
| `src/db.ts` | Opens the SQLite database at `DB_PATH`, sets PRAGMAs, runs migrations on import (side effect) |
| `src/constants.ts` | `MCP_VERSION`, `DB_PATH`, and all environment-variable-driven configuration defaults |
| `src/types.ts` | Shared TypeScript types for database rows and tool I/O |
| `src/utils.ts` | Shared helpers: id generation, timestamps, error-response shaping |
| `src/tools/memory.ts` | `memory_save`, `memory_search`, `memory_list`, `memory_get`, `memory_update`, `memory_delete`, `memory_record_usage_feedback`, and the telemetry report tools (`memory_usage_report`, `memory_adoption_report`, `memory_agent_scorecard`) |
| `src/tools/reasoning.ts` | `reasoning_start_session` (auto-recall + stale-session cleanup), `reasoning_add_step`, `reasoning_complete_session`, `reasoning_get_trace`, `reasoning_list_sessions`, `reasoning_mark_step`, `reasoning_search_steps`, `reasoning_list_milestones`, `reasoning_get_session_outline` |
| `src/tools/telemetry.ts` | Shared usage-event recording (`tool_usage_events` inserts) called by both `tools/memory.ts` and `tools/reasoning.ts`; owns the `MEMORY_TELEMETRY` gate for diagnostics events |
| `src/tools/usage-guide.ts` | `get_usage_guide` — serves the versioned `GUIDELINES.md` content and records a telemetry event for the read |
| `src/schemas/memory.ts` | zod input contracts for every `memory_*` tool |
| `src/schemas/reasoning.ts` | zod input contracts for every `reasoning_*` tool |
| `src/migrations/0001_initial.ts` … `0005_memory_workspace.ts` | Individual, ordered schema migrations (see Section 5) |
| `src/migrations/index.ts` | `runMigrations(db)` — applies pending migrations in order inside a transaction per migration, tracked in `schema_migrations` |
| `src/__tests__/*` | Behavior-locking tests, one file per feature wave plus focused suites (`memory-tools`, `migrations`, `reasoning-audit-tools`) |

## 4. Data Flow

The typical task lifecycle, and where each step reads or writes the database:

1. **`reasoning_start_session(title, ...)`** — writes a new row to
   `reasoning_sessions`. Before returning, it **reads** `memories` (full-text
   search against `title`, BM25-ranked, workspace-aware — see
   `related_memories` in the response) and **reads+writes**
   `reasoning_sessions` again to auto-abandon any `in_progress` session older
   than `MEMORY_SESSION_TTL_HOURS`.
2. **`reasoning_add_step(session_id, ...)`** (single or batched, up to 20 per
   call) — **writes** sequentially-numbered rows to `reasoning_steps` inside
   one transaction per call.
3. **`reasoning_mark_step(...)`** (optional, any time during the task) —
   **writes** a row to `reasoning_step_marks` tagging a step as `decision`,
   `conflict`, `hypothesis`, `milestone`, or `important`.
4. **`reasoning_complete_session(session_id, conclusion, ...)`** — **writes**
   the closing state to `reasoning_sessions`; if `save_as_memory=true` or
   `memory_mode='always'`, **writes** a new row to `memories` whose
   `source` provenance points back at this session; if `used_memory_ids` is
   supplied, **writes** one usage-feedback event per id (always recorded,
   independent of `MEMORY_TELEMETRY`).

`memory_save` / `memory_search` / `memory_list` / `memory_get` /
`memory_update` / `memory_delete` operate directly on `memories` outside any
reasoning session, for durable facts that don't need a task trace.

Every tool call that isn't pure usage-feedback also **writes** one row to
`tool_usage_events` when `MEMORY_TELEMETRY=on` (diagnostics only — never
required for correctness of the above flow).

## 5. Storage Model

SQLite tables, all created/altered by the migrations in `src/migrations/`:

| Table | Added by | Purpose |
| --- | --- | --- |
| `memories` | `0001_initial` (workspace column added by `0005_memory_workspace`) | Durable memory rows: `type`, `content`, `importance`, `tags`, `agent_id`, `source` (session provenance), `workspace` |
| `reasoning_sessions` | `0001_initial` | One row per task-level reasoning session: `title`, `status`, `conclusion`, timestamps |
| `reasoning_steps` | `0001_initial` | Ordered steps within a session: `thought`/`action`/`observation`, `step_number` |
| `reasoning_step_marks` | `0002_reasoning_step_marks` | One mark per (step, mark type) — enforces a single row per step/type pair |
| `tool_usage_events` | `0004_tool_usage_events` | Diagnostics/telemetry events (gated by `MEMORY_TELEMETRY`) and usage-feedback events (always recorded) |
| `schema_migrations` | created directly by `runMigrations` (not a numbered migration) | Tracks which migration versions have been applied |

Plus two FTS5 virtual tables for full-text search, added by
`0001_initial` (`memories_fts`) and `0003_reasoning_steps_fts`
(`reasoning_steps_fts`).

Migrations run automatically: importing `src/db.ts` calls
`runMigrations(db)`, which reads `schema_migrations`, applies any migration
not yet recorded there (each inside its own `BEGIN`/`COMMIT`, rolled back on
error), and records it. **Upgrading the npm package never requires manual
schema work** — the next server start migrates the existing database file in
place.

## 6. Adding a New Tool

1. Add the input contract to `src/schemas/memory.ts` or
   `src/schemas/reasoning.ts` (whichever domain it belongs to).
2. Add the handler to `src/tools/memory.ts` or `src/tools/reasoning.ts`,
   following the existing handlers' pattern: validate with the schema,
   operate on the database parameter (defaulting to the `db.ts` singleton),
   record a `tool_usage_events` row via `src/tools/telemetry.ts` if the tool
   should be measurable, and return a `ToolResponse`.
3. Register the tool inside the file's `register*Tools(server, db?)`
   function.
4. If the tool needs new columns or tables, add a new numbered file under
   `src/migrations/` (never edit a shipped migration) and list it in
   `src/migrations/index.ts`.
5. Add or extend a test in `src/__tests__/`.
6. **Update docs in the same change, per the sync rule**: `README.md`'s Tool
   Surface table, `CHANGELOG.md`, `GUIDELINES.md` (version bump + assertion
   sync in `reasoning-audit-tools.test.ts` if agent-facing behavior
   changed), and **this file** — update Sections 3–5 if the module map, data
   flow, or storage model changed. Do not leave `docs/architecture.md`
   describing a shape the code no longer has.

## 7. Telemetry vs. Usage Feedback

Two different signals share the `tool_usage_events` table but have different
gating:

- **Telemetry** (diagnostics: searches, saves, recalls, latency) is
  **opt-in** via `MEMORY_TELEMETRY=on` (default `off`). It exists for
  operators running multiple agent personas who want usage reports
  (`memory_usage_report`, `memory_adoption_report`,
  `memory_agent_scorecard`).
- **Usage feedback** (`used_memory_ids` on `reasoning_complete_session`,
  `memory_record_usage_feedback`) is **always recorded locally**,
  regardless of `MEMORY_TELEMETRY` — it is the first-party learning signal
  for whether recall is actually helping, not a diagnostics concern. Only
  *failed* feedback attempts (e.g. an unknown memory id) are treated as
  diagnostics and stay gated behind `MEMORY_TELEMETRY`.

Nothing recorded by either mechanism leaves the local machine.
