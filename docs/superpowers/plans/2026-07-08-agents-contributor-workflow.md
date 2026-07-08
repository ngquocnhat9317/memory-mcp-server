# AGENTS Contributor Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite `AGENTS.md` so it becomes a strict contributor workflow contract for agents working inside this repository.

**Architecture:** Replace the current MCP-usage-heavy document with a short operational contract. Keep `README.md` as the user-facing install/usage guide, and make `AGENTS.md` point contributors toward code, tests, verification expectations, and minimal MCP-usage rules needed while working in-repo.

**Tech Stack:** Markdown docs, npm build/test verification, existing repo structure under `src/` and `src/__tests__/`

---

### Task 1: Rewrite `AGENTS.md`

**Files:**
- Modify: `AGENTS.md`
- Test: `README.md`

- [ ] **Step 1: Review the source material**

Read:

```text
AGENTS.md
README.md
docs/superpowers/specs/2026-07-08-agents-contributor-workflow-design.md
```

Expected: clear mapping of what stays in `README.md` versus what belongs in `AGENTS.md`

- [ ] **Step 2: Replace the existing AGENTS structure with a contributor contract**

Write `AGENTS.md` with these sections, in this order:

```md
# AGENTS.md

## Purpose
[Repo-working contract. README is user-facing.]

## Source of Truth
[Code first, tests second, docs follow.]

## Working Rules
[Read relevant code first, keep diffs small, preserve compatibility unless task requires change.]

## Verification
[Balanced verification policy.]

## Docs
[Only update docs when user-facing or docs become wrong.]

## Repo Map
[Key files and directories.]

## Using This MCP
[Call get_usage_guide when needed, use memory_* vs reasoning_* correctly, do not store secrets.]

## Done Criteria
[Change matches source of truth, tests preserved/updated, verification status reported.]
```

- [ ] **Step 3: Keep the wording strict and terse**

Apply these content constraints while editing:

```text
- no installation/setup instructions
- no long tool-by-tool catalog
- no migration list
- no user-facing MCP onboarding copied from README
- no speculative process that is not enforced by this repo
```

Expected: `AGENTS.md` is shorter and more operational than the current version.

- [ ] **Step 4: Verify the file still tells an in-repo agent how to use this MCP**

Check that `AGENTS.md` still includes:

```text
- call get_usage_guide when current runtime rules are needed
- use memory_* for durable facts/decisions/context
- use reasoning_* for multi-step investigation/debugging/planning
- do not store secrets/tokens/raw sensitive data
```

Expected: the file remains useful to contributors without becoming a user guide.

- [ ] **Step 5: Review the diff for scope control**

Run:

```bash
git diff -- AGENTS.md
```

Expected:

```text
- only AGENTS.md changed for this task
- README guidance is not duplicated
- the new file is shorter and stricter than before
```

- [ ] **Step 6: Run build verification**

Run:

```bash
npm run build
```

Expected: build succeeds

- [ ] **Step 7: Run full test suite**

Run:

```bash
npm test
```

Expected: all tests pass

- [ ] **Step 8: Commit**

```bash
git add AGENTS.md docs/superpowers/plans/2026-07-08-agents-contributor-workflow.md docs/superpowers/specs/2026-07-08-agents-contributor-workflow-design.md
git commit -m "docs: rewrite AGENTS contributor workflow"
```
