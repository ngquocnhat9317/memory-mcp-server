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
| `1.3.1` | Agent-guidance snippet installer: `install-agents` CLI subcommand and `scripts/install-agent-snippet.sh` (`curl \| bash`), both writing the README's Memory MCP snippet into global Claude Code / Codex CLI config | *(no design spec — ad hoc; see `CHANGELOG.md`)* |

## Planned / Next

| Target | Theme | Design spec |
| --- | --- | --- |
| `1.3.5` | Provenance consistency (WI-10), recall relevance eval base (WI-11), duplicate-surfacing hint on `memory_save` (WI-13). WI-12 and WI-14 were evaluated and dropped — see the spec §8 for why | [2026-07-12-spec-v1.3.5-recall-refinements.md](design/2026-07-12-spec-v1.3.5-recall-refinements.md) |
| `1.4.0` | Wave 4 candidates (WI-6, WI-7) — gated behind a 4–6 week real-usage evidence window defined in the Wave 3 spec §9.3; not started until that gate opens | [2026-07-11-spec-mcp-value-improvement.md](design/2026-07-11-spec-mcp-value-improvement.md) §9 |
| _TBD_ | Codebase Memory (Codegraph) — structured code index: `code_symbols` + `code_edges` + FTS5, `codegraph_*` tools for file→symbols, symbol→definition (file:line), and caller/callee lookups; agent-fed, workspace-scoped, no new dependency. Draft — awaiting owner approval before coding | [2026-07-15-memory-codebase.md](design/2026-07-15-memory-codebase.md) |

## How to Read This

- **Shipped** rows are historical record — do not re-derive them, `CHANGELOG.md`
  is the authoritative changelog.
- **Planned** rows point at the spec that owns the real requirements. If a
  planned item's scope is unclear, read the linked spec — do not guess from
  this table.
- When a release ships, move its row from Planned to Shipped in the same
  change that updates `CHANGELOG.md` (see Release Process in
  `CLAUDE.md`/`AGENTS.md`).
