# memory-mcp-server

MCP server for agents that need:

- durable memory across tasks
- per-task reasoning traces
- lightweight audit/review tools over those traces

This server runs over stdio, stores data in SQLite, and is meant to be installed into an MCP client such as Claude Code, Codex, or another MCP-compatible agent.

## What This MCP Is For

Use this MCP when you want an agent to:

- save stable facts, decisions, and preferences for later reuse
- keep a reasoning session for one concrete task
- search or review prior reasoning traces
- measure memory/reasoning usage through telemetry reports

High-level split:

- `memory_*` tools: durable recall
- `reasoning_*` tools: live task trace and audit retrieval
- `get_usage_guide`: runtime usage guide an agent can call after connection

## Requirements

- Node.js `>= 22.5.0`
- support for Node's built-in `node:sqlite`

No native addon build is required.

## Install

```bash
npm install
npm run build
```

Built entrypoint:

- `dist/index.js`

## Run

```bash
npm start
```

or:

```bash
node dist/index.js
```

The server runs over stdio and logs the active DB path to stderr on startup.

## Practical Setup

If you are a real user wiring this into Claude Code, Codex, Antigravity, or another MCP client, the normal setup is:

1. Build this repo:

```bash
npm install
npm run build
```

2. Register it in your MCP client as a stdio server:

- command: `node`
- args: `["/absolute/path/to/memory-mcp-server/dist/index.js"]`

3. Optionally set `MEMORY_DB_PATH` if you do not want the default database location.

Default DB path:

- `~/.memory-mcp-server/memory.db`

4. Restart the MCP client.

5. Verify the connection with a cheap read-only tool such as:

- `get_usage_guide`
- `memory_list`

### Example MCP Config

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

### Shared vs Project-Scoped Memory

Shared memory across many repos:

```json
{
  "env": {
    "MEMORY_DB_PATH": "/Users/you/.memory-mcp-server/shared-memory.db"
  }
}
```

Project-scoped memory:

```json
{
  "env": {
    "MEMORY_DB_PATH": "/absolute/path/to/your-project/.memory/project-memory.db"
  }
}
```

Practical recommendation:

- use shared memory if you want one agent persona to accumulate knowledge across projects
- use project-scoped memory if you want isolation per repository or customer

### How An Agent Learns To Use This MCP

The human installer reads this `README`.

The runtime agent usually does not.

That means:

- `README.md` is for the person installing the MCP
- `AGENTS.md` in this repo is for agents working inside this repo
- an agent working in some other repo will usually only see:
  - tool names
  - tool descriptions
  - schemas
  - any runtime tool it can call, especially `get_usage_guide`

If you want a newly connected agent to use this MCP correctly, the most reliable pattern is:

1. install the MCP
2. add a short instruction snippet to your own repo's `AGENTS.md` or client prompt
3. tell the agent to call `get_usage_guide` before using memory/reasoning tools the first time

## Suggested AGENTS.md Snippet

If you want your agent to use this MCP well, you can paste something like this into your own repo's `AGENTS.md`:

```md
## Memory MCP

When the `memory` MCP server is available:

- On first use, call `get_usage_guide` to load the current usage rules.
- Use `memory_*` tools for durable facts, decisions, and reusable context.
- Use `reasoning_*` tools for multi-step task traces, debugging, or planning.
- Do not store secrets, tokens, or raw sensitive data in memory.
- Prefer `memory_search` for targeted recall and `memory_list` only for browsing.
- Start a `reasoning_start_session` before substantial multi-step investigation, then close it with `reasoning_complete_session`.
```

Keep that snippet in the repo where the agent actually works. Do not rely on the agent reading this MCP repo.

## Do I Need `AGENTS.md` or `CLAUDE.md` In This Repo?

Usually no.

- You do not need to edit this repo's `AGENTS.md` just to install the MCP into your own agent.
- You do not need a `CLAUDE.md` here unless you want Claude-specific rules for contributors working inside this MCP repo.
- The useful place for runtime instructions is the user's own repo or client prompt, not this MCP repo.

## Tool Surface

### Memory tools

| Tool | Purpose |
| --- | --- |
| `memory_save` | Save a durable memory |
| `memory_search` | Search memory content and tags |
| `memory_list` | Browse memories with filters |
| `memory_get` | Fetch one memory by id |
| `memory_update` | Update an existing memory |
| `memory_delete` | Delete a memory |
| `memory_usage_report` | Aggregate tool usage telemetry |
| `memory_adoption_report` | Summarize adoption behavior across memory and reasoning |
| `memory_agent_scorecard` | Compare agent usage patterns |
| `memory_record_usage_feedback` | Record whether recalled memory was useful |
| `get_usage_guide` | Return the runtime usage guide for this MCP |

### Reasoning tools

| Tool | Purpose |
| --- | --- |
| `reasoning_start_session` | Open a reasoning session |
| `reasoning_add_step` | Append a thought, action, or observation |
| `reasoning_get_trace` | Return the full ordered trace |
| `reasoning_list_sessions` | List sessions with grouped step counts |
| `reasoning_mark_step` | Add or update an audit mark on a step |
| `reasoning_search_steps` | Search reasoning steps |
| `reasoning_list_milestones` | List marked steps without loading a full trace |
| `reasoning_get_session_outline` | Return marked steps or deterministic fallback outline |
| `reasoning_complete_session` | Close a session and optionally save its conclusion as memory |

## Storage Model

Main tables:

- `memories`
- `reasoning_sessions`
- `reasoning_steps`
- `reasoning_step_marks`
- `tool_usage_events`
- `schema_migrations`

FTS tables:

- `memories_fts`
- `reasoning_steps_fts`

## Migrations

Schema is managed in `src/migrations/`.

Migrations run automatically at server startup. There is currently no separate manual migration CLI command in this repo.

If you need migrations applied, start the server normally:

```bash
npm start
```

or:

```bash
node dist/index.js
```

## Development

```bash
npm run dev
npm run build
npm run test
npm run clean
```

## Implementation Notes

- `src/db.ts` owns DB open and migration bootstrap
- `src/tools/memory.ts` owns memory tool handlers
- `src/tools/reasoning.ts` owns reasoning and audit tool handlers
- `src/tools/usage-guide.ts` owns `get_usage_guide`

## Notes

- `node:sqlite` is still experimental in Node and may print an `ExperimentalWarning`
- this is a local stdio MCP server, not a network service
- `agent_id` is a filtering aid, not a security boundary
