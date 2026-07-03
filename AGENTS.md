# AGENTS.md

## Core Rules

- This MCP has two tool families only: `memory_*` and `reasoning_*`.
- Use a `reasoning-first` workflow for any non-trivial task.
- Do not open a reasoning session for a trivial one-step lookup.
- Do not store a full chain of thought in memory.
- Do not store secrets, credentials, tokens, passwords, or raw sensitive personal data.
- If this file conflicts with actual tool behavior, trust `src/tools/memory.ts`, `src/tools/reasoning.ts`, and their schemas first.

## Strict Decision Tree

Follow this flow in order.

### 1. Classify the task

- If the task is a trivial lookup with no meaningful branching, do not call `reasoning_*`.
- If the task is a single-step factual task, use `memory_*` only if prior stored context would help.
- If the task is non-trivial, multi-step, uncertain, investigative, or decision-heavy, start with `reasoning_start_session`.

### 2. Start reasoning early for non-trivial work

Call `reasoning_start_session` before the main investigation begins when any of these are true:

- the task may take multiple steps
- the task has uncertainty or competing hypotheses
- the task includes debugging, planning, investigation, or trade-offs
- the task may need an auditable trace later

Do not delay session creation until after important decisions have already happened.

### 3. Pull memory into the reasoning session only when needed

Once a reasoning session exists, decide which read tool to call:

- Use `memory_search` when you have a topic, keyword, or concrete hypothesis.
- Use `memory_list` when you need to browse by `type`, `agent_id`, `tags`, `importance`, or recency and do not have a strong search query yet.
- Use `memory_get` only when you already have an exact memory id.
- Use `reasoning_list_sessions` when you want to find older reasoning sessions but do not know the session id yet.
- Use `reasoning_get_trace` only when you need the full ordered trace of a known prior session.

Do not browse with `memory_search` when you have no query.
Do not use `memory_list` when a precise keyword search would be better.
Do not use `reasoning_get_trace` when a durable conclusion should have been retrieved from memory instead.

### 4. Log only meaningful reasoning steps

While a session is `in_progress`, call `reasoning_add_step` only when at least one of these happened:

- a new hypothesis or decision was formed
- a meaningful action was taken
- an observation changed understanding
- an option was accepted or rejected for a reason
- an intermediate conclusion is worth preserving

Each step must include at least one of:

- `thought`
- `action`
- `observation`

Do not log every keystroke, every tiny command, or noisy scratch work.
Do not call `reasoning_add_step` on a completed or abandoned session.

### 5. Finish the session explicitly

At the end of the task:

- use `reasoning_complete_session(status="completed")` when a conclusion was reached
- use `reasoning_complete_session(status="abandoned")` when the work was dropped or could not be completed

Do not leave stale sessions open without reason.

### 6. Persist only durable conclusions

Use `save_as_memory=true` in `reasoning_complete_session` only when the conclusion is worth long-term recall.

Good candidates:

- stable facts
- durable user or agent preferences
- decisions likely to matter again
- distilled reasoning outcomes worth reusing later

Bad candidates:

- transient debugging noise
- temporary hypotheses
- partial work notes
- full traces
- context that will be stale quickly

## Tool Rules

### `memory_search`

Use when:

- you have a concrete topic, keyword, or hypothesis
- you want relevance-ranked results from stored memory content and tags

Do not use when:

- you only want to browse broadly
- you do not have a useful query yet

Preferred next step:

- `memory_get` if one result needs close reading
- return to the current reasoning session if the search answered the question

Common mistakes:

- using it as a browse tool
- using vague queries when a better keyword is available

### `memory_list`

Use when:

- you need browsing rather than keyword search
- you want to filter by `type`, `agent_id`, `tags`, or `min_importance`
- you want recent or important memories without a query

Do not use when:

- the question already has a clear search term

Preferred next step:

- `memory_get` for a chosen item
- `memory_search` after browsing suggests a better query

Common mistakes:

- listing too much data instead of narrowing the filter
- using it where `memory_search` would be more precise

### `memory_get`

Use when:

- you already know the exact memory id

Do not use when:

- you still need to discover which record matters

Preferred next step:

- continue reasoning with the retrieved fact

Common mistakes:

- treating it like search

### `memory_save`

Use when:

- you have a self-contained durable fact, preference, episodic note, decision, or reasoning summary worth keeping

Do not use when:

- the information is only useful in the current task
- the content is a full trace or raw chain of thought

Preferred next step:

- continue the task; do not create extra workflow around a small save

Common mistakes:

- saving noisy transcripts
- saving weak conclusions that are not durable

### `memory_update`

Use when:

- an existing memory is wrong, outdated, misclassified, or needs corrected tags/metadata

Do not use when:

- the new fact should exist as a separate memory rather than overwriting history

Preferred next step:

- if the correction happened during a live investigation, note the decision in the reasoning session when useful

Common mistakes:

- overwriting older context that still has historical value

### `memory_delete`

Use when:

- a memory is incorrect, duplicated, unsafe, or should not exist

Do not use when:

- the record is merely old but still historically useful

Preferred next step:

- create or keep a correct replacement only if long-term recall still matters

Common mistakes:

- deleting when an update would preserve useful history

### `reasoning_start_session`

Use when:

- the task is non-trivial and multi-step
- the task has uncertainty, branching, debugging, planning, or trade-offs

Do not use when:

- the task is a trivial one-shot lookup

Preferred next step:

- `reasoning_add_step` for meaningful progress
- `memory_search` or `memory_list` if prior context is needed

Common mistakes:

- starting the session too late
- opening sessions for tiny tasks

### `reasoning_add_step`

Use when:

- you have meaningful `thought`, `action`, or `observation` to record

Do not use when:

- nothing important changed
- the session is no longer `in_progress`

Preferred next step:

- continue the investigation
- call the next read/write tool only if it changes understanding or records a conclusion

Common mistakes:

- logging every small action
- omitting all three fields

### `reasoning_list_sessions`

Use when:

- you want to locate related past reasoning sessions
- you do not yet know the exact session id

Do not use when:

- you already know the session to inspect
- what you actually need is a durable fact from memory

Preferred next step:

- `reasoning_get_trace` for the chosen session if you need the full trace

Common mistakes:

- using session history instead of memory for stable conclusions

### `reasoning_get_trace`

Use when:

- you already know which prior session you need
- you need the full ordered trace, not just a summary

Do not use when:

- a stored memory would answer the question well enough

Preferred next step:

- extract only the useful conclusion into the current reasoning flow

Common mistakes:

- copying full old traces into memory
- reading traces when a durable summary would be enough

### `reasoning_complete_session`

Use when:

- the session reached a final conclusion
- the work is being explicitly abandoned

Do not use when:

- the task is still actively in progress

Preferred next step:

- set `save_as_memory=true` only for durable conclusions worth later reuse

Common mistakes:

- forgetting to complete the session
- saving every conclusion as memory without quality filtering

## Quality Guardrails

Before calling a tool, check these:

- Is this task truly non-trivial enough to require `reasoning_start_session`?
- If I need stored context, do I have a real query for `memory_search`, or should I browse with `memory_list`?
- Do I already have an exact id, making `memory_get` the correct tool?
- Is this reasoning step meaningful enough for `reasoning_add_step`?
- Is the session still `in_progress` before I add a step?
- Is the conclusion durable enough to justify `save_as_memory=true` or `memory_save`?
- Am I about to store a secret, a transcript, or short-lived noise?
