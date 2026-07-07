# Memory MCP Guidelines

Version: 2026-07-07.v1

This file is the single source of truth for how an agent should use this MCP.

## Fast Rule

1. Trivial one-step lookup:
   - do not open a reasoning session
   - do not use memory tools unless prior recall is actually needed
2. Single-step factual task where prior context may change the answer:
   - use `memory_search` when you have a real keyword or topic
   - use `memory_list` only when browsing is better than searching
3. Non-trivial task with multiple steps, uncertainty, debugging, planning, review, or trade-offs:
   - start with `reasoning_start_session` before the main investigation
   - add only meaningful steps with `reasoning_add_step`
   - finish with `reasoning_complete_session`
   - save only durable conclusions

## Tool Choice

- `memory_search`: targeted recall by keyword, topic, or hypothesis
- `memory_list`: recent or filtered browsing
- `memory_get`: fetch one memory when you already know the exact id
- `memory_save`: store durable facts, decisions, preferences, or reasoning summaries
- `memory_update`: correct an existing memory in place
- `memory_delete`: remove unsafe, duplicated, or wrong memory
- `reasoning_start_session`: open live trace capture for a non-trivial task
- `reasoning_add_step`: log a decision, hypothesis, rejected option, or meaningful observation
- `reasoning_complete_session`: close the session and optionally persist only the conclusion

## Do Not Store

- secrets, tokens, or credentials
- full hidden chain-of-thought
- transient debugging noise
- raw tool dumps with no durable value

## Rule Of Thumb

- durable reusable knowledge -> `memory_*`
- live multi-step task trace -> `reasoning_*`
- when in doubt, skip storage unless the information will help a future agent or future run
