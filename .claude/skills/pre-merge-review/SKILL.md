---
name: pre-merge-review
description: Runs a pre-merge quality gate on the memory-mcp-server repository — verifies the build has no errors, unit tests pass 100%, docs (README/CHANGELOG/GUIDELINES/docs/architecture.md/docs/roadmap.md) are still in sync with whatever code changed, and every version marker (package.json, MCP_VERSION, docs/architecture.md, GUIDELINES.md) still points at the same version. Use this whenever the user asks to review before merging, review a branch/PR, check if something is ready to merge, "review code và docs trước khi merge", "kiểm tra trước khi merge", or wants a go/no-go on shipping a change — even if they don't name this skill directly. Spawns one subagent for code+tests and one for docs+version sync, then reports a single PASS/BLOCK verdict.
---

# Pre-Merge Review

## Why this exists

This repo has three things that are easy to get right individually and easy
to let drift apart under time pressure: the code, the tests, and the docs
that describe both (including a hard version lock between `package.json`,
`MCP_VERSION`, `docs/architecture.md`, and `GUIDELINES.md` — see
`CLAUDE.md`'s Version-Sync Conventions). A merge should not go through with
any of those three out of alignment. This skill runs a structured check of
all three before you merge, so the reviewer (human or agent) doesn't have to
remember the full checklist by hand every time.

**Do not hand-review this yourself when the skill applies.** Reviewing code
and docs in the same pass, from the same head, biases you toward missing the
exact thing this skill exists to catch: a code change that shipped without
its matching doc update. Splitting the two into independent subagents that
don't see each other's findings is the point — keep that separation.

## Process

### Step 1 — Establish scope

Determine:
- **Repo root**: `git rev-parse --show-toplevel` — never hardcode a path;
  this must work whether you're in the primary checkout or a git worktree
  checked out on another branch.
- **Current branch**: `git branch --show-current`
- **Base branch**: `develop` by default (this repo's integration branch — see
  `git branch -a`). If the user names a different base, use that instead.
- **Commit range**: `git log <base>..HEAD --oneline` and
  `git diff <base>...HEAD --stat` — this is the actual scope of the review.
  If the range is empty, tell the user there's nothing to review and stop.

If the working tree has uncommitted changes (`git status --short` is
non-empty), tell the user and ask whether to include them in scope or to
commit first — don't silently review a moving target.

### Step 2 — Spawn two independent subagents, in parallel

Use the `Agent` tool with **`run_in_background: false` on both calls, sent
in the same message.** Both still run concurrently — two tool calls in one
message always do — but `run_in_background: false` makes each call block
until its result comes back, so your turn does not end until you actually
have both reports in hand. If you fire these in the default background mode
instead, the harness lets your turn end right after the two "launched"
acknowledgements, before either subagent has produced anything, and there is
no guarantee anything resumes you to pick the results back up afterward —
you would appear to finish the review having produced nothing. Do not use
background mode for this step.

Each subagent gets only the prompt below — it does not see the other's
output, and it does not see this conversation's history. Fill in
`<repo-root>`, `<base>`, `<current-branch>`,
and the commit range from Step 1.

**Subagent 1 — Code & Tests:**

```
You are reviewing a code change in the memory-mcp-server repo before it
merges. Repo root: <repo-root>
Base branch: <base>   Current branch: <current-branch>
Diff scope: git diff <base>...<current-branch>

This repo has no linter configured — TypeScript's strict-mode compiler
(`tsc`) and the test suite are the only automated correctness gates. Do
this:

1. Run `npm run build`. Report the exact result (pass, or the exact
   compiler errors).
2. Run `npm test`. Report the exact pass/fail/total counts. 100% pass is
   required — any failure is a blocking finding, quote the failing test
   name and assertion.
3. Run `git diff <base>...<current-branch> --stat` then look at the full
   diff for files under `src/` (skip `src/__tests__/*` for this step —
   you'll cross-check those in step 4). For each changed file, read enough
   surrounding context to judge correctness: does the change do what it
   appears to intend, does it follow this repo's existing patterns (read
   a neighboring file in the same directory if unsure what "existing
   pattern" means here), does it introduce anything CLAUDE.md's Working
   Rules forbid (speculative abstractions, behavior changes without
   updating tests, invented commands/behavior not implemented elsewhere)?
4. This repo has no code-coverage tool (no nyc/c8/istanbul) — so "coverage"
   here means a reasoning check, not a percentage. For every changed or
   added function/branch in the `src/` diff, find the test(s) in
   `src/__tests__/` that actually exercise it. List any changed behavior
   you cannot find a corresponding test for — that's a blocking gap, not a
   suggestion.
5. Read `CLAUDE.md`'s "Source of Truth" and "Working Rules" sections in the
   repo root and confirm the diff doesn't violate them.

Report back in this exact structure:

## Build
<pass, or exact errors>

## Tests
<X/Y passed. If any failed, name + assertion for each.>

## Code Review Findings
For each finding: severity (BLOCKING / MINOR), file:line, one-sentence
description, why it matters. Empty list if none.

## Test Coverage Gaps
For each gap: file:line of the untested change, what behavior has no test.
Empty list if none.
```

**Subagent 2 — Docs & Version Sync:**

```
You are reviewing a code change in the memory-mcp-server repo before it
merges, specifically for documentation sync and version consistency. Repo
root: <repo-root>
Base branch: <base>   Current branch: <current-branch>
Diff scope: git diff <base>...<current-branch>

First, read `CLAUDE.md` in the repo root — specifically the "Docs
Conventions", "Release Process", and "Version-Sync Conventions" sections.
Those sections are the current source of truth for what must stay in sync;
follow whatever they say even if it differs from what's summarized below
(they may have changed since this skill was written).

Do this:

1. Run `git diff <base>...<current-branch> --stat` to see the full change
   set. Separate it mentally into: (a) behavior-changing code under `src/`
   (excluding tests), (b) everything else.
2. If (a) is non-empty, check whether the diff also touches the docs that
   describe that behavior:
   - `README.md` — if the tool surface, config, or user-facing behavior
     changed, its Tool Surface table / Configuration table / relevant prose
     should have changed too.
   - `CHANGELOG.md` — any shipped behavior change should have an entry.
   - `GUIDELINES.md` — if agent-facing tool behavior changed (what an agent
     calling this MCP should do differently), the guide should reflect it,
     and its `Version:` line should be bumped along with the assertion in
     `src/__tests__/reasoning-audit-tools.test.ts`.
   - `docs/architecture.md` — if the module map, data flow, storage model,
     or tool surface changed (Sections 3-5 of that file), it should have
     been updated in the same diff per its own Section 6 sync rule.
   For anything in (a) with no corresponding doc update, that's a blocking
   finding — quote the src file:line and name the doc that's now stale.
3. Verify version mapping across these four locations, independent of
   whether anything in the diff touched them:
   - `package.json` → `version` field
   - `src/constants.ts` → `MCP_VERSION` constant
   - `docs/architecture.md` → the `Version:` line near the top
   - `GUIDELINES.md` → the `Version:` line, cross-checked against the
     `guide_version` literal asserted in
     `src/__tests__/reasoning-audit-tools.test.ts`
   `package.json`, `MCP_VERSION`, and `docs/architecture.md`'s `Version:`
   line must all read the same value. If `GUIDELINES.md` changed in this
   diff, its version and the test assertion must match each other (they
   don't need to equal the package version — GUIDELINES uses its own dated
   version scheme). Report the exact value found at each location and flag
   any mismatch as blocking.
4. Confirm the new-file placement conventions were followed if the diff
   added any new doc: design specs under `docs/design/`, implementation
   plans under `docs/plans/`, go-to-market docs under `docs/growth/` (per
   CLAUDE.md's Docs Conventions).

Report back in this exact structure:

## Docs Sync
For each finding: severity (BLOCKING / MINOR), the src change, the doc
that's stale or missing an update, why it matters. Empty list if none.

## Version Mapping
Table of the four locations and the value found at each. Then: MATCH or
MISMATCH, with specifics if mismatched.

## Placement Conventions
Any new doc file that didn't follow the Docs Conventions. Empty list if
none.
```

### Step 3 — Aggregate and report

Once both subagents return, write a single report yourself (don't just
concatenate their output — synthesize it). Use this structure:

```
# Pre-Merge Review — <current-branch> → <base>

**Scope:** <N> commits, <M> files changed (`git diff <base>...<current-branch> --stat` summary)

## Code & Tests
<synthesized from Subagent 1: build result, test pass rate, findings, coverage gaps>

## Docs & Version Sync
<synthesized from Subagent 2: docs sync findings, version mapping table, placement issues>

## Verdict: PASS | BLOCK

<If BLOCK: numbered list of every BLOCKING finding from either subagent,
each with file:line and the specific fix needed — this list is what has to
be resolved before merge.>

<If PASS: note any MINOR findings as optional follow-ups; state plainly
that build passed, tests are 100%, docs are in sync, and versions match.>
```

**Verdict rule:** any single BLOCKING finding from either subagent forces
`BLOCK`. MINOR findings never block — they're judgment calls the human can
take or leave. Don't soften a BLOCKING finding into a suggestion just
because the rest of the change looks good.

## Notes

- If the environment has no subagent support, run both checklists yourself
  sequentially instead of spawning agents, and still produce the same final
  report structure — the report format matters more than how you produced
  it.
- This skill reviews what's in the diff. It does not re-litigate
  pre-existing issues outside the diff's scope unless they're severe enough
  to block correctness of the new change (e.g., the new code depends on
  already-broken behavior).
- If `CLAUDE.md`'s Docs Conventions / Release Process / Version-Sync
  Conventions sections have changed since this skill was written, trust the
  live file over this skill's summary of it — Subagent 2 is instructed to
  read it fresh every run for exactly this reason.
