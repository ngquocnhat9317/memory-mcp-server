# Memory MCP Guidelines

Version: 2026-07-11.v4

This file is the single source of truth for how an agent should use this MCP.
It is organized around the three moments of a task where this MCP matters.

## Moment 1 — Task Start

1. Decide the task size first:
   - Trivial one-step lookup: do NOT open a reasoning session and do NOT call
     memory tools unless prior recall is genuinely needed. Stop here.
   - Anything multi-step, uncertain, or involving debugging, planning, review,
     or trade-offs: call `reasoning_start_session` with a specific title.
2. Read what the server hands back — this is free recall, act on it:
   - `related_memories`: saved knowledge matched to your title, ranked by
     text relevance. Review the snippets before working; fetch full content
     with `memory_get` if needed. Entries persisted from a past reasoning
     session carry a `source` field (`{session_id, session_title, created_at}`)
     — when you need to verify how a conclusion was reached, replay its origin
     with `reasoning_get_trace(source.session_id)`. Remember which ones
     actually help — you will report them at completion.
   - `open_sessions_warning` / `open_sessions`: sessions you (or a previous
     run) forgot to close. Close finished ones with
     `reasoning_complete_session`; stale ones are auto-abandoned by the server.
3. Only call `memory_search` yourself when you need recall on a topic that is
   NOT the session title (the server already searched the title for you).

## Moment 2 — During The Task

- Log decisions, hypotheses, rejected options, conflicts, and meaningful
  observations with `reasoning_add_step`. Routine mechanical actions do not
  need steps.
- Prefer batch mode when it lowers friction: `reasoning_add_step` with
  `steps: [{thought/action/observation}, ...]` logs up to 20 steps in one
  call — ideal for recording a stretch of work you just finished instead of
  pausing after every step. A post-hoc trace is far better than an empty one.
- Mark pivotal steps with `reasoning_mark_step` (`decision`, `conflict`,
  `hypothesis`, `milestone`, `important`) when a future reviewer would want to
  jump straight to them.

## Moment 3 — Task End

Always close the session with `reasoning_complete_session`:

- `conclusion`: the actual answer/decision, written to be reusable.
- `used_memory_ids`: ids of memories (e.g. from `related_memories`) that
  genuinely helped. Report honestly, including reporting none. Successful
  usage feedback is a learning signal for recall quality and is always
  recorded locally, regardless of the `MEMORY_TELEMETRY` setting (failed
  attempts, e.g. an unknown memory id, return a warning and are not recorded).
- Saving the conclusion as durable memory is opt-in: pass
  `save_as_memory=true` or `memory_mode='always'`. The default (`auto`) does
  NOT save on its own. Save when the conclusion would help a future task;
  skip (optionally with `memory_mode='never'` + `not_saved_reason`) when it is
  one-off noise.
- If the task was dropped without a real conclusion, complete with
  `status='abandoned'` instead of leaving the session open.

## Tool Reference

Durable memory:

- `memory_save`: store durable facts, decisions, preferences, or summaries
- `memory_search`: targeted recall by keyword, topic, or hypothesis
- `memory_list`: recent or filtered browsing (when browsing beats searching)
- `memory_get`: fetch one memory by exact id
- `memory_update`: correct an existing memory in place
- `memory_delete`: remove unsafe, duplicated, or wrong memory
- `memory_record_usage_feedback`: record whether a recalled memory was
  used/ignored/stale — prefer `used_memory_ids` at completion for the common
  case; successful feedback is always persisted locally regardless of
  `MEMORY_TELEMETRY`

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
  telemetry-backed views of how memory/reasoning is actually being used — with
  `MEMORY_TELEMETRY` off (the default) only usage-feedback events and session
  tables have data; full funnels and ratios need `MEMORY_TELEMETRY=on`

## Do Not Store

- secrets, tokens, or credentials
- full hidden chain-of-thought
- transient debugging noise
- raw tool dumps with no durable value

## Rule Of Thumb

- durable reusable knowledge -> `memory_*`
- live multi-step task trace -> `reasoning_*`
- when in doubt, skip storage unless the information will help a future agent
  or future run
