# Docs Restructure & Contributor Documentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure `docs/` into a clean `design/` + `plans/` + `growth/` hierarchy, add the three missing contributor documents (`docs/README.md`, `docs/architecture.md`, `docs/roadmap.md`), and teach the repo how to keep `architecture.md` in sync with the shipped version going forward.

**Architecture:** Pure documentation and repo-structure change. `git mv` relocates six existing spec/plan files and commits one previously-untracked spec; three new markdown files are authored from the current `src/` code and `CHANGELOG.md`; `CLAUDE.md`/`AGENTS.md` (twins) gain new sections; one new Node test-file enforces that `docs/architecture.md`'s `Version:` line never drifts from `package.json`.

**Tech Stack:** Markdown, `git mv`, Node's built-in `node:test` + `node:assert/strict` (existing test stack, no new dependency).

## Global Constraints

- Filenames of moved spec/plan files must stay **unchanged** — the specs cross-reference each other with relative links (e.g. `./2026-07-11-spec-mcp-value-improvement.md`) and renaming would break them.
- `docs/growth/registry-submissions.md` stays at its current path — `CHANGELOG.md:33` references it directly and must not need an edit.
- Every file move uses `git mv` (not `mv` + `git add`/`git rm`) so history is preserved, except the one currently-untracked file (`2026-07-12-spec-v1.3.5-recall-refinements.md`), which is untracked and must be moved with plain `mv` then `git add`.
- No runtime (`src/`) behavior changes — the only `src/` change in this plan is one new, isolated test file.
- `CLAUDE.md` and `AGENTS.md` are twins: every edit to one is applied identically to the other, in the same task.
- Per `CLAUDE.md`/`AGENTS.md`: run `npm run build && npm test` after any change that touches `src/__tests__/*` or repo structure referenced by tests.
- Spec of record: `docs/design/2026-07-14-docs-restructure-design.md` (already committed at `acf8434`). If anything in this plan seems to contradict that spec, the spec wins — flag it instead of silently deviating.

---

### Task 1: Move design specs and plans into the new `docs/` structure

**Files:**
- Create: `docs/design/` (directory, populated by moves below)
- Create: `docs/plans/` (directory — already exists on disk from plan authoring; populated by moves below)
- Move (git mv): `docs/plan-improvement-performance/2026-07-11-spec-mcp-value-improvement.md` → `docs/design/2026-07-11-spec-mcp-value-improvement.md`
- Move (git mv): `docs/plan-improvement-performance/2026-07-12-spec-recall-precision-workspace.md` → `docs/design/2026-07-12-spec-recall-precision-workspace.md`
- Move (plain `mv` + `git add`, file is currently untracked): `docs/plan-improvement-performance/2026-07-12-spec-v1.3.5-recall-refinements.md` → `docs/design/2026-07-12-spec-v1.3.5-recall-refinements.md`
- Move (git mv): `docs/superpowers/specs/2026-07-03-memory-mcp-audit-layer-design.md` → `docs/design/2026-07-03-memory-mcp-audit-layer-design.md`
- Move (git mv): `docs/superpowers/specs/2026-07-05-memory-mcp-guidance-telemetry-design.md` → `docs/design/2026-07-05-memory-mcp-guidance-telemetry-design.md`
- Move (git mv): `docs/superpowers/specs/2026-07-08-agents-contributor-workflow-design.md` → `docs/design/2026-07-08-agents-contributor-workflow-design.md`
- Move (git mv): `docs/superpowers/plans/2026-07-01-agents-md-rewrite.md` → `docs/plans/2026-07-01-agents-md-rewrite.md`
- Move (git mv): `docs/superpowers/plans/2026-07-03-audit-layer-implementation.md` → `docs/plans/2026-07-03-audit-layer-implementation.md`
- Move (git mv): `docs/superpowers/plans/2026-07-08-agents-contributor-workflow.md` → `docs/plans/2026-07-08-agents-contributor-workflow.md`
- Delete (directory, once empty): `docs/plan-improvement-performance/`
- Delete (directory, once empty): `docs/superpowers/specs/`, `docs/superpowers/plans/`, `docs/superpowers/`

**Interfaces:**
- Consumes: nothing from earlier tasks (this is the first task).
- Produces: `docs/design/` and `docs/plans/` directories populated with 7 files total, ready for Task 2–5 to add new top-level docs alongside them, and for Task 6 to update `CLAUDE.md`/`AGENTS.md` repo-map references to these exact paths.

- [ ] **Step 1: Confirm the untracked file and current tree**

Run: `git -C /Users/macbook_343/Documents/mcp/memory-mcp-server status --short`
Expected output includes exactly one line:
```
?? docs/plan-improvement-performance/2026-07-12-spec-v1.3.5-recall-refinements.md
```
(plus possibly `docs/plans/` if empty directories are shown — empty dirs are not tracked by git so this is fine to ignore).

- [ ] **Step 2: Move the three `plan-improvement-performance/` specs**

```bash
cd /Users/macbook_343/Documents/mcp/memory-mcp-server
git mv docs/plan-improvement-performance/2026-07-11-spec-mcp-value-improvement.md docs/design/2026-07-11-spec-mcp-value-improvement.md
git mv docs/plan-improvement-performance/2026-07-12-spec-recall-precision-workspace.md docs/design/2026-07-12-spec-recall-precision-workspace.md
mv docs/plan-improvement-performance/2026-07-12-spec-v1.3.5-recall-refinements.md docs/design/2026-07-12-spec-v1.3.5-recall-refinements.md
git add docs/design/2026-07-12-spec-v1.3.5-recall-refinements.md
```

- [ ] **Step 3: Move the three `superpowers/specs/` design docs**

```bash
git mv docs/superpowers/specs/2026-07-03-memory-mcp-audit-layer-design.md docs/design/2026-07-03-memory-mcp-audit-layer-design.md
git mv docs/superpowers/specs/2026-07-05-memory-mcp-guidance-telemetry-design.md docs/design/2026-07-05-memory-mcp-guidance-telemetry-design.md
git mv docs/superpowers/specs/2026-07-08-agents-contributor-workflow-design.md docs/design/2026-07-08-agents-contributor-workflow-design.md
```

- [ ] **Step 4: Move the three `superpowers/plans/` implementation plans**

```bash
git mv docs/superpowers/plans/2026-07-01-agents-md-rewrite.md docs/plans/2026-07-01-agents-md-rewrite.md
git mv docs/superpowers/plans/2026-07-03-audit-layer-implementation.md docs/plans/2026-07-03-audit-layer-implementation.md
git mv docs/superpowers/plans/2026-07-08-agents-contributor-workflow.md docs/plans/2026-07-08-agents-contributor-workflow.md
```

- [ ] **Step 5: Remove the now-empty old directories**

```bash
find docs -type d -empty -print -delete
```
Expected: prints and removes `docs/plan-improvement-performance`, `docs/superpowers/specs`, `docs/superpowers/plans`, `docs/superpowers` (in some order — `-delete` with `find` removes empty dirs bottom-up correctly in one pass, but if `docs/superpowers` isn't empty yet on the first pass, re-run the same command once more).

- [ ] **Step 6: Verify the new tree and that no old paths remain**

```bash
find docs -type f | sort
git status --short
```
Expected: `find` lists exactly `docs/design/*` (6 files), `docs/plans/*` (3 files), `docs/growth/registry-submissions.md`. `git status --short` shows only renames (`R`) plus one new file (`A`) for the previously-untracked spec — no `??` entries, no leftover `docs/plan-improvement-performance` or `docs/superpowers` paths.

- [ ] **Step 7: Spot-check the cross-references between moved specs still resolve**

```bash
grep -n '](\./' docs/design/2026-07-12-spec-recall-precision-workspace.md docs/design/2026-07-12-spec-v1.3.5-recall-refinements.md
```
Expected: the relative links (e.g. `[2026-07-11-spec-mcp-value-improvement.md](./2026-07-11-spec-mcp-value-improvement.md)`) point to filenames that now exist as siblings in `docs/design/` — confirm each linked filename appears in the `docs/design/` listing from Step 6.

- [ ] **Step 8: Commit**

```bash
git add -A docs/
git commit -m "docs: restructure docs/ into design/, plans/, growth/

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Author `docs/architecture.md` and its version-lock test

**Files:**
- Create: `docs/architecture.md`
- Create: `src/__tests__/architecture-doc-version.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1 directly (independent content), but must be created after Task 1 so `docs/design/` paths referenced inside it (if any) already exist. This task does not link to `docs/design/` files, so it has no hard ordering dependency, but is sequenced second per the plan.
- Produces: `docs/architecture.md` with a `Version: 1.3.0` line on its own line near the top (exact regex the test and future contributors rely on: `/^Version:\s*(\S+)/m`). Task 6 (CLAUDE.md/AGENTS.md) references this exact file path and the version-sync rule established here.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/architecture-doc-version.test.ts`:

```typescript
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("docs/architecture.md Version line matches package.json version", () => {
  const pkg = JSON.parse(
    fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")
  ) as { version: string };

  const architectureDoc = fs.readFileSync(
    new URL("../../docs/architecture.md", import.meta.url),
    "utf8"
  );

  const match = architectureDoc.match(/^Version:\s*(\S+)/m);
  assert.ok(match, "docs/architecture.md must contain a 'Version: X' line");
  assert.equal(
    match?.[1],
    pkg.version,
    "docs/architecture.md Version line must match package.json version — bump both together on every release"
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/macbook_343/Documents/mcp/memory-mcp-server && npm test`
Expected: build succeeds, then `node --test` reports a failure for `docs/architecture.md Version line matches package.json version` with the message `docs/architecture.md must contain a 'Version: X' line` (the file doesn't exist yet, so `fs.readFileSync` throws `ENOENT` — that counts as the expected failure).

- [ ] **Step 3: Write `docs/architecture.md`**

Create `docs/architecture.md` with this exact content:

````markdown
# Architecture

Version: 1.3.0

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
index.ts            tool registration + MCP transport wiring
   |
tools/*.ts           tool handlers: validate → do the work → shape the response
   |
schemas/*.ts          zod input contracts consumed by tools/*.ts
   |
db.ts                 opens the SQLite database, runs pending migrations
```

`src/index.ts` is the entry point: it constructs the `McpServer`, calls each
`register*Tools(server)` function, and connects a `StdioServerTransport`.
Importing `src/db.ts` has a side effect — it opens (or creates) the SQLite
file at `DB_PATH`, sets `PRAGMA journal_mode = WAL` and
`PRAGMA foreign_keys = ON`, and runs `runMigrations(db)` — so the schema is
always current before any tool handler runs. `src/index.ts` imports `./db.js`
purely for this side effect, before registering tools.

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
| `src/index.ts` | Entry point: constructs the `McpServer`, registers all tool groups, connects the stdio transport |
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
````

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /Users/macbook_343/Documents/mcp/memory-mcp-server && npm test`
Expected: full suite passes, including `docs/architecture.md Version line matches package.json version`.

- [ ] **Step 5: Commit**

```bash
git add docs/architecture.md src/__tests__/architecture-doc-version.test.ts
git commit -m "docs: add architecture.md with a package.json-version-locked test

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Author `docs/roadmap.md`

**Files:**
- Create: `docs/roadmap.md`

**Interfaces:**
- Consumes: the file paths produced by Task 1 (`docs/design/*.md`) — every link in this file must point at a file that exists after Task 1.
- Produces: `docs/roadmap.md`, referenced from `docs/README.md` (Task 4) and from the Docs Conventions section (Task 5).

- [ ] **Step 1: Write `docs/roadmap.md`**

Create `docs/roadmap.md` with this exact content:

````markdown
# Roadmap

This page is a navigation map, not a source of truth. For the full
reasoning, acceptance criteria, and rejected alternatives behind any item
below, follow the link into `docs/design/`. This file introduces no new
commitments — it only indexes what `CHANGELOG.md` and the design specs
already state.

## Shipped

| Release | Theme | Design spec |
| --- | --- | --- |
| `1.2.0` | Wave 1 — close the memory value loop: auto-recall in `reasoning_start_session`, stale-session cleanup, `used_memory_ids` usage feedback | *(predates the `docs/design/` spec set — see `CHANGELOG.md`)* |
| `1.2.5` | Wave 2 — cut logging friction: batch `reasoning_add_step`, GUIDELINES rewritten around the task lifecycle, README rewritten as a landing page | *(predates the `docs/design/` spec set — see `CHANGELOG.md`)* |
| `1.3.0` | Wave 3 + amendment — recall that stays right as the store grows: BM25 relevance ranking, provenance on `related_memories`, usage feedback decoupled from the telemetry gate, recall quality floor, workspace-aware ranking | [2026-07-11-spec-mcp-value-improvement.md](design/2026-07-11-spec-mcp-value-improvement.md), [2026-07-12-spec-recall-precision-workspace.md](design/2026-07-12-spec-recall-precision-workspace.md) |

## Planned / Next

| Target | Theme | Design spec |
| --- | --- | --- |
| `1.3.5` | Provenance consistency (WI-10), recall relevance eval base (WI-11), duplicate-surfacing hint on `memory_save` (WI-13). WI-12 and WI-14 were evaluated and dropped — see the spec §8 for why | [2026-07-12-spec-v1.3.5-recall-refinements.md](design/2026-07-12-spec-v1.3.5-recall-refinements.md) |
| `1.4.0` | Wave 4 candidates (WI-6, WI-7) — gated behind a 4–6 week real-usage evidence window defined in the Wave 3 spec §9.3; not started until that gate opens | [2026-07-11-spec-mcp-value-improvement.md](design/2026-07-11-spec-mcp-value-improvement.md) §9 |

## How to Read This

- **Shipped** rows are historical record — do not re-derive them, `CHANGELOG.md`
  is the authoritative changelog.
- **Planned** rows point at the spec that owns the real requirements. If a
  planned item's scope is unclear, read the linked spec — do not guess from
  this table.
- When a release ships, move its row from Planned to Shipped in the same
  change that updates `CHANGELOG.md` (see Release Process in
  `CLAUDE.md`/`AGENTS.md`).
````

- [ ] **Step 2: Verify the links resolve**

```bash
cd /Users/macbook_343/Documents/mcp/memory-mcp-server
for f in design/2026-07-11-spec-mcp-value-improvement.md design/2026-07-12-spec-recall-precision-workspace.md design/2026-07-12-spec-v1.3.5-recall-refinements.md; do
  test -f "docs/$f" && echo "OK: $f" || echo "MISSING: $f"
done
```
Expected: three `OK:` lines (all three files were created by Task 1).

- [ ] **Step 3: Commit**

```bash
git add docs/roadmap.md
git commit -m "docs: add consolidated roadmap.md

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Author `docs/README.md` index

**Files:**
- Create: `docs/README.md`

**Interfaces:**
- Consumes: the final `docs/` structure from Tasks 1–3 (must describe `design/`, `plans/`, `growth/`, `architecture.md`, `roadmap.md` — all must already exist).
- Produces: `docs/README.md`, linked from Task 5's CLAUDE.md/AGENTS.md repo map as the entry point into `docs/`.

- [ ] **Step 1: Write `docs/README.md`**

Create `docs/README.md` with this exact content:

```markdown
# docs/

Index of this directory. Start with `architecture.md` if you're new to the
codebase; start with `roadmap.md` if you want to know what's planned.

| Path | What it is |
| --- | --- |
| `architecture.md` | How the system is built — layering, module map, data flow, storage model, how to add a tool. Version-locked to `package.json` (see `CLAUDE.md`/`AGENTS.md` Version-Sync Conventions). |
| `roadmap.md` | Consolidated shipped/planned index over the design specs below. Navigation only — specs are the source of truth. |
| `design/` | Design specs: the "what and why" behind a change, written and approved before implementation. |
| `plans/` | Implementation plans: the "how" a design spec was actually executed, task-by-task. |
| `growth/` | Go-to-market docs — positioning, registry/directory submission notes. Not implementation-facing. |

For user-facing install/usage docs, see [`../README.md`](../README.md). For
the runtime rules an agent follows when calling this MCP, see
[`../GUIDELINES.md`](../GUIDELINES.md). For the contributor working contract,
see [`../CLAUDE.md`](../CLAUDE.md) / [`../AGENTS.md`](../AGENTS.md).
```

- [ ] **Step 2: Commit**

```bash
cd /Users/macbook_343/Documents/mcp/memory-mcp-server
git add docs/README.md
git commit -m "docs: add docs/ index README

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Update `CLAUDE.md` and `AGENTS.md` (twin files)

**Files:**
- Modify: `CLAUDE.md`
- Modify: `AGENTS.md`

**Interfaces:**
- Consumes: the final `docs/` paths from Tasks 1–4 (`docs/design/`, `docs/plans/`, `docs/growth/`, `docs/architecture.md`, `docs/roadmap.md`, `docs/README.md`) and the test file name from Task 2 (`src/__tests__/architecture-doc-version.test.ts`).
- Produces: the durable contributor contract that Task 6's final verification checks for consistency with the actual tree.

`CLAUDE.md` and `AGENTS.md` currently have near-identical bodies (see Global
Constraints — they are twins with a one-line self-reference difference: each
says the other "mirrors"/"is the twin of" it). Apply every edit below to
**both** files, adjusting only that one cross-reference line as shown.

- [ ] **Step 1: Replace the Repo Map section in `CLAUDE.md`**

Find this block in `CLAUDE.md`:

```markdown
## Repo Map

- `src/tools/memory.ts` — memory tools, telemetry reports, feedback tools
- `src/tools/reasoning.ts` — reasoning session and audit tools
- `src/tools/usage-guide.ts` — `get_usage_guide`
- `src/schemas/*` — input contracts
- `src/db.ts` — DB bootstrap and migration startup
- `src/migrations/*` — schema migrations
- `src/__tests__/*` — behavior locks
```

Replace it with:

```markdown
## Repo Map

- `src/tools/memory.ts` — memory tools, telemetry reports, feedback tools
- `src/tools/reasoning.ts` — reasoning session and audit tools
- `src/tools/telemetry.ts` — shared usage-event recording for memory/reasoning tools
- `src/tools/usage-guide.ts` — `get_usage_guide`
- `src/schemas/*` — input contracts
- `src/db.ts` — DB bootstrap and migration startup
- `src/migrations/*` — schema migrations
- `src/__tests__/*` — behavior locks
- `docs/architecture.md` — system architecture; `Version:` line must match `package.json` (see Version-Sync Conventions below)
- `docs/roadmap.md` — consolidated shipped/planned roadmap
- `docs/design/*` — design specs (what/why)
- `docs/plans/*` — implementation plans (how, done)
- `docs/growth/*` — go-to-market docs
```

- [ ] **Step 2: Replace the Docs section in `CLAUDE.md` with four sections**

Find this block in `CLAUDE.md`:

```markdown
## Docs

- **Always sync the docs in the same change as the code update.** After any code change, re-check `GUIDELINES.md`, `README.md`, and `CHANGELOG.md`; if the behavior they describe changed, update them together with the code — never leave them one release behind.
- When `GUIDELINES.md` changes, bump its `Version:` line and update the matching assertions in `src/__tests__/reasoning-audit-tools.test.ts`.
- `AGENTS.md` is the twin of this file — apply any edit here to `AGENTS.md` as well.
- Do not copy `README.md` setup guidance into this file.
```

Replace it with:

```markdown
## Docs

- Do not copy `README.md` setup guidance into this file.
- `AGENTS.md` is the twin of this file — apply any edit here to `AGENTS.md` as well.

## Docs Conventions

- New design spec → `docs/design/YYYY-MM-DD-<topic>.md`.
- New implementation plan → `docs/plans/YYYY-MM-DD-<topic>.md`.
- Go-to-market docs (positioning, registry/directory submissions) → `docs/growth/`.
- `docs/architecture.md` and `docs/roadmap.md` are living documents, not specs — edit them in place rather than superseding them with a new dated file.

## Release Process

When bumping the package version, update in this order, in the same change:

1. `package.json` `version`.
2. `MCP_VERSION` in `src/constants.ts`.
3. `docs/architecture.md` `Version:` line — bump only after confirming the document still matches the code (see Version-Sync Conventions).
4. `CHANGELOG.md` — add a release entry.
5. `GUIDELINES.md` `Version:` line, only if agent-facing behavior changed.
6. Run `npm run build && npm test`.
7. Move the relevant row from Planned to Shipped in `docs/roadmap.md`.

## Version-Sync Conventions

- **Always sync docs in the same change as the code update.** After any code change, re-check `GUIDELINES.md`, `README.md`, `CHANGELOG.md`, and `docs/architecture.md`; if the behavior or structure they describe changed, update them together with the code — never leave them one release behind.
- `GUIDELINES.md`'s `Version:` line must match the version asserted in `src/__tests__/reasoning-audit-tools.test.ts` (`structuredContent.guide_version`). When `GUIDELINES.md` changes, bump its `Version:` line and update that assertion in the same change.
- `docs/architecture.md`'s `Version:` line must match `package.json`'s `version` field, enforced by `src/__tests__/architecture-doc-version.test.ts`. Bump both together on every release — even a release with no architectural change — or the test fails the build.
```

- [ ] **Step 3: Apply the identical changes to `AGENTS.md`**

`AGENTS.md`'s current Repo Map and Docs sections are the same content with
one different phrase in the last Docs bullet (`` `CLAUDE.md` is a mirror of
this file `` instead of `` `AGENTS.md` is the twin of this file ``). Apply
the same two replacements from Steps 1–2 to `AGENTS.md`, keeping that one
self-reference line worded as it already is in `AGENTS.md` (mirror
direction), i.e. the final Docs section in `AGENTS.md` should read:

```markdown
## Docs

- Do not copy `README.md` setup guidance into this file.
- `CLAUDE.md` is a mirror of this file — apply any edit here to `CLAUDE.md` as well.

## Docs Conventions

- New design spec → `docs/design/YYYY-MM-DD-<topic>.md`.
- New implementation plan → `docs/plans/YYYY-MM-DD-<topic>.md`.
- Go-to-market docs (positioning, registry/directory submissions) → `docs/growth/`.
- `docs/architecture.md` and `docs/roadmap.md` are living documents, not specs — edit them in place rather than superseding them with a new dated file.

## Release Process

When bumping the package version, update in this order, in the same change:

1. `package.json` `version`.
2. `MCP_VERSION` in `src/constants.ts`.
3. `docs/architecture.md` `Version:` line — bump only after confirming the document still matches the code (see Version-Sync Conventions).
4. `CHANGELOG.md` — add a release entry.
5. `GUIDELINES.md` `Version:` line, only if agent-facing behavior changed.
6. Run `npm run build && npm test`.
7. Move the relevant row from Planned to Shipped in `docs/roadmap.md`.

## Version-Sync Conventions

- **Always sync docs in the same change as the code update.** After any code change, re-check `GUIDELINES.md`, `README.md`, `CHANGELOG.md`, and `docs/architecture.md`; if the behavior or structure they describe changed, update them together with the code — never leave them one release behind.
- `GUIDELINES.md`'s `Version:` line must match the version asserted in `src/__tests__/reasoning-audit-tools.test.ts` (`structuredContent.guide_version`). When `GUIDELINES.md` changes, bump its `Version:` line and update that assertion in the same change.
- `docs/architecture.md`'s `Version:` line must match `package.json`'s `version` field, enforced by `src/__tests__/architecture-doc-version.test.ts`. Bump both together on every release — even a release with no architectural change — or the test fails the build.
```

- [ ] **Step 4: Diff both files against each other to confirm they stayed twins**

```bash
cd /Users/macbook_343/Documents/mcp/memory-mcp-server
diff <(sed 's/CLAUDE\.md/X.md/g; s/AGENTS\.md/X.md/g' CLAUDE.md) \
     <(sed 's/CLAUDE\.md/X.md/g; s/AGENTS\.md/X.md/g' AGENTS.md)
```
Expected: no output (empty diff) — after normalizing the two files' names to
a placeholder, they are byte-identical. Any remaining diff output means the
twin edit was applied inconsistently; fix before proceeding.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md AGENTS.md
git commit -m "docs: teach CLAUDE.md/AGENTS.md the new docs/ layout, release process, and version-sync rules

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Final verification

**Files:**
- None created or modified — this task only runs checks.

**Interfaces:**
- Consumes: the complete state produced by Tasks 1–5.
- Produces: a verified, committed final state ready to hand back to the user.

- [ ] **Step 1: Full clean build and test run**

```bash
cd /Users/macbook_343/Documents/mcp/memory-mcp-server
npm run build
npm test
```
Expected: both commands exit 0; `node --test` output includes
`docs/architecture.md Version line matches package.json version` passing
alongside all pre-existing tests, with no new failures.

- [ ] **Step 2: Confirm no stray old paths and no uncommitted changes remain**

```bash
find docs -type d \( -name "plan-improvement-performance" -o -name "superpowers" \)
git status --short
```
Expected: the `find` command prints nothing (both old directories are gone);
`git status --short` prints nothing (clean tree, everything committed).

- [ ] **Step 3: Confirm the full final `docs/` tree matches the design spec's target structure**

```bash
find docs -type f | sort
```
Expected, exactly:
```
docs/README.md
docs/architecture.md
docs/design/2026-07-03-memory-mcp-audit-layer-design.md
docs/design/2026-07-05-memory-mcp-guidance-telemetry-design.md
docs/design/2026-07-08-agents-contributor-workflow-design.md
docs/design/2026-07-11-spec-mcp-value-improvement.md
docs/design/2026-07-12-spec-recall-precision-workspace.md
docs/design/2026-07-12-spec-v1.3.5-recall-refinements.md
docs/design/2026-07-14-docs-restructure-design.md
docs/growth/registry-submissions.md
docs/plans/2026-07-01-agents-md-rewrite.md
docs/plans/2026-07-03-audit-layer-implementation.md
docs/plans/2026-07-08-agents-contributor-workflow.md
docs/plans/2026-07-14-docs-restructure.md
docs/roadmap.md
```

- [ ] **Step 4: Report done**

No commit needed for this task (verification only). If Step 1 or Step 2
turns up anything unexpected, fix it in the task that caused it and re-run
Task 6 from Step 1 before considering the plan complete.

---

## Self-Review Notes

- **Spec coverage:** §3 target structure and §3.1 mapping table → Task 1. §4 architecture.md (7 sections + Version line + lock test + sync rule) → Task 2. §5 roadmap.md → Task 3. §7 docs/README.md → Task 4. §6 CLAUDE.md/AGENTS.md (repo map, docs conventions, release process, version-sync) → Task 5. §8 verification → Task 6. §9 out-of-scope items (no README/CHANGELOG/GUIDELINES content rewrite, no runtime behavior change, no filename renames, no new roadmap commitments) are respected by every task above — confirmed no task touches those files' content or renames a moved file.
- **Placeholder scan:** no TBD/TODO; every created file has full literal content; every code step shows the actual code.
- **Type/name consistency:** the test in Task 2 reads `docs/architecture.md` via `new URL("../../docs/architecture.md", import.meta.url)` from `dist/__tests__/`, matching the existing pattern in `reasoning-audit-tools.test.ts` for reading `GUIDELINES.md` from the same relative depth — verified against the compiled path (`dist/__tests__/*.test.js` → `../../` → repo root). The `Version:` line regex (`/^Version:\s*(\S+)/m`) matches the literal text written into `docs/architecture.md` in Task 2 Step 3.
