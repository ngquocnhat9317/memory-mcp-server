# CLAUDE.md

> This file mirrors `AGENTS.md` — if you edit one, apply the same edit to the other.

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

- Do not copy `README.md` setup guidance into this file.
- `AGENTS.md` is the twin of this file — apply any edit here to `AGENTS.md` as well.

## Docs Conventions

- New design spec → `docs/design/YYYY-MM-DD-<topic>.md`.
- New implementation plan → `docs/plans/YYYY-MM-DD-<topic>.md`.
- Go-to-market docs (positioning, registry/directory submissions) → `docs/growth/`.
- `docs/architecture.md` and `docs/roadmap.md` are living documents, not specs — edit them in place rather than superseding them with a new dated file.

## Release Process

When bumping the package version, update in this order, in the same change:

1. `package.json` `version`.
2. `MCP_VERSION` in `src/constants.ts`.
3. `docs/architecture.md` `Version:` line — bump only after confirming the document still matches the code (see Version-Sync Conventions).
4. `CHANGELOG.md` — add a release entry.
5. `GUIDELINES.md` `Version:` line, only if agent-facing behavior changed.
6. Run `npm run build && npm test`.
7. Move the relevant row from Planned to Shipped in `docs/roadmap.md`.

## Version-Sync Conventions

- **Always sync docs in the same change as the code update.** After any code change, re-check `GUIDELINES.md`, `README.md`, `CHANGELOG.md`, and `docs/architecture.md`; if the behavior or structure they describe changed, update them together with the code — never leave them one release behind.
- `GUIDELINES.md`'s `Version:` line must match the version asserted in `src/__tests__/reasoning-audit-tools.test.ts` (`structuredContent.guide_version`). When `GUIDELINES.md` changes, bump its `Version:` line and update that assertion in the same change.
- `docs/architecture.md`'s `Version:` line must match `package.json`'s `version` field, enforced by `src/__tests__/architecture-doc-version.test.ts`. Bump both together on every release — even a release with no architectural change — or the test fails the build.

## Repo Map

- `src/tools/memory.ts` — memory tools, telemetry reports, feedback tools
- `src/tools/reasoning.ts` — reasoning session and audit tools
- `src/tools/telemetry.ts` — shared usage-event recording for memory/reasoning tools
- `src/tools/usage-guide.ts` — `get_usage_guide`
- `src/schemas/*` — input contracts
- `src/db.ts` — DB bootstrap and migration startup
- `src/migrations/*` — schema migrations
- `src/__tests__/*` — behavior locks
- `docs/architecture.md` — system architecture; `Version:` line must match `package.json` (see Version-Sync Conventions below)
- `docs/roadmap.md` — consolidated shipped/planned roadmap
- `docs/design/*` — design specs (what/why)
- `docs/plans/*` — implementation plans (how, done)
- `docs/growth/*` — go-to-market docs

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
