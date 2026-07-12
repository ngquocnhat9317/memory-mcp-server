# v1.3.0 Amendment Spec — Sharper Recall: Quality Floor (F1) and Workspace-Aware Ranking (F2)

| Field | Value |
|---|---|
| Doc version | 0.2 (Draft — awaiting owner approval before coding; 0.1 was the Vietnamese draft) |
| Date | 2026-07-12 |
| Relation to main spec | Amendment to [2026-07-11-spec-mcp-value-improvement.md](./2026-07-11-spec-mcp-value-improvement.md) — same release, v1.3.0 (not yet published) |
| Work items | WI-8 (F1 — recall quality floor) · WI-9 (F2 — workspace-aware recall + tag hygiene) |
| Origin | Owner's real-world dogfooding of the 1.3.0 build, 2026-07-12 |

---

## 1. Evidence and diagnosis

The owner ran the 1.3.0 build against real work and observed two problems. Both **inflate input tokens and inject noise, degrading output quality** — a direct hit on the denominator of the value fraction (main spec §1):

### Problem A — Memories from other workspaces/projects leak into recall

**Root cause (verified in code):** all memories live in one global DB file (`DB_PATH` defaults to `~/.memory-mcp-server/memory.db`, `src/constants.ts:32-34`), and `recallRelatedMemories` (`src/tools/reasoning.ts`) matches FTS across the whole store — **no layer has any concept of a workspace**: no schema column, nothing recorded at save time, no distinction at recall time. The more projects share the store, the higher the odds of cross-project recall.

A secondary aggravator: agents have been encoding project names into **tags** (e.g. `["memory-mcp-server", ...]`). Since `memories_fts` indexes tags, a session title that happens to share a token with a project name pulls in that project's memories — tags are currently doing (badly) the job a workspace column should do.

### Problem B — Barely-relevant memories still occupy recall slots

**Root cause (verified in code):** recall uses per-word OR prefix matching on the title (`toFtsOrQuery`, `src/utils.ts:41-44`). An N-word title matches *any* memory containing *any single* word. BM25 (WI-1) ranks the best match first, but recall **always fills all `AUTO_RECALL_LIMIT` (3) slots** with whatever matched — including memories that share only one common word ("fix", "service", "update"). There is no quality floor: one-word junk is still returned whenever it is "the best that's left". Problem A amplifies Problem B: a multi-project store means more junk candidates.

**Scope note:** the "importance outranks relevance" symptom was 1.2.x behavior, already fixed by BM25 in WI-1. This spec addresses what *remains* after WI-1.

---

## 2. Goals and non-goals

### Goals

- **G-A:** Memories from the current workspace are preferred at recall time; memories from other workspaces appear only when they are genuinely strong matches (soft preference, never a hard filter).
- **G-B:** Recall stops padding its slots with weak matches — better to return fewer, correct results and save input tokens.
- **G-C:** Zero-config: both correct behaviors are the default. Env overrides exist only as escape hatches.
- **G-D:** Tags describe *topics*, not *locations* — workspace identity is the server's job, not the tagger's.

### Non-goals

- **`memory_search` is unchanged** — search is a deliberate act with an explicit query; applying floors or workspace bias there would second-guess the caller. Revisit only with its own evidence.
- **No hard workspace filtering** — a user preference saved in project A must remain recallable in project B when it matches strongly.
- **No new dependencies, no semantic search** — same discipline as every previous wave.
- **No tool-surface changes.**

---

## 3. WI-8 (F1) — Recall quality floor: minimum term matches + match-count ranking

### 3.1. Design

**Step 1 — Recall-specific term preparation** (does not touch `memory_search`): new helper `toRecallTerms(title)` in `src/utils.ts`:
- Tokenize like the existing `ftsTerms` (prefix-quoted).
- **Drop terms ≤ 2 characters** ("in", "of", "to"… — the main source of one-word junk; if that empties the list, keep the original terms).
- **Cap at the first 8 terms** (an unusually long title must not spawn 15 queries).

**Step 2 — Count matched terms per candidate.** Run one OR query to get the candidate set + `rank` (BM25), then one per-term query returning rowid sets; count in JS how many terms each candidate matches. Cost: at most 9 FTS queries against local SQLite — negligible (µs–ms), and it runs once per session start.

**Step 3 — Quality floor (min-match):**

```
required = (significant terms >= 3) ? 2 : 1
```

Titles with 3+ significant terms → a candidate must match **at least 2 terms** to enter recall. 1–2 term titles keep today's behavior (one match already covers 50–100% of the title).

**Step 4 — New ranking:**

```
ORDER BY matched_terms DESC        -- more matched terms wins
       , [workspace_priority DESC] -- WI-9, see §4
       , bm25 rank ASC             -- WI-1 keeps its role
       , importance DESC
       , updated_at DESC
```

**Step 5 — When no candidate clears the floor:** return **at most 1** best OR match (by rank) instead of 3. Rationale: keep one serendipity lifeline for the genuinely relevant single-shared-keyword case (e.g. title "fix payment bug" ↔ memory "payment provider rotation"), while cutting ⅔ of the tokens versus today. Alternative (return nothing) — see OQ-A.

### 3.2. Functional requirements

- FR-8.1: For titles with ≥3 significant terms, every `related_memories` record matches ≥2 terms, except the FR-8.3 fallback.
- FR-8.2: Ranking follows §3.1 Step 4; record shape unchanged (still `id/type/importance/tags/snippet/source?`).
- FR-8.3: Nothing clears the floor → return at most 1 best match; nothing matches at all → empty as today (the WI-4 nudge keeps its own separate condition).
- FR-8.4: Recall stays best-effort — an FTS error must never block session creation (keep the try/catch).
- FR-8.5: `memory_search` behavior unchanged.

### 3.3. Acceptance criteria

- AC-8.1: Store contains memory X matching 3 terms and memory Y (importance 5) matching 1 term, 4-word title → recall contains X and **not** Y.
- AC-8.2: 2-word title → a 1-term match is still recalled (old behavior preserved for short titles).
- AC-8.3: No candidate matches ≥2 terms of a long title → exactly 1 record returned (best-ranked match).
- AC-8.4: Deliberately separated fixtures (lesson from AC-1.1): clear matched-term gaps, comparable content lengths.

---

## 4. WI-9 (F2) — Workspace-aware recall (soft preference) + tag hygiene

### 4.1. Design

**Workspace identity** (`src/constants.ts`):

```ts
export const WORKSPACE = process.env.MEMORY_WORKSPACE ?? process.cwd();
```

Claude Code / Codex launch the MCP server inside the project directory, so `process.cwd()` *is* the project. Clients that launch from home/root make every memory share one workspace → the preference degrades to a harmless no-op (never wrong, just not helpful). `MEMORY_WORKSPACE` is the explicit escape hatch for pinning.

**Schema** — migration `0005_memory_workspace`:

```sql
ALTER TABLE memories ADD COLUMN workspace TEXT;
CREATE INDEX IF NOT EXISTS idx_memories_workspace ON memories(workspace);
```

Existing rows carry `NULL` = "global/unknown origin". A real column (rather than a metadata JSON field) because it participates in ORDER BY and indexing directly, leaves existing metadata untouched, and the migration infra (0001–0004) is already in place.

**Stamping at save time:** `memory_save` and the persist-conclusion branch of `reasoning_complete_session` write `WORKSPACE` into the column. No input-schema changes — fully automatic.

**Recall preference** — 3 tiers, computed in SQL:

```sql
CASE
  WHEN m.workspace = ?     THEN 2  -- same workspace: preferred
  WHEN m.workspace IS NULL THEN 1  -- global/legacy: neutral
  ELSE 0                           -- other workspace: ranked last
END AS workspace_priority
```

Placed **below `matched_terms` but above `bm25 rank`** (§3.1 Step 4): raw relevance stays the number-one criterion (the WI-1 lesson — never again let a secondary signal outrank relevance), but among matches with equal term coverage, "home" memories beat "neighbor" memories. Trade-off details: OQ-B.

**No hard filtering.** A cross-workspace memory that matches more terms still wins — deliberately: strongly-matching cross-project preferences and conclusions are exactly the most valuable kind of recall.

**Tag hygiene (owner requirement, 2026-07-12):** with workspace now a first-class column, tags must stop doubling as location markers. Encoding workspace/project names into tags (a) duplicates what the server now records automatically and (b) actively causes cross-project noise, because `memories_fts` indexes tags — any title token that overlaps a project name drags that project's memories into recall. Guidance therefore changes:

- `GUIDELINES.md` (bump to `2026-07-11.v5`, or dated v2026-07-12 — keep the repo's existing convention): add to the save guidance and/or "Do Not Store" area: *"Tags describe topics ('sqlite', 'auth', 'perf'), not locations. Do not put workspace or project names in tags — the server records the workspace automatically."*
- `memory_save` tool description: add the same one-line rule so agents that never read GUIDELINES still see it at the call site.
- This is guidance-only for existing data: old tags are not rewritten (non-destructive; the workspace column makes them progressively irrelevant for scoping).

### 4.2. Functional requirements

- FR-9.1: Migration 0005 adds the column + index; existing DBs migrate automatically on open; old rows have `workspace = NULL`.
- FR-9.2: `memory_save` and persist-conclusion stamp the current workspace automatically; no tool input schema changes.
- FR-9.3: Recall ranks `workspace_priority` (2/1/0) between `matched_terms` and `rank`.
- FR-9.4: `MEMORY_WORKSPACE` overrides `process.cwd()`; read once at module load (a workspace does not change mid-process — acceptable).
- FR-9.5: Recall records do **not** gain a workspace field — no payload growth; workspace is an internal ranking signal only. (`memory_get` returns the full row if debugging is ever needed.)
- FR-9.6: README updates: a `MEMORY_WORKSPACE` row in the Configuration table + the "Shared vs project-scoped memory" section explains that soft workspace preference is now the default, with per-project `MEMORY_DB_PATH` remaining the hard-isolation option.
- FR-9.7: Tag-hygiene guidance added to `GUIDELINES.md` (version bump + assertion sync in `src/__tests__/reasoning-audit-tools.test.ts`, per repo rules) and to the `memory_save` tool description, worded as in §4.1.

### 4.3. Acceptance criteria

- AC-9.1: Two equally-matching memories, one same-workspace and one other-workspace → same-workspace ranks first.
- AC-9.2: Other-workspace memory matching 3 terms vs same-workspace memory matching 1 term (long title) → the other-workspace memory wins (matched_terms dominates) — proving the preference is soft.
- AC-9.3: Legacy rows (`NULL`) rank in the middle: after same-workspace, before other-workspace, when higher-order criteria tie.
- AC-9.4: With `MEMORY_WORKSPACE=/x`, newly saved memories carry `/x`.
- AC-9.5: Migration runs on a DB populated under 0001–0004 without errors; data intact.
- AC-9.6: `GUIDELINES.md` contains the tag-hygiene rule; `memory_save` description contains it; guide version assertions synced.

---

## 5. Token impact (estimated)

| Scenario | Today | After F1+F2 |
|---|---|---|
| ≥1 good match exists, multi-project store | 3 slots always full; typically 1–2 are cross-project / one-word junk | Only floor-clearing matches, home workspace first |
| No good match | 3 junk slots | 1 slot (or 0 — OQ-A) |
| Empty store | 0 + nudge | Unchanged |

Each record costs ~250–400 input tokens (snippet + tags + source). Cutting 2 junk slots saves **~500–800 input tokens per session start** — precisely where the owner reported the pain.

---

## 6. Open questions — ALL RESOLVED (owner, 2026-07-12)

- **OQ-A — RESOLVED: 1-record fallback.** When nothing clears the floor, return the single best-ranked match (serendipity lifeline, still cuts ⅔ of the tokens).
- **OQ-B — RESOLVED: `workspace_priority` below `matched_terms`.** Relevance stays the main course. Owner note: effectiveness will be evaluated in real use first; based on that evidence, a proper **scoring mechanism is planned for v1.4.0** (connects with the main spec's §9 evidence-gated Wave 4 — a blended score would fold matched-terms, workspace, BM25, and possibly used-count into one formula instead of lexicographic ordering).
- **OQ-C — RESOLVED: as proposed.** Dropping ≤2-character terms is the only junk-term control for v1.3.0; no stopword list.
- **FR-9.4 amendment (implementation detail):** workspace is read at call time via a `getWorkspace()` helper (env first, `process.cwd()` fallback) instead of a module-load constant — same pattern as `isTelemetryEnabled()`, trivially testable, no behavioral difference for real servers.

## 7. Execution plan

```
WI-8 + WI-9 as one commit series on feat/v1.3.0-wave3, still version 1.3.0 (unpublished):
  1. migration 0005 + constants.WORKSPACE                (WI-9 foundation)
  2. toRecallTerms + new recall (floor + ranking)        (WI-8 + FR-9.3 in one place)
  3. workspace stamping in memory_save + persist         (WI-9)
  4. tag-hygiene guidance: GUIDELINES bump + memory_save
     description                                         (FR-9.7)
  5. tests (AC-8.x, AC-9.x) + docs (README, CHANGELOG's
     existing 1.3.0 entry, GUIDELINES version-assertion sync)
  6. npm test + coverage ≥95% + subagent re-review of the new diff
```

**Files expected to change (~10):** `src/constants.ts`, `src/migrations/0005_memory_workspace.ts`, `src/migrations/index.ts`, `src/utils.ts`, `src/tools/reasoning.ts`, `src/tools/memory.ts`, `src/__tests__/*` (wave3 files + migrations test), `README.md`, `CHANGELOG.md`, `GUIDELINES.md`.

## 8. Risks

| # | Risk | Mitigation |
|---|---|---|
| R-1 | Min-match floor too strict → recall goes quiet more than expected | 1-record fallback (OQ-A); 1–2 term titles keep old behavior; the floor is one constant if future data says lower it |
| R-2 | Client launches the server outside the project dir → workspace meaningless | Harmless no-op; `MEMORY_WORKSPACE` escape hatch; documented |
| R-3 | N+1 FTS queries per session start | Capped at 8 terms, local SQLite, once per session |
| R-4 | Existing tests locking recall order/count will fail | Intentional behavior change — update tests in the same commit (repo rule) |
| R-5 | Migration runs on the owner's live DB | ALTER TABLE ADD COLUMN is non-destructive; migration infra is already tested |
| R-6 | Old memories with project names in tags keep causing tag-based noise | Accepted for now: guidance stops new pollution, the workspace column supersedes tags for scoping, and F1's floor already demotes single-token tag hits; no destructive rewrite of user data |

## 9. Done criteria

- [ ] Every AC-8.x and AC-9.x has a test; `npm test` passes; coverage ≥95%.
- [ ] README/CHANGELOG (existing 1.3.0 entry) updated in the same change; GUIDELINES bumped with assertions synced.
- [ ] Subagent review PASS on the new diff.
- [ ] Commits only, no push — owner reviews first.

## 10. Revision history

- **0.2 (2026-07-12):** Rewritten in English per owner request. Added tag-hygiene requirement (FR-9.7, AC-9.6, R-6): tags must not carry workspace/project names now that the server stamps workspace automatically — includes GUIDELINES + `memory_save` description updates.
- **0.1 (2026-07-12):** Initial Vietnamese draft — F1 quality floor, F2 workspace soft preference, token impact estimate, OQ-A/B/C.
