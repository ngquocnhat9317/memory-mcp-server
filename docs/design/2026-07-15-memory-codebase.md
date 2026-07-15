# Design Spec — Codebase Memory (Codegraph): Structured Code Index for Recall

| Field | Value |
|---|---|
| Doc version | 0.2 (Draft — awaiting owner approval before coding; adds §11 value analysis and §12 optimization directions) |
| Date | 2026-07-15 |
| Status | Proposed / direction-setting — no product code in this change |
| Feature name | "memory codebase" → **Codegraph Memory** |
| Origin | Owner request: memory should store a codegraph of the system — what functions a file contains, where a function is defined (file:line), and where it is called (caller/callee) |
| Relation to existing surface | New tool family `codegraph_*`, sits alongside `memory_*` (free-text facts) and `reasoning_*` (investigation narrative) |

---

## 1. Background & motivation

The server today stores two kinds of knowledge, both as **free text**:

- `memory_*` — facts, preferences, decisions, reasoning summaries (`memories` table, `src/tools/memory.ts`).
- `reasoning_*` — investigation narrative as `thought`/`action`/`observation` (`reasoning_steps` table, `src/tools/reasoning.ts`).

Neither layer holds a **structured link to source code**: no file path, symbol, line range, or call relationship. A full-repo survey confirms there is **no** code ingestion / indexing / codegraph anywhere — no concept of files, symbols, chunks, or ASTs. Retrieval is entirely **SQLite FTS5 + BM25** (`memories_fts`, `src/migrations/0001_initial.ts:23-45`), no embeddings.

When an agent works in a large repo, the same questions cost many turns of searching:

- "What functions/classes does this file contain?"
- "Where is function `X` defined?" (file + line)
- "Where is `X` called?" (list of callers)
- "What does `X` call?" (callees)

Codegraph Memory stores these facts in a **structured, queryable** form so the agent recalls them directly instead of re-scanning the repo each time.

## 2. Goals / Non-goals

### Goals

- **G1** — "file → symbols": list functions/classes in a file with kind and line range.
- **G2** — "symbol → definition": name → definition site (`file:start_line-end_line`, signature).
- **G3** — "symbol → callers/callees": bidirectional call relationships, each with the `file:line` of the call.
- **G4** — Workspace scoping: the current repo's codegraph does not mix with another repo's.
- **G5** — Idempotent per-file re-index: recording one file replaces that file's prior data cleanly, no duplicates.
- **G6** — Zero new runtime dependency in the server: keep the repo discipline (only `@modelcontextprotocol/sdk` + `zod`).

### Non-goals (proposed — pending owner sign-off)

- **The server does not parse source code itself** at runtime. No tree-sitter / parser / AST embedded in the server process (would strain G6). Symbol/edge data is supplied by an **external producer**. See §6 and §12 for the producer question.
- **No embeddings / semantic search.** Retrieval is structured lookup + FTS5, consistent with every prior wave.
- **No cross-repo / global call graph across workspaces** in v1.
- **No change to `memory_*` / `reasoning_*`.** Codegraph is an independent tool family.

## 3. Data model (proposed)

Reuse the existing FTS5 external-content + trigger-sync template (`src/migrations/0001_initial.ts:23-45`, `src/migrations/0003_reasoning_steps_fts.ts`). New migration `0006_codegraph.ts`.

> **Note:** the columns below are the v1 baseline. §12 proposes additional provenance/freshness columns (`resolution`, `content_sha`, `index_commit`, `indexed_at`) that are **prerequisites** for the feature to be trustworthy — fold them in before coding if the owner takes the §12 direction.

### 3.1. `code_symbols`

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | `sym_<uuid>` (via `newId`) |
| `workspace` | TEXT NOT NULL | `getWorkspace()` at write time |
| `file_path` | TEXT NOT NULL | relative to workspace root |
| `symbol_name` | TEXT NOT NULL | function/class/… name |
| `symbol_kind` | TEXT NOT NULL | CHECK IN (`function`,`method`,`class`,`interface`,`type`,`variable`,`module`) |
| `signature` | TEXT | signature / declaration head, optional |
| `container` | TEXT | parent symbol (e.g. the class of a method), optional |
| `start_line` | INTEGER NOT NULL | 1-based |
| `end_line` | INTEGER NOT NULL | 1-based |
| `language` | TEXT | e.g. `typescript`, optional |
| `created_at` | TEXT NOT NULL | `nowIso()` |
| `updated_at` | TEXT NOT NULL | `nowIso()` |

Indexes: `(workspace, file_path)`, `(workspace, symbol_name)`, `(workspace, symbol_kind)`.

### 3.2. `code_edges`

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | `edge_<uuid>` |
| `workspace` | TEXT NOT NULL | as above |
| `caller_symbol_id` | TEXT NOT NULL | FK → `code_symbols(id)` ON DELETE CASCADE |
| `callee_symbol_id` | TEXT | FK → `code_symbols(id)`; NULL if unresolved (callee outside repo or not yet indexed) |
| `callee_name` | TEXT NOT NULL | callee name as text — always stored so it can be re-resolved later |
| `edge_kind` | TEXT NOT NULL | CHECK IN (`calls`,`imports`,`references`,`extends`,`implements`) |
| `file_path` | TEXT NOT NULL | where the call occurs |
| `line` | INTEGER NOT NULL | line of the call |
| `created_at` | TEXT NOT NULL | `nowIso()` |

Indexes: `(caller_symbol_id)`, `(callee_symbol_id)`, `(workspace, callee_name)`.

### 3.3. `code_symbols_fts`

FTS5 external-content over `symbol_name` + `signature` + `file_path`, `content='code_symbols'`, `content_rowid='rowid'`; three triggers (AI/AD/AU) syncing as in `0003`, plus a `('rebuild')` backfill on creation. Used for fuzzy name/signature lookup (`codegraph_search`). Sanitize queries with `toFtsQuery` (`src/utils.ts:34-69`).

## 4. Tool surface (`codegraph_*` family)

Registered via `registerCodegraphTools(server, database?)` in `src/server.ts` next to `registerMemoryTools`, each handler wrapped in `withTelemetry` (add a new `operation_type` for codegraph to the CHECK on `tool_usage_events`, or reuse a fitting label — decide when coding).

| Tool | Access | Description |
|---|---|---|
| `codegraph_record` | write | Batch upsert symbols + edges for **one file**; clears that `file_path`'s prior symbols/edges before writing (idempotent re-index). |
| `codegraph_file_symbols` | read | `file_path` → list of symbols + kind + line range. (G1) |
| `codegraph_find_symbol` | read | `symbol_name` → definition site (`file:line`, signature, container). (G2) |
| `codegraph_find_references` / `codegraph_callers` | read | symbol → edges where it is callee → callers with `file:line`. (G3 — "where is it called") |
| `codegraph_callees` | read | symbol → what it calls. (G3 — reverse direction) |
| `codegraph_search` | read | FTS over name/signature, BM25-ranked (per `src/tools/memory.ts:363-378`). |

Input schemas live in `src/schemas/codegraph.ts`, using `.strict()` consistent with `src/schemas/memory.ts`.

> **Surface will likely shrink — see §11/§12.** From an agent-consumer standpoint, `find_symbol`/`file_symbols`/`callees`/`search` largely duplicate `grep`/`Read`/LSP and lose to them (those are ground-truth on the current file; the codegraph copy can be stale). The differentiated value is the **resolved, coverage-aware reference graph**. §12 recommends collapsing the surface toward `codegraph_references` (resolved + coverage + freshness), `codegraph_impact` (transitive callers), and `codegraph_map` (ranked, token-budgeted). Treat the six tools above as the naive baseline, not the final surface.

## 5. Workspace scoping

Unlike `memory_*` — where workspace is a **soft ranking signal** (tie-break, never a hard filter; `src/tools/reasoning.ts:250-325`) — codegraph should use a **hard workspace filter**: every `codegraph_*` query returns only symbols/edges with `workspace = getWorkspace()`. Rationale: another repo's call graph is pure noise with no cross-project recall value. Reuse `getWorkspace()` (`src/constants.ts:49-51`).

## 6. Data source — primary open question

Who populates the codegraph?

- **(a) The agent analyzes code and calls `codegraph_record`.** Server is pure storage, language-agnostic, zero dependency. The naive v1 assumption.
- **(b) Add a CLI subcommand indexer** (like `install-agents` in `src/index.ts`) that scans the repo and populates. Stronger but needs a parser → new dependency, against repo discipline.

The naive spec leaned toward (a) for v1. **§12 argues (a) is the feature's core weakness** — LLM-produced edges are untrustworthy — and that a deterministic producer (tree-sitter / SCIP, run out-of-process) is a prerequisite, not an optional extension. Resolve this before coding (see §12 and §10 Q5).

## 7. Staleness / invalidation (baseline)

- Per-file re-index: `codegraph_record` for a `file_path` deletes all of that file's prior symbols (+ edges via CASCADE) and writes fresh → a file's data always reflects the last index.
- Consequence: when a symbol is deleted, `code_edges` from **other** files pointing at it via `callee_symbol_id` become dangling. Because `callee_name` is always kept, the callee can be **re-resolved** by name on a later index. Resolve strategy (lazy at query vs eager at record) decided when coding.
- The baseline does **not** detect that a file changed on disk; re-calling `codegraph_record` is the agent/indexer's responsibility. §12 replaces this with content-hash freshness tracking.

## 8. Alternatives considered & rejected

- **Embeddings / vector search** — rejected: heavy new dependency, against "no new dependency"; the owner's questions are structural relationships (definition/caller/callee), not semantic similarity.
- **Stuff it into `memories` via `metadata`** — rejected: `metadata` is JSON text, cannot query caller/callee relationships efficiently; no index for "who calls this function".
- **Server parses source at runtime (tree-sitter in-process)** — deferred: powerful but strains G6 for the server process. §12 keeps parsing **out-of-process** so the server stays lean while data stays deterministic.

## 9. Implementation sketch (for a later session)

Listed only — **not done in this change**:

1. Migration `src/migrations/0006_codegraph.ts` (2 tables + FTS5 + triggers), registered in `src/migrations/index.ts`.
2. Update the ordered version-list assertions in `src/__tests__/migrations.test.ts` and `src/__tests__/reasoning-audit-tools.test.ts`.
3. `src/schemas/codegraph.ts` — input contracts.
4. `src/tools/codegraph.ts` — `registerCodegraphTools`, each tool wrapped in `withTelemetry`.
5. One registration line in `src/server.ts`.
6. Test `src/__tests__/codegraph-tools.test.ts` following the `memory-tools.test.ts` harness pattern.
7. Bump `MCP_VERSION` (`src/constants.ts`) + `package.json` + `docs/architecture.md` `Version:` + `CHANGELOG.md`, update the tool table in `README.md` and the storage model in `docs/architecture.md` (per Release Process in `CLAUDE.md`).

## 10. Open questions for the owner

1. Data source: (a) agent-fed, (b) deterministic indexer, or both? (§6, §12) — **this is now the go/no-go question.**
2. `edge_kind`: all five values (`calls/imports/references/extends/implements`) or just `calls` for v1?
3. Do we need `codegraph_delete` / `codegraph_clear_workspace` to prune old index data?
4. Target release version at implementation time (fill into roadmap after the spec is approved).
5. **Go/no-go:** are the §12 preconditions (deterministic producer + freshness tracking + coverage metadata) accepted as prerequisites before any coding? If not, §11's verdict stands: do not build.

---

## 11. Value & failure modes (agent-consumer POV)

This section is written from the standpoint of an agent that is **required to use these tools** during real work, with `Grep`/`Glob`/`Read` (and often an LSP) already available. That baseline matters: `Grep`/`Read`/LSP are always **ground-truth on the current code**, whereas a codegraph copy can be **stale, partial, or LLM-fabricated**. Each tool must beat that baseline to justify itself.

### 11.1. Per-tool assessment

- **`codegraph_find_symbol`** ("where is X defined") — `grep -n "function X"` or LSP go-to-def answers this instantly and correctly on current code. The codegraph copy can only tie or lose (staleness). **Redundant.**
- **`codegraph_file_symbols`** ("what's in this file") — an agent usually `Read`s the file anyway, or greps definition lines. Marginal token savings on very large files, with staleness risk. **Weak.**
- **`codegraph_callees`** ("what does X call") — X's body is right there; `Read` is short and always correct. **Low value.**
- **`codegraph_search`** (fuzzy by name) — competes with `grep -i` / fuzzy find. **Weak.**
- **`codegraph_find_references` / `codegraph_callers`** ("who calls X") — the **one genuinely valuable query**, because `grep` is bad here: false positives (same-named symbols, matches in comments/strings) and false negatives (calls via alias/re-export). A *resolved* call edge answers correctly. **But** the answer is only usable if the index is **complete + fresh + accurate**: a list of "2 callers" is unusable for a rename/delete decision unless it is provably *all* callers. A partial/stale list that looks complete is **more dangerous than grep**.
- **`codegraph_record`** — not a "solves-my-problem" tool but a **tax**. To record accurate edges the agent must analyze the code first — and once it has, it already holds that knowledge for the current task. The payoff is deferred to a future session that may never come.

### 11.2. The five failure modes

1. **Trust** — with the server not parsing code, the agent (an LLM) is the source of edges. LLMs miss calls, invent callees, misjudge line numbers. A codegraph you must re-verify with grep has no value.
2. **Staleness** — `start_line/end_line` drift the moment anyone edits above a symbol. Per-file manual re-index detects nothing on disk. Stale `file:line` actively misleads; grep is always current.
3. **Coverage false-confidence** — reverse lookups are correct only if *every* possibly-calling file is indexed. A 60%-covered index returns "2 callers" when there are 5, and the tool cannot distinguish "no callers" from "no callers found in a partial index." This is the most dangerous mode: it can green-light deleting live code.
4. **Write/read asymmetry** — recording is a certain cost now for an uncertain, deferred benefit.
5. **Redundancy** — 5 of 6 tools duplicate `Grep`/`Read`/LSP and lose, because those are ground-truth on current code.

### 11.3. ROI verdict (as specced)

As currently specced (agent-fed, per-file manual record, no freshness detection), the feature is **mostly hollow**: five tools return nothing better than tools the agent already has and trusts more, and the one differentiator (reverse call graph) collapses without a completeness + freshness + accuracy guarantee — exactly where it would earn its keep (refactor / dead-code decisions). **Not worth building in this form.** §12 defines what flips the verdict.

## 12. Optimization directions & preconditions

Grounded in how serious code-intelligence systems work. Overarching principle from the field: **never let an LLM be the source of truth, never use line numbers as identity, and always return coverage with the answer.** Each failure mode from §11 maps to a concrete fix, with trade-offs called out.

### 12.1. Trust → deterministic producer, tiered provenance

- **Definitions + call sites → tree-sitter.** The modern foundation (aider builds its repo map with tree-sitter; the arXiv "Codebase-Memory" work builds a tree-sitter knowledge graph for LLMs over MCP; Graphify extracts across ~66 languages). Parsing is O(file size) and accurate on current text; yields defs (with signatures) and syntactic call sites.
- **Resolved references → SCIP.** Tree-sitter gives syntactic call sites but not which definition a call binds to. The industry artifact for complete, resolved "find references" is **SCIP** (Sourcegraph; replaced LSIF; indexers like `scip-typescript`/`scip-python`; protobuf, ~10× faster than `lsif-node`, ~4–5× smaller). Ingesting a SCIP index into `code_edges` yields trustworthy reverse references.
- **ctags** — cheap but definitions only, no references → enough for `find_symbol`/`file_symbols`, useless for callers.
- **Provenance tiers:** add a `resolution` column per edge — `resolved` (SCIP/LSP) · `syntactic` (tree-sitter) · `heuristic` (LLM, last resort). Every query returns the tier so the agent knows how far to trust it. This mirrors the existing provenance pattern already used on `related_memories`.

**Trade-off:** the server keeps G6 (zero runtime dep) only if parsing runs **out-of-process** — the server just ingests. A pure-WASM `web-tree-sitter` (no node-gyp) confined to the indexer path, or shelling out to installed `scip-*`/`ctags` binaries (zero npm dep, but requires the binary present), are the two ways to hold the line. In-process native parsers would break G6.

### 12.2. Staleness → content identity + incremental re-index

- Store per file: **git blob SHA** (or content hash) + `indexed_at` + `index_commit`. (aider caches tree-sitter tags in SQLite keyed by `mtime`, invalidating on change; blob SHA is a stronger identity.)
- **Stale flag at query time:** compare stored hash vs current (`git hash-object` / `git ls-files -s`, or `mtime` fast-path) → return `stale: true` instead of silently serving dead line numbers.
- **Reduce line drift:** do not treat absolute line as identity. Store a stable anchor (symbol name + container + hash of the symbol body) so re-index re-matches and updates line numbers; only serve a "confident" line when the file is unchanged.
- **Incremental:** re-index only files whose blob changed since `index_commit` (`git diff --name-only <index_commit> HEAD`, or a Merkle/dir-hash). Ongoing cost becomes proportional to the change set — near-free after the first pass.

**Trade-off:** these fixes assume a git repo (blob SHA, `git diff`). For non-git trees, fall back to content hash + `mtime`; slightly weaker but workable.

### 12.3. Coverage false-confidence → manifest + metadata on every answer

- **Manifest table:** which files are indexed, at which commit, when, with which resolver tier.
- **Every reference/caller response carries:** `indexed_files/total_files`, `stale_count`, `index_commit`→`HEAD` distance, and the resolution tier of the returned edges.
- This turns "2 callers" into either *"2 resolved callers, 100% coverage, index at HEAD"* (actionable) or *"2 callers, 60% coverage, 3 commits behind"* (a warning). Directly kills the most dangerous failure mode.
- Completeness only comes from **whole-repo batch indexing**, never per-file agent records → another reason to move population off the agent.

### 12.4. Write/read asymmetry → populate off the agent hot path

- Run the indexer in the background: a **CLI subcommand `index`** (mirroring `install-agents` in `src/index.ts`), a **SessionStart hook**, or a file-watcher. The agent never pays per query — it only reads.
- Combined with §12.2 incremental indexing, steady-state cost is tiny.
- This demotes `codegraph_record` (agent-fed) to an optional/last-resort path; the primary path is deterministic batch indexing.

### 12.5. Redundancy → lean into the real differentiators

Drop the competition where grep wins; concentrate on the three things grep / per-session LSP do **not** give:

- **(a) Persistence across sessions/agents** without paying LSP cold-start each time.
- **(b) A resolved, coverage-aware reference graph** as one uniform tool surface.
- **(c) Ranking + impact analysis** — which grep fundamentally cannot do. aider runs **PageRank over the reference graph** to surface central symbols and fit them into a **token budget**. That enables new queries: *"the N most central symbols relevant to X within a token budget"* and *"transitive callers of X — is it safe to change/delete?"* (blast radius).

Recommended surface (replacing the naive six): `codegraph_references` (resolved + coverage + freshness + tier), `codegraph_impact` (transitive callers), `codegraph_map` (PageRank, token-budgeted). Keep `find_symbol`/`file_symbols` only as thin cache conveniences explicitly marked "grep is authoritative."

### 12.6. Recommended architecture (flips the §11 verdict)

Four changes turn "not worth it" into "worth it," and all four are **prerequisites (go/no-go), not nice-to-haves**:

1. **Populate with tree-sitter (+ SCIP for resolved edges), out-of-process.** LLM only as a flagged `heuristic` tier. → fixes Trust.
2. **Freshness via git blob SHA + `index_commit`, incremental via `git diff`, stale flags at query.** → fixes Staleness.
3. **Coverage metadata attached to every answer.** → fixes Coverage + Write-cost.
4. **Shrink the surface to the differentiators** (`references` / `impact` / `map`). → fixes Redundancy.

**Honest limits.** In a single session with a warm LSP, LSP still wins on freshness and accuracy. Codegraph wins when: the LSP is unavailable / slow to start for the language, work spans **multiple repos**, **cross-session memory** is wanted, or the agent needs **ranking / impact / token-budget** queries that an LSP does not expose. If the owner cannot commit to a deterministic producer + freshness mechanism, the §11 verdict holds: do not build.

**Trade-off summary**

| Axis | Cheap / naive | Trustworthy / recommended |
|---|---|---|
| Producer | agent-fed (`codegraph_record`) | tree-sitter + SCIP, out-of-process |
| Dependency | zero | one WASM parser (indexer path) or external binaries |
| Freshness | none (manual re-record) | git blob SHA + incremental `git diff` |
| Coverage | unknown | manifest + metadata per answer |
| Trust | LLM-fabricated | resolved, tiered provenance |
| Surface | 6 grep-overlapping tools | 3 differentiated tools |

**Evidence gate (matches repo culture, cf. Wave 4 gating).** Ship the smallest trustworthy slice first — resolved `references` + coverage + freshness, deterministically populated — and use the existing telemetry / adoption-report pattern (`memory_adoption_report`, `src/tools/memory.ts:854-1060`) to measure whether agents actually query it before building `impact`/`map`.

### 12.7. Sources

- SCIP — a better code indexing format than LSIF (Sourcegraph): https://sourcegraph.com/blog/announcing-scip
- SCIP design: https://github.com/scip-code/scip/blob/main/docs/DESIGN.md
- Building a better repository map with tree-sitter (aider): https://aider.chat/2023/10/22/repomap.html
- Codebase-Memory: Tree-Sitter-Based Knowledge Graphs for LLM Code Exploration via MCP (arXiv): https://arxiv.org/html/2603.27277v1
- Tree-sitter AST Extraction Across 19 Languages (Graphify): https://graphify.net/tree-sitter-ast-extraction.html
- Building Call Graphs for Code Exploration Using Tree-Sitter (DZone): https://dzone.com/articles/call-graphs-code-exploration-tree-sitter
