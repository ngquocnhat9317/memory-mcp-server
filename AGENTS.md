# AGENTS.md

This file tells an agent how to use this MCP correctly based on the code that exists now.

If this file and the implementation disagree, trust these files first:

- `src/tools/memory.ts`
- `src/tools/reasoning.ts`
- `src/schemas/memory.ts`
- `src/schemas/reasoning.ts`

## Core Model

This MCP has two tool families:

- `memory_*` for durable recall
- `reasoning_*` for per-task trace capture and audit retrieval

Do not treat them as interchangeable.

## Fast Decision Rule

Use this order:

1. Trivial one-step lookup:
   - do not open a reasoning session
   - use no MCP tool unless memory recall is actually needed
2. Single-step factual task where prior context may matter:
   - prefer `memory_search` for a real keyword
   - use `memory_list` only when browsing is better than searching
3. Non-trivial task with multiple steps, uncertainty, debugging, planning, or trade-offs:
   - start with `reasoning_start_session`
   - then pull memory only if it changes the outcome

## Reasoning Workflow

For non-trivial tasks:

1. Call `reasoning_start_session` before the main investigation.
2. Add meaningful steps with `reasoning_add_step`.
3. Finish with `reasoning_complete_session`.

Do not:

- open a reasoning session after the important decisions already happened
- log every tiny action
- leave sessions open without an explicit end state

Good `reasoning_add_step` events:

- a new hypothesis
- a decision
- a rejected option
- an observation that changed understanding
- an action that materially moved the task forward

Bad `reasoning_add_step` events:

- every shell command
- every file read
- scratch noise with no durable value

## Memory Workflow

Use `memory_save` only for durable conclusions, not for live scratch work.

Good memory candidates:

- stable facts
- user or agent preferences
- decisions likely to matter again
- distilled reasoning outcomes

Bad memory candidates:

- full traces
- transient debugging notes
- secrets or tokens
- stale implementation minutiae

## Tool-Specific Guidance

### `memory_search`

Use when:

- you have a real topic, keyword, or hypothesis

Do not use when:

- you are just browsing broadly

### `memory_list`

Use when:

- you need recent or filtered browsing by type, tags, agent, or importance

Do not use when:

- you already know the search terms

### `memory_get`

Use when:

- you already have the exact memory id

### `memory_update`

Use when:

- an existing memory should be corrected in place

### `memory_delete`

Use when:

- a memory is wrong, duplicated, or unsafe to keep

### `reasoning_list_sessions`

Use when:

- you need to find prior sessions without knowing the id

Notes:

- results include grouped `step_count`
- optional filters: `agent_id`, `status`, `limit`, `offset`

### `reasoning_get_trace`

Use when:

- you need the full ordered step history for a known session

Do not use when:

- a durable memory already answers the question

### `reasoning_mark_step`

Use when:

- a step should be marked for later audit or summary views

Supported `mark_type` values:

- `milestone`
- `decision`
- `conflict`
- `important`
- `hypothesis`

Semantics:

- one `(step_id, mark_type)` row only
- same mark with new `note` updates that note
- same mark without `note` keeps the current note

### `reasoning_search_steps`

Use when:

- you need direct search across reasoning trace text

Notes:

- searches `thought`, `action`, and `observation`
- uses FTS, not plain `LIKE`
- supports optional `session_id`, `agent_id`, and `mark_type` filters

### `reasoning_list_milestones`

Use when:

- you want marked steps without loading a whole trace

Returns:

- session id
- step id
- step number
- mark type
- note
- timestamp
- short snippet

### `reasoning_get_session_outline`

Use when:

- you need a compact audit view of one session

Behavior:

- if marks exist, returns marked steps in deterministic order
- otherwise falls back to first, middle, last

### `reasoning_complete_session`

Use when:

- the session reached a conclusion
- the work is being abandoned explicitly

Notes:

- `save_as_memory=true` stores only the conclusion summary
- it does not persist the full reasoning trace into memory

## Audit Layer Notes

This repo now includes a lightweight reasoning audit layer:

- `reasoning_step_marks` stores explicit marks
- `reasoning_steps_fts` supports search over step text
- milestone and outline views are derived from trace data

Do not assume this is a tamper-evident audit log. It is an audit-oriented retrieval layer over agent-managed reasoning records.

## Safety Rules

Never store:

- passwords
- API keys
- tokens
- raw sensitive personal data
- full hidden chain-of-thought copied into durable memory

Also:

- `agent_id` is a filtering aid, not a real authorization boundary
- validate assumptions against schemas and handlers, not just this document

## Schema And Upgrade Notes

Database schema is migration-based.

Current migration set:

- `0001_initial`
- `0002_reasoning_step_marks`
- `0003_reasoning_steps_fts`

If you are reasoning about compatibility or startup behavior, inspect:

- `src/db.ts`
- `src/migrations/index.ts`
- `src/migrations/*.ts`

## Minimal Rule Of Thumb

- durable reusable knowledge -> `memory_*`
- live multi-step task trace -> `reasoning_*`
- non-trivial task -> start reasoning early
- audit/navigation over reasoning history -> use mark/search/milestone/outline tools instead of replaying everything
