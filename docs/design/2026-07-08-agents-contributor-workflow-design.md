# AGENTS.md Contributor Workflow Design

Date: 2026-07-08
Status: Draft for review

## Goal

Rewrite `AGENTS.md` so it acts as a working contract for an agent contributing inside this repository.

The new file should not be a user-facing MCP guide. That role now belongs to `README.md`.

## Scope

This change only rewrites `AGENTS.md`.

It does not:

- change MCP behavior
- change tool schemas
- change tests
- duplicate the installation/setup guidance from `README.md`

## Intended Reader

An agent actively editing this repository.

The file should help that agent answer:

- what files are source of truth
- how much to trust code, tests, and docs
- when to verify
- when docs must be updated
- how to use this MCP while working in this repo

## Agreed Design

Tone:

- strict
- terse
- operational

Verification policy:

- balanced

Source-of-truth policy:

- code first
- tests second
- preserve tested behavior or update tests together with the change

Docs policy:

- update docs only when the change is user-facing or when the existing docs become wrong

## Proposed Structure

The new `AGENTS.md` should contain these sections:

1. `Purpose`
   - states that this is a repo-working contract for contributors/agents
   - states that `README.md` is the user-facing MCP guide

2. `Source of Truth`
   - prefer `src/tools/*`, `src/schemas/*`, `src/db.ts`, `src/migrations/*`
   - treat tests as behavior locks
   - if docs disagree with code/tests, trust code/tests

3. `Working Rules`
   - read relevant code before editing
   - keep diffs small
   - avoid changing public behavior without understanding impact
   - preserve compatibility unless the task requires a behavior change

4. `Verification`
   - run `npm run build` and `npm test` for behavior/tool/schema/migration/test-surface changes
   - docs-only or very small low-risk changes may skip verification, but the agent must say so explicitly

5. `Docs`
   - update docs only for user-facing changes or when the docs are made inaccurate by the change

6. `Repo Map`
   - `src/tools/memory.ts`
   - `src/tools/reasoning.ts`
   - `src/tools/usage-guide.ts`
   - `src/schemas/*`
   - `src/db.ts`
   - `src/migrations/*`
   - `src/__tests__/*`

7. `Using This MCP`
   - if this MCP is available while working in the repo:
     - call `get_usage_guide` when current runtime usage rules are needed
     - use `memory_*` for durable facts/decisions/context
     - use `reasoning_*` for multi-step investigation/debugging/planning
     - do not store secrets, tokens, or raw sensitive data

8. `Done Criteria`
   - change matches code source-of-truth
   - related tests are preserved or updated
   - verification status is reported clearly

## Content Constraints

The rewritten file should:

- stay short
- avoid long tool-by-tool documentation
- avoid installation/setup instructions
- avoid duplicating `README.md`
- avoid contributor ceremony that is not enforced by the repo

## Recommended Outcome

Replace the current MCP-usage-heavy `AGENTS.md` with a contributor-oriented file that is shorter, stricter, and easier for an in-repo agent to follow during implementation work.
