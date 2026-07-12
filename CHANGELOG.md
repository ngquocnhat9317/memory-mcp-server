# Changelog

## 1.3.0 (2026-07-11)

Theme: recall that stays right as the store grows — relevance ranking, provenance, and an always-on learning signal.

### Added

- **Workspace-aware recall**: memories are stamped with the workspace they were saved from (`MEMORY_WORKSPACE`, defaulting to the server's working directory — which is the project folder under Claude Code/Codex), and auto-recall softly prefers the current workspace: same workspace > unknown/legacy > other workspaces, applied *after* text relevance so strong cross-project matches still win. Migration `0005_memory_workspace` adds the column non-destructively; existing rows rank as neutral. No configuration required.
- **Recall quality floor**: for titles with 3+ significant words, auto-recall now requires candidates to match at least 2 of them — one-common-word junk ("fix", "service") no longer fills the slots. When nothing clears the floor, recall returns at most one best-effort match instead of three, cutting input-token noise where it hurt most. Short 1–2 word titles behave as before; `memory_search` is unchanged.
- **Provenance on auto-recall**: memories that were persisted from a reasoning session now carry a `source` field (`{session_id, session_title, created_at}`) in `related_memories`, turning a recalled sentence into a conclusion with an origin — pass `source.session_id` to `reasoning_get_trace` to replay how it was reached. Manually saved memories are unchanged (no `source` field).
- **Cold-start nudge**: while the memory store is completely empty, `reasoning_start_session` adds one sentence to its text response suggesting `save_as_memory=true` at completion. It disappears forever after the first memory is saved — zero noise for existing stores.
- README "What it feels like": a two-scene text walkthrough of save-then-auto-recall with provenance. (An animated GIF/asciinema recording of the same scenario is planned but deferred — it needs a human-recorded terminal session.)

### Changed

- **Recall and search are now relevance-ranked** (BM25): both auto-recall (`related_memories` on `reasoning_start_session`) and `memory_search` order results by FTS5 text-match quality first, with `importance` and `updated_at` as tie-breaks — previously ordering was importance-first, which let a high-importance but off-topic memory outrank the best match as the store grows. No response shape change, no new configuration; all existing filters (`type`, `agent_id`, `tags`) behave the same.
- **Usage feedback is now always recorded** (learning signal ≠ diagnostics): `used_memory_ids` on `reasoning_complete_session` and `memory_record_usage_feedback` persist locally regardless of `MEMORY_TELEMETRY`. Feedback is the first-party signal that measures whether recall is actually helping, so it no longer shares a gate with opt-in diagnostics. Only *successful* feedback is exempt — failed feedback attempts (error codes, latency) are diagnostics and stay gated. Everything else (searches, saves, recalls, reports data) stays opt-in via `MEMORY_TELEMETRY=on`. `memory_record_usage_feedback` no longer returns `recorded: false` when telemetry is off. Nothing leaves your machine in either mode.
- **Report outputs are self-describing about telemetry**: when `MEMORY_TELEMETRY` is off, `memory_usage_report`, `memory_adoption_report`, and `memory_agent_scorecard` include a `telemetry_note` field in their JSON output so empty funnels cannot be mistaken for real zeros.
- `GUIDELINES.md` bumped to `2026-07-12.v5`: feedback reporting described as always-on for successful feedback; report tools clarified to need `MEMORY_TELEMETRY=on` for full funnels; task-start guidance now teaches the relevance-ranked, workspace-aware recall and the `source` provenance field (replay origins with `reasoning_get_trace`); **tag hygiene** — tags describe topics, not locations: do not put workspace/project names in tags, the server records workspace automatically (also stated in the `memory_save` tool description). The README AGENTS snippet gained the provenance hint.

### Fixed

- `memory_adoption_report` and `memory_agent_scorecard` crashed with "ambiguous column name: created_at" when called with `date_from`/`date_to` while session data existed — the session-table filter is now column-qualified in the queries that join `reasoning_steps`. (Pre-existing since 1.2.0, surfaced by the new coverage suite.)

## 1.2.5 (2026-07-11)

Theme: cut logging friction and make the docs tell the new story.

### Added

- **Batch steps**: `reasoning_add_step` accepts `steps: [{thought?, action?, observation?}, ...]` (max 20) to log several steps in one call — ideal for recording a stretch of finished work instead of pausing after every step. Insertion is atomic (all steps or none) and numbering stays sequential. Single-step calls and their response shape are unchanged.
- `keywords` in package.json and a registry submission playbook under `docs/growth/registry-submissions.md`.

### Changed

- **Telemetry is now opt-in**: `MEMORY_TELEMETRY` defaults to **off**; set `MEMORY_TELEMETRY=on` to record usage events locally. The report tools (`memory_usage_report`, `memory_adoption_report`, `memory_agent_scorecard`) only have data when it is on, and usage feedback is only persisted when it is on. Core features — auto-recall, stale-session cleanup, batch steps, memory CRUD — work fully without it. Rationale: telemetry serves operators who run multiple agent personas and study their behavior; for single-agent users it was overhead with no benefit. If you were relying on the previous default, add `MEMORY_TELEMETRY=on` to your MCP config env.
- **`memory_record_usage_feedback` degrades softly when telemetry is off**: instead of a hard error, it validates inputs normally and returns `{recorded: false, ...}` with a warning explaining how to enable telemetry. Validation failures (unknown memory id, unverifiable event) still return real errors. The telemetry check now runs after input validation.
- **GUIDELINES.md rewritten around the task lifecycle** (`2026-07-11.v1`): task start (act on `related_memories`, close forgotten sessions), during (log decisions, batch mode, mark pivotal steps), task end (`used_memory_ids`, opt-in memory save). All 20 tools are now documented in the guide, including the audit and report layers.
- **README rewritten as a user-facing landing page**: npx quick-install for Claude Code / Claude Desktop / Codex / Cursor / Antigravity, a "why this one" comparison, configuration table, and an updated AGENTS.md snippet matching the v1.2.x lifecycle. Telemetry is presented as an optional operator feature rather than a headline.

## 1.2.0 (2026-07-10)

Theme: close the memory value loop — recall becomes automatic, cleanup becomes automatic, and usefulness becomes measurable.

### Added

- **Auto-recall in `reasoning_start_session`**: the response now includes `related_memories` — up to 3 saved memories relevant to the session title (id, type, importance, tags, snippet), matched via full-text search. Configure the limit with `MEMORY_AUTO_RECALL_LIMIT` (default 3, `0` disables). Recall is best-effort: a failed lookup never blocks session creation.
- **Stale-session cleanup**: `in_progress` sessions untouched for longer than `MEMORY_SESSION_TTL_HOURS` (default 24, `0` disables) are automatically marked `abandoned` (conclusion `auto-abandoned: stale session`) the next time `reasoning_start_session` is called. The response reports `auto_abandoned_sessions` when cleanup happened, and lists up to 5 other still-open sessions under `open_sessions` with an `open_sessions_warning`.
- **Usage feedback at completion**: `reasoning_complete_session` accepts `used_memory_ids` (string[], max 50) — ids of memories that actually helped during the session. The server records a `used` usage-feedback telemetry event per id; unknown ids produce warnings instead of errors. The response includes `used_memory_feedback_recorded`.
- **Recall telemetry**: `memory_search` and `memory_list` events now record the returned memory ids (bounded to 20) in `output_shape.memory_ids`, so recalled-but-unused memories become measurable.
- `CHANGELOG.md`, GitHub Actions CI (`npm test` on Node 22), and direct unit tests for the memory CRUD tools.

### Changed

- **`memory_record_usage_feedback` verification widened**: `event_id` may now reference any event that recalled the memory — `memory_get`, `memory_search`, or `memory_list` (previously only `memory_get`, which made verified feedback impossible in practice). Feedback without `event_id` is unchanged.
- **Adoption/scorecard reports** count feedback events regardless of `related_event_id`, so feedback recorded via `reasoning_complete_session` is included.
- **`memory_record_usage_feedback` output**: returns `{recorded: true, memory_id, usefulness}` instead of an `event_id` field that was always `null`.
- Documentation now matches actual behavior of `memory_mode='auto'`: it does **not** save a memory on its own; a memory is only created with `save_as_memory=true` or `memory_mode='always'`. (Behavior unchanged — the docs were wrong.) GUIDELINES version bumped to `2026-07-10.v1`.
- Tag filters (`tags` on search/list) treat `%`, `_`, and `\` literally instead of as SQL LIKE wildcards.

### Fixed

- Telemetry `not_saved_reason_category` now correctly records `zero_step` for zero-step completions (substring mismatch made it unreachable).
- Stale internal references to better-sqlite3; two accidentally tracked temp `.db` files removed from git.

### Upgrade notes

- Existing dangling `in_progress` sessions will be auto-abandoned on your first `reasoning_start_session` after upgrading. This is intended cleanup; set `MEMORY_SESSION_TTL_HOURS=0` before starting the server if you want to keep them open.
- No schema migration required; the SQLite database is fully compatible.

## 1.1.5 and earlier

See git history.
