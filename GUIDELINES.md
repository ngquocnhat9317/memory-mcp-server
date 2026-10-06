# Memory MCP Guidelines

Version: 2026-10-06.v9

This file is the single source of truth for how an agent should use this MCP.
Tool schemas and descriptions are the source of truth for parameter contracts
(required fields, types, enums); this guide covers policy — when and why.
In short: a task's trace goes into a reasoning session; durable knowledge is
the session's conclusion, saved by `reasoning_complete_session`.

## Moment 1 — Task Start

1. Decide the task size:
   - Trivial one-step lookup (read one value, answer from context you
     already have): no session, no memory calls. Stop here.
   - Anything multi-step, uncertain, or involving debugging, planning, review
     or trade-offs: call `reasoning_start_session`. The title is also the
     recall query, so use concrete keywords (module, error, ticket names).
     Pass `workspace` = the absolute path of your project; `/` and the home
     directory count as unknown. If the response has a `workspace_warning`,
     pass `workspace` to every later `reasoning_start_session`.
   - The user's answer to a pending conclusion (a choice, a "go") starts a new
     task. Open a session, short if needed, whose title names the decision.
2. Read what comes back:
   - `related_memories`: saved conclusions matched to your title. An empty
     list is normal; do not pad the title. Snippets show the start of each
     memory, plus the matching part when it lies further in; read one in full
     with `memory_get`. A `source` says which session produced it; read that
     session with `reasoning_find(session_id)` when the snippet is not enough
     to know why. Note which ones help — you report them at the end.
   - With 2 or more memories, skim them for contradictions first. If two
     conflict: read both with `memory_get` and prefer the newer
     same-workspace one. If the loser can be corrected, fix it with
     `memory_update`; otherwise flag it stale (see Moment 3). A wrong memory
     is corrected or flagged, never deleted. A stale flag removes the memory
     from auto-recall until it is next corrected with `memory_update`; it
     stays reachable through `memory_search`.
   - `open_sessions`: close the ones you opened and finished; leave the others
     alone. A closed session cannot be reopened: start a new one and name the
     old one in the title.
3. Recall beyond the title:
   - `memory_search`: saved memories on a topic other than your title.
   - `reasoning_find(query)`: when the user refers to earlier work, a past
     decision or a previous conversation that your context does not contain
     ("last time…", "continue the unfinished…"). Find first, then read only
     the session that matters with `reasoning_find(session_id)`.

## Moment 2 — During The Task

Every `reasoning_add_step` and `reasoning_complete_session` call requires the
`session_id` returned by `reasoning_start_session`.

Steps are the searchable record of how a task was done. When a later session
has lost this context, `reasoning_find` searches your steps to recover it. The
conclusion is a summary; it drops evidence, numbers and the options you
rejected. A session with only a conclusion can be found, but not
reconstructed.

- A useful trace answers three questions for a future agent: what did you
  check, what did you find, and what did you decide and why — including the
  options you rejected. One to three steps usually cover a normal task. Skip
  routine actions, not the whole trace.
- Log a step (batch mode `steps: [...]` is fine) at these checkpoints:
  - before you ask the user to choose or confirm something;
  - when you present a plan or result;
  - before `reasoning_complete_session`, if the trace does not yet answer
    the three questions.
- If you realise mid-task that the work is non-trivial, open the session
  then, and first log what you have done so far as one batch.
- Within a step: `thought` = your reasoning, `action` = what you did,
  `observation` = what resulted; fill whichever apply.

## Moment 3 — Task End

Always close the session with `reasoning_complete_session`:

- `conclusion`: the answer or decision, written to be reused. Its first
  sentence states the subject and the outcome; dates, sources and caveats come
  after, because a recall snippet always shows the start. State the key
  decisions and the options you rejected, with reasons. Required even when
  abandoning — one line saying why is enough.
- A conclusion that waits on the user is not final. When the answer comes,
  record it: update the pending memory with `memory_update`, or flag it stale
  and let the new session's conclusion replace it.
- `used_memory_ids`: ids of recalled memories that genuinely helped. Report
  honestly, including none.
- Flag a memory with `memory_record_usage_feedback(usefulness='stale')` the
  moment either happens:
  - a recalled memory contradicts what you just verified in code or data and
    you are not correcting it with `memory_update`;
  - a decision you just recorded supersedes an older or pending memory.
- Saving is opt-in: pass `save_as_memory=true` or `memory_mode='always'`; the
  default (`auto`) does not save. Save when the conclusion would help a future
  task; otherwise skip with `memory_mode='never'` (requires
  `not_saved_reason`). This is the only way to create a memory.
  `memory_tags`: tags describe topics ('sqlite', 'auth'), not projects.
- Leave `memory_type` and `memory_importance` at their defaults, except
  `memory_type='preference'` for a user preference that applies across
  projects — the only type recall treats differently.
- Dropped without a real conclusion? Complete with `status='abandoned'`.

## Tool Reference

- `get_usage_guide`: this guide.
- `reasoning_start_session`, `reasoning_add_step`,
  `reasoning_complete_session`: the core loop above.
- `reasoning_find`: find past sessions (`query`) or read one (`session_id`).
- `memory_search`, `memory_get`: recall beyond the title; read one memory.
- `memory_update`: correct a memory.
- `memory_record_usage_feedback`: report a stale or unsafe memory, or a use
  outside a session.
- `MEMORY_TELEMETRY` is a server-side env var (default `off`) that agents
  cannot change. Usage feedback and session data are always recorded locally.

## Do Not Store

Applies to conclusions saved as memory. Steps may summarize tool output
briefly, but secrets are banned everywhere.

- secrets, tokens, or credentials
- full hidden chain-of-thought
- transient debugging noise
- raw tool dumps with no durable value
