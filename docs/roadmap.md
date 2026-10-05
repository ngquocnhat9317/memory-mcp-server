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
| `1.3.3` | Recall workspace identity + blended scoring on both recall surfaces — Option A in full: `workspace` parameter, `/`/home treated as unknown, cross-project gate with `preference` bypass, blended auto-recall score, stale-feedback exclusion, no lifeline; `memory_search` OR matching with a coverage floor and the same blended ranking computed in SQL (Option A′); recall eval base (WI-11, pulled forward from `1.4.0`) | [2026-10-05-spec-recall-workspace-identity.md](design/2026-10-05-spec-recall-workspace-identity.md), [2026-08-07-spec-zero-mem-inspired-recall.md](design/2026-08-07-spec-zero-mem-inspired-recall.md) §2 Option A / A′, [2026-07-12-spec-v1.3.5-recall-refinements.md](design/2026-07-12-spec-v1.3.5-recall-refinements.md) WI-11 |
| `1.3.2` | Guide-contract alignment: `GUIDELINES.md` synced with real tool contracts (`v5`→`v6`→`v7`), server-level `instructions` field, tool description clarity pass, new docs-consistency test; conflict-check and mark-step guidance tightened from soft suggestions to concrete triggers after telemetry showed near-zero adoption | *(no design spec — ad hoc; see `CHANGELOG.md`; monitoring note in [2026-07-12-spec-v1.3.5-recall-refinements.md](design/2026-07-12-spec-v1.3.5-recall-refinements.md) §8.1)* |

## Planned / Next

**Retargeted 2026-08-07** (owner direction, following Zero-Mem research): the
work originally planned for `1.3.5` now ships as part of `1.4.0`; the work
originally planned for `1.4.0` (Wave 4) now moves to `2.0.0`. No standalone
`1.3.5` release ships. See each spec's revision history for the retarget
record.

### `1.4.0`

Retargeted from `1.3.5` — recall refinements, joined by the low-usage tool
removal. **WI-11 and Option A′ were pulled forward into `1.3.3`** (owner
direction, 2026-10-05) and are listed under Shipped.

- **WI-10** — provenance consistency
- **WI-13** — duplicate-surfacing hint on `memory_save`
- **WI-15** — memory-scope hygiene
- **Low-usage tool removal** — gated on a 2-week re-check, see the gate
  status below; a deliberate semver exception (breaking change on a minor
  version, reasoned in the spec)

WI-12 and WI-14 were evaluated and dropped (spec §8) — WI-14's second
rejection reason was voided on 2026-08-07.

Design specs:
[2026-07-12-spec-v1.3.5-recall-refinements.md](design/2026-07-12-spec-v1.3.5-recall-refinements.md)
(§8.1.2, §11 rev 0.7). WI-10 and WI-13 should add their eval cases to the
`1.3.3` eval base (`src/__tests__/fixtures/recall-eval-cases.ts`).

#### Tool removal gate — status as of 2026-08-07

The standing policy (metric, thresholds, minimum sample) lives in
`CLAUDE.md`/`AGENTS.md` § "Tool Surface Policy". This table is its first
scheduled application, detailed in the `1.3.5` spec §8.1.2 above — navigation
only.

| | |
|---|---|
| Re-check window | 2026-08-07 → 2026-08-21 |
| Metric | `tool_rate = calls in window / reasoning sessions opened in window × 100%` |
| Thresholds | ≥30% keep · 5–30% review and improve · ≤5% remove |
| Minimum sample | 20 reasoning sessions opened in the window |
| Target version if removals proceed | `1.4.0` (semver exception) |
| Candidate pool | `reasoning_get_trace`, `reasoning_list_sessions`, `reasoning_search_steps`, `reasoning_list_milestones`, `reasoning_get_session_outline`, `memory_list`, `memory_delete`, `memory_usage_report`, `memory_adoption_report`, `memory_agent_scorecard` |

`reasoning_get_trace`, `reasoning_list_sessions`, and `memory_delete` are
actively promoted by `GUIDELINES.md` v7 (v8, 2026-10-05, keeps that guidance and starts a new Tool Surface Policy observation window — the window above was measured on v7) — a low reading
on those three specifically should prompt checking `get_usage_guide` uptake
before removing, not removal on the number alone.

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
