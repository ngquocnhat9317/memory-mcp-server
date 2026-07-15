# SPEC — Raising the Value of Memory MCP (Wave 3: "Recall that is more accurate, more trustworthy, and arrives sooner")

| Field | Value |
|---|---|
| Document version | 0.3 (Draft — revision history in §13) |
| Date | 2026-07-11 |
| Current MCP version | 1.2.5 (`src/constants.ts:6`) |
| Target MCP version | 1.3.0 (Wave 3) |
| Next direction | 1.4.0 (Wave 4 — conditional candidate, only starts after the evidence gate in §9.3) |
| Author | Claude (based on the owner's positioning brief) |
| Scope | Wave 3 (v1.3.0): WI-1..3 code + WI-4..5 docs/growth · Wave 4 (v1.4.0): WI-6, WI-7 — candidates behind the gate (§9) |

---

## 1. Context and guiding philosophy

The product has been through two Waves: Wave 1 closed the memory value loop (auto-recall, `used_memory_ids`, session TTL), Wave 2 finished batch steps, the lifecycle guide, and the repositioned README. The current user-facing positioning fits in one sentence:

> **"Self-operating memory: your agent remembers past work without being told, and you maintain nothing."**

The root of this positioning is a lesson from real data: **the correct behavior must be the default behavior**. The server opens the right filing cabinet at the right moment (auto-recall when a session opens), cleans up after itself (TTL), and asks "did this help?" at the one moment the agent is guaranteed to be present (`used_memory_ids` at task close). Never bet on agent discipline.

The perceived value of the whole system reduces to one fraction:

```
                   number of useful recalls
Perceived value = ─────────────────────────────
                   effort spent + noise endured
```

Every item in this spec must answer the single filtering question: **"Does this make the next useful recall arrive sooner, more accurately, or more trustworthily?"** Any item that cannot answer it is cut (see §8 — Considered but not doing).

---

## 2. Goals and non-goals

### 2.1. Goals

- **G1 — More accurate recall (raise the numerator):** as the memory store grows (hundreds of records), the memory that *best matches the task context* must rank above a memory that is "high importance but off-topic". Noise in recall is worse than no recall — it teaches the agent to ignore the feature.
- **G2 — More trustworthy recall:** a recalled memory must show *where it came from*, so the agent (and a human reading the transcript) can distinguish "a conclusion with provenance, traceable to its trace" from "a floating sentence".
- **G3 — The value feedback loop works in the default configuration:** the signal "this memory actually helped" (`used_memory_ids`) must be recorded on every install, independent of any optional configuration.
- **G4 — Shorter time-to-first-value:** a new user must hit the "oh, it remembered" moment within the first week — before they get around to uninstalling.
- **G5 — Words match the product:** every release channel (README, registry submissions) uses the same "it just remembers" positioning line.

### 2.2. Non-goals

- **No new dependencies.** All ranking changes use the FTS5 capabilities already available in `node:sqlite`. No embeddings, no vector search, no external services.
- **No new configuration variables** unless strictly required — the philosophy is zero-config; correct behavior is the default.
- **No store-degradation mechanism (memory decay/expiry)** — there is no evidence it is needed yet (lesson of the 13 unused tools: do not build ahead of demand).
- **No tool-surface changes** — no tools added or removed; only enrich the output of existing tools.
- **No cloud/network behavior** — the product stays 100% local, one SQLite file.

---

## 3. Current technical state (verified against code, branch `feat/improve-README` @ `278d53f`)

| # | Finding | Evidence |
|---|---|---|
| HT-1 | **Auto-recall does not rank by match quality.** `recallRelatedMemories` OR-matches each word of the title (fuzzy), then `ORDER BY m.importance DESC, m.updated_at DESC` — FTS match quality is dropped entirely from the ordering. | `src/tools/reasoning.ts:248-254`; `toFtsOrQuery` at `src/utils.ts:41-44`; `AUTO_RECALL_LIMIT` defaults to 3 at `src/constants.ts:23-25` |
| HT-2 | **`memory_search` also ranks by importance, not relevance**, even though the tool description says "ranked by relevance". Search uses AND-matching (`toFtsQuery`), so the consequence is milder than auto-recall, but it is the same defect. | `src/tools/memory.ts:333-351` |
| HT-3 | **FTS5 is already ready for relevance ranking.** The `memories_fts` table is FTS5 external-content (columns `content`, `tags`) — the `bm25()` function / `rank` column is available and currently unused. | `src/migrations/0001_initial.ts:23-28` |
| HT-4 | **Memory provenance is already stored but never surfaced.** When `reasoning_complete_session` persists a conclusion, the metadata records `source_session_id`, `session_title`, `step_count`. But the record returned in `related_memories` only carries `id/type/importance/tags/snippet` — provenance is lost. (`memory_search`/`memory_get` return the full record, so they already include metadata — only auto-recall is missing it.) | Written at: `src/tools/reasoning.ts:1406-1411`. Lost when surfaced: `src/tools/reasoning.ts:261-267`. Search returns it in full: `src/tools/memory.ts:40-52` |
| HT-5 | **[New finding, outside the brief] The `used_memory_ids` feedback loop is dead in the default configuration.** `recordToolUsageEvent` returns `null` immediately when `TELEMETRY_ENABLED` is off (`if (!TELEMETRY_ENABLED) return null;`), and telemetry has defaulted to off since commit `278d53f`. Consequence: the agent reports "memory X helped" at session close → the server only returns the warning "Telemetry is disabled; usage feedback ... was not recorded" and discards the signal. A core product signal (measuring the numerator of the value fraction) is locked behind the same door as optional analytics. | Gate: `src/tools/telemetry.ts:89`; default off: `src/constants.ts:8`; warning: `src/tools/reasoning.ts:1446-1448` |
| HT-6 | **There is a SECOND, independent telemetry gate that a fix in `recordToolUsageEvent` does not touch.** The `memory_record_usage_feedback` tool checks `telemetryPersistenceEnabled()` itself (a separate function that reads `process.env.MEMORY_TELEMETRY` directly) inside its handler and returns `recorded:false` when off — fully decoupled from the `recordToolUsageEvent` gate. The tool description also hard-codes "Requires MEMORY_TELEMETRY=on". Additionally, this tool writes its event through the `withTelemetry` wrapper (operationType `"feedback"`) rather than calling `recordToolUsageEvent` directly — so if only `recordToolUsageEvent` is ungated, the event *would* be written while the handler still reports `recorded:false`, creating a contradiction between the data and the tool response. | Gate 2: `src/tools/memory.ts:1313`; function: `src/tools/memory.ts:95-97`; tool description: `src/tools/memory.ts:1230`; writing wrapper: `src/tools/telemetry.ts:159` + `src/tools/memory.ts:1243` |

**Impact walkthrough for HT-1** (since it is the core item): with a store of ~10 memories, importance-first is harmless. But OR-matching means the title "Fix checkout timeout in payment service" matches *every* memory containing the word "fix" or "service". At 500 memories, the three recall slots (limit 3) get taken by any three importance-5 memories that happen to contain one common word — an importance-3 memory matching both "checkout" and "timeout" never surfaces. The longer a user stays, the more diluted recall becomes — the value curve inverts exactly when it should be rising.

---

## 4. Work items

### WI-1 — Rank recall by BM25 relevance (P1 — the core of Wave 3)

**Answer to the filtering question:** makes the next recall **more accurate**.

**Description.** Make FTS5 match quality (`rank` = BM25; smaller value = better match) the primary ranking criterion for both auto-recall (`recallRelatedMemories`) and `memory_search`; `importance` and `updated_at` become secondary criteria (tie-breaks).

**Design.** Replace the `rowid IN (...)` subquery with a JOIN so the `rank` column is available:

```sql
-- recallRelatedMemories (src/tools/reasoning.ts)
SELECT m.id, m.type, m.content, m.tags, m.importance
FROM memories m
JOIN (
  SELECT rowid, rank FROM memories_fts WHERE memories_fts MATCH ?
) f ON m.rowid = f.rowid
ORDER BY f.rank ASC, m.importance DESC, m.updated_at DESC
LIMIT ?
```

`memory_search` applies the same pattern but **needs more careful assembly**: the current query appends `tagClause` (a subquery-based tag filter) to the `WHERE` clause (`src/tools/memory.ts:349`). When switching to a JOIN with FTS to obtain `rank`, the `tagClause` plus the `type`/`agent_id` filters must be preserved and `ORDER BY rank` placed last — do not copy the `recallRelatedMemories` query verbatim. No new configuration variable — relevance-first is the new default behavior, consistent with the philosophy.

**Functional requirements:**
- FR-1.1: Auto-recall orders by `rank ASC` first, then `importance DESC`, then `updated_at DESC`.
- FR-1.2: `memory_search` orders by the same rule; the tool description ("ranked by relevance") becomes true.
- FR-1.3: Error behavior is unchanged — recall stays best-effort; a broken FTS query must not block session creation (keep the `try/catch` block at `src/tools/reasoning.ts:268-271`).
- FR-1.4: No response-shape change — only element ordering changes.

**Acceptance criteria:**
- AC-1.1: Store contains memory A (importance 5, matching 1 word of the title) and memory B (importance 3, matching 3 words) → B ranks above A in `related_memories`. *Testing note:* BM25 depends on term frequency, IDF, and document length, so "more matched words ⇒ higher rank" holds only directionally, not absolutely — the test must use a **deliberately separated fixture** (matched-term gap large enough, comparable content lengths) to avoid flakiness; do not use arbitrary data.
- AC-1.2: Two memories with equal match quality → the higher-importance one ranks first; equal importance → the more recent one ranks first.
- AC-1.3: The whole existing test suite passes after updating the ordering assertions (this is an intentional behavior change — update tests with the change, per the "Preserve tested behavior or update the tests together with the change" rule in `CLAUDE.md`).

**Test plan:** add relevance-ordering tests to the memory + reasoning suites (`src/__tests__/`); audit which existing tests lock importance-first ordering and fix them in the same commit.

**Files expected to change:** `src/tools/reasoning.ts`, `src/tools/memory.ts`, `src/__tests__/*`. Effort: **S** (half a day).

**Technical note:** the `rank` column is only valid inside a query that has `MATCH` on the FTS table — hence the JOIN with an FTS subquery rather than pulling `rank` out. Column weighting (favoring `content` over `tags` via `bm25(memories_fts, w1, w2)`) stays at defaults for this step — see OQ-1.

---

### WI-2 — Surface provenance in `related_memories` (P1)

**Answer to the filtering question:** makes the next recall **more trustworthy**.

**Description.** The metadata already stores provenance whenever a conclusion is persisted from a reasoning session (HT-4); it just needs to be read out and attached to the record returned by auto-recall. Recall turns from "a floating sentence" into "a conclusion with provenance" — and the agent can follow the trace (`reasoning_get_trace`) if verification is needed.

**Design.** Extend the `RelatedMemoryRecord` interface — note this interface is defined **locally in `src/tools/reasoning.ts:215`**, not in `src/types.ts`, so WI-2 does not touch `types.ts`. The returned record currently carries `id/type/importance/tags/snippet` (`src/tools/reasoning.ts:261-267`); add one optional field:

```ts
source?: {
  session_id: string;      // metadata.source_session_id
  session_title: string;   // metadata.session_title
  created_at: string;      // memories.created_at
}
```

`recallRelatedMemories` additionally SELECTs `m.metadata, m.created_at`, parses via the existing `parseJsonObject` (`src/utils.ts:22`); attach `source` only when the metadata has both `source_session_id` and `session_title`. Manually saved memories (not from a session) do not get this field — semantically correct.

**Functional requirements:**
- FR-2.1: A memory persisted from `reasoning_complete_session`, when auto-recalled, must carry `source` with all 3 fields above.
- FR-2.2: A memory with no provenance in its metadata → no `source` field (do not return a noisy empty `null`).
- FR-2.3: Update the `reasoning_start_session` description so agents know to read the `source` field and can trace back via `reasoning_get_trace(source.session_id)`.
- FR-2.4: Corrupt metadata (JSON parse failure) → skip silently, no error (leverages `parseJsonObject`, which already returns a safe `null`).

**Acceptance criteria:**
- AC-2.1: End-to-end flow: session A completes with `save_as_memory=true` → open session B with a related title → `related_memories[0].source.session_title` = A's title.
- AC-2.2: A memory created via plain `memory_save` → recall has no `source` field.

**Test plan:** add cases to the existing reasoning lifecycle tests; keep all existing assertions intact (this is an additive change).

**Files expected to change:** `src/tools/reasoning.ts` (both the `RelatedMemoryRecord:215` interface and `recallRelatedMemories`), `src/__tests__/*`. (No `src/types.ts` — the interface is local.) Effort: **S** (a couple of hours).

---

### WI-3 — Decouple usage feedback from the telemetry gate (P1 — small but foundational)

**Answer to the filtering question:** makes future recalls **more accurate in the long run** — without the "used" signal, the numerator of the value fraction can never be measured, and every later optimization decision is blind.

**Problem (HT-5).** `used_memory_ids` and `memory_record_usage_feedback` are **product signals** (first-party, serving the recall value loop itself), but they are written through the same path as **analytics telemetry** (opt-in, off by default). On a default install, the agent dutifully reports "this memory helped" and the server... throws it away with a warning line. This directly contradicts the philosophy "correct behavior must be the default behavior".

**Clarification needed before choosing a design:** telemetry here only ever writes to the `tool_usage_events` table inside the local SQLite file — there is no network. The reason it is opt-in is minimal footprint, not network privacy. Therefore recording *just the feedback portion* by default does not break the "local and private" promise; this must be stated clearly in the docs.

**Proposed design (minimal option — BOTH gates must be fixed, see HT-5 and HT-6):**

*Gate 1 — `recordToolUsageEvent` (`src/tools/telemetry.ts:89`):* allow writes when `operationType === "feedback"` regardless of `TELEMETRY_ENABLED`:

```ts
if (!TELEMETRY_ENABLED && event.operationType !== "feedback") return null;
```

*Gate 2 — `telemetryPersistenceEnabled()` inside `memory_record_usage_feedback` (`src/tools/memory.ts:1313`):* this is an **independent** gate that fixing Gate 1 does not touch. This tool must persist when telemetry is off (remove the telemetry-driven `recorded:false` branch, keep all other validation), update the `recorded`/warning outputs accordingly, and fix the tool description at `memory.ts:1230` (currently hard-coding "Requires MEMORY_TELEMETRY=on"). If this gate is skipped, `memory_record_usage_feedback` would still report `recorded:false` even though the wrapper already wrote the event to the table — the contradiction described in HT-6.

No new migration, no new table — feedback events stay in `tool_usage_events` with `operation_type='feedback'` as today; only the two gates change. The alternative (a dedicated `memory_feedback` table) is rejected: larger footprint with no added value at this stage.

**Functional requirements:**
- FR-3.1: **[Gate 1]** `reasoning_complete_session` with `used_memory_ids` records the feedback event when telemetry is off; the "Telemetry is disabled..." warning (`src/tools/reasoning.ts:1446-1448`) is removed.
- FR-3.2: **[Gate 2]** `memory_record_usage_feedback` persists feedback and returns `recorded:true` when telemetry is off (fix the `telemetryPersistenceEnabled()` gate at `src/tools/memory.ts:1313` + the tool description at `memory.ts:1230`). After the fix, there must be no code path that writes a feedback event while the tool reports `recorded:false`.
- FR-3.3: **[Limitation that must be stated — see §6]** Ungating feedback only restores the **numerator** (the count of `used` feedback); the `memory_usage_report`/`memory_adoption_report`/`memory_agent_scorecard` reports compute their **denominators** (`memory_recalled`, `memory_searched`, ...) from other tools' events, which remain telemetry-blocked when off. So WI-3 does **not** make those ratios measurable on a default install — it only makes the raw feedback count real. Audit the report messages so they do **not** imply "full funnels exist even when off"; state clearly in the output that ratios require `MEMORY_TELEMETRY=on`. Whether to extend the ungating to recall/search events: see OQ-4.
- FR-3.4: Update `GUIDELINES.md` (bump `Version:` + sync the assertions in `src/__tests__/reasoning-audit-tools.test.ts`, per the rule in `CLAUDE.md`) and the `README.md` telemetry section: clearly distinguish "usage feedback (always recorded, local)" from "usage telemetry (opt-in)".

**Acceptance criteria:**
- AC-3.1: With `MEMORY_TELEMETRY` unset: completing a session with `used_memory_ids=[X]` → the output field **`used_memory_feedback_recorded` = 1** (the exact field name at `src/tools/reasoning.ts:1460`), and the `warnings` array no longer contains the "Telemetry is disabled..." line.
- AC-3.2: With `MEMORY_TELEMETRY` unset: `memory_record_usage_feedback` returns `recorded:true` and writes one `operation_type='feedback'` row into `tool_usage_events`.
- AC-3.3: With `MEMORY_TELEMETRY` unset: all other events (search/save/reasoning start...) are still **not** recorded — the telemetry gate for the analytics portion stays intact.

**Files expected to change:** `src/tools/telemetry.ts` (gate 1), `src/tools/memory.ts` (gate 2 at `:1313`, tool description at `:1230`, report messages), `src/tools/reasoning.ts` (message), `GUIDELINES.md`, `README.md`, `CHANGELOG.md`, `src/__tests__/*`. Effort: **S→M** (two gates + a report-message audit; more than the initial estimate).

**Future enabler (recorded, not built in Wave 3):** once enough feedback accumulates, recall ranking could be boosted by used-count — this has been shaped into **WI-6 for v1.4.0**, unlocked only by the evidence gate. See §9. WI-3 is precisely the data-seeding step for that gate: without WI-3, six months from now there would still be no basis for any decision.

---

### WI-4 — Shorten time-to-first-value for new users (P2 — docs + 1 in-product nudge)

**Answer to the filtering question:** makes the **first** useful recall arrive **sooner** — the biggest threat is cold start: an empty store in week one → no "oh, it remembered" moment → uninstall before value accumulates.

**Three tasks, ordered by impact:**

1. **A demo visible before installing (README GIF/asciinema).** Two-scene script: *Session 1* — the agent finishes a debug task and closes the session with `save_as_memory=true`; *Session 2* (simulating the next day) — a related task opens and `related_memories` automatically surfaces the old conclusion with its provenance (dovetails with WI-2 — record the demo **after** WI-2 merges so provenance shows too). The value moment must be visible before installation.
2. **The AGENTS.md snippet as a real onboarding tool.** The snippet in the README must get the agent saving conclusions from the very first task (seeding the first recall). Audit the existing snippet: make sure it clearly instructs `save_as_memory=true` for durable conclusions and `used_memory_ids` when a memory helped.
3. **Empty-store nudge (in-product, one line).** When `reasoning_start_session` returns an empty `related_memories` **and** the total number of memories in the store is 0, append one sentence to the text response: *"No memories yet — when you complete this session, persist durable conclusions with save_as_memory=true so future sessions can recall them."* The strict condition (fully empty store) makes the nudge disappear permanently after the first memory — it never becomes noise (protecting the denominator).

**Acceptance criteria:**
- AC-4.1: README has a demo section with a GIF/recording showing the two-scene script. **[Partially DEFERRED — 2026-07-11]:** v1.3.0 ships with a two-scene text walkthrough in the README ("What it feels like"); the GIF/asciinema asset requires the owner to record a real terminal session (the agent cannot record one) — exactly as anticipated by R6 (the code release does not wait for the demo). Once recorded, replace/add it in the same section.
- AC-4.2: The nudge appears only when the store is empty; a test locks this behavior.

**Files expected to change:** `README.md` (+ asset), `src/tools/reasoning.ts` (nudge, ~5 lines), `src/__tests__/*`. Effort: **M** (mostly producing the demo).

---

### WI-5 — Align messaging across every channel (P3 — docs only)

**Description.** The README has already moved to the "it just remembers" positioning. Audit `docs/growth/registry-submissions.md` and every registry listing description: use the exact positioning line from §1, link the same demo GIF from WI-4; remove any remaining narrative that leads with "analytics/telemetry" as the main value. State the competitive differentiators in order: (1) auto-recall without being asked, (2) zero maintenance, (3) auditable reasoning traces — something competitors lack, (4) local & private (stronger now that telemetry is opt-in).

**Acceptance criteria:** AC-5.1: `registry-submissions.md` and the README use the same positioning line; no channel leads with analytics.

**Files expected to change:** `docs/growth/registry-submissions.md`, `README.md` (if drifted). Effort: **XS**.

---

## 5. Implementation order

```
Wave 3.1 — code, bundled into release v1.3.0:
  WI-3 (ungate feedback)  →  WI-1 (BM25 ranking)  →  WI-2 (provenance)
Wave 3.2 — docs/growth, immediately after 3.1 merges:
  WI-4 (demo + nudge)     →  WI-5 (messaging sync)
Wave 4 — v1.4.0, NO schedule commitment:
  WI-6 (feedback-weighted ranking) — starts only when the §9.3 evidence gate opens,
  after v1.3.0 is published and users' memory stores have grown through real use
```

Rationale for the order: WI-3 goes first because it is the precondition for *measuring* the impact of WI-1/WI-2 later (without the "used" signal, every claimed recall improvement is a feeling). WI-1 before WI-2 because both touch `recallRelatedMemories` — finish the ranking, then extend the record, to reduce conflicts. WI-4 records the demo last so the demo can show off provenance too. One commit/PR per WI, small diffs, per repo rules.

---

## 6. Success metrics

**Important measurability caveat (revised per review):** the reports (`memory_usage_report`/`memory_adoption_report`/`memory_agent_scorecard`) aggregate over the `tool_usage_events` table. WI-3 only ungates **feedback events** — every other event (auto-recall, search, save, reasoning) is still telemetry-blocked when off. Therefore the **denominator** of most metrics below (memories recalled, search counts) is **not** recorded on a default install. Two groups must be kept distinct:

### 6.1. Measurable on a default install (`MEMORY_TELEMETRY` off) — thanks to WI-3 alone

| Metric | Definition | Expectation after Wave 3 |
|---|---|---|
| Raw used-feedback count | rows with `operation_type='feedback'`, `usefulness='used'` in `tool_usage_events` | > 0 within the first week of real use (evidence the feedback loop is alive again) |
| Messaging consistency | release channels use the same positioning line | Pass/fail (WI-5) |

### 6.2. Requires `MEMORY_TELEMETRY=on` (because the denominator comes from recall/search events)

| Metric | Definition | Dependency |
|---|---|---|
| Used-recall ratio | `used` feedback count / memories auto-recalled | Requires the auto-recall event (`memory_recalled`, `src/tools/memory.ts:940`) — telemetry-gated |
| Recall coverage | % of opened sessions with non-empty `related_memories` | Requires the `reasoning_start_session` event with `related_memory_count` — telemetry-gated |
| Time-to-first-used | days from the first memory record to the first `used` feedback | **No tool computes this yet** — needs new report logic; the base data also needs telemetry. Treat as a future item, not a ready metric |

**Consequence (OQ-4 — resolved, see §11 and §9.1):** the boundary stays as framed by "learning signal ≠ diagnostics" — do not extend the ungating to auto-recall/search events in Wave 3. Only §6.1 counts as mandatory AC; §6.2 is validated via end-to-end test scenarios (run with telemetry on in CI), not via default-install data.

---

## 7. Risks and mitigations

| # | Risk | Level | Mitigation |
|---|---|---|---|
| R1 | WI-1 changes recall ordering → existing tests locking importance-first ordering will fail | High (certain to happen) | This is an intentional behavior change: update tests in the same commit, note it clearly in `CHANGELOG.md` |
| R2 | BM25 on OR-queries: long titles produce many terms; common terms ("fix", "the") dilute the rank | Medium | BM25 inherently penalizes common terms (IDF); keep limit 3 + importance tie-break. If still noisy: consider column weights (OQ-1) before thinking about stopwords |
| R3 | The FTS5 `rank` column in `node:sqlite` may differ across Node versions | Low `[UNVERIFIED]` | FTS5 is already in use in the repo; write relevance tests that run in CI to self-verify on supported Node versions |
| R4 | WI-3 gets misread as "silently re-enabling telemetry" | Medium (perception) | FR-3.4: docs clearly separate feedback (local, serving the user's own ranking/reports) from telemetry (opt-in); emphasize neither involves the network |
| R5 | Scope creep — usage-based ranking boost, stopwords, decay... "while we're at it" | Medium | §8 is an explicit blocklist; one PR per WI, minimal diffs |
| R6 | The demo GIF (WI-4) costs more effort than expected and delays the whole wave | Low | Wave 3.2 is decoupled from 3.1 — the code release does not wait for the demo |

---

## 8. Considered but NOT doing (and why)

- **Semantic/vector search:** adds a heavy dependency, breaks the "one SQLite file, zero-config" promise. BM25 is good enough for stores of a few thousand records.
- **Used-count ranking boost (within Wave 3):** the right direction, but it needs accumulated feedback data first (WI-3 is exactly the seeding step); building it now means building on zero. → **Moved to candidate WI-6 for v1.4.0**, unlocked only by the evidence gate — see §9.
- **Memory decay/TTL for memories:** no evidence of store degradation yet; GUIDELINES already blocks junk input ("when in doubt, skip storage"). Do not repeat the 13-unused-tools lesson.
- **Stopword filtering for FTS:** wait and see whether BM25 (which already penalizes common terms) suffices.
- **Auto-recall for `memory_search`:** search is a deliberate action and already has ranking; no extra mechanism needed.
- **New ranking config (BM25 on/off):** two ranking modes = double the surface to test and explain, contrary to the correct-by-default philosophy.

---

## 9. Direction for v1.4.0 (Wave 4) — turning feedback into recall fuel, unlocked by evidence

> **Status: conditional candidate — NOT a committed backlog.** Wave 4 starts only after v1.3.0 has been published, users have accumulated real memory stores through use, and the evidence gate in §9.3 opens. If the gate does not open, the items here are cancelled or replaced by the cheaper path (fallback branch, §9.3) — that is not a failure; that is the spec working as designed.

### 9.1. Settled framing: learning signal ≠ diagnostics

Framing decision (settled together with OQ-4, 2026-07-11): data written to `tool_usage_events` is classified by **purpose of use**, not by write mechanism:

| Class | Includes | Policy | Rationale |
|---|---|---|---|
| **Learning signal** | usage feedback (`used`/`ignored`/`stale`/`unsafe`) | **Always recorded**, local, by default (WI-3) | It is fuel for recall — returns value directly to the user via better recall; not numbers for someone to read |
| **Diagnostics** | every other event (search/save/recall/reasoning, latency, error_code, version breakdown) | **Opt-in** `MEMORY_TELEMETRY=on`, unchanged | The owner's diagnostic instrument; user indifference to it is normal |

Practical consequence of this framing: **do not invest in making diagnostics "valuable to users"** — that is investment in the wrong place. User value flows through exactly one door: recall quality. The question "how do we get users to enable telemetry" is answered by **making them not need to** — the value-bearing part (feedback) is already always on.

### 9.2. WI-6 (candidate) — Feedback-weighted ranking

**The problem.** BM25 (WI-1) measures *textual match* — "is this memory about the right topic?". `used` feedback measures *proven usefulness* — "did this memory actually help in a similar task?". The two signals complement each other: combined, they yield a recall that **self-improves with use** — a static memory store becomes a learning memory. This is the step that upgrades the positioning from "it remembers" to "the more you use it, the better it remembers what matters".

**Design sketch** (details finalized only when the gate opens):
- `used_count` = number of events with `operation_type='feedback'`, `usefulness='used'` per `memory_id` in `tool_usage_events` (data that exists thanks to WI-3).
- `used_count` participates in ranking **after** BM25 — as a weighted tie-break or a **capped** boost, never replacing relevance.
- **Anti rich-get-richer (mandatory constraint):** the boost must be capped (e.g. worth at most one rank step) and blended with recency — a formerly "hot" memory must never permanently bury a newer, better-matching one.
- No new dependencies, no new config — same discipline as Wave 3.

**Three risks identified in adversarial review (kept in the spec as constraints — they are why the gate exists in §9.3):**
1. **The signal source depends on agent discipline.** `used_memory_ids` is an optional parameter the agent passes voluntarily — contradicting the "never bet on agent discipline" philosophy. Living proof: a working session fully compliant with GUIDELINES still produced 0 feedback events.
2. **Small stores neutralize the boost.** With a store of tens to hundreds of memories, `used_count` is mostly 0 → the criterion mostly just breaks ties; users feel no difference for months.
3. **Without an eval set, every tuning decision is guesswork.** One cannot claim "feedback-aware ranking beats pure BM25" without a query set + expected orderings to compare against — condition G-d below.

### 9.3. Evidence gate — unlock conditions for WI-6

Measured after **4–6 weeks** of real v1.3.0 use (all read from the local `tool_usage_events` — feasible on a default install thanks to WI-3):

| # | Condition | Threshold | Meaning |
|---|---|---|---|
| G-a | Cumulative `used` events | ≥ 20–30 | Minimum fuel for the flywheel |
| G-b | Memories with `used_count ≥ 2` | ≥ 5 | Genuinely repeated signal, not one-off noise |
| G-c | Concrete complaints/reports about recall quality persist despite BM25 (WI-1) running | Concrete evidence exists | The problem still exists after the cheap solution was tried |
| G-d | A small eval suite (≥ 10 queries + expected orderings) written **before** any weight tuning | Mandatory | No measuring stick, no tuning allowed |

**All four conditions met → open WI-6.** Any condition missing → do not build.

**Fallback branch — and the branch expected to happen:** if **G-a fails** (the most likely outcome, see risk 1 in §9.2), the real problem is the *feedback capture rate*, not ranking. The replacement item is then **WI-6b — fix the guidance**: update `GUIDELINES.md` and the AGENTS snippet in the README so agents remember to pass `used_memory_ids` at session close (with the version bump + test sync per repo rules). It costs about one percent of WI-6 and fixes the actual bottleneck. Only if G-a still fails after WI-6b has run for another 4–6-week cycle can one conclude the flywheel is not viable for this product.

### 9.4. WI-7 (further-out candidate) — Evidence-based store cleanup

Idea: a memory recalled many times but always `ignored` or marked `stale` → a clear deletion candidate, replacing guesswork. Right direction, **but with an identified hidden gap**: knowing "recalled often but never used" requires recording recall events (the denominator) — which sits on the **diagnostics** side of the boundary (opt-in) per the §9.1 framing. That means WI-7 forces an explicit reopening of the OQ-4 boundary decision. Therefore: no gate is attached to WI-7 in this revision; consider it only after WI-6 has actually run and a concrete store-cleanup need has been recorded.

### 9.5. Wave 4 still does NOT include

- Semantic/vector search, embeddings — as in §8, unchanged.
- Fully replacing BM25 with usage-based ranking — violates the anti rich-get-richer constraint (§9.2).
- Making diagnostics "appealing to users" — wrong value door (§9.1).

---

## 10. Done criteria for Wave 3 (v1.3.0)

- [ ] `npm run build` and `npm test` pass after every code WI (verification rule in `CLAUDE.md`).
- [ ] `GUIDELINES.md` version bumped + assertions in `src/__tests__/reasoning-audit-tools.test.ts` synced (mandatory for WI-3).
- [ ] `README.md`, `CHANGELOG.md` updated with the change — never leave docs one release behind.
- [ ] `MCP_VERSION` raised to `1.3.0` at the Wave 3.1 release.
- [ ] Every AC in §4 has a corresponding test or acceptance scenario.
- [ ] Git operations performed by the owner (per the repo's working convention).

## 11. Open questions

- **OQ-1:** Should BM25 weight the `content` column above `tags` (`bm25(memories_fts, 2.0, 1.0)`)? Proposal: keep defaults in v1.3.0; decide after relevance tests run on real data.
- **OQ-2:** Should the WI-4 nudge condition widen to "store < 3 memories" instead of "store empty"? Proposal: keep "empty" — the strictest condition, zero noise; loosen later if time-to-first-used data shows it is not enough.
- **OQ-3:** Should provenance be surfaced in the text summary of `memory_search` (metadata is already returned in structured content)? Proposal: not in Wave 3 — auto-recall is the most important touchpoint; avoid diff bloat.
- **OQ-4 [RESOLVED — 2026-07-11, owner]:** ~~Should WI-3 be extended to also ungate auto-recall/search events on the default install?~~ **Settled by the "learning signal ≠ diagnostics" framing (§9.1):** usage feedback is a learning signal — always recorded by default (exactly the current WI-3 scope); every other event is diagnostics — stays opt-in. No ungating extension in Wave 3; accept that §6.2 is only measurable with telemetry on. This boundary may only be reopened explicitly if WI-7 (§9.4) is considered in Wave 4.

---

## 12. Conclusion

Wave 3 adds no new features — it makes the existing promise **hold as users stay longer**: recall stays accurate as the store grows (WI-1), recall carries provenance so it can be trusted (WI-2), **the `used` feedback loop is recorded on the default install** instead of being discarded (WI-3 — though the full value-measurement ratios still require telemetry, see §6 and OQ-4), and new users touch value before they can leave (WI-4, WI-5). All of it sits within the settled philosophy: no new dependencies, no new config, correct behavior is the default behavior.

**Proposed next step:** owner reviews the spec → resolve OQ-1..3 (OQ-4 was resolved in revision 0.3) → execute Wave 3.1 in the §5 order, one PR per WI. **Wave 4 (v1.4.0) is not on the execution backlog** — it is activated only by the §9.3 evidence gate, measured 4–6 weeks after v1.3.0 is published and users have accumulated memory stores through real use.

---

## 13. Revision history

### 0.3 — 2026-07-11 (added the v1.4.0 / Wave 4 direction)

- **Resolved OQ-4** via the "learning signal vs diagnostics" framing (§9.1): usage feedback is always recorded by default (WI-3); all diagnostics events stay opt-in; no ungating extension in Wave 3.
- **Added §9 — Direction for v1.4.0 (Wave 4):** WI-6 (feedback-weighted ranking) enters the spec as a **conditional** candidate, unlocked only when the §9.3 evidence gate meets all 4 conditions G-a..G-d after 4–6 weeks of real v1.3.0 use; includes the fallback branch WI-6b (fix the guidance to raise the capture rate — ~100× cheaper than the ranker), which is the branch expected to happen. WI-7 (evidence-based store cleanup) recorded as a further-out candidate, blocked by the diagnostics boundary.
- The WI-6 idea went through one round of **adversarial review** before entering the spec; the three risks found (capture depends on agent discipline — with living proof of a GUIDELINES-compliant session producing 0 feedback events; small stores keep the boost from changing order; no eval suite to validate tuning) are kept in §9.2 as design constraints and as the reason the gate exists.
- §8: the "used-count ranking boost" item moved from "not doing" to "v1.4.0 candidate behind the gate → §9".
- Renumbered: Done criteria → §10, Open questions → §11, Conclusion → §12, Revision history → §13.

### 0.2 — 2026-07-11 (revised after a code-verification review)

Revision 0.1 was reviewed against the actual code; the incorrect/unclear points were fixed:

- **[Critical] WI-3 missed the second telemetry gate.** Added HT-6: `memory_record_usage_feedback` has an independent `telemetryPersistenceEnabled()` gate (`src/tools/memory.ts:1313`) + a tool description hard-coding "Requires MEMORY_TELEMETRY=on" (`:1230`). The WI-3 design now requires fixing **both** gates; FR-3.2 and the file list updated accordingly.
- **[Critical] §6 contradicted the telemetry non-goal.** Rewrote §6 to separate "measurable on a default install" (raw feedback count only) from "requires telemetry on" (ratios needing recall/search denominators — still gated). Added OQ-4 for the decision on extending the ungating. FR-3.3 and §11 revised for honesty.
- **[Minor] AC-3.1 had the wrong field name:** `usage_feedback_recorded` → `used_memory_feedback_recorded` (`src/tools/reasoning.ts:1460`).
- **[Minor] WI-2 listed the wrong file:** removed `src/types.ts` — `RelatedMemoryRecord` is a local interface at `src/tools/reasoning.ts:215`.
- **[Clarity] WI-1:** added the note that `memory_search` must keep `tagClause` when rewriting to JOIN-rank (`src/tools/memory.ts:349`).
- **[Clarity] AC-1.1:** added the note that BM25 does not absolutely guarantee "more matched words ⇒ higher rank" — the test needs a deliberately separated fixture.
- **[Clarity] Time-to-first-used:** marked as a future item (no tool computes it yet), not a ready metric.
