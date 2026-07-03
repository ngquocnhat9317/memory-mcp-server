# Memory MCP Audit Layer Design

Date: 2026-07-03
Project: `memory-mcp-server`
Status: Draft for user review

## Goal

Improve `reasoning_*` support for debug/audit workflows without breaking existing SQLite databases, existing tool names, or the current core usage model where the agent is responsible for opening sessions and logging meaningful steps.

## Problem Statement

The current MCP already stores reasoning traces, but it is still weak as an audit tool:

- finding the relevant step inside a long session is hard
- there is no lightweight way to mark important reasoning events
- session review tends to require loading the full trace
- some internal queries do unnecessary work as data volume grows
- schema evolution is currently implicit because schema creation happens inline at startup rather than through explicit migrations

The next version should improve audit usability while making upgrades safe for existing databases.

## Design Principles

1. Keep the core small.
2. Do not break existing tools or their main input/output shape.
3. Let the agent stay in control of what matters.
4. Prefer read-oriented audit helpers over heavy automation.
5. Treat database upgrades as a first-class part of the design.

## Scope

### In Scope

- optimize reasoning read paths that currently do extra work
- add a structured way to mark important reasoning steps
- add audit-focused read tools
- add explicit file-based SQLite migrations
- ensure startup upgrades existing databases safely

### Out of Scope

- vector search
- web UI or dashboard
- LLM-generated auto-summary inside the MCP
- replacing the current `reasoning_add_step` workflow
- redesigning the memory system into a general knowledge base

## Target Architecture

The MCP should remain a narrow `reasoning store + audit retrieval layer`.

It will have three layers:

1. Core persistence
   - existing tables remain the source of truth
   - new schema only adds the minimum needed for audit markers and migrations

2. Audit retrieval layer
   - new read tools expose search, milestone listing, and session outline views
   - these tools reduce the need to fetch and post-process the full trace

3. Derived audit views
   - outlines and milestone views are derived from trace data
   - derived output does not replace the original trace

## Tool Surface

Existing tools remain supported unchanged:

- `reasoning_start_session`
- `reasoning_add_step`
- `reasoning_get_trace`
- `reasoning_list_sessions`
- `reasoning_complete_session`
- all current `memory_*` tools

### New Tools

#### `reasoning_mark_step`

Purpose:
- attach audit markers to an existing reasoning step

Expected input:
- `step_id`
- `mark_type`
- `note?`

Supported `mark_type` values in v1:
- `milestone`
- `decision`
- `conflict`
- `important`
- `hypothesis`

Expected behavior:
- one step may have multiple marks
- marks are additive
- adding marks does not alter the original step text

#### `reasoning_list_milestones`

Purpose:
- quickly retrieve marked steps without loading full traces

Expected filters:
- `session_id?`
- `agent_id?`
- `mark_type?`
- `limit?`
- `offset?`

Expected output:
- session id
- step id
- step number
- mark type
- optional note
- timestamp
- short trace excerpt

#### `reasoning_search_steps`

Purpose:
- search reasoning steps directly across `thought`, `action`, and `observation`

Expected filters:
- `query`
- `session_id?`
- `agent_id?`
- `mark_type?`
- `limit?`
- `offset?`

Expected output:
- matching steps with session context and compact text snippets

#### `reasoning_get_session_outline`

Purpose:
- return an audit-oriented summary view of a session

Expected output:
- session metadata
- step count
- conclusion
- marked steps ordered by time
- fallback outline if no marks exist

Fallback behavior:
- if the session has no marks, return a lightweight outline using session metadata, conclusion, and representative steps rather than failing

## Data Model

### Keep Existing Tables

Keep:
- `memories`
- `reasoning_sessions`
- `reasoning_steps`

Do not change the meaning of existing columns.

### Add New Table

Add:

`reasoning_step_marks`

Suggested columns:
- `id TEXT PRIMARY KEY`
- `step_id TEXT NOT NULL REFERENCES reasoning_steps(id) ON DELETE CASCADE`
- `mark_type TEXT NOT NULL`
- `note TEXT`
- `created_at TEXT NOT NULL`

Suggested constraints:
- `mark_type` checked against the supported set

Suggested indexes:
- index on `step_id`
- index on `mark_type`
- optional composite index on `(mark_type, created_at)`

### Why A Separate Table

This is preferred over adding many columns to `reasoning_steps` because:

- a step may have multiple audit meanings
- most steps will remain unmarked
- backward compatibility stays simple
- audit queries stay explicit instead of depending on JSON blobs

## Query Strategy

### `reasoning_list_sessions`

Current concern:
- step counts should not be fetched one session at a time

Planned fix:
- use one aggregate query with `COUNT(reasoning_steps.id)` grouped by session

Expected benefit:
- no `N+1` counting pattern
- no tool contract change

### `reasoning_search_steps`

Search target:
- `thought`
- `action`
- `observation`

Recommended first version:
- SQLite text search compatible with the current stack
- no semantic search

### `reasoning_get_session_outline`

Outline generation should:
- read session metadata
- gather marked steps in chronological order
- include conclusion if present
- fall back cleanly for sessions without markers

No summary cache is needed in the first iteration.

## Migration Strategy

This is a required part of the design.

### Goals

- new versions must upgrade old databases in place
- existing data must remain readable
- startup must be safe when the database already exists
- migrations must be explicit, ordered, and idempotent

### Required Change

Move schema evolution out of one large inline bootstrap block and into file-based migrations.

Add:
- a `schema_migrations` table
- a migration runner
- ordered migration files

### Proposed Structure

Suggested layout:

- `src/migrations/`
  - `0001_initial.ts`
  - `0002_reasoning_step_marks.ts`
  - future migrations follow the same pattern

Each migration file should:
- export a stable version id
- include the SQL needed to apply the migration
- be safe to run exactly once

### `schema_migrations` Table

Suggested columns:
- `version TEXT PRIMARY KEY`
- `applied_at TEXT NOT NULL`

Purpose:
- track which migrations have already been applied
- prevent duplicate execution during upgrades

### Startup Behavior

On startup:

1. open the database
2. ensure `schema_migrations` exists
3. list applied migrations
4. run unapplied migrations in order
5. abort startup if any migration fails

This is safer than partially applying schema changes and continuing.

### Initial Migration Plan

#### `0001_initial`

Responsibility:
- create the current baseline schema exactly once

Important detail:
- this migration must represent the already-shipped schema so a fresh database gets the current baseline before newer migrations apply

#### `0002_reasoning_step_marks`

Responsibility:
- create `reasoning_step_marks`
- create indexes for mark-based audit queries

Important detail:
- no existing table data needs rewriting
- no existing rows need backfill
- older sessions simply have zero marks until agents start using them

### Compatibility Rules

- never rename or repurpose existing columns silently
- avoid destructive migrations unless absolutely necessary
- prefer additive migrations
- if a migration needs data backfill in the future, it must be resumable or fully transactional

### Failure Handling

If migration fails:
- server startup should fail clearly
- database should not be left in a partially upgraded logical state

SQLite guidance:
- wrap each migration in a transaction when possible
- keep each migration focused and small

### Rollback Position

The design does not require full down-migrations in v1.

Instead:
- optimize for safe forward-only migrations
- keep each migration additive
- ensure older data remains readable after upgrade

This matches the practical goal: new package versions should not damage existing user databases.

## Validation Plan

### Minimum Automated Coverage

1. Fresh database bootstrap
   - applying all migrations from empty DB produces the expected schema

2. Upgrade path
   - starting from a database with only the initial schema upgrades cleanly to the new version

3. Compatibility
   - existing reasoning tools still work on upgraded databases

4. Audit flow
   - create session
   - add step
   - mark step
   - list milestones
   - search steps
   - fetch session outline
   - complete session

5. Fallback behavior
   - `reasoning_get_session_outline` works for sessions with no marks

### Manual Smoke Expectations

At minimum, a release candidate should verify:
- an existing DB file can be opened by the new binary
- old sessions remain readable
- new step marks can be added without affecting old tools

## Rollout Plan

### Phase 1: Safety And Quick Wins

- introduce migration runner and migration files
- convert current bootstrap schema into `0001_initial`
- optimize `reasoning_list_sessions`
- add minimal migration and lifecycle tests

### Phase 2: Audit Foundation

- add `0002_reasoning_step_marks`
- add `reasoning_mark_step`
- add `reasoning_list_milestones`

### Phase 3: Audit Retrieval

- add `reasoning_search_steps`
- add `reasoning_get_session_outline`

## Risks

1. Migration drift
   - risk: inline schema and migration files diverge
   - mitigation: make migrations the single source of truth for schema creation

2. Query complexity creep
   - risk: audit tools grow into a second system
   - mitigation: keep tools read-focused and limited to explicit audit use cases

3. Weak marker adoption
   - risk: agents do not mark steps consistently
   - mitigation: keep outline fallback useful even without marks

## Recommendation

Proceed with a migration-first audit layer:

- first, make database upgrades explicit and safe
- second, add the minimal schema needed for audit markers
- third, add read tools that make reasoning traces actually usable for debug and audit

This keeps the MCP small, upgrade-safe, and meaningfully better for the primary use case.
