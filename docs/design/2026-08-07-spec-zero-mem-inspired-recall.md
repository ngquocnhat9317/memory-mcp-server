# SPEC — Zero-Mem-Inspired Recall Directions (Options A/B/C)

| Field | Value |
|---|---|
| Document version | 0.2 (Research draft — candidate directions only, not yet approved for build; became the single owner of the "blended scoring" work on 2026-08-07, see §6) |
| Date | 2026-08-07 |
| Relation to prior specs | Sibling to [2026-07-12-spec-v1.3.5-recall-refinements.md](./2026-07-12-spec-v1.3.5-recall-refinements.md) (retargeted to v1.4.0 — see that doc's §11 revision 0.5) and [2026-07-11-spec-mcp-value-improvement.md](./2026-07-11-spec-mcp-value-improvement.md) §9 (Wave 4, retargeted to v2.0.0 — see that doc's §13 revision 0.4) |
| Current MCP version | 1.3.2 (`src/constants.ts`) |
| Target MCP versions | Option A → v1.4.0 (bundled with the retargeted 1.3.5 work items). Options B and C → v2.0.0 candidates, gated the same way Wave 4's WI-6/WI-7 already are |
| Origin | External research trigger: arXiv 2607.29377, "Zero-Mem: Zero-Token Memory Operations for LLM Agents" (Hong Kong Polytechnic University et al., submitted 2026-07-31), found via a TikTok summary and researched in full during this session |
| Status | Research only. No code has been written. No owner approval has been given to build any of A/B/C yet — this document exists to make the direction decision explicit and reviewable, per the repo's evidence-first spec culture |

---

## 1. Context — what Zero-Mem is and why it's relevant here

Zero-Mem addresses a problem this repo already partially solves: LLM agents need memory to act consistently over long interactions, but most memory systems spend LLM calls (and tokens) *operating* that memory — generating summaries, mediating retrieval — which adds cost and can obscure the original evidence. Zero-Mem's answer is **zero-token memory operations**: no step outside the final answer invokes an LLM. It keeps raw interaction traces as the source of record and organizes them two ways:

- An **entity–context graph**: entities (extracted via non-generative NER) linked to the context units they appear in, with edge weight `w(d_i,e) = c(e,d_i) / Σc(e',d_i)` (frequency normalized per unit), plus adjacency edges between neighboring units.
- A **temporal hierarchy**: turn → window → episode → local span, preserving conversational locality and session boundaries.

At query time it fuses both views — `S_fuse = ρ·S_primary + (1−ρ)·S_secondary`, ρ=0.6 favoring the graph for relational queries — then applies deterministic (non-LLM) evidence calibration before the one LLM call that answers the question. On LoCoMo (GPT-4o-mini) it scores 59.15 F1 vs. Mem0's 45.10 and A-Mem's 39.65, and cuts memory-operation latency 57.6% vs. the fastest baseline compared, while consuming zero LLM tokens for memory operations.

**Why this matters for `memory-mcp-server` specifically:** this server's `memory_search`/`memory_list`/`memory_get` path (`src/tools/memory.ts:308-403`) is *already* zero-token by construction — it's pure SQL (FTS5 BM25) with no LLM call anywhere in the read path. The philosophical alignment is real. What's missing, compared to Zero-Mem's actual contribution, is the **second view**: today there is exactly one retrieval signal (lexical BM25 match), with `importance`/`updated_at` as a tie-break that HT-12a (in the 1.3.5 spec) already proved almost never fires on real data. There is no relational signal and no temporal-structure signal.

The official Zero-Mem code (`github.com/TheMoon0815/Zero-mem`) is not yet public — the authors state it will be released post peer-review. This spec is therefore built from the paper's stated formulas and architecture, not from reading their implementation. A community-built MCP server inspired by the same paper (`localmem`, github.com/dangchison/localmem) already exists and validates that the *shape* of this idea (SQLite + FTS5 + entity graph + recency, zero LLM calls on the read path) is implementable with the same minimal-dependency discipline this repo already follows.

---

## 2. The three candidate directions

### Option A — Recency/temporal-decay scoring

**What.** Replace the current dead tie-break (`ORDER BY f.rank ASC, m.importance DESC, m.updated_at DESC` in `memory_search`, `src/tools/memory.ts:370`) with a scoring formula that blends BM25 rank with a recency-decay term (e.g. exponential half-life, ~30 days, following `localmem`'s validated default) computed from `updated_at`. This is the "temporal" half of Zero-Mem's two-view idea, minus the four-level hierarchy — a single continuous decay term, not a structural turn/window/episode model.

**Why it's viable now, unlike the dropped WI-12.** The 1.3.5 spec's HT-12a killed a decay *tie-break* because it sits after the BM25 float criterion and effectively never fires. Option A is different in kind: it proposes decay as a **blended score component**, not a tie-break slot — exactly the distinction that same spec's §8 already flagged as the reason WI-12's underlying idea was deferred to "the blended-scoring work" rather than rejected outright. Option A *is* that deferred work, now scoped concretely.

**Footprint.** One file (`src/tools/memory.ts`), one query rewrite. No schema/migration change — `updated_at` already exists. Needs WI-11's eval base (already planned, see §3) to validate the change doesn't regress existing orderings, per this repo's own "no ranking change without measurement" discipline (G-d in the Wave 4 gate, same standard applied here).

#### Option A is the single owner of "blended scoring" (consolidated 2026-08-07)

Before this revision the same idea — *replace `memory_search`'s lexicographic
comparator with one blended score* — was owned by three documents under three
names, with the design constraints scattered across them. A 2026-08-07 spec
review (session `sess_3a7191e2`) found this and consolidated ownership **here**.
The other two sites now point at this section instead of specifying it:

| Prior owner | What it was called there | Status now |
|---|---|---|
| [2026-07-12-spec-recall-precision-workspace.md](./2026-07-12-spec-recall-precision-workspace.md) OQ-B | "a proper scoring mechanism is planned for v1.4.0 … a blended score would fold matched-terms, workspace, BM25, and possibly used-count into one formula" | Pointer only — constraint absorbed below as C-1 |
| [2026-07-12-spec-v1.3.5-recall-refinements.md](./2026-07-12-spec-v1.3.5-recall-refinements.md) §8 | "the blended-score work" that WI-12/WI-14 defer into | Pointer only — constraint absorbed below as C-2 |

**Inherited design constraints — these are binding on Option A, not optional
background.** Each was paid for by a prior review and would be expensive to
rediscover:

- **C-1 (from OQ-B, and originally the WI-1 lesson): raw relevance stays the
  top-weighted term.** Wave 3 shipped BM25 precisely because "high importance
  but off-topic" outranking a good match destroyed trust in recall. Any
  blended formula that lets recency, workspace, or usage outweigh relevance
  repeats that failure. Recency is a *modifier*, never the primary signal.
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
  page, which is wrong. See OQ-4 in §5.

**Sequencing conflict with WI-6 — must be resolved before either is built.**
Wave 4's WI-6 (feedback-weighted ranking, now targeted at v2.0.0) writes into
this same comparator, and its design sketch in
[2026-07-11-spec-mcp-value-improvement.md](./2026-07-11-spec-mcp-value-improvement.md)
§9.2 is written against the *current* lexicographic ordering ("`used_count`
participates in ranking **after** BM25 — as a weighted tie-break or a capped
boost"). If Option A lands at v1.4.0 and replaces that ordering with a blended
formula, WI-6's sketch describes a structure that no longer exists — and note
that "weighted tie-break" is precisely the C-2 anti-pattern. **Recommendation:
when Option A is designed in detail, re-express WI-6's `used_count` as a
prospective weighted term in the same formula rather than a separate later
mechanism.** The anti-rich-get-richer cap that §9.2 makes mandatory carries
over unchanged and must survive the translation.

### Option B — Entity-context graph (dual-view fusion)

**What.** Add a lightweight relational signal alongside BM25: a new table (e.g. `memory_entities`) populated by regex/dictionary-based extraction (not spaCy — keeping the zero-new-heavy-dependency discipline `localmem` and this repo both follow) at `memory_save` time. At query time, compute a second score from entity overlap between the query and candidate memories, then fuse with the BM25 score using Zero-Mem's own formula: min-max normalize each view, `S_fuse = ρ·S_primary + (1−ρ)·S_secondary`.

**Why it's the highest-value option.** This is Zero-Mem's actual core contribution — the ability to surface a memory that's *relationally* relevant (shares an entity/topic) even when it doesn't share query vocabulary, which pure BM25 structurally cannot do. It's also the option this repo has the least amount of existing infrastructure for, so it needs new schema and new write-path work — see §4 for the footprint honesty.

### Option C — Full temporal hierarchy (turn/window/episode/local-span)

**What.** The four-level structure from the paper, requiring a redefinition of how `memories` relates to `reasoning_steps`/sessions to group content into turns → windows → episodes.

**Why it's not being scoped further here.** This repo's data model is "flat durable memories + per-task reasoning sessions," not a continuous multi-turn conversation log the way Zero-Mem's benchmark domains (LoCoMo, HotpotQA) are. Building a 4-tier hierarchy for a workload that doesn't naturally have turns/windows/episodes risks exactly the failure mode this repo's specs have repeatedly guarded against (see the 1.3.5 spec §8's rejection list, and Wave 3's "no schema change without evidence" discipline): infrastructure built ahead of demonstrated need. Option C stays a named, tracked idea — not a scoped work item — until real usage data shows the flat model is actually the bottleneck.

---

## 3. Value / effort / risk comparison

| Option | Nội dung | Ảnh hưởng / giá trị | Khối lượng xử lý | Cost / rủi ro |
|---|---|---|---|---|
| **A — Recency/temporal scoring** | Blend a recency-decay term into `memory_search`'s ranking formula, replacing the dead `updated_at` tie-break. No schema change. | **Trung bình.** Fixes a proven-dead code path (HT-12a) with a real scoring mechanism; improves recall for active/evolving topics. Does not address relational recall gaps. | **Thấp.** 1 file, 1 query rewrite. Needs WI-11's eval base (already planned) to validate before/after. | **Thấp.** Main risk is picking a badly-tuned half-life constant; fully reversible, no schema to roll back. |
| **B — Entity-context graph** | New table + extraction at save time + dual-view fusion at search time, per Zero-Mem's own formula. | **Cao.** Directly targets the biggest real gap: relational recall independent of shared vocabulary. This is the paper's actual contribution, not a peripheral tweak. | **Trung bình–Cao.** New migration, changes to `memory_save`/`memory_search`/`memory_update`/`memory_delete` (entity sync on edit/delete), new tests, doc sync across `docs/architecture.md`/`README.md`. | **Trung bình.** Regex/dictionary extraction is weaker than the paper's NER — expect some miss/false-positive rate; adds write-path cost and DB surface area. Needs its own eval-base comparison (extends WI-11) before/after to prove it's worth the complexity, not assumed. |
| **C — Full temporal hierarchy** | 4-tier turn/window/episode/local-span structure, requires redesigning `memories` ↔ `reasoning_steps` relationships. | **Không rõ / có thể thấp** for this repo's actual workload (flat durable facts + per-task traces, not continuous multi-turn dialogue). | **Cao.** Multiple migrations, redesigned data model, high blast radius across most of `src/tools/`. | **Cao.** Speculative infrastructure without demonstrated need; directly against this repo's own "no schema change without evidence" precedent (Wave 3, 1.3.5 §8). Not scoped as a work item in this document for that reason. |

---

## 4. Recommendation and gating

- **Option A** is small enough, and directly continues a decision this repo's own specs already made (the deferred WI-12 idea), to bundle into **v1.4.0** alongside the retargeted 1.3.5 work items (WI-10, WI-11, WI-13, WI-15 — see roadmap). It should build on WI-11's eval base, not skip it.
- **Option B** should become a **v2.0.0 candidate**, gated the same way Wave 4's WI-6 already is — not started speculatively. Proposed gate conditions (mirroring the Wave 4 gate's evidence-first shape in [2026-07-11-spec-mcp-value-improvement.md](./2026-07-11-spec-mcp-value-improvement.md) §9.3):
  - G-e: WI-11's eval base (extended with relational-recall cases) exists and can measure a fusion change before/after.
  - G-f: Concrete evidence (from real `memory_search` usage, once the manual CRUD surface is actually used — see the 1.3.5 spec §8.1 monitoring note) that BM25-only recall misses relationally-related memories in practice, not just in theory.
  - Both conditions unmet today — this is why B is a v2.0.0 candidate, not a committed v1.4.0 item.
- **Option C** stays a named idea, not a gated candidate — no version target, revisit only if real usage data shows the flat data model itself (not just the ranking formula) is the limiting factor.

This mirrors the existing Wave 4 pattern exactly: cheap, low-risk ranking work (Option A, like the eval base and duplicate hint before it) ships close to now; expensive, structurally invasive work (Option B, like WI-6's feedback-weighted ranking) waits for evidence; speculative work with no demonstrated need (Option C) doesn't get a target version at all.

---

## 5. Open questions

- **OQ-1:** Should Option A's half-life constant be hardcoded (matching this repo's "no new config" discipline reaffirmed in the 1.3.5 spec) or exposed as an env var? Leaning hardcoded, pending owner decision.
- **OQ-2:** Should Option B's entity extraction be regex/dictionary-based (zero new dependencies, weaker recall) or allow one small NLP dependency (better recall, breaks the zero-dependency discipline every prior spec in this repo has held to)? This needs an explicit owner decision before B is scoped further — it is the single biggest design fork in this document.
- **OQ-3:** Does G-f's evidence requirement need `MEMORY_TELEMETRY=on` data, or can it be satisfied from usage-feedback data alone (always recorded, per §7 of `docs/architecture.md`)? Affects how soon the gate can realistically open.
- **OQ-4 (added 2026-08-07, blocking):** How does a blended score stay correct under `LIMIT`/`OFFSET` pagination? Constraint C-2 requires the recency term to participate in every comparison, but `memory_search` paginates — computing the blend in JS after the SQL `LIMIT` would reorder only the current page, producing results that change depending on how they were paged. Either the blend is expressed in SQL so `ORDER BY` sees it, or pagination semantics change. This is the unanswered half of the v1.3.5 spec §8's "doubly out" objection and **must be resolved before Option A is coded**, not during.
- **OQ-5 (added 2026-08-07):** Should WI-6's `used_count` be folded into Option A's formula as a prospective weighted term (see the sequencing note in §2), rather than left as a separate v2.0.0 mechanism written against a comparator Option A will have replaced?

**Blocking map:** OQ-1 and OQ-4 block Option A from being coded (OQ-4 is the
hard one). OQ-2 and OQ-3 block Option B from being scoped further. OQ-5 is a
sequencing decision that should be made when Option A is designed in detail,
and does not block Option A's own implementation.

---

## 6. Revision history

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
