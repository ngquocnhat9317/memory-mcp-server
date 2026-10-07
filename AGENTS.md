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

- Do not copy `README.md` setup guidance into this file.
- `CLAUDE.md` only imports this file (`@AGENTS.md`) — edit the rules here, not there.

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
8. After the change is merged to `master`, publish by pushing a tag: `git tag vX.Y.Z && git push origin vX.Y.Z`. `.github/workflows/release.yml` verifies the tag against `package.json`, `MCP_VERSION` and `CHANGELOG.md`, runs the tests, publishes to npm (Trusted Publishing, no token) and creates the GitHub Release. A failed run can be re-run: a version already on npm from the same commit is skipped (from a different commit it fails), and an existing or draft GitHub Release for the tag gets the CHANGELOG notes and is published. Do not run `npm publish` by hand.

## Version-Sync Conventions

- **Always sync docs in the same change as the code update.** After any code change, re-check `GUIDELINES.md`, `README.md`, `CHANGELOG.md`, and `docs/architecture.md`; if the behavior or structure they describe changed, update them together with the code — never leave them one release behind.
- `GUIDELINES.md`'s `Version:` line must match the version asserted in `src/__tests__/reasoning-audit-tools.test.ts` (`structuredContent.guide_version`). When `GUIDELINES.md` changes, bump its `Version:` line and update that assertion in the same change.
- `docs/architecture.md`'s `Version:` line must match `package.json`'s `version` field, enforced by `src/__tests__/architecture-doc-version.test.ts`. Bump both together on every release — even a release with no architectural change — or the test fails the build.

## Tool Surface Policy

When deciding whether a registered tool should be kept, improved, or removed
for low real-world usage, use this standing threshold (owner decision,
2026-08-07):

- **Metric:** `tool_rate = (tool calls in the observation window) / (reasoning
  sessions opened in the same window) × 100%`. Read straight from
  `tool_usage_events` (`GROUP BY tool_name`) and `reasoning_sessions`
  (`COUNT(*) WHERE created_at >= <window start>`) — no `session_id` join
  required. A tool called more than once per session can exceed 100%; that is
  correct, not a bug in the formula.
- **Thresholds:**
  - `tool_rate >= 30%` → keep as-is, no action.
  - `5% < tool_rate < 30%` → under-used; review and propose an improvement
    (better guidance, clearer trigger, or a design change) before considering
    removal.
  - `tool_rate <= 5%` → candidate for removal and surface cleanup.
- **Observation window:** count only from the start of the currently-running
  `GUIDELINES.md` version — mixing data from a prior guide version dilutes the
  signal a guide change was meant to produce. Record the window's start/end
  dates and the guide version in effect wherever the metric is reported.
- **Minimum sample:** do not decide on fewer than 20 reasoning sessions opened
  in the window; extend the window instead of deciding on a small sample.
- **A high `tool_rate` is necessary, not sufficient.** A tool whose output
  or stored data is never exploited — no agent-facing read path and no
  server-side use — is a removal candidate at any rate: being called without
  being exploited only spends tokens. Data that no remaining tool, server
  path or documented measurement query (e.g. the recall used-rate query in
  `docs/architecture.md`) reads is deleted with a migration, not kept "for
  later".
- **Removing a tool is a breaking change to the MCP tool surface** — it
  requires its own `MCP_VERSION`/`package.json` bump and `CHANGELOG.md` entry
  per the Release Process above, regardless of which version line it lands on.
- A specific application of this policy (window dates, removal list, the
  reusable SQL) lives in
  [`docs/design/2026-10-06-spec-v1.4.0-tool-surface-reduction.md`](docs/design/2026-10-06-spec-v1.4.0-tool-surface-reduction.md)
  §3.1 — this section is the durable rule, that spec is one measurement
  against it.

## Repo Map

- `src/tools/memory.ts` — memory tools and usage feedback
- `src/tools/reasoning.ts` — reasoning session tools and `reasoning_find`
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
