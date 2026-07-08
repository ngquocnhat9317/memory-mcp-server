# AGENTS.md

## Purpose

This file is the working contract for an agent contributing inside this repository.

Use `README.md` for user-facing MCP installation and usage guidance. Use this file for repo contribution rules.

## Source of Truth

- Trust code first.
- Trust tests second.
- If docs disagree with code or tests, trust code and tests.
- Preserve tested behavior or update the tests together with the change.

Primary source-of-truth paths:

- `src/tools/*`
- `src/schemas/*`
- `src/db.ts`
- `src/migrations/*`
- `src/__tests__/*`

## Working Rules

- Read the relevant code before editing.
- Keep diffs small.
- Do not change public behavior until the impact is clear.
- Preserve compatibility unless the task explicitly requires behavior change.
- Do not invent commands, tools, or runtime behavior that the repo does not implement.

## Verification

- Run `npm run build` and `npm test` for behavior, tool surface, schema, migration, or test changes.
- Docs-only or very small low-risk changes may skip verification, but state that explicitly in the final report.

## Docs

- Update docs only when the change is user-facing or when existing docs become inaccurate.
- Do not copy `README.md` setup guidance into this file.

## Repo Map

- `src/tools/memory.ts` — memory tools, telemetry reports, feedback tools
- `src/tools/reasoning.ts` — reasoning session and audit tools
- `src/tools/usage-guide.ts` — `get_usage_guide`
- `src/schemas/*` — input contracts
- `src/db.ts` — DB bootstrap and migration startup
- `src/migrations/*` — schema migrations
- `src/__tests__/*` — behavior locks

## Using This MCP

When this MCP is available while working in the repo:

- Call `get_usage_guide` when you need the current runtime usage rules.
- Use `memory_*` tools for durable facts, decisions, and reusable context.
- Use `reasoning_*` tools for multi-step investigation, debugging, or planning.
- Do not store secrets, tokens, or raw sensitive data.

## Done Criteria

- The change matches code source-of-truth.
- Related tests are preserved or updated.
- Verification status is reported clearly.
