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
| `1.3.2` | Guide-contract alignment: `GUIDELINES.md` synced with real tool contracts (`v5`→`v6`→`v7`), server-level `instructions` field, tool description clarity pass, new docs-consistency test; conflict-check and mark-step guidance tightened from soft suggestions to concrete triggers after telemetry showed near-zero adoption | *(no design spec — ad hoc; see `CHANGELOG.md`; tool-usage evidence in [2026-10-06-spec-v1.4.0-tool-surface-reduction.md](design/2026-10-06-spec-v1.4.0-tool-surface-reduction.md) §3.1)* |
| `1.3.3` | Recall workspace identity + blended scoring on both recall surfaces — Option A in full: `workspace` parameter, `/`/home treated as unknown, cross-project gate with `preference` bypass, blended auto-recall score, stale-feedback exclusion, no lifeline; `memory_search` OR matching with a coverage floor and the same blended ranking computed in SQL (Option A′); recall eval base (WI-11, pulled forward from `1.4.0`) | [2026-10-05-spec-recall-workspace-identity.md](design/2026-10-05-spec-recall-workspace-identity.md), [2026-08-07-spec-zero-mem-inspired-recall.md](design/2026-08-07-spec-zero-mem-inspired-recall.md) §2 Option A / A′, eval cases in `src/__tests__/fixtures/recall-eval-cases.ts` (WI-11) |
| `1.4.0` | Tool-surface reduction — 12 tools that were unused or never exploited removed (`tools/list` 27,484 → 16,223 characters, 9 tools), `reasoning_find` replaces the trace/session/step readers, migration `0007` drops `reasoning_step_marks`, recalled memory ids recorded per session (`0008`) with a documented used-rate query, query-aware recall snippet, stale/unsafe memories return to recall once corrected, `reasoning_find` results carry `workspace`, rank empty sessions last and match titles/conclusions by word prefix, `GUIDELINES.md` v9 | [2026-10-06-spec-v1.4.0-tool-surface-reduction.md](design/2026-10-06-spec-v1.4.0-tool-surface-reduction.md), [2026-10-06-v1.4.0-tool-surface-reduction.md](plans/2026-10-06-v1.4.0-tool-surface-reduction.md) |

## Planned / Next

**`1.3.3` is the last `1.3.x` release** — there is no `1.3.4` or `1.3.5`.
The work once planned for `1.3.5` was resolved elsewhere: WI-11 shipped in
`1.3.3`, and the other items were dropped (WI-12 and WI-14 earlier, WI-10,
WI-13 and WI-15 on 2026-10-05). Wave 4 moved to `2.0.0`.

### `2.0.0`

Retargeted from `1.4.0` — Wave 4, gated behind evidence.

- **WI-6** — feedback-weighted ranking — gated, see the evidence gate below
- **WI-7** — evidence-based store cleanup — further-out candidate
- **Option B** — entity-context graph / dual-view fusion (arXiv 2607.29377
  "Zero-Mem") — gated behind its own evidence conditions (G-f redefined in
  spec rev 0.4); must beat the B-lite tag-hop baseline, not just BM25
- **Option C** — full temporal hierarchy — named idea only, not gated, no
  target version

**WI-6b is obsolete** — the feedback-capture-rate problem it targeted does
not exist (see the gate table below).

Design specs:
[2026-07-11-spec-mcp-value-improvement.md](design/2026-07-11-spec-mcp-value-improvement.md)
§9 + §9.3.1 (rev 0.5) ·
[2026-08-07-spec-zero-mem-inspired-recall.md](design/2026-08-07-spec-zero-mem-inspired-recall.md)
§2 Options B/C, §4

#### Wave 4 evidence gate — status as of 2026-08-07

Scored for the first time against live telemetry during the spec review of
2026-08-07. Full detail and caveats in the value-improvement spec §9.3.1
above — navigation only.

| Condition | Threshold | Measured | Status |
|---|---|---:|---|
| G-a — cumulative `used` events | ≥ 20–30 | 54 | ✅ Met |
| G-b — memories with `used_count ≥ 2` | ≥ 5 | 14 | ✅ Met |
| G-c — recall-quality complaints persisting despite BM25 | evidence exists | owner report 2026-10-05 (cross-project, stale, irrelevant recall; see the `1.3.3` spec) | ✅ Met |
| G-d — eval suite written before tuning | mandatory | WI-11 eval base, written before the `memory_search` ranking change and shown to fail on the old code | ✅ Met in `1.3.3` |

**Gate status (2026-10-05):** with WI-11 shipping in `1.3.3`, all four
conditions are met, so per §9.3's own rule WI-6 may now be scoped. The
value-improvement spec §9.3.1 has not yet been re-scored to record this —
do that before WI-6 work starts.

Measurements for both gate tables come from the owner's dogfooding database,
not external users.

## How to Read This

- **Shipped** rows are historical record — do not re-derive them, `CHANGELOG.md`
  is the authoritative changelog.
- **Planned** rows point at the spec that owns the real requirements. If a
  planned item's scope is unclear, read the linked spec — do not guess from
  this table.
- When a release ships, move its row from Planned to Shipped in the same
  change that updates `CHANGELOG.md` (see Release Process in
  `CLAUDE.md`/`AGENTS.md`).
