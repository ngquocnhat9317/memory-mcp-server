# memory-mcp-server

[![npm version](https://img.shields.io/npm/v/%40nhatnguyen9317%2Fmemory-mcp-server)](https://www.npmjs.com/package/@nhatnguyen9317/memory-mcp-server)
[![CI](https://github.com/ngquocnhat9317/memory-mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/ngquocnhat9317/memory-mcp-server/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![node >= 22.5](https://img.shields.io/badge/node-%3E%3D22.5-brightgreen)](#requirements)

**Memory that runs itself** — your agent remembers past work without being
told, and you maintain nothing.

Long-term memory and reasoning traces for AI agents.

- **Durable memory** across tasks and sessions (SQLite + full-text search)
- **Reasoning traces**: per-task step-by-step records you can search and audit
- **Auto-recall**: starting a session automatically surfaces related memories
- **Self-cleaning**: stale sessions are auto-abandoned instead of piling up

Runs over stdio. Local only, no network service, no native addon build.

## What it feels like

**Session 1 — Tuesday.** Your agent debugs a flaky checkout test and closes its
reasoning session:

```
reasoning_complete_session
  conclusion: "checkout retry logic must reopen the connection before retrying"
  save_as_memory: true
→ memory mem_a1b2… saved
```

**Session 2 — Friday, fresh context, nobody mentions Tuesday.** The agent starts
a related task:

```
reasoning_start_session  title: "checkout intermittently times out under load"
→ related_memories: [
    {
      snippet: "checkout retry logic must reopen the connection before retrying",
      source: { session_title: "diagnose flaky checkout retry logic",
                session_id: "sess_9f3c…", created_at: "…Tue…" }
    }
  ]
```

No one asked it to search. The Tuesday conclusion surfaces on its own, with its
origin attached — and `reasoning_get_trace(source.session_id)` replays exactly
how it was reached.

## Why this one?

Most memory servers store what you save and hope the agent remembers to search.
In practice agents don't: they write memories nobody ever reads. This server
makes the right behavior the default behavior:

| | typical memory MCP | this server |
| --- | --- | --- |
| Recall | agent must remember to search | server auto-recalls related memories at session start |
| Reasoning traces | — | first-class sessions with steps, marks, outlines |
| Stale state | grows forever | stale sessions auto-abandoned (configurable TTL) |

For teams running **multiple agent personas**, there is also an opt-in telemetry
layer (`MEMORY_TELEMETRY=on`) with usage reports, an adoption funnel, and
per-agent scorecards to compare how each persona actually uses memory. If you
run a single agent for yourself, you can ignore it — everything above works
without it.

## Quick Install

### Claude Code

```bash
claude mcp add memory -- npx -y @nhatnguyen9317/memory-mcp-server
```

### Claude Desktop / Cursor / Antigravity (JSON config)

```json
{
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": ["-y", "@nhatnguyen9317/memory-mcp-server"]
    }
  }
}
```

Optionally pin the database location with `"env": {"MEMORY_DB_PATH": "/path/to/memory.db"}`
(default: `~/.memory-mcp-server/memory.db`).

### Codex CLI (TOML config)

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.memory]
enabled = true
command = "npx"
args = ["-y", "@nhatnguyen9317/memory-mcp-server"]
```

Verify the connection by calling a cheap read-only tool such as `get_usage_guide`
or `memory_list`.

## Requirements

- Node.js `>= 22.5.0` (for the built-in `node:sqlite` — no native addon build)

> Note: `node:sqlite` is still an experimental Node.js API on Node 22. The server
> works reliably, but Node prints an `ExperimentalWarning` to stderr on startup,
> and the API surface may change between Node releases.

## How it works

1. **Task start** — the agent calls `reasoning_start_session`. The server
   full-text-searches the title against saved memories and returns
   `related_memories` in the response — best text match first, current
   workspace preferred, weak one-word matches filtered out — warns about
   still-open sessions, and auto-abandons stale ones
   (`MEMORY_SESSION_TTL_HOURS`, default 24).
2. **During the task** — the agent logs decisions and observations with
   `reasoning_add_step` (single, or up to 20 steps per call in batch mode),
   and can mark pivotal steps for later audit.
3. **Task end** — `reasoning_complete_session` records the conclusion,
   optionally saves it as durable memory, and accepts `used_memory_ids` so the
   server learns which recalled memories actually helped. This usage feedback
   is a local learning signal and is always recorded, regardless of the
   telemetry setting.
4. **Optional, for multi-agent operators** — with `MEMORY_TELEMETRY=on`,
   `memory_adoption_report` shows the funnel (sessions → completions → saves →
   recalls → reuse) with risk flags, and `memory_agent_scorecard` compares
   agent personas' habits and suggests corrections.

Agents learn the rules at runtime by calling `get_usage_guide`, which returns
the versioned [GUIDELINES.md](./GUIDELINES.md).

## Configuration

| Env var | Default | Purpose |
| --- | --- | --- |
| `MEMORY_DB_PATH` | `~/.memory-mcp-server/memory.db` | SQLite database location |
| `MEMORY_SESSION_TTL_HOURS` | `24` | Auto-abandon in_progress sessions older than this (`0` disables) |
| `MEMORY_AUTO_RECALL_LIMIT` | `3` | Max related memories returned at session start (`0` disables) |
| `MEMORY_WORKSPACE` | current working directory | Workspace identity stamped on saved memories and used to prefer same-workspace results at recall time. The default works out of the box for clients that launch the server inside the project (Claude Code, Codex); set explicitly if yours doesn't |
| `MEMORY_TELEMETRY` | `off` | Set `on` to record diagnostics events locally (searches, saves, recalls, latency) — required for full data in the report tools (`memory_usage_report`, `memory_adoption_report`, `memory_agent_scorecard`). Usage feedback (`used_memory_ids`, `memory_record_usage_feedback`) is a learning signal, not diagnostics: it is always recorded locally, with this flag on or off |

### Shared vs project-scoped memory

- **Shared** (default path): one agent persona accumulates knowledge across all
  projects. Since v1.3.0 the shared store is workspace-aware by default:
  memories are stamped with the workspace they were saved from, and recall
  softly prefers the current workspace — cross-project memories still surface
  when they match strongly (that's the point of a shared store), but they no
  longer crowd out local ones.
- **Project-scoped**: point `MEMORY_DB_PATH` at a file inside the project
  (e.g. `.memory/project-memory.db`) for hard isolation per repository or
  customer.

## Teaching your agent to use it

The runtime agent never reads this README — it only sees tool names, schemas,
and whatever it can call. The reliable pattern:

1. Install the MCP (above).
2. Paste a short snippet into your own repo's `AGENTS.md` / client prompt:

```md
## Memory MCP

When the `memory` MCP server is available:

- On first use, call `get_usage_guide` and follow it.
- Non-trivial task? `reasoning_start_session` first — review the
  `related_memories` it returns before working; if one carries a `source`,
  you can replay its origin with `reasoning_get_trace`.
- Log meaningful steps with `reasoning_add_step` (batch mode `steps: [...]`
  is fine for recording finished work).
- Always close with `reasoning_complete_session`; report helpful memories via
  `used_memory_ids`; pass `save_as_memory=true` for durable conclusions.
- Never store secrets, tokens, or raw sensitive data.
```

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
| `memory_adoption_report` | Adoption funnel + risk flags |
| `memory_agent_scorecard` | Compare agent usage patterns |
| `memory_record_usage_feedback` | Record whether recalled memory was useful |
| `get_usage_guide` | Return the runtime usage guide |

### Reasoning tools

| Tool | Purpose |
| --- | --- |
| `reasoning_start_session` | Open a session (auto-recall + stale cleanup) |
| `reasoning_add_step` | Append one step or a batch of steps |
| `reasoning_get_trace` | Return the full ordered trace |
| `reasoning_list_sessions` | List sessions with step counts |
| `reasoning_mark_step` | Add/update an audit mark on a step |
| `reasoning_search_steps` | Search reasoning steps |
| `reasoning_list_milestones` | List marked steps across sessions |
| `reasoning_get_session_outline` | Marked steps or deterministic outline |
| `reasoning_complete_session` | Close a session; optional memory save + usage feedback |

## Storage Model

Tables: `memories`, `reasoning_sessions`, `reasoning_steps`,
`reasoning_step_marks`, `tool_usage_events`, `schema_migrations` — plus FTS5
indexes `memories_fts` and `reasoning_steps_fts`.

Migrations run automatically at server startup; upgrading the package never
requires manual schema work.

## Development

```bash
npm install
npm run build   # tsc -> dist/
npm test        # build + node --test
npm run dev     # tsx watch src/index.ts
```

- `src/db.ts` owns DB open and migration bootstrap
- `src/tools/memory.ts` owns memory tool handlers
- `src/tools/reasoning.ts` owns reasoning and audit tool handlers
- `src/tools/usage-guide.ts` owns `get_usage_guide`

See [CHANGELOG.md](./CHANGELOG.md) for release history.

## Notes

- Local stdio MCP server, not a network service
- `agent_id` is a filtering aid, not a security boundary
- License: MIT
