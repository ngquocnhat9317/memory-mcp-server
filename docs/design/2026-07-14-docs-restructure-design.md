# Docs Restructure & Contributor Documentation — Design

| Field | Value |
| --- | --- |
| Date | 2026-07-14 |
| Status | Approved (brainstorming), pending implementation plan |
| System version at design time | 1.3.0 (`package.json`) |
| Audience | Contributors to `memory-mcp-server` (including the maintainer) |
| Author | Maintainer + agent (brainstorming session) |

## 1. Purpose

The user-facing docs (`README.md`, `CHANGELOG.md`, `GUIDELINES.md`) are current
with the 1.3.0 code. The **contributor-facing** documentation is not: there is no
architecture document, no consolidated roadmap, the design specs are split across
two parallel folders with inconsistent naming, one spec is still untracked in git,
and the `CLAUDE.md` / `AGENTS.md` contract lacks a release process, docs-placement
conventions, and version-sync rules.

This change restructures `docs/` into a clean, single-purpose hierarchy and adds
the three missing contributor documents (index, architecture, roadmap), while
teaching the repo how to keep them in sync going forward.

Non-goal: no change to user-facing README/CHANGELOG/GUIDELINES content, no change
to any runtime code behavior. The only `src/` change is a new lock test.

## 2. Current State (surveyed 2026-07-14)

```
docs/
  growth/registry-submissions.md
  plan-improvement-performance/
    2026-07-11-spec-mcp-value-improvement.md
    2026-07-12-spec-recall-precision-workspace.md
    2026-07-12-spec-v1.3.5-recall-refinements.md      ← UNTRACKED in git
  superpowers/
    plans/2026-07-01-agents-md-rewrite.md
    plans/2026-07-03-audit-layer-implementation.md
    plans/2026-07-08-agents-contributor-workflow.md
    specs/2026-07-03-memory-mcp-audit-layer-design.md
    specs/2026-07-05-memory-mcp-guidance-telemetry-design.md
    specs/2026-07-08-agents-contributor-workflow-design.md
```

Link inventory (what a move must not break):

- The three `plan-improvement-performance/` specs cross-reference each other with
  **relative** links (e.g. `./2026-07-11-spec-mcp-value-improvement.md`). Moving
  them **together into one folder with unchanged filenames** keeps those links valid.
- `CHANGELOG.md:33` references `docs/growth/registry-submissions.md`. Keeping
  `growth/` in place means CHANGELOG needs no edit.
- The `superpowers/plans/*` files contain historical `git add docs/superpowers/...`
  command lines. These are archival records of past actions, not live links; they
  are left as-is.

## 3. Target Structure

```
docs/
  README.md            ← NEW: index explaining how docs/ is organized
  architecture.md      ← NEW: architecture doc (carries a Version: line)
  roadmap.md           ← NEW: consolidated roadmap
  design/              ← all design/spec docs (the "what/why")
    2026-07-03-memory-mcp-audit-layer-design.md
    2026-07-05-memory-mcp-guidance-telemetry-design.md
    2026-07-08-agents-contributor-workflow-design.md
    2026-07-11-spec-mcp-value-improvement.md
    2026-07-12-spec-recall-precision-workspace.md
    2026-07-12-spec-v1.3.5-recall-refinements.md         ← committed here
    2026-07-14-docs-restructure-design.md                ← this file
  plans/               ← all implementation plans (the "how, done")
    2026-07-01-agents-md-rewrite.md
    2026-07-03-audit-layer-implementation.md
    2026-07-08-agents-contributor-workflow.md
  growth/              ← UNCHANGED: go-to-market concern, kept separate
    registry-submissions.md
```

Principles:

- Three separated concerns — `design/` (what/why), `plans/` (how, already done),
  `growth/` (go-to-market) — plus three top-level files (`README` index,
  `architecture`, `roadmap`).
- All moves use `git mv` to preserve history.
- Filenames are **kept unchanged** so relative cross-refs between specs stay valid.
- The old `plan-improvement-performance/` and `superpowers/` directories are removed
  once empty.

### 3.1 File move mapping

| From | To |
| --- | --- |
| `docs/plan-improvement-performance/2026-07-11-spec-mcp-value-improvement.md` | `docs/design/2026-07-11-spec-mcp-value-improvement.md` |
| `docs/plan-improvement-performance/2026-07-12-spec-recall-precision-workspace.md` | `docs/design/2026-07-12-spec-recall-precision-workspace.md` |
| `docs/plan-improvement-performance/2026-07-12-spec-v1.3.5-recall-refinements.md` (untracked) | `docs/design/2026-07-12-spec-v1.3.5-recall-refinements.md` (git add here) |
| `docs/superpowers/specs/2026-07-03-memory-mcp-audit-layer-design.md` | `docs/design/2026-07-03-memory-mcp-audit-layer-design.md` |
| `docs/superpowers/specs/2026-07-05-memory-mcp-guidance-telemetry-design.md` | `docs/design/2026-07-05-memory-mcp-guidance-telemetry-design.md` |
| `docs/superpowers/specs/2026-07-08-agents-contributor-workflow-design.md` | `docs/design/2026-07-08-agents-contributor-workflow-design.md` |
| `docs/superpowers/plans/2026-07-01-agents-md-rewrite.md` | `docs/plans/2026-07-01-agents-md-rewrite.md` |
| `docs/superpowers/plans/2026-07-03-audit-layer-implementation.md` | `docs/plans/2026-07-03-audit-layer-implementation.md` |
| `docs/superpowers/plans/2026-07-08-agents-contributor-workflow.md` | `docs/plans/2026-07-08-agents-contributor-workflow.md` |
| `docs/growth/registry-submissions.md` | *(unchanged)* |

## 4. New Document: `docs/architecture.md`

Contributor-facing architecture, written from the actual `src/` code. Opens with a
`Version:` line (see §4.1). Section outline:

1. **Overview** — stdio MCP server, local-only, `node:sqlite` (no native addon,
   Node ≥ 22.5), what the server is and is not.
2. **Layering** — `index.ts` (tool registration + dispatch) → `tools/*` (handlers)
   → `schemas/*` (input validation) → `db.ts` (DB open + migration bootstrap), with
   `constants.ts`, `types.ts`, `utils.ts` as shared support.
3. **Module map** — one line per `src/` file stating its responsibility: `db.ts`,
   `tools/memory.ts`, `tools/reasoning.ts`, `tools/telemetry.ts`,
   `tools/usage-guide.ts`, `schemas/memory.ts`, `schemas/reasoning.ts`,
   `migrations/*`.
4. **Data flow** — the task lifecycle: `reasoning_start_session` (auto-recall +
   stale cleanup) → `reasoning_add_step` → `reasoning_complete_session` (+ usage
   feedback), naming where DB reads/writes happen.
5. **Storage model** — the six tables + two FTS5 indexes, and how migrations run
   automatically at startup (`db.ts` + `migrations/index.ts`).
6. **Adding a new tool** — checklist: schema in `schemas/`, handler in `tools/`,
   registration in `index.ts`, tests in `__tests__/`, migration if the schema
   changes, and **update `README.md` / `CHANGELOG.md` / `GUIDELINES.md` /
   `docs/architecture.md`** in the same change when behavior or structure changes
   (see §4.2 sync rule).
7. **Telemetry vs usage-feedback** — the `MEMORY_TELEMETRY` opt-in diagnostics gate
   vs the always-recorded usage-feedback learning signal.

This is a human-facing document; it is written at the length needed to be clear and
complete, not compressed.

### 4.1 Version line

`docs/architecture.md` begins with a `Version:` line that matches the system version
in `package.json` (currently `1.3.0`), mirroring how `GUIDELINES.md` carries its own
version line.

- Enforced by a **lock test** (new), mirroring the existing `GUIDELINES.md` version
  assertion in `src/__tests__/reasoning-audit-tools.test.ts`: the test asserts the
  `Version:` value in `architecture.md` equals the `version` field in `package.json`.
  CI fails if they drift.
- Accepted trade-off: **every** release must touch `architecture.md` (at minimum bump
  the version line after confirming the content still matches the code), even a
  release that changes no architecture. This is the cost of a hard guarantee and is
  intentional.

### 4.2 Sync-on-change rule

Any system change that affects the module map, data flow, storage model, or tool
surface must update `docs/architecture.md` in the **same** change — never leave it a
release behind. This parallels the existing "sync docs in the same change" rule for
README/CHANGELOG/GUIDELINES and is recorded as a convention in §6.

## 5. New Document: `docs/roadmap.md`

A consolidated navigation map derived from `CHANGELOG.md` (shipped) and the design
specs (planned). It introduces **no new commitments** — it only aggregates what
already exists. Sections:

1. **Shipped** — table by release, each row linking to its design spec in
   `docs/design/`:
   - `1.2.0` — Wave 1: auto-recall, stale-session cleanup, usage-feedback loop.
   - `1.2.5` — Wave 2: batch steps, GUIDELINES lifecycle rewrite, README landing page.
   - `1.3.0` — Wave 3 + amendment: BM25 relevance ranking, recall quality floor,
     workspace-aware recall, provenance on auto-recall, cold-start nudge — links to
     `2026-07-11-spec-mcp-value-improvement.md` and
     `2026-07-12-spec-recall-precision-workspace.md`.
2. **Planned / next** — `v1.3.5` (WI-10..14 recall refinements) linking
   `2026-07-12-spec-v1.3.5-recall-refinements.md`; `v1.4.0` candidates (WI-6/WI-7,
   behind the evidence gate) from the value-improvement spec §9.
3. **How to read this** — one line: the source of truth for "planned" work is the
   design specs; the roadmap is navigation only and does not replace a spec.

## 6. Contract Updates: `CLAUDE.md` and `AGENTS.md` (twin)

`CLAUDE.md` and `AGENTS.md` are twins — every edit here applies identically to both.

1. **Repo Map update** — point at the new `docs/` structure (`design/`, `plans/`,
   `growth/`, `architecture.md`, `roadmap.md`) instead of the old layout; add the
   currently-missing `src/tools/telemetry.ts` entry.
2. **Docs conventions (new section)** — where files live:
   - New design spec → `docs/design/YYYY-MM-DD-<topic>.md`.
   - New implementation plan → `docs/plans/YYYY-MM-DD-<topic>.md`.
   - Stated so the brainstorming / writing-plans skills write to `docs/design/` and
     `docs/plans/` going forward, not `docs/superpowers/`.
3. **Release process (new section)** — version bump checklist:
   `package.json` → `MCP_VERSION` in `src/constants.ts` → `Version:` line in
   `docs/architecture.md` (after confirming accuracy) → `CHANGELOG.md` entry →
   `GUIDELINES.md` version if agent-facing behavior changed, then
   `npm run build && npm test`.
4. **Version-sync conventions (new section, extends the existing Docs section)** —
   collects all version couplings in one place:
   - `GUIDELINES.md` `Version:` ↔ assertion in `reasoning-audit-tools.test.ts` (existing).
   - `architecture.md` `Version:` ↔ `package.json` `version` (new, §4.1).
   - The "sync docs in the same change" rule extended to explicitly cover
     `architecture.md` (§4.2).

## 7. New Document: `docs/README.md`

A short index: one line per top-level file and per subdirectory (`design/`, `plans/`,
`growth/`), so a newcomer opening `docs/` knows where to go.

## 8. Verification

Per `CLAUDE.md`: this change touches the test surface (new lock test) and repo
structure, so `npm run build` and `npm test` must pass. Additional checks:

- The new `architecture.md` version lock test passes (version line == package.json).
- No broken relative links after the move (the three `design/` specs still resolve
  each other; `CHANGELOG.md` → `growth/registry-submissions.md` unchanged).
- `git mv` used for every move so history is preserved; old directories removed.

## 9. Out of Scope

- Rewriting or restructuring README/CHANGELOG/GUIDELINES content.
- Any runtime code behavior change (only a new test is added under `src/`).
- Renaming spec/plan files (filenames kept to protect relative links).
- Adding new roadmap commitments or new design work.
