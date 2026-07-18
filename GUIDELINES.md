# Memory MCP Guidelines

Version: 2026-07-18.v7

This file is the single source of truth for how an agent should use this MCP.
It is organized around the three moments of a task where this MCP matters.
Tool schemas and descriptions are the source of truth for parameter contracts
(required fields, types, enums); this guide covers policy — when and why.

## Moment 1 — Task Start

1. Decide the task size first:
   - Trivial one-step lookup: do NOT open a reasoning session and do NOT call
     memory tools unless prior recall is genuinely needed. Stop here.
     (Examples: read one config value, answer a question from context you
     already have.)
   - Anything multi-step, uncertain, or involving debugging, planning, review,
     or trade-offs: call `reasoning_start_session` with a specific title.
     (Examples: any bug hunt, any change touching more than one file.)
     The title doubles as the recall query — favor concrete keywords
     (component, module, error names) over generic phrasing.
2. Read what the server hands back — this is free recall, act on it:
   - `related_memories`: saved knowledge matched to your title, ranked by
     text relevance and biased toward your current workspace. Weak one-word
     matches are filtered out, so an empty or short list is normal. Review
     the snippets before working; fetch full content
     with `memory_get` if needed. Entries persisted from a past reasoning
     session carry a `source` field (`{session_id, session_title, created_at}`)
     — when you need to verify how a conclusion was reached, replay its origin
     with `reasoning_get_trace(source.session_id)`. Remember which ones
     actually help — you will report them at completion.
     If `related_memories` has 2 or more entries, do not act on the first one
     blindly: skim all the snippets for contradictions before proceeding.
       - Agree or don't overlap → use the most relevant one(s) directly.
       - Conflict, or you're unsure → call
         `reasoning_get_trace(source.session_id)` on the newer, same-workspace
         one *before* deciding, not after. Once resolved, clean up the losing
         memory with `memory_update` or `memory_delete`.
   - `open_sessions_warning` / `open_sessions`: sessions left in_progress.
     Close the ones YOU opened and finished with
     `reasoning_complete_session`. Leave sessions you don't recognize alone —
     they may belong to another agent or a parallel run; stale ones are
     auto-abandoned by the server. A completed or abandoned session cannot be
     reopened: to resume interrupted work, start a new session and reference
     the old one in the title or an early step.
3. Only call `memory_search` yourself when you need recall on a topic that is
   NOT the session title (the server already searched the title for you).

## Moment 2 — During The Task

Every `reasoning_add_step` and `reasoning_complete_session` call requires the
`session_id` returned by `reasoning_start_session`; `reasoning_mark_step`
instead takes the `step_id` returned by `reasoning_add_step`.

- Log decisions, hypotheses, rejected options, conflicts, and meaningful
  observations with `reasoning_add_step`. Routine mechanical actions do not
  need steps. Within a step: `thought` = your reasoning, `action` = what you
  did, `observation` = what resulted — fill whichever apply (at least one).
- Prefer batch mode when it lowers friction: `reasoning_add_step` with
  `steps: [{thought/action/observation}, ...]` logs up to 20 steps in one
  call — ideal for recording a stretch of work you just finished instead of
  pausing after every step. A post-hoc trace is far better than an empty one.
- Mark pivotal steps with `reasoning_mark_step` in the same turn you log
  them with `reasoning_add_step` — don't defer it, deferred marks get
  forgotten. Call it whenever the step you just logged was any of: a choice
  between alternatives (`decision`), an option you rejected (`decision`),
  a genuine contradiction you found (`conflict`), an unverified guess you're
  about to test (`hypothesis`), or a result that changed the direction of the
  task (`milestone`). If none of these apply, skip it — not every step needs
  a mark.

## Moment 3 — Task End

Always close the session with `reasoning_complete_session`:

- `conclusion`: the actual answer/decision, written to be reusable. Required
  even when abandoning — one line stating why the task was dropped is enough.
- `used_memory_ids`: ids of memories (e.g. from `related_memories`) that
  genuinely helped. Report honestly, including reporting none. This is the
  "used" feedback path when you have a session; call
  `memory_record_usage_feedback` directly instead when there is no session to
  close, or the moment you discover a recalled memory is stale or wrong. A
  failed report (e.g. an unknown memory id) returns a warning and is not
  recorded.
- Saving the conclusion as durable memory is opt-in: pass
  `save_as_memory=true` or `memory_mode='always'`. The default (`auto`) does
  NOT save on its own. Save when the conclusion would help a future task;
  skip with `memory_mode='never'` (requires `not_saved_reason`) when it is
  one-off noise.
- When persisting, pick a `memory_type` (`fact`, `preference`, `episodic`,
  `decision`, `reasoning_summary`) and a `memory_importance` (1–5 scale;
  anchors: 5 = convention or decision affecting every task in the workspace,
  3 = reusable pattern within one area, 1 = minor context note).
- If the task was dropped without a real conclusion, complete with
  `status='abandoned'` instead of leaving the session open.

## Tool Reference

- `get_usage_guide`: returns this guide (with its version) at runtime

Durable memory:

- `memory_save`: store durable facts, decisions, preferences, or summaries.
  Tags describe topics ('sqlite', 'auth', 'perf'), not locations — do not put
  workspace or project names in tags; the server records the workspace
  automatically and prefers same-workspace memories at recall time
- `memory_search`: targeted recall by keyword, topic, or hypothesis
- `memory_list`: recent or filtered browsing (when browsing beats searching)
- `memory_get`: fetch one memory by exact id
- `memory_update`: correct an existing memory in place
- `memory_delete`: remove unsafe, duplicated, or wrong memory
- `memory_record_usage_feedback`: record how a recalled memory turned out
  (`used`, `ignored`, `irrelevant`, `stale`, `unsafe_to_use`) — prefer
  `used_memory_ids` at completion for the common case; use this tool directly
  for no-session tasks and for non-`used` reports

Reasoning traces:

- `reasoning_start_session` / `reasoning_add_step` / `reasoning_complete_session`:
  the core loop described above
- `reasoning_get_trace`: replay a session's full ordered trace
- `reasoning_list_sessions`: find past sessions before retrieving a trace

Audit & reports (mostly for reviewers and operators, not everyday tasks):

- `reasoning_mark_step`, `reasoning_list_milestones`,
  `reasoning_get_session_outline`, `reasoning_search_steps`: navigate traces
  by their pivotal moments
- `memory_usage_report`, `memory_adoption_report`, `memory_agent_scorecard`:
  telemetry-backed views of how memory/reasoning is actually being used
- Telemetry note: `MEMORY_TELEMETRY` is a server-side env var (`on`/`off`,
  default `off`); agents cannot change it. Successful usage feedback and
  session data are always recorded locally regardless of the setting — only
  the full funnels and ratios in the reports above need `MEMORY_TELEMETRY=on`.

## Do Not Store

This list applies to durable memory — `memory_save` and conclusions persisted
via `save_as_memory`. Reasoning steps may summarize tool output briefly, but
secrets are banned everywhere.

- secrets, tokens, or credentials
- full hidden chain-of-thought
- transient debugging noise
- raw tool dumps with no durable value

## Rule Of Thumb

- durable reusable knowledge -> `memory_*`
- live multi-step task trace -> `reasoning_*`
- when in doubt, skip storage unless the information will help a future agent
  or future run
