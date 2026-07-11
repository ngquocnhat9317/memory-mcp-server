# Registry Submission Playbook

Ready-to-paste content for listing `@nhatnguyen9317/memory-mcp-server` in MCP
registries and directories. Submit top-to-bottom; the first two matter most.

## Shared copy (reuse everywhere)

- **Name**: Memory MCP Server (with adoption analytics)
- **Package**: `@nhatnguyen9317/memory-mcp-server`
- **Repo**: https://github.com/ngquocnhat9317/memory-mcp-server
- **One-liner**: Long-term memory + reasoning traces for agents — with built-in analytics that tell you whether your agents actually use it.
- **Description (short)**:
  > SQLite-backed long-term memory and per-task reasoning traces over stdio. Auto-recalls related memories at session start, auto-abandons stale sessions, and ships adoption telemetry (usage reports, adoption funnel, per-agent scorecards) so you can measure recall hit rate and reuse instead of hoping.
- **Install**: `npx -y @nhatnguyen9317/memory-mcp-server`
- **Categories/tags**: memory, knowledge, reasoning, analytics, sqlite
- **Requirements**: Node >= 22.5 (uses built-in `node:sqlite`, no native build)

## 1. Official MCP Registry (registry.modelcontextprotocol.io)

- Docs: https://github.com/modelcontextprotocol/registry — publish via the
  `mcp-publisher` CLI with a `server.json` at the repo root.
- Draft `server.json`:

```json
{
  "$schema": "https://static.modelcontextprotocol.io/schemas/2025-07-09/server.schema.json",
  "name": "io.github.ngquocnhat9317/memory-mcp-server",
  "description": "Long-term memory + reasoning traces for agents, with built-in adoption analytics.",
  "repository": {
    "url": "https://github.com/ngquocnhat9317/memory-mcp-server",
    "source": "github"
  },
  "version": "1.2.5",
  "packages": [
    {
      "registry_type": "npm",
      "identifier": "@nhatnguyen9317/memory-mcp-server",
      "version": "1.2.5",
      "transport": { "type": "stdio" }
    }
  ]
}
```

- Steps: install `mcp-publisher`, `mcp-publisher login github`, `mcp-publisher publish`.
- Note: verify the current schema URL/fields against the registry docs before
  publishing — the spec is still evolving.

## 2. awesome-mcp-servers (github.com/punkpeye/awesome-mcp-servers)

- Open a PR adding one line under the **Knowledge & Memory** section
  (alphabetical order):

```md
- [ngquocnhat9317/memory-mcp-server](https://github.com/ngquocnhat9317/memory-mcp-server) 📇 🏠 - Long-term memory and reasoning traces with auto-recall and built-in adoption analytics (SQLite, no native build)
```

(`📇` = TypeScript, `🏠` = local service — check the legend before submitting.)

## 3. Smithery (smithery.ai)

- Sign in with GitHub → Add Server → point at the repo.
- Smithery may ask for a `smithery.yaml`; a minimal stdio one:

```yaml
startCommand:
  type: stdio
  commandFunction: |
    (config) => ({
      command: "npx",
      args: ["-y", "@nhatnguyen9317/memory-mcp-server"],
      env: config.dbPath ? { MEMORY_DB_PATH: config.dbPath } : {}
    })
  configSchema:
    type: object
    properties:
      dbPath:
        type: string
        description: Optional path to the SQLite database file
```

## 4. Glama (glama.ai/mcp/servers)

- Glama auto-indexes GitHub repos with MCP topics — the repo topics added in
  v1.2.5 should get it crawled. To speed it up: sign in → Submit Server →
  paste the repo URL.

## 5. mcp.so

- Submit form on the site (or PR to its data repo) with the shared copy above.

## 6. PulseMCP (pulsemcp.com)

- Submit form: https://www.pulsemcp.com/submit — shared copy + npm link.

## Post-submission checklist

- [ ] npm README renders correctly (npmjs.com package page)
- [ ] GitHub topics present: mcp, model-context-protocol, mcp-server, agent-memory, reasoning-trace
- [ ] Track weekly: npm downloads, GitHub stars, `memory_adoption_report` version_breakdown for new-version adoption
