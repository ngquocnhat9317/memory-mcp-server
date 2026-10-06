# SPEC — Zero-Mem-Inspired Recall Directions (Options A/B/C)

| Field | Value |
|---|---|
| Document version | 0.6 (Single owner of the "blended scoring" work since 2026-08-07. Option A ships in full in 1.3.3: the auto-recall slice and the `memory_search` slice (retargeted as A′ on live evidence). B and C remain research-only candidates — see §6 and §7) |
| Date | 2026-08-07 (rev 0.4–0.6: 2026-10-05) |
| Relation to prior specs | Sibling to `2026-07-12-spec-v1.3.5-recall-refinements.md` (removed 2026-10-06 — superseded by [2026-10-06-spec-v1.4.0-tool-surface-reduction.md](./2026-10-06-spec-v1.4.0-tool-surface-reduction.md); its WI-10, WI-13 and WI-15 were dropped on 2026-10-05; full text in git history) (retargeted to v1.4.0 — see that doc's §11 revision 0.5) and [2026-07-11-spec-mcp-value-improvement.md](./2026-07-11-spec-mcp-value-improvement.md) §9 (Wave 4, retargeted to v2.0.0 — see that doc's §13 revision 0.4) |
| Current MCP version | 1.3.3 (`src/constants.ts`) |
| Target MCP versions | Option A (auto-recall slice and A′) and its eval base WI-11 → 1.3.3 (A′ and WI-11 pulled forward from v1.4.0 by the owner on 2026-10-05). Options B and C → v2.0.0 candidates, gated the same way Wave 4's WI-6/WI-7 already are |
| Origin | External research trigger: arXiv 2607.29377, "Zero-Mem: Zero-Token Memory Operations for LLM Agents" (Hong Kong Polytechnic University et al., submitted 2026-07-31), found via a TikTok summary and researched in full during this session |
| Status | Option A is built and ships in 1.3.3: the auto-recall slice under its own spec ([2026-10-05-spec-recall-workspace-identity.md](./2026-10-05-spec-recall-workspace-identity.md)), and the `memory_search` slice (A′) approved by the owner on 2026-10-05 (OQ-4, OQ-6). Options B and C remain research only — no owner approval to build them; this document keeps that direction decision explicit and reviewable, per the repo's evidence-first spec culture |

---

## 1. Context — what Zero-Mem is and why it's relevant here

Zero-Mem addresses a problem this repo already partially solves: LLM agents need memory to act consistently over long interactions, but most memory systems spend LLM calls (and tokens) *operating* that memory — generating summaries, mediating retrieval — which adds cost and can obscure the original evidence. Zero-Mem's answer is **zero-token memory operations**: no step outside the final answer invokes an LLM. It keeps raw interaction traces as the source of record and organizes them two ways:

- An **entity–context graph**: entities (extracted via non-generative NER) linked to the context units they appear in, with edge weight `w(d_i,e) = c(e,d_i) / Σc(e',d_i)` (frequency normalized per unit), plus adjacency edges between neighboring units.
- A **temporal hierarchy**: turn → window → episode → local span, preserving conversational locality and session boundaries.

At query time it fuses both views — `S_fuse = ρ·S_primary + (1−ρ)·S_secondary`, ρ=0.6 favoring the graph for relational queries — then applies deterministic (non-LLM) evidence calibration before the one LLM call that answers the question. On LoCoMo (GPT-4o-mini) it scores 59.15 F1 vs. Mem0's 45.10 and A-Mem's 39.65, and cuts memory-operation latency 57.6% vs. the fastest baseline compared, while consuming zero LLM tokens for memory operations.

**Why this matters for `memory-mcp-server` specifically:** this server's `memory_search`/`memory_list`/`memory_get` path (`src/tools/memory.ts:308-403`) is *already* zero-token by construction — it's pure SQL (FTS5 BM25) with no LLM call anywhere in the read path. The philosophical alignment is real. What's missing, compared to Zero-Mem's actual contribution, is the **second view**: today there is exactly one retrieval signal (lexical BM25 match), with `importance`/`updated_at` as a tie-break that HT-12a (in the 1.3.5 spec) already proved almost never fires on real data. There is no relational signal and no temporal-structure signal.

> **Rev 0.4 update (2026-10-05):** the paragraph above describes `develop` as of 2026-08-07. Since 1.3.3, auto-recall (`recallRelatedMemories` in `src/tools/reasoning.ts`) ranks by a blended score — term coverage 0.45, normalized BM25 0.20, workspace 0.30, recency 0.05 with `recency = 1 / (1 + age_days / RECALL_RECENCY_DAYS)`, `RECALL_RECENCY_DAYS = 60`. The single-signal description now holds only for `memory_search`. Live evidence in §6 also shows that `memory_search`'s biggest problem is not its ordering at all but its implicit-AND match semantics.

The official Zero-Mem code (`github.com/TheMoon0815/Zero-mem`) is not yet public — the authors state it will be released post peer-review. This spec is therefore built from the paper's stated formulas and architecture, not from reading their implementation. A community-built MCP server inspired by the same paper (`localmem`, github.com/dangchison/localmem) already exists and validates that the *shape* of this idea (SQLite + FTS5 + entity graph + recency, zero LLM calls on the read path) is implementable with the same minimal-dependency discipline this repo already follows.

---

## 2. The three candidate directions

### Option A — Recency/temporal-decay scoring

**What.** Replace the current dead tie-break (`ORDER BY f.rank ASC, m.importance DESC, m.updated_at DESC` in `memory_search`, `src/tools/memory.ts:370`) with a scoring formula that blends BM25 rank with a recency-decay term (e.g. exponential half-life, ~30 days, following `localmem`'s validated default) computed from `updated_at`. This is the "temporal" half of Zero-Mem's two-view idea, minus the four-level hierarchy — a single continuous decay term, not a structural turn/window/episode model.

**Why it's viable now, unlike the dropped WI-12.** The 1.3.5 spec's HT-12a killed a decay *tie-break* because it sits after the BM25 float criterion and effectively never fires. Option A is different in kind: it proposes decay as a **blended score component**, not a tie-break slot — exactly the distinction that same spec's §8 already flagged as the reason WI-12's underlying idea was deferred to "the blended-scoring work" rather than rejected outright. Option A *is* that deferred work, now scoped concretely.

**Footprint (corrected in rev 0.4).** The code change is concentrated in `src/tools/memory.ts` (the `memory_search` query) and possibly `src/utils.ts` (term preparation), with no schema/migration change — `updated_at` already exists. The *change set* is larger than "one file": the `memory_search` tool description ("ranked by relevance") must say what it ranks by, `src/__tests__/wave3-value-loop.test.ts` ("memory_search orders by relevance…") must be re-validated, and `CHANGELOG.md`, `README.md` and `docs/architecture.md` must be synced per the repo's Version-Sync Conventions — plus `GUIDELINES.md` (with its version bump and the `guide_version` test assertion) if agent-facing search advice changes. Needs WI-11's eval base (already planned, see §3) to validate the change doesn't regress existing orderings, per this repo's own "no ranking change without measurement" discipline (G-d in the Wave 4 gate, same standard applied here).

#### Status by slice (rev 0.4)

| Slice | Status | Where |
|---|---|---|
| Auto-recall (`related_memories`) | **Shipped in 1.3.3** — blended score incl. hyperbolic 60-day recency. Sidesteps C-3/OQ-4 because auto-recall does not paginate | [2026-10-05-spec-recall-workspace-identity.md](./2026-10-05-spec-recall-workspace-identity.md) §3.4 |
| `memory_search` — as originally written (recency term only) | **Not recommended.** Measured no-op on live data: top-1 and top-3 unchanged in 138/138 simulated queries even at 4× the shipped recency weight (§6.1) | — |
| `memory_search` — retargeted as **A′** (below) | **Ships in 1.3.3** (pulled forward from v1.4.0, owner 2026-10-05). OQ-4 decided (additive), OQ-6 accepted (owner, 2026-10-05) | this section |

#### A′ — `memory_search` slice, retargeted on live evidence

**What.** Bring `memory_search` onto the same model auto-recall already uses, computed in SQL:

1. **Match with OR, not implicit AND.** Today `toFtsQuery` (`src/utils.ts`) joins prefix terms with spaces, which FTS5 treats as AND. On live data that returns zero results for 43% of 2-term, 65% of 3-term and 82% of 5-term queries; 3 of the 5 real `memory_search` calls on record returned nothing (§6.2). OR matching plus a coverage floor fixes recall without flooding results.
2. **Rank by the shipped blended formula**, not a new one: coverage + normalized BM25 + recency, using the same `RECALL_RECENCY_DAYS` decay shape so the two recall surfaces cannot disagree. The workspace term is out of scope for A′ unless the owner asks for it — `memory_search` is an explicit query, and WI-15 (scope hygiene) of the 1.3.5 spec was dropped on 2026-10-05, so no work item owns it now.
3. **Compute it in `ORDER BY`** so `LIMIT/OFFSET` stays correct (resolves C-3/OQ-4; see the design choice in OQ-4).

**Why A′ instead of the original slice.** The original slice adds a signal that changes nothing users see (§6.1), which is exactly the C-2 failure in a different position. A′ changes something agents actually hit: whether a specific query returns anything at all.

**Decay shape — one curve, not two.** Rev 0.1–0.3 proposed an *exponential* half-life (~30 days, `localmem`'s default). 1.3.3 shipped a *hyperbolic* curve (`1 / (1 + age/60)`). A′ must reuse the shipped curve and constant; introducing a second curve on the second recall surface would make the two disagree on how "old" a memory is for no measured benefit.

**Compatibility.** Switching AND → OR is a behavior change for callers who relied on AND to narrow results. The coverage term puts all-terms matches first, so the AND result set remains the top of the OR result set; the difference is that a query no longer returns nothing when one term is absent. This must be stated in the tool description and `CHANGELOG.md`.

#### Option A is the single owner of "blended scoring" (consolidated 2026-08-07)

Before this revision the same idea — *replace `memory_search`'s lexicographic
comparator with one blended score* — was owned by three documents under three
names, with the design constraints scattered across them. A 2026-08-07 spec
review (session `sess_3a7191e2`) found this and consolidated ownership **here**.
The other two sites now point at this section instead of specifying it:

| Prior owner | What it was called there | Status now |
|---|---|---|
| [2026-07-12-spec-recall-precision-workspace.md](./2026-07-12-spec-recall-precision-workspace.md) OQ-B | "a proper scoring mechanism is planned for v1.4.0 … a blended score would fold matched-terms, workspace, BM25, and possibly used-count into one formula" | Pointer only — constraint absorbed below as C-1 |
| `2026-07-12-spec-v1.3.5-recall-refinements.md` (removed 2026-10-06 — superseded by [2026-10-06-spec-v1.4.0-tool-surface-reduction.md](./2026-10-06-spec-v1.4.0-tool-surface-reduction.md); its WI-10, WI-13 and WI-15 were dropped on 2026-10-05; full text in git history) §8 | "the blended-score work" that WI-12/WI-14 defer into | Pointer only — constraint absorbed below as C-2 |

**Inherited design constraints — these are binding on Option A, not optional
background.** Each was paid for by a prior review and would be expensive to
rediscover:

- **C-1 (from OQ-B, and originally the WI-1 lesson): raw relevance stays the
  top-weighted term.** Wave 3 shipped BM25 precisely because "high importance
  but off-topic" outranking a good match destroyed trust in recall. Any
  blended formula that lets recency, workspace, or usage outweigh relevance
  repeats that failure. Recency is a *modifier*, never the primary signal.
  **Interpretation as applied in 1.3.3 (rev 0.4):** the owner set auto-recall
  weights to relevance 0.65 (coverage 0.45 + BM25 0.20) vs workspace 0.30 vs
  recency 0.05. C-1 therefore means *relevance is the largest block of
  weight*, not *the single largest term*. A′ inherits this reading; without
  a workspace term, relevance carries ~0.93 of the weight.
- **C-2 (from HT-12a): do not place a new signal in a position that only
  executes on an exact BM25 tie.** That is what made WI-12 and WI-14
  unshippable — the branch never fires on real data, so the feature passes
  fixture tests while changing nothing. A blended score is only worth doing
  if the new term participates in *every* comparison.
- **C-3 (from the v1.3.5 non-goals): `memory_search` pagination correctness.**
  §8 of that spec notes decay ranking was "doubly out — blocked by
  `LIMIT`/`OFFSET` pagination correctness *and* by HT-12a's tie-break
  futility." C-2 answers the second half; **the pagination half is still
  unanswered** and must be resolved in Option A's own design before coding —
  a score computed in JS after a `LIMIT` query reorders only the current
  page, which is wrong. See OQ-4 in §5. **Rev 0.4: technically resolved** —
  the blend can be expressed in SQL; verified on `node:sqlite` (§6.3).

**Sequencing conflict with WI-6 — must be resolved before either is built.**
Wave 4's WI-6 (feedback-weighted ranking, now targeted at v2.0.0) writes into
this same comparator, and its design sketch in
[2026-07-11-spec-mcp-value-improvement.md](./2026-07-11-spec-mcp-value-improvement.md)
§9.2 is written against the *current* lexicographic ordering ("`used_count`
participates in ranking **after** BM25 — as a weighted tie-break or a capped
boost"). Option A (shipping in 1.3.3) replaces that ordering with a blended
formula, so WI-6's sketch describes a structure that no longer exists — and note
that "weighted tie-break" is precisely the C-2 anti-pattern. **Recommendation:
when Option A is designed in detail, re-express WI-6's `used_count` as a
prospective weighted term in the same formula rather than a separate later
mechanism.** The anti-rich-get-richer cap that §9.2 makes mandatory carries
over unchanged and must survive the translation.

### Option B — Entity-context graph (dual-view fusion)

**What.** Add a lightweight relational signal alongside BM25: a new table (e.g. `memory_entities`) populated by regex/dictionary-based extraction (not spaCy — keeping the zero-new-heavy-dependency discipline `localmem` and this repo both follow) at `memory_save` time. At query time, compute a second score from entity overlap between the query and candidate memories, then fuse with the BM25 score using Zero-Mem's own formula: min-max normalize each view, `S_fuse = ρ·S_primary + (1−ρ)·S_secondary`.

**Why it's the highest-value option.** This is Zero-Mem's actual core contribution — the ability to surface a memory that's *relationally* relevant (shares an entity/topic) even when it doesn't share query vocabulary, which pure BM25 structurally cannot do. It's also the option this repo has the least amount of existing infrastructure for, so it needs new schema and new write-path work — see §4 for the footprint honesty.

**B-lite — the baseline B must beat (added rev 0.4).** The repo already has a curated entity set: `tags`, which `GUIDELINES.md` and the `memory_save` description require to name topics (`sqlite`, `auth`, `perf`), not locations. FTS5 already indexes tags, so the "query → entity" half of Zero-Mem is partly covered by BM25 today. What BM25 cannot do is the *relational hop*: surfacing a memory that shares a tag with the top hits but shares no words with the query. B-lite adds only that hop at read time — take the top-k matches, collect their tags, and add a bounded, low-weight term for other memories carrying those tags. No migration, no extraction, no entity sync on `memory_update`/`memory_delete`. It is weaker than true entity extraction (it depends on tagging discipline, and tags are sparse), which is exactly why it is the right baseline: Option B's extra table, write-path cost and OQ-2 dependency are only justified if B measurably beats B-lite on the relational cases in the eval base (G-e).

### Option C — Full temporal hierarchy (turn/window/episode/local-span)

**What.** The four-level structure from the paper, requiring a redefinition of how `memories` relates to `reasoning_steps`/sessions to group content into turns → windows → episodes.

**Why it's not being scoped further here.** This repo's data model is "flat durable memories + per-task reasoning sessions," not a continuous multi-turn conversation log the way Zero-Mem's benchmark domains (LoCoMo, HotpotQA) are. Building a 4-tier hierarchy for a workload that doesn't naturally have turns/windows/episodes risks exactly the failure mode this repo's specs have repeatedly guarded against (see the 1.3.5 spec §8's rejection list, and Wave 3's "no schema change without evidence" discipline): infrastructure built ahead of demonstrated need. Option C stays a named, tracked idea — not a scoped work item — until real usage data shows the flat model is actually the bottleneck.

---

## 3. Value / effort / risk comparison

Column headings switched to English in rev 0.4 to match the rest of the document. Row A was split into what is shipped, what was measured as a no-op, and the retargeted A′.

| Option | Content | Impact / value | Effort | Cost / risk |
|---|---|---|---|---|
| **A — auto-recall slice** | Blended score incl. recency in `related_memories`. | Shipped in 1.3.3. | Done. | Done. |
| **A — `memory_search`, recency term only (as written in rev 0.1–0.3)** | Blend a recency-decay term into `memory_search`'s ranking, replacing the dead `updated_at` tie-break. | **Measured ~zero.** Top-1 and top-3 unchanged in 138/138 simulated queries on the live store, even at 4× the shipped recency weight (§6.1). | Low code, but full doc/test sync (see Option A footprint). | Low technical risk; the real risk is shipping a change that passes fixture tests while changing nothing — the C-2 failure in a new position. **Not recommended.** |
| **A′ — `memory_search` OR matching + shipped blended formula** | OR match with coverage floor; coverage + normalized BM25 + recency (shipped curve) in SQL `ORDER BY`. | **Medium–High** for `memory_search` callers. Removes zero-result queries (43–82% of 2–5-term queries today, §6.2) and aligns the two recall surfaces. Does not address relational gaps. | **Low–Medium.** `memory.ts` query + `utils.ts` term prep; tool description, test, `CHANGELOG`/`README`/`architecture` sync. Needs WI-11 first. | **Low–Medium.** AND→OR is an observable behavior change (more results); coverage ordering keeps AND matches on top. Reversible, no schema. |
| **B-lite — tag hop** | Read-time bonus for memories sharing tags with the top-k hits. | **Unknown, probably modest** — limited by tagging discipline. Its main job is to be the baseline B must beat. | **Low.** One query extension, no migration. | **Low.** Bounded low-weight term; may surface weakly related memories if tags are generic. |
| **B — Entity-context graph** | New table + extraction at save time + dual-view fusion at search time, per Zero-Mem's own formula. | **High in theory.** Targets relational recall independent of shared vocabulary — the paper's actual contribution. Real-world size of this gap in this repo is **unmeasured** (see G-f). | **Medium–High.** New migration, changes to `memory_save`/`memory_search`/`memory_update`/`memory_delete` (entity sync on edit/delete), new tests, doc sync across `docs/architecture.md`/`README.md`. | **Medium.** Regex/dictionary extraction is weaker than the paper's NER — expect some miss/false-positive rate; adds write-path cost and DB surface area. Must beat B-lite on the eval base, not just baseline BM25. |
| **C — Full temporal hierarchy** | 4-tier turn/window/episode/local-span structure, requires redesigning `memories` ↔ `reasoning_steps` relationships. | **Unclear / likely low** for this repo's actual workload (flat durable facts + per-task traces, not continuous multi-turn dialogue). | **High.** Multiple migrations, redesigned data model, high blast radius across most of `src/tools/`. | **High.** Speculative infrastructure without demonstrated need; directly against this repo's own "no schema change without evidence" precedent (Wave 3, 1.3.5 §8). Not scoped as a work item in this document for that reason. |

---

## 4. Recommendation and gating

- **Option A — auto-recall slice:** shipped in 1.3.3, nothing further.
- **Option A — `memory_search` slice:** build **A′**, not the recency-only version. *Rev 0.6: built on WI-11's eval base and shipping in 1.3.3 (originally planned for v1.4.0 alongside WI-10, WI-13, WI-15).* WI-11 includes the zero-result cases from §6.2 (multi-term queries where one term is absent) so A′'s main claim is measured, not assumed.
- **Option B** should become a **v2.0.0 candidate**, gated the same way Wave 4's WI-6 already is — not started speculatively. Gate conditions (mirroring the Wave 4 gate's evidence-first shape in [2026-07-11-spec-mcp-value-improvement.md](./2026-07-11-spec-mcp-value-improvement.md) §9.3):
  - G-e: WI-11's eval base (extended with relational-recall cases) exists and can measure a fusion change before/after — against **both** current BM25 and B-lite.
  - G-f (**redefined in rev 0.4** — the earlier wording could not be satisfied, see OQ-3): at least *N* recorded relational misses, where a miss is a memory the agent ended up using that shared no query term with the query that should have found it. Two acceptable sources: (a) relational cases added to the WI-11 eval base from real sessions, where the owner confirms the expected memory; (b) after A′ ships, `memory_record_usage_feedback` / `used_memory_ids` reports for memories that the preceding `memory_search` or auto-recall did not return. *N* is an owner decision; this spec suggests 5 distinct cases as a minimum, in line with the repo's "no decision on tiny samples" rule.
  - Both conditions unmet today — this is why B is a v2.0.0 candidate, not a committed v1.4.0 item.
- **B-lite** is not a committed work item. It is the cheapest relational experiment and should be tried on the eval base before B is scoped, because a positive or null result from B-lite directly informs whether B's cost is worth paying.
- **Option C** stays a named idea, not a gated candidate — no version target, revisit only if real usage data shows the flat data model itself (not just the ranking formula) is the limiting factor.

This mirrors the existing Wave 4 pattern: cheap, low-risk ranking work (A′, like the eval base and duplicate hint before it) ships close to now; expensive, structurally invasive work (Option B, like WI-6's feedback-weighted ranking) waits for evidence; speculative work with no demonstrated need (Option C) doesn't get a target version at all.

---

## 5. Open questions

- **OQ-1 (resolved in practice by 1.3.3):** ~~Should Option A's half-life constant be hardcoded or exposed as an env var?~~ 1.3.3 hardcoded `RECALL_RECENCY_DAYS = 60` in `src/tools/reasoning.ts`, consistent with the "no new config" discipline. A′ reuses that constant (moving it somewhere both tools can import is an implementation detail). Reopen only if the owner wants it configurable.
- **OQ-2:** Should Option B's entity extraction be regex/dictionary-based (zero new dependencies, weaker recall) or allow one small NLP dependency (better recall, breaks the zero-dependency discipline every prior spec in this repo has held to)? This needs an explicit owner decision before B is scoped further — it is the single biggest design fork in this document. *Rev 0.4: less urgent if B-lite (§2) is tried first; its result tells us whether any extraction is worth it.*
- **OQ-3 (reframed in rev 0.4):** The original question — telemetry data vs usage-feedback data for G-f — was the wrong question: **neither source records a miss.** A memory that recall failed to return leaves no trace in `tool_usage_events` or in feedback, whatever `MEMORY_TELEMETRY` is set to. G-f has been redefined (§4) around evidence that can actually be collected. Remaining question for the owner: the value of *N*, and whether to add an explicit feedback signal for "had to find this memory another way".
- **OQ-4 (rev 0.5: decided — additive, normalized; implemented):** How does a blended score stay correct under `LIMIT`/`OFFSET` pagination? Answer: express the blend in SQL so `ORDER BY` sees it. `node:sqlite` supports everything needed — `exp()`, `julianday()`, and window aggregates such as `MIN(f.rank) OVER ()` — verified in §6.3. Two shapes, owner picks one:
  - **Multiplicative:** `ORDER BY f.rank * (1.0 + w * recency)`. BM25 rank is negative, so multiplying by a factor ≥1 promotes newer memories; no normalization needed, and a small `w` keeps relevance dominant. Simplest, but cannot easily carry a coverage term.
  - **Additive, normalized (recommended for A′):** min-max normalize `f.rank` with `MIN/MAX(f.rank) OVER ()` across the full match set, then add coverage and recency with the shipped weights. Matches the auto-recall formula, so both surfaces behave alike.
  - Required acceptance criterion either way — **AC-A′-page:** for any query, concatenating pages of size *k* equals the first *n·k* rows of a single unpaged query (with a final `m.id` tie-break so the order is total).
- **OQ-5 (added 2026-08-07):** Should WI-6's `used_count` be folded into Option A's formula as a prospective weighted term (see the sequencing note in §2), rather than left as a separate v2.0.0 mechanism written against a comparator Option A will have replaced? *Rev 0.4: 1.3.3 showed the blended formula can take another bounded term without restructuring, so the recommendation is yes — as a capped term, carrying WI-6's anti-rich-get-richer cap.*
- **OQ-6 (rev 0.5: accepted by the owner, 2026-10-05):** Does the owner accept the AND → OR change to `memory_search` match semantics (A′ step 1)? It returns more results for multi-term queries and changes what existing callers see; coverage ordering keeps all-terms matches on top. Blocks A′.

**Blocking map (rev 0.5):** A′ is no longer blocked — WI-11's eval base is built,
OQ-6 was accepted and OQ-4 decided (additive) on 2026-10-05. OQ-2
and the G-f value of *N* (OQ-3) block Option B from being scoped further; B-lite
should run before either is decided. OQ-5 is a sequencing decision that does
not block A′.

---

## 6. Empirical evidence (rev 0.4, 2026-10-05)

**Setup.** A snapshot of the owner's live store (`sqlite3 .backup` of `~/.memory-mcp-server/memory.db`, so the WAL was included) taken 2026-10-05: 70 memories, 111 reasoning sessions; memories span 2026-07-16 → 2026-10-05 (81 days), 51/70 are older than 60 days, and only 5 have ever been edited (`updated_at <> created_at`). All experiments ran read-only against the copy.

**Caveats that apply to all of §6.** The store is small. Telemetry records query *shape* (term count, result count), not query text, so §6.1/§6.2 use **proxy queries** (tag values, and the leading significant words of real session titles), not real `memory_search` inputs. Session titles are partly what the memories were written from, which favors matching. Treat the numbers as direction, not precision; WI-11 is where they get re-measured properly.

### 6.1. Recency in `memory_search` changes nothing visible

138 proxy queries with ≥2 matches (median 3 matches, max 27). Each variant was compared with today's `ORDER BY f.rank, importance DESC, updated_at DESC`, with `recency = 1 / (1 + age_days / 60)` (the shipped curve):

| Variant | Top-1 changed | Top-3 set changed | Any order changed |
|---|---|---|---|
| Multiplicative, w = 0.05 | 0/138 | 0/138 | 6 |
| Multiplicative, w = 0.20 | 0/138 | 0/138 | 13 |
| Additive, 0.93 · bm25_norm + 0.07 · recency | 0/138 | 0/138 | 6 |

With a corpus this young and this rarely edited, recency hardly separates candidates. This holds today; it may change as the store ages, which is one reason A′ still carries the recency term (consistency with auto-recall) rather than dropping it.

### 6.2. Implicit AND makes multi-term queries return nothing

`toFtsQuery` emits `"t1"* "t2"* …`, which FTS5 evaluates as AND. Same proxy source (leading significant words of session titles), AND vs OR:

| Terms | AND → 0 results | OR → 0 results |
|---|---|---|
| 2 | 49/113 (43%) | 2/113 |
| 3 | 74/113 (65%) | 0/113 |
| 5 | 90/110 (82%) | 0/110 |

Real calls agree: of the 5 `memory_search` calls in `tool_usage_events` (2026-08-05 → 2026-09-09), the three with 2, 5 and 7 terms returned **0 results**; the two single-term calls returned 5 and 1. Low `memory_search` usage (see the 1.3.5 spec §8.1.1) *may* be partly caused by this — agents that get nothing back stop asking — but that causal link is **[UNVERIFIED]**.

### 6.3. The blend can live in SQL; pagination stays correct

On `node:sqlite` (Node 22.23.1): `exp(-1.0)`, `julianday('now')` and `MAX(x) OVER ()` all evaluate. For the additive variant above, with `m.id` as the final tie-break, concatenating pages of `LIMIT 2 OFFSET k` produced exactly the single-query order for **all** 138 queries.

### 6.4. Reproducing

```sql
-- Additive blend, computed where ORDER BY can see it (shape for A′; weights illustrative)
SELECT m.id
FROM memories m
JOIN (SELECT rowid, rank FROM memories_fts WHERE memories_fts MATCH ?) f
  ON m.rowid = f.rowid
ORDER BY
  0.93 * (MAX(f.rank) OVER () - f.rank)
       / NULLIF(MAX(f.rank) OVER () - MIN(f.rank) OVER (), 0)
  + 0.07 / (1 + (julianday('now') - julianday(m.updated_at)) / 60) DESC,
  m.importance DESC,
  m.id
LIMIT ? OFFSET ?;

-- Zero-result rate: count matches for the same terms joined by ' ' (AND) vs ' OR '
SELECT count(*) FROM memories_fts WHERE memories_fts MATCH ?;

-- Real memory_search shapes
SELECT json_extract(input_shape, '$.query_term_count')  AS terms,
       json_extract(output_shape, '$.result_count')     AS results
FROM tool_usage_events WHERE tool_name = 'memory_search';
```

Note: when every match has the same rank, `NULLIF` makes the normalized term `NULL`; A′'s implementation must map that to 1 (all-equal counts as best), as auto-recall already does.

---

## 7. Revision history

### 0.6 — 2026-10-05 (A′ and WI-11 pulled into 1.3.3)

- **Release target changed by the owner:** A′ and the WI-11 eval base ship in **1.3.3** together with the auto-recall slice, instead of v1.4.0. Header, slice table and §4 updated; roadmap moves both to Shipped.
- **Punctuation-only query tokens** (`-`, `–`, `/`) are dropped by `toSearchTerms` so they no longer count toward the coverage floor; eval case added.
- WI-6's sequencing note (§2) now refers to Option A as shipping in 1.3.3.

### 0.5 — 2026-10-05 (A′ implemented on branch)

- **Decisions (owner):** OQ-6 accepted (AND → OR); OQ-4 decided as the additive normalized blend, score = 0.45·coverage + 0.20·bm25_norm + 0.05·recency with no workspace term, computed in SQL `ORDER BY`; coverage floor = 3+ distinct terms need ≥ 2 matches, otherwise ≥ 1; no stopword filtering for `memory_search`; tie-break `importance DESC, updated_at DESC, id ASC`.
- **WI-11 case list adjusted** to match shipped 1.3.3 behavior: case 3 ("other workspace with more terms wins") and case 8 ("fallback lifeline") replaced by the cross-project gate and no-lifeline cases; cases 9/10 deferred together with WI-10/WI-13.
- Implemented on branch `feat/memory-search-blended-recall`, unreleased (v1.4.0): eval fixture and suite, shared constants, OR matching in `memory_search`.

### 0.4 — 2026-10-05 (live-evidence pass; `memory_search` slice retargeted)

From a deep research session (`sess_507362af`, memory `mem_a1ec99df`) run against a snapshot of the live store, in parallel with the unmerged `feat/recall-workspace-identity` (1.3.3) branch.

- **Measured the original `memory_search` slice as a no-op** (§6.1) and **found the real defect**: implicit-AND matching returns zero results for most multi-term queries (§6.2). Retargeted the slice as **A′** — OR matching + the shipped blended formula, computed in SQL.
- **OQ-4 technically resolved** (§6.3): SQL `ORDER BY` with window aggregates; added the AC-A′-page acceptance criterion and the multiplicative vs additive choice.
- **Synced with 1.3.3:** current version 1.3.3; recorded the shipped weights and the C-1 interpretation (relevance = largest block); one decay curve (shipped hyperbolic 60-day) instead of the earlier exponential 30-day proposal; OQ-1 resolved in practice.
- **Corrected Option A's footprint** to include tool description, test and doc sync.
- **Added B-lite** (tag hop) as the baseline Option B must beat, and **redefined G-f** so it can actually be met; reframed OQ-3 (no data source records a miss).
- **Added OQ-6** (owner acceptance of AND → OR) and rewrote the blocking map.
- Switched §3 column headings to English; the value/effort table now separates shipped, measured-no-op and retargeted slices.
- The Zero-Mem paper's figures (§1) were not re-verified in this pass; they remain as reported by the paper.

### 0.3 — 2026-10-05 (auto-recall slice of Option A shipped)

The auto-recall slice of Option A shipped in 1.3.3 — see [2026-10-05-spec-recall-workspace-identity.md](./2026-10-05-spec-recall-workspace-identity.md). It sidesteps OQ-4 because auto-recall does not paginate. The `memory_search` slice, OQ-4 and OQ-5 are unchanged and still open.

### 0.2 — 2026-08-07 (consolidated ownership of "blended scoring")

From the spec review in session `sess_3a7191e2` (memory `mem_c80ca0fe`), which
found the same future work owned by three documents under three names.

- **Option A is now the single owner** of the blended-scoring rewrite of
  `memory_search`. OQ-B in the recall-precision spec and §8 of the v1.3.5 spec
  are reduced to pointers.
- **Absorbed the inherited constraints** those documents held, as binding
  C-1 (relevance stays top-weighted — the WI-1 lesson), C-2 (no signal in a
  tie-break-only position — the HT-12a lesson), and C-3 (pagination
  correctness, still unresolved).
- **Recorded the sequencing conflict with WI-6**, whose §9.2 design sketch is
  written against the lexicographic comparator Option A would replace — and
  whose "weighted tie-break" phrasing is itself the C-2 anti-pattern.
- **Added OQ-4 (blocking)** — how a blended score stays correct under
  `LIMIT`/`OFFSET`, the unanswered half of the v1.3.5 spec's "doubly out"
  objection — and **OQ-5**, whether `used_count` should fold into Option A's
  formula rather than remain a separate v2.0.0 mechanism. Added a blocking map
  so it is clear which questions stop which option.

### 0.1 — 2026-08-07 (initial research draft)

- Created following a two-stage research pass (TikTok video summary → full paper read via arXiv HTML, plus the `localmem` community implementation) requested by the owner. Captures Options A/B/C as candidate directions with a value/effort/risk table, and proposes retargeting them into the existing v1.4.0/v2.0.0 roadmap slots rather than opening a new release track. No code written; no work items approved.
