# SPEC — Recall Workspace Identity + Scoped Blended Scoring (auto-recall)

| Field | Value |
|---|---|
| Document version | 0.3 (Implemented in 1.3.3; design approved by owner 2026-10-05, option "b"; weights and `preference` bypass set by owner in rev 0.2) |
| Date | 2026-10-05 |
| Target MCP version | 1.3.3 (`package.json`, `MCP_VERSION`) |
| Relation to prior specs | Builds on [2026-07-12-spec-recall-precision-workspace.md](./2026-07-12-spec-recall-precision-workspace.md) (workspace soft preference, shipped 1.3.0). Takes the **auto-recall-only slice** of Option A in [2026-08-07-spec-zero-mem-inspired-recall.md](./2026-08-07-spec-zero-mem-inspired-recall.md); the `memory_search` slice stays blocked on that spec's OQ-4. |
| Trigger | Owner report, 2026-10-05: `reasoning_start_session` recalls memories from other projects, old memories, and memories from the same project with near-zero relevance. This is the first recorded recall-quality complaint, i.e. evidence for roadmap gate G-c. |
| Reasoning trace | session `sess_a53d19b2-c690-46e5-afe6-49ad3772eaf5` |

---

## 1. Problem and verified root causes

All findings below were observed directly (code read, live DB queried read-only, running processes inspected), not inferred.

**RC-1 — Workspace identity is unreliable (primary cause).** `getWorkspace()` returns `MEMORY_WORKSPACE ?? process.cwd()` (`src/constants.ts`). Desktop-app launches start the MCP server with cwd `/` or `~`. In the live DB, **36 of 68 memories carry `workspace = '/'`**, yet they belong to at least DarkestTerminal, tsukrel-seo and opencode work. Several running server processes had cwd `/` or `/Users/macbook_343`. A session also started from `/` sees every one of those 36 rows as "same workspace" (`workspace_priority = 2`), so the 1.3.0 workspace preference is a no-op for them.

**RC-2 — Workspace is only a secondary sort key.** In `recallRelatedMemories` (`src/tools/reasoning.ts:250-353`) the comparator is `matched DESC, workspace_priority DESC, fts_rank, importance, updated_at`. A cross-project memory matching one more term beats any home memory. The 50-row candidate pool is the global top-50 BM25, so home memories may never enter it.

**RC-2b — The "serendipity lifeline" returns junk.** When no candidate clears the term floor, the code still returns the single best match from any workspace (`reasoning.ts:313-316`).

**RC-3 — Generic title words count as matches.** A title like "Fix bug in recall" matches any memory containing "fix"/"bug". The floor counts these toward `matched`, which is the main source of same-project, near-zero-relevance recalls.

**RC-4 — No time signal and no negative feedback signal.** Recall ignores `updated_at` entirely (except as the last tie-break, which per the 1.3.5 spec HT-12a never fires) and ignores memories already reported `stale` / `unsafe_to_use` via `memory_record_usage_feedback`.

## 2. Goals and non-goals

### Goals

- **G-1:** A workspace of `/`, the home directory, or empty is treated as **unknown**, never as a project.
- **G-2:** Agents can state their project explicitly (`workspace` parameter) because they, unlike the server, always know their cwd.
- **G-3:** Memories from other projects are returned only when they are strong matches. Still no hard filter. `preference` memories are cross-project by nature and bypass the cross-project gate.
- **G-4:** When nothing is relevant, `related_memories` is `[]`.
- **G-5:** Ranking is one blended score in which relevance dominates (C-1) and every signal participates in every comparison (C-2).
- **G-6:** Memories already flagged `stale` / `unsafe_to_use` are not auto-recalled.

### Non-goals

- `memory_search` ranking (blocked on OQ-4; unchanged).
- Entity graph (Option B), temporal hierarchy (Option C), `used_count` weighting (WI-6 / OQ-5 — deliberately not folded in yet).
- Re-attributing the 36 legacy `/` rows to real projects by guessing from content (rejected as an error-prone heuristic).
- A hard workspace filter, or per-project databases (`MEMORY_DB_PATH` remains the hard-isolation option).

## 3. Design

### 3.1 Workspace resolution (`src/constants.ts`)

`getWorkspace(explicit?: string): string | null`

1. Candidate = `explicit` if provided, else `MEMORY_WORKSPACE`, else `process.cwd()`.
2. Normalize: trim, strip trailing path separators (keep a lone `/`).
3. Return `null` if the result is empty, `/`, or `os.homedir()`; otherwise the normalized string.

`null` means **unknown**. Unknown is stored as SQL `NULL`, the same value legacy rows already use for "global / unknown origin".

### 3.2 New optional `workspace` parameter

- `reasoning_start_session` and `memory_save` accept `workspace` (string, max 500, optional). Description: the absolute path of the project directory the agent is working in; pass it so recall can prefer this project's memories.
- `reasoning_start_session` persists the resolved workspace on the session (§3.3) and **returns it** as `workspace` (string or `null`). When it is `null`, the response also carries `workspace_warning` telling the agent that project could not be determined and to pass `workspace`.
- `reasoning_complete_session` takes no new parameter: a persisted conclusion inherits the session's workspace.

### 3.3 Migration `0006_workspace_identity`

```sql
ALTER TABLE reasoning_sessions ADD COLUMN workspace TEXT;
UPDATE memories SET workspace = NULL WHERE workspace = '/' OR workspace = <os.homedir()>;
```

The home path is injected from JS (`os.homedir()`), not hard-coded. Existing sessions keep `workspace = NULL`. No data is lost: the 36 legacy `/` rows become "unknown" and rank neutrally.

### 3.4 Recall algorithm (`recallRelatedMemories`)

Inputs: `title`, `currentWorkspace` (resolved, may be `null`).

1. **Terms.** `toRecallTerms` additionally drops a small stoplist of generic words (task verbs and function words, English plus a few Vietnamese such as `fix add update improve implement review investigate debug bug issue task`, `không của cho với`). If the stoplist would empty the list, fall back to the unfiltered significant tokens (existing behavior), so a title made only of generic words still works.
2. **Candidate pool (50).** FTS match over the terms. When `currentWorkspace` is known, order the pool by `workspace_priority DESC, fts_rank ASC` so home memories always enter the pool. `workspace_priority` is 2 for the current workspace, 1 for NULL **or** a `preference` memory, 0 for any other project (so cross-project preferences also always enter the pool). When unknown, order by `fts_rank` only.
3. **Eligibility gate**, with `N` = number of terms and `matched` = terms matched by that memory:
   - Home or NULL memory: `matched >= (N >= 3 ? 2 : 1)` (existing floor).
   - Other-workspace memory with `type != 'preference'` (only when `currentWorkspace` is known): `matched >= max(2, ceil(0.75 · N))`. For `N = 1` this is unsatisfiable, so a one-term title never recalls non-preference memories from another project. Intentional.
   - `type = 'preference'` memory, any workspace: bypasses the cross-project gate and uses the base floor (`matched >= (N >= 3 ? 2 : 1)`). It still has to be relevant to the title; it is just not penalized for coming from another project.
   - `currentWorkspace` unknown: existing floor for everyone; no tiers.
4. **Exclusion.** Drop any memory with a successful feedback event whose `metadata.usefulness` is `stale` or `unsafe_to_use`.
5. **Score** over the eligible set:

```
score = 0.45 · coverage            (matched / N)
      + 0.20 · bm25_norm           (min-max of fts_rank within the eligible set; all-equal → 1)
      + 0.30 · workspace_term      (home 1.0; NULL or preference 0.5; other 0.0; constant 0.5 when current is unknown)
      + 0.05 · recency             (1 / (1 + age_days / 60), age from updated_at)
```

   Relevance (coverage + BM25) carries 65% of the weight against 30% for workspace (C-1: relevance stays the largest single block, but workspace is deliberately a strong modifier, per owner). Because other-workspace memories already passed the strict gate in step 3, the 0.3 workspace term only orders eligible candidates; it cannot let a weak cross-project match in. A `preference` memory from another project scores the neutral 0.5 workspace term (treated as global, like NULL). Ties break by `importance DESC`, then `updated_at DESC`.
6. **No lifeline.** Return the top `AUTO_RECALL_LIMIT` of the eligible set; empty if the set is empty.

The weights are hard-coded constants with a comment pointing here (OQ-1 resolution: no new config surface). They are an unvalidated starting point; §6 and §7 describe how they are checked.

### 3.5 Units and boundaries

- `getWorkspace` (constants) — pure resolution, no DB.
- `toRecallTerms` (utils) — term preparation incl. stoplist, no DB.
- `recallRelatedMemories` (reasoning) — pool, gate, exclusion, score; the only place weights live.
- Migration 0006 — schema + legacy cleanup only.

## 4. Footprint

| File | Change |
|---|---|
| `src/constants.ts` | `getWorkspace(explicit?)` returns `string \| null`, with `/` and home treated as unknown |
| `src/utils.ts` | stoplist in `toRecallTerms` |
| `src/tools/reasoning.ts` | recall rewrite; persist/return session workspace; conclusion inherits it |
| `src/tools/memory.ts` | `memory_save` uses `getWorkspace(params.workspace)` |
| `src/schemas/reasoning.ts`, `src/schemas/memory.ts` | `workspace` field |
| `src/migrations/0006_workspace_identity.ts`, `src/migrations/index.ts` | new migration, registered |
| `src/__tests__/*` | new/updated tests (§6) |
| `GUIDELINES.md`, `README.md`, `CHANGELOG.md`, `docs/architecture.md`, `docs/roadmap.md`, `package.json`, `src/constants.ts` | doc and version sync (§7) |

Files considered and excluded: `memory_search` path in `memory.ts` (OQ-4), `src/tools/telemetry.ts`, `src/tools/usage-guide.ts`.

## 5. Acceptance criteria

- **AC-1:** `getWorkspace()` returns `null` for `/`, `os.homedir()`, empty, and whitespace; normalizes a trailing slash; honors the `explicit` argument over `MEMORY_WORKSPACE` over cwd.
- **AC-2:** Migration 0006 sets legacy `/` and home-dir rows to NULL, leaves other workspaces untouched, adds `reasoning_sessions.workspace`, and is idempotent on an already-migrated DB.
- **AC-3:** With current workspace `A`, a memory in workspace `B` matching 2 of 4 terms is **not** recalled, while a memory in `A` matching 2 of 4 terms is.
- **AC-4:** With current workspace `A`, a memory in `B` matching all terms **is** recalled (soft preference, not a hard filter).
- **AC-4b:** With current workspace `A`, a `preference` memory in `B` matching 1 of 4 terms (base floor 2 of 4 not met) is not recalled, while one matching 2 of 4 **is** recalled even though a non-preference `B` memory with the same match is not.
- **AC-5:** When no memory clears the gate, `related_memories` is `[]` (no lifeline), including when only other-workspace weak matches exist.
- **AC-6:** A title whose only overlap with a memory is stoplist words does not recall it.
- **AC-7:** A memory with a `stale` or `unsafe_to_use` feedback event is not recalled; `used` / `ignored` do not exclude.
- **AC-8:** Among two eligible memories with equal coverage, the home one outranks a NULL one, and a more recently updated one outranks an older one only when relevance is otherwise comparable (relevance is never overridden by recency).
- **AC-9:** `reasoning_start_session` with `workspace` stores it on the session; `reasoning_complete_session(save_as_memory=true)` persists the memory with that workspace.
- **AC-10:** With an unknown workspace the response has `workspace: null` and a `workspace_warning`; memory saved without a resolvable workspace has `workspace = NULL`.
- **AC-11:** Existing recall tests (`wave3b-recall-scoping`, `wave3-*`) still pass or are updated with a stated reason.

## 6. Verification plan

- Unit/behavior tests for AC-1…AC-11 in `src/__tests__/` (extend `wave3b-recall-scoping.test.ts`, `migrations.test.ts`; fixtures use two or three synthetic workspaces with deliberately overlapping vocabulary).
- A **read-only replay of the real DB** before release: run the new recall against the owner's `~/.memory-mcp-server/memory.db` for a handful of realistic titles per workspace (this repo, GoalTracker, DarkestTerminal, tsukrel-seo) and record before/after in the PR. This is manual evidence, not a committed test, and it is the stand-in for the missing eval base (WI-11).
- `npm run build && npm test`.

## 7. Documentation and release sync

Per `CLAUDE.md` Release Process and Version-Sync Conventions, in the same change:

1. `package.json` → `1.3.3`; `MCP_VERSION` in `src/constants.ts` → `1.3.3`.
2. `docs/architecture.md`: update recall section and bump `Version:`.
3. `CHANGELOG.md`: `1.3.3` entry (behavior change: lifeline removed, other-workspace gate, blended score; new `workspace` parameter; migration 0006).
4. `GUIDELINES.md`: Moment 1 — tell agents to pass `workspace`; describe empty `related_memories` as normal; bump to `2026-10-05.v8` and update the `guide_version` assertion in `src/__tests__/reasoning-audit-tools.test.ts`.
5. `README.md`: Configuration / "Shared vs project-scoped memory" sections.
6. `docs/roadmap.md`: add 1.3.3 to Shipped; note G-c now has recorded evidence; mark the auto-recall slice of Option A as shipped and the `memory_search` slice as still blocked on OQ-4.
7. Update the 2026-08-07 spec and 2026-07-12 spec revision histories with pointers to this spec.

## 8. Risks and open questions

- **R-1 — Weights unvalidated.** No eval base exists (gate G-d). Mitigations: relevance (coverage + BM25) is the largest block at 65%, the workspace term cannot admit anything the gate rejected, hard categorical gate for cross-project, the real-DB replay in §6. If the replay shows bad orderings, adjust constants before release.
- **R-2 — Agents that do not pass `workspace`** from a cwd-`/` launch still get no project scoping (they get the safe "unknown" behavior plus a visible warning). Resolved only by agent compliance; mitigated by GUIDELINES text and the response warning.
- **R-3 — One-term titles never recall cross-project** by design (§3.4 gate). Cross-project preferences/conventions with a distinctive single word are reachable via `memory_search`.
- **R-4 — Stoplist maintenance.** Small, static, with a documented fallback; revisit if replay shows over-filtering.
- **OQ-A — RESOLVED (owner, 2026-10-05):** `type = 'preference'` memories bypass the other-workspace gate. Residual choice made by the spec author, not explicitly confirmed: a cross-project preference gets the neutral 0.5 workspace term (not 1.0) and still must meet the base term floor.
- **OQ-B:** Should `irrelevant` feedback also exclude or only down-weight? This spec excludes only `stale` / `unsafe_to_use`; `irrelevant` is context-dependent (irrelevant to one task, fine for another).

## 9. Revision history

### 0.3 — 2026-10-05

Implemented in 1.3.3 (plan: [docs/plans/2026-10-05-recall-workspace-identity.md](../plans/2026-10-05-recall-workspace-identity.md)). Clarified §3.4 step 2: pool priority counts `preference` memories as tier 1. No behavior change from rev 0.2 otherwise.

### 0.2 — 2026-10-05

Owner decisions: (1) `preference` memories bypass the cross-project gate (OQ-A resolved; added AC-4b); (2) score weights changed from 0.60/0.25/0.10/0.05 to **coverage 0.45, bm25_norm 0.20, workspace_term 0.30, recency 0.05** — relevance is 65%, not 85%; updated the C-1 rationale and R-1 accordingly.

### 0.1 — 2026-10-05

Initial design, approved by owner in conversation (decisions: explicit `workspace` parameter plus `/`/`~` fallback; empty result instead of lifeline; migration to NULL for legacy `/` rows; option "b" — gate plus blended scoring for auto-recall only; version 1.3.3).
