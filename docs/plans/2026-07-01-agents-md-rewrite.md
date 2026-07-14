# AGENTS.md Rewrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite `AGENTS.md` so it contains only tool rules and a strict, detailed reasoning-first workflow for `memory_*` and `reasoning_*`.

**Architecture:** Keep a single repo-root instruction file. Remove general repo guidance and replace it with behavior-grounded rules derived from `src/tools/memory.ts` and `src/tools/reasoning.ts`. Optimize for “which tool to call when” rather than broad documentation.

**Tech Stack:** Markdown, MCP tool semantics from the TypeScript implementation

---

### Task 1: Rewrite the agent instruction file

**Files:**
- Modify: `AGENTS.md`

- [ ] **Step 1: Re-read the source-of-truth tool behavior**

Read:
- `src/tools/memory.ts`
- `src/tools/reasoning.ts`

Expected: confirm the file only documents behavior that exists in code.

- [ ] **Step 2: Replace the current broad guidance with a strict decision tree**

Write `AGENTS.md` so it contains:
- core rules only for this MCP
- a reasoning-first decision tree
- per-tool rules for every `memory_*` and `reasoning_*` tool
- quality guardrails

Expected: no generic repo guidance, no setup notes, no validation section unless directly relevant to tool behavior.

- [ ] **Step 3: Verify the rewritten file matches real tool logic**

Check:
- `memory_search` is query-first search, not browse
- `memory_list` is browse/filter, not search
- `memory_get` / `memory_update` / `memory_delete` are id-based
- `reasoning_add_step` requires at least one of `thought`, `action`, `observation`
- `reasoning_add_step` only works for `in_progress` sessions
- `reasoning_complete_session` can persist a `reasoning_summary` via `save_as_memory=true`

Expected: no instruction in `AGENTS.md` contradicts these rules.
