# memory-mcp-server

An MCP (Model Context Protocol) server that gives an agent **durable
long-term memory** and the ability to **record and replay step-by-step
reasoning traces**, backed by a local SQLite database with full-text
search.

Runs locally over stdio — plug it into Claude Desktop, Claude Code, or any
other MCP client.

## Why two concepts?

- **Memory** (`memory_*`): small, durable facts/preferences/decisions you
  want the agent to recall across sessions ("user prefers TypeScript",
  "the staging DB is at ...").
- **Reasoning** (`reasoning_*`): a *session* of numbered steps
  (thought/action/observation) capturing how the agent worked through a
  specific task. You can later fetch the full trace, or distill just the
  conclusion into a permanent memory via
  `reasoning_complete_session(save_as_memory=true)`.

## Requirements

- Node.js **>= 22.5.0** (uses the built-in `node:sqlite` module — no
  native compilation step, so `npm install` is fast and has no build
  toolchain requirements).

## Install & build

```bash
npm install
npm run build
```

This produces `dist/index.js`, the server entry point.

## Run standalone (for testing)

```bash
npm start
# or directly:
node dist/index.js
```

The server logs `memory-mcp-server running via stdio (db: ...)` to
stderr and then waits for MCP JSON-RPC messages on stdin.

## Connect to Claude Desktop / Claude Code

Add to your MCP client config (e.g. `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "memory": {
      "command": "node",
      "args": ["/absolute/path/to/memory-mcp-server/dist/index.js"],
      "env": {
        "MEMORY_DB_PATH": "/absolute/path/to/where/you/want/memory.db"
      }
    }
  }
}
```

`MEMORY_DB_PATH` is optional — if omitted, the database defaults to
`~/.memory-mcp-server/memory.db`. Set it explicitly if you want separate
memory stores per project.

## Tools

### Memory

| Tool | Purpose |
|---|---|
| `memory_save` | Save a fact / preference / episodic note / decision / reasoning summary |
| `memory_search` | Full-text search over memory content + tags (relevance ranked) |
| `memory_list` | Browse/filter memories by type, agent, tags, importance (no search query) |
| `memory_get` | Fetch one memory by id |
| `memory_update` | Edit content/type/tags/importance/metadata of a memory |
| `memory_delete` | Permanently delete a memory |

### Reasoning

| Tool | Purpose |
|---|---|
| `reasoning_start_session` | Begin a new reasoning session for a task |
| `reasoning_add_step` | Append a thought/action/observation step |
| `reasoning_get_trace` | Retrieve the full ordered trace for a session |
| `reasoning_list_sessions` | Browse past sessions, filter by status/agent |
| `reasoning_complete_session` | Finalize a session with a conclusion; optionally persist the conclusion as a memory |

All tools return both a text summary and `structuredContent` (JSON) so
MCP clients can render or programmatically consume the result.

## Data model

SQLite tables (auto-created on first run):

- `memories` — id, type, content, tags (JSON array), agent_id, importance
  (1-5), metadata (JSON object), timestamps. Indexed with an FTS5 virtual
  table (`memories_fts`) kept in sync via triggers.
- `reasoning_sessions` — id, title, agent_id, status
  (in_progress/completed/abandoned), conclusion, timestamps.
- `reasoning_steps` — id, session_id, step_number, thought, action,
  observation, created_at.

## Multi-agent usage

Every memory and session accepts an optional `agent_id`. If you're
running several distinct agent personas against the same database, pass
a consistent `agent_id` per persona and filter with it in
`memory_search` / `memory_list` / `reasoning_list_sessions` to keep their
memories separate.

## Development

```bash
npm run dev     # tsx watch mode, runs src/index.ts directly
npm run build   # compile to dist/
npm run clean   # remove dist/
```

## Notes

- `node:sqlite` is still an experimental Node API — you'll see an
  `ExperimentalWarning` on stderr at startup. This is expected and
  harmless; the API used here (`DatabaseSync`, `prepare`, `run`, `get`,
  `all`, FTS5) is stable across recent Node 22/24 releases.
- The database uses WAL journal mode for better concurrent read
  performance.
