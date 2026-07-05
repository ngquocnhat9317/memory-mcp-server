# memory-mcp-server

Local MCP server for two related jobs:

- durable long-term memory (`memory_*`)
- structured reasoning traces plus audit retrieval (`reasoning_*`)

It runs over stdio, stores data in SQLite, uses FTS5 for search, and now boots the schema through explicit migrations instead of one inline bootstrap block.

## What It Does

This server separates two persistence models:

- `memory_*`: stable facts, preferences, episodic notes, decisions, and reasoning summaries
- `reasoning_*`: per-task step logs with optional audit marks, search, milestone views, and lightweight session outlines

Use memory when the result should survive across tasks. Use reasoning when the agent needs a trace for one concrete piece of work.

## Requirements

- Node.js `>= 22.5.0`
- SQLite support from Node's built-in `node:sqlite`

No native addon build is required.

## Install

```bash
npm install
npm run build
```

Entry point:

- `dist/index.js`

## Run

```bash
npm start
```

or:

```bash
node dist/index.js
```

The server listens on stdio and logs the active DB path to stderr on startup.

## MCP Config

Example client config:

```json
{
  "mcpServers": {
    "memory": {
      "command": "node",
      "args": ["/absolute/path/to/memory-mcp-server/dist/index.js"],
      "env": {
        "MEMORY_DB_PATH": "/absolute/path/to/memory.db"
      }
    }
  }
}
```

`MEMORY_DB_PATH` is optional. Default:

- `~/.memory-mcp-server/memory.db`

## Tool Surface

### Memory tools

| Tool | Purpose |
| --- | --- |
| `memory_save` | Create a durable memory record |
| `memory_search` | FTS search across memory content and tags |
| `memory_list` | Browse memories with filters and pagination |
| `memory_get` | Fetch one memory by id |
| `memory_update` | Replace selected fields on an existing memory |
| `memory_delete` | Permanently remove a memory |

### Reasoning tools

| Tool | Purpose |
| --- | --- |
| `reasoning_start_session` | Open a reasoning session |
| `reasoning_add_step` | Append a thought, action, or observation |
| `reasoning_get_trace` | Return the full ordered trace |
| `reasoning_list_sessions` | List sessions with grouped step counts |
| `reasoning_mark_step` | Add or update an audit mark on a step |
| `reasoning_search_steps` | FTS search across reasoning steps |
| `reasoning_list_milestones` | List marked steps without loading full traces |
| `reasoning_get_session_outline` | Return marked steps or deterministic fallback outline |
| `reasoning_complete_session` | Close a session and optionally save its conclusion as memory |

## Audit Layer Semantics

Audit marks are stored separately from reasoning steps.

Supported mark types:

- `milestone`
- `decision`
- `conflict`
- `important`
- `hypothesis`

Important behavior:

- one step can have multiple different mark types
- `(step_id, mark_type)` is unique
- repeating the same mark write with a new `note` updates that note on the existing row
- repeating the same mark write without `note` keeps the existing note unchanged

`reasoning_get_session_outline` uses:

- marked steps ordered by mark time when marks exist
- otherwise a deterministic fallback of first, middle, last

## Storage Model

Main tables:

- `memories`
- `reasoning_sessions`
- `reasoning_steps`
- `reasoning_step_marks`
- `schema_migrations`

FTS tables:

- `memories_fts`
- `reasoning_steps_fts`

## Migrations

Schema is managed in `src/migrations/`.

Current migrations:

- `0001_initial` - baseline memory and reasoning schema
- `0002_reasoning_step_marks` - audit mark table and indexes
- `0003_reasoning_steps_fts` - FTS index and triggers for reasoning-step search

Startup flow:

- open DB
- enable WAL
- enable foreign keys
- run pending migrations in order

This keeps upgrades additive and protects existing databases during version bumps.

## Development

```bash
npm run dev
npm run build
npm run test
npm run clean
```

Tests cover:

- migration bootstrap and upgrade path
- audit mark uniqueness and update semantics
- reasoning-step FTS backfill and search
- session count aggregation
- milestone and outline behavior

## Implementation Notes

- `src/db.ts` owns DB open + migration bootstrap
- `src/tools/memory.ts` owns memory tool handlers
- `src/tools/reasoning.ts` owns reasoning and audit tool handlers
- `src/utils.ts` contains shared helpers like id generation, JSON parsing, FTS query shaping, and output truncation

## Notes

- `node:sqlite` is still marked experimental in Node, so startup may show an `ExperimentalWarning`
- the server is local stdio infrastructure, not a network service
- `agent_id` is a filter and partitioning hint, not a hard security boundary
