# Changelog

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
