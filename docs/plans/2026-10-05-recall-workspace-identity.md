# Recall Workspace Identity + Scoped Blended Scoring — Implementation Plan

**Goal:** Make `reasoning_start_session` auto-recall stop returning other-project, stale, and irrelevant memories, by fixing workspace identity and replacing the lexicographic comparator with a gated blended score.

**Architecture:** Workspace resolution moves into `getWorkspace(explicit?)` and returns `null` for `/`, the home dir, or empty. Sessions persist their resolved workspace (migration 0006) so session conclusions inherit it. `recallRelatedMemories` gains a workspace-tiered candidate pool, a strict cross-project gate (with a `preference` bypass), a stale-feedback exclusion, a blended score, and no "lifeline" fallback. `toRecallTerms` drops generic stopwords.

**Tech Stack:** TypeScript (ES2022, Node16 modules), `node:sqlite` (FTS5), `zod`, `node:test`. Tests run against compiled `dist/` (`npm test` builds first).

**Spec:** [docs/design/2026-10-05-spec-recall-workspace-identity.md](../design/2026-10-05-spec-recall-workspace-identity.md) (rev 0.2, approved). Read it before starting; this plan implements it and does not restate every rationale.

## Global Constraints

- Target version **1.3.3** (`package.json` `version` and `MCP_VERSION` in `src/constants.ts`); `docs/architecture.md` `Version:` must match `package.json` (enforced by `src/__tests__/architecture-doc-version.test.ts`).
- `GUIDELINES.md` `Version:` → `2026-10-05.v8`, and the `guide_version` assertion in `src/__tests__/reasoning-audit-tools.test.ts` must change in the same change.
- Score weights (hard-coded constants, no new env var): coverage **0.45**, bm25_norm **0.20**, workspace_term **0.30**, recency **0.05**; recency = `1 / (1 + age_days / 60)` from `updated_at`.
- Cross-project gate: other-workspace, non-`preference` memory needs `matched >= max(2, ceil(0.75 · N))`; home/NULL/`preference` need the base floor `matched >= (N >= 3 ? 2 : 1)`. `N` = number of recall terms.
- Workspace term: home 1.0; NULL or `preference` 0.5; other 0.0; constant 0.5 when the current workspace is unknown. Equals `workspace_priority / 2` where priority is home 2, NULL-or-preference 1, other 0.
- No lifeline: if nothing is eligible, `related_memories` is `[]`.
- Exclude memories with a successful `feedback` event whose `metadata.usefulness` is `stale` or `unsafe_to_use`.
- `memory_search` is **not** changed (OQ-4). No new dependencies. No new config.
- Verification command for every task: `npm run build && npm test` (baseline before any change: 75 tests pass).
- **Commits:** none during implementation; the whole change is committed once, after review. Work on a feature branch: `git switch -c feat/recall-workspace-identity` before the first edit (the starting branch is `develop`).

## File Structure

| File | Responsibility after this change |
|---|---|
| `src/constants.ts` | `normalizeWorkspace`, `getWorkspace(explicit?)` → `string \| null`; `MCP_VERSION` |
| `src/utils.ts` | `toRecallTerms` + stopword list (pure, no DB) |
| `src/types.ts` | `ReasoningSessionRow.workspace` |
| `src/migrations/0006_workspace_identity.ts` (new), `src/migrations/index.ts` | session workspace column + legacy `/`/home cleanup |
| `src/schemas/reasoning.ts`, `src/schemas/memory.ts` | optional `workspace` input |
| `src/tools/reasoning.ts` | start/complete workspace handling; the only place recall weights live |
| `src/tools/memory.ts` | `memory_save` uses explicit workspace |
| `src/__tests__/workspace-identity.test.ts` (new) | all new behavior tests (AC-1…AC-10) |
| other tests | updated only where they encode the old lifeline / importance-over-recency behavior |
| docs | synced per spec §7 |

---

### Task 1: Workspace resolution + `memory_save` workspace parameter

Covers AC-1, AC-10 (memory half).

**Files:**
- Modify: `src/constants.ts` (`getWorkspace`, ~line 44-46)
- Modify: `src/schemas/memory.ts` (`MemorySaveInputSchema`, after `agent_id`, ~line 59)
- Modify: `src/tools/memory.ts:233` (description) and `:286` (`workspace: getWorkspace(...)`)
- Create: `src/__tests__/workspace-identity.test.ts`

**Interfaces:**
- Produces: `normalizeWorkspace(raw: string | null | undefined): string | null`; `getWorkspace(explicit?: string): string | null` (precedence: trimmed `explicit` → `MEMORY_WORKSPACE` → `process.cwd()`, then normalized).
- Consumes: nothing.

- [ ] **Step 0: Create the feature branch**

```bash
git switch -c feat/recall-workspace-identity
```

- [ ] **Step 1: Write the failing tests**

Create `src/__tests__/workspace-identity.test.ts` with the shared harness used by every later task, plus the first tests:

```ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getWorkspace, normalizeWorkspace } from "../constants.js";
import { runMigrations } from "../migrations/index.js";
import { toRecallTerms } from "../utils.js";

function makeWorkspaceDbPath(name: string): string {
  const dir = fs.mkdtempSync(path.join(process.cwd(), ".tmp-memory-mcp-"));
  return path.join(dir, `${name}.db`);
}

type ToolResult = {
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
};
type RegisteredToolMap = Record<
  string,
  { handler: (params: Record<string, unknown>) => Promise<ToolResult> }
>;

async function makeHarness(name: string): Promise<{
  toolDb: DatabaseSync;
  toolDir: string;
  tools: RegisteredToolMap;
}> {
  const toolDbPath = makeWorkspaceDbPath(name);
  const toolDir = path.dirname(toolDbPath);
  const toolDb = new DatabaseSync(toolDbPath);
  runMigrations(toolDb);

  const { registerMemoryTools } = await import("../tools/memory.js");
  const { registerReasoningTools } = await import("../tools/reasoning.js");
  const server = new McpServer({ name: "test-server", version: "1.3.3" });
  registerMemoryTools(server, toolDb);
  registerReasoningTools(server, toolDb);

  const tools = (server as unknown as { _registeredTools: RegisteredToolMap })
    ._registeredTools;
  return { toolDb, toolDir, tools };
}

function cleanup(toolDb: DatabaseSync, toolDir: string): void {
  toolDb.close();
  fs.rmSync(toolDir, { recursive: true, force: true });
}

function insertMemory(
  db: DatabaseSync,
  fields: {
    id: string;
    content: string;
    type?: string;
    workspace?: string | null;
    importance?: number;
    updatedAt?: string;
  }
): void {
  db.prepare(
    `INSERT INTO memories (id, type, content, tags, agent_id, importance, metadata, workspace, created_at, updated_at)
     VALUES (?, ?, ?, '[]', NULL, ?, NULL, ?, ?, ?)`
  ).run(
    fields.id,
    fields.type ?? "fact",
    fields.content,
    fields.importance ?? 3,
    fields.workspace ?? null,
    "2026-07-01T00:00:00.000Z",
    fields.updatedAt ?? "2026-07-01T00:00:00.000Z"
  );
}

async function recall(
  tools: RegisteredToolMap,
  title: string,
  workspace?: string
): Promise<string[]> {
  const started = await tools.reasoning_start_session.handler(
    workspace === undefined ? { title } : { title, workspace }
  );
  assert.equal(started.isError, undefined);
  const payload = started.structuredContent as {
    related_memories: Array<{ id: string }>;
  };
  return payload.related_memories.map((row) => row.id);
}

function withEnv<T>(name: string, value: string | undefined, fn: () => T): T {
  const original = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return fn();
  } finally {
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  }
}

test("normalizeWorkspace treats empty, root and home as unknown (AC-1)", () => {
  assert.equal(normalizeWorkspace(undefined), null);
  assert.equal(normalizeWorkspace(null), null);
  assert.equal(normalizeWorkspace(""), null);
  assert.equal(normalizeWorkspace("   "), null);
  assert.equal(normalizeWorkspace("/"), null);
  assert.equal(normalizeWorkspace(os.homedir()), null);
  assert.equal(normalizeWorkspace(`${os.homedir()}/`), null);
});

test("normalizeWorkspace trims and strips trailing separators (AC-1)", () => {
  assert.equal(normalizeWorkspace("/proj/a"), "/proj/a");
  assert.equal(normalizeWorkspace("/proj/a/"), "/proj/a");
  assert.equal(normalizeWorkspace("  /proj/a//  "), "/proj/a");
});

test("getWorkspace precedence is explicit, then MEMORY_WORKSPACE, then cwd (AC-1)", () => {
  withEnv("MEMORY_WORKSPACE", "/env-ws", () => {
    assert.equal(getWorkspace("/explicit/"), "/explicit");
    assert.equal(getWorkspace(), "/env-ws");
    assert.equal(getWorkspace("   "), "/env-ws");
    assert.equal(getWorkspace("/"), null, "explicit root is unknown, not a fall-through");
  });
  withEnv("MEMORY_WORKSPACE", undefined, () => {
    assert.equal(getWorkspace(), process.cwd());
  });
});

test("memory_save stores the explicit workspace, normalized (AC-10)", async () => {
  const { toolDb, toolDir, tools } = await makeHarness("ws-save-explicit");
  try {
    const saved = await tools.memory_save.handler({
      content: "saved from an explicit project",
      type: "fact",
      importance: 3,
      workspace: "/proj/x/",
    });
    assert.equal(saved.isError, undefined);
    const id = (saved.structuredContent as { id: string }).id;
    const row = toolDb
      .prepare(`SELECT workspace FROM memories WHERE id = ?`)
      .get(id) as { workspace: string | null };
    assert.equal(row.workspace, "/proj/x");
  } finally {
    cleanup(toolDb, toolDir);
  }
});

test("memory_save stores NULL when the workspace is unknown (AC-10)", async () => {
  const { toolDb, toolDir, tools } = await makeHarness("ws-save-unknown");
  try {
    const saved = await tools.memory_save.handler({
      content: "saved from an unknown project",
      type: "fact",
      importance: 3,
      workspace: "/",
    });
    assert.equal(saved.isError, undefined);
    const id = (saved.structuredContent as { id: string }).id;
    const row = toolDb
      .prepare(`SELECT workspace FROM memories WHERE id = ?`)
      .get(id) as { workspace: string | null };
    assert.equal(row.workspace, null);
  } finally {
    cleanup(toolDb, toolDir);
  }
});
```

(`toRecallTerms` is imported now so Task 3 only appends tests.)

- [ ] **Step 2: Run to verify failure**

Run: `npm run build 2>&1 | tail -20`
Expected: **build error** — `normalizeWorkspace` is not exported from `../constants.js`, and `workspace` is not a known key. (Tests run on compiled output, so a compile failure is the "red" state here.)

- [ ] **Step 3: Implement `src/constants.ts`**

Replace the existing `getWorkspace` (and its doc comment) with:

```ts
function stripTrailingSeparators(value: string): string {
  let result = value.trim();
  while (result.length > 1 && /[\\/]$/.test(result)) {
    result = result.slice(0, -1);
  }
  return result;
}

/**
 * Normalizes a workspace path: trims it and strips trailing separators.
 * Returns null ("unknown") for values that cannot identify a project —
 * empty, "/", and the home directory. Desktop clients launch the server
 * from those, and treating them as a project merges unrelated projects.
 */
export function normalizeWorkspace(
  raw: string | null | undefined
): string | null {
  if (!raw) return null;
  const value = stripTrailingSeparators(raw);
  if (value === "" || value === "/") return null;
  if (value === stripTrailingSeparators(os.homedir())) return null;
  return value;
}

/**
 * Workspace identity for memory scoping, or null when unknown. Precedence:
 * an explicit value passed by the agent (it always knows its project),
 * then MEMORY_WORKSPACE, then process.cwd() — Claude Code/Codex launch the
 * server inside the project, desktop apps often do not. Read at call time
 * (same pattern as isTelemetryEnabled) for testability.
 */
export function getWorkspace(explicit?: string): string | null {
  return normalizeWorkspace(
    explicit?.trim() || process.env.MEMORY_WORKSPACE || process.cwd()
  );
}
```

- [ ] **Step 4: Implement the schema field and `memory_save`**

In `src/schemas/memory.ts`, inside `MemorySaveInputSchema` after the `agent_id` field:

```ts
    workspace: z
      .string()
      .max(500)
      .optional()
      .describe(
        "Absolute path of the project directory this memory belongs to. Pass your current working directory so recall can prefer this project's memories. If omitted the server uses its own working directory; '/' and the home directory count as unknown."
      ),
```

In `src/tools/memory.ts` change line 286 to:

```ts
            workspace: getWorkspace(params.workspace),
```

and replace the `memory_save` tool description (line 233) with:

```ts
        "Persist a piece of long-term memory so it can be recalled in future sessions. Returns the created memory's id. Tags describe topics ('sqlite', 'auth', 'perf'), not locations — do not put workspace or project names in tags. Pass workspace (your project directory) so the memory is scoped to this project; if omitted the server records its own working directory, and '/' or the home directory are stored as unknown.",
```

- [ ] **Step 5: Run to verify pass**

Run: `npm run build && npm test 2>&1 | tail -12`
Expected: build clean; `# pass` = 75 + 5 new = 80, `# fail 0`. (If an existing test fails, read it — only the AC-9.4 `MEMORY_WORKSPACE` test touches this code and must still pass.)

- [ ] **Step 6: Checkpoint**

Run: `git diff --stat` — expect only `constants.ts`, `schemas/memory.ts`, `tools/memory.ts`, plus the untracked new test file.

---

### Task 2: Migration 0006 + session workspace (start returns it, complete inherits it)

Covers AC-2, AC-9, AC-10 (session half).

**Files:**
- Create: `src/migrations/0006_workspace_identity.ts`
- Modify: `src/migrations/index.ts`
- Modify: `src/types.ts:52-60` (`ReasoningSessionRow`)
- Modify: `src/schemas/reasoning.ts` (`ReasoningStartSessionInputSchema`)
- Modify: `src/tools/reasoning.ts` (start handler ~416-474, description ~365-378, complete handler ~1503)
- Modify: `src/__tests__/migrations.test.ts` (expected version list)
- Test: `src/__tests__/workspace-identity.test.ts` (append)

**Interfaces:**
- Consumes: `getWorkspace(explicit?: string): string | null` from Task 1.
- Produces: `reasoning_sessions.workspace TEXT NULL`; `reasoning_start_session` response fields `workspace: string | null` and (only when null) `workspace_warning: string`; `recallRelatedMemories(database, title, workspace: string | null)` now takes the workspace as a third argument (its body is rewritten in Task 4; in this task only the call site and signature change, keeping the old SQL but passing `workspace` instead of calling `getWorkspace()` inside).

- [ ] **Step 1: Update the migrations test expectation, then add the new tests**

In `src/__tests__/migrations.test.ts` add `"0006_workspace_identity",` after `"0005_memory_workspace",` in the expected array.

Append to `src/__tests__/workspace-identity.test.ts` (add the imports `migration0001Initial` … `migration0005MemoryWorkspace` at the top of the file):

```ts
import { migration0001Initial } from "../migrations/0001_initial.js";
import { migration0002ReasoningStepMarks } from "../migrations/0002_reasoning_step_marks.js";
import { migration0003ReasoningStepsFts } from "../migrations/0003_reasoning_steps_fts.js";
import { migration0004ToolUsageEvents } from "../migrations/0004_tool_usage_events.js";
import { migration0005MemoryWorkspace } from "../migrations/0005_memory_workspace.js";
```

```ts
test("migration 0006 nulls legacy root/home workspaces and adds the session column (AC-2)", () => {
  const dbPath = makeWorkspaceDbPath("ws-migration");
  const dir = path.dirname(dbPath);
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      )
    `);
    for (const migration of [
      migration0001Initial,
      migration0002ReasoningStepMarks,
      migration0003ReasoningStepsFts,
      migration0004ToolUsageEvents,
      migration0005MemoryWorkspace,
    ]) {
      migration.apply(db);
      db.prepare(
        `INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)`
      ).run(migration.version, "2026-07-01T00:00:00.000Z");
    }
    for (const [id, workspace] of [
      ["mem_root", "/"],
      ["mem_home", os.homedir()],
      ["mem_proj", "/proj/a"],
      ["mem_null", null],
    ] as const) {
      insertMemory(db, { id, content: `content ${id}`, workspace });
    }

    runMigrations(db);
    runMigrations(db); // idempotent: second run is a no-op

    const workspaces = Object.fromEntries(
      (
        db.prepare(`SELECT id, workspace FROM memories`).all() as Array<{
          id: string;
          workspace: string | null;
        }>
      ).map((row) => [row.id, row.workspace])
    );
    assert.deepEqual(workspaces, {
      mem_root: null,
      mem_home: null,
      mem_proj: "/proj/a",
      mem_null: null,
    });

    const columns = (
      db.prepare(`PRAGMA table_info(reasoning_sessions)`).all() as Array<{
        name: string;
      }>
    ).map((column) => column.name);
    assert.ok(columns.includes("workspace"));
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("start_session stores and returns the resolved workspace (AC-9)", async () => {
  const { toolDb, toolDir, tools } = await makeHarness("ws-start-stores");
  try {
    const started = await tools.reasoning_start_session.handler({
      title: "inspect checkout flow",
      workspace: "/proj/a/",
    });
    assert.equal(started.isError, undefined);
    const payload = started.structuredContent as {
      session_id: string;
      workspace: string | null;
      workspace_warning?: string;
    };
    assert.equal(payload.workspace, "/proj/a");
    assert.equal(payload.workspace_warning, undefined);
    const row = toolDb
      .prepare(`SELECT workspace FROM reasoning_sessions WHERE id = ?`)
      .get(payload.session_id) as { workspace: string | null };
    assert.equal(row.workspace, "/proj/a");
  } finally {
    cleanup(toolDb, toolDir);
  }
});

test("start_session warns when the workspace is unknown (AC-10)", async () => {
  const { toolDb, toolDir, tools } = await makeHarness("ws-start-unknown");
  try {
    const started = await tools.reasoning_start_session.handler({
      title: "inspect checkout flow",
      workspace: "/",
    });
    assert.equal(started.isError, undefined);
    const payload = started.structuredContent as {
      session_id: string;
      workspace: string | null;
      workspace_warning?: string;
    };
    assert.equal(payload.workspace, null);
    assert.match(payload.workspace_warning ?? "", /pass workspace/i);
    const row = toolDb
      .prepare(`SELECT workspace FROM reasoning_sessions WHERE id = ?`)
      .get(payload.session_id) as { workspace: string | null };
    assert.equal(row.workspace, null);
  } finally {
    cleanup(toolDb, toolDir);
  }
});

test("a session conclusion inherits the session workspace (AC-9)", async () => {
  const { toolDb, toolDir, tools } = await makeHarness("ws-complete-inherits");
  try {
    const started = await tools.reasoning_start_session.handler({
      title: "diagnose checkout retries",
      workspace: "/proj/a",
    });
    const sessionId = (started.structuredContent as { session_id: string })
      .session_id;
    const completed = await tools.reasoning_complete_session.handler({
      session_id: sessionId,
      conclusion: "retries must reopen the connection",
      status: "completed",
      save_as_memory: true,
      memory_tags: [],
      used_memory_ids: [],
    });
    assert.equal(completed.isError, undefined);
    const memoryId = (completed.structuredContent as { memory_id: string })
      .memory_id;
    const row = toolDb
      .prepare(`SELECT workspace FROM memories WHERE id = ?`)
      .get(memoryId) as { workspace: string | null };
    assert.equal(row.workspace, "/proj/a");
  } finally {
    cleanup(toolDb, toolDir);
  }
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run build && npm test 2>&1 | grep -E "^not ok|^# (pass|fail)"`
Expected: build may fail (`workspace` not in start schema is a runtime key, not a type error, so build passes); then FAIL for: migrations version list, migration 0006 test, the three session tests (`workspace` undefined / column missing).

- [ ] **Step 3: Create the migration and register it**

`src/migrations/0006_workspace_identity.ts`:

```ts
import os from "node:os";
import type { Migration } from "./index.js";

export const migration0006WorkspaceIdentity: Migration = {
  version: "0006_workspace_identity",
  apply(db) {
    db.exec(`ALTER TABLE reasoning_sessions ADD COLUMN workspace TEXT;`);
    // '/' and the home directory never identified a project; they were the
    // server's cwd when a desktop app launched it. NULL = unknown origin.
    db.prepare(
      `UPDATE memories SET workspace = NULL WHERE workspace = '/' OR workspace = ?`
    ).run(os.homedir());
  },
};
```

In `src/migrations/index.ts` add the import `import { migration0006WorkspaceIdentity } from "./0006_workspace_identity.js";` and append `migration0006WorkspaceIdentity,` to the `migrations` array after `migration0005MemoryWorkspace,`.

- [ ] **Step 4: Type, schema, and handlers**

`src/types.ts` — add to `ReasoningSessionRow` after `conclusion`:

```ts
  workspace: string | null;
```

`src/schemas/reasoning.ts` — in `ReasoningStartSessionInputSchema` after `agent_id`:

```ts
    workspace: z
      .string()
      .max(500)
      .optional()
      .describe(
        "Absolute path of the project directory you are working in. Pass it so recall prefers this project's memories and your conclusion is saved under it. If omitted the server uses its own working directory; '/' and the home directory count as unknown."
      ),
```

`src/tools/reasoning.ts`:

1. In the `reasoning_start_session` description, after the `agent_id` Args line add:
   `  - workspace (string, optional): Absolute path of the project directory you are working in. Pass it: the server's own working directory is often "/" or your home directory, which counts as unknown.`
   and in the Returns list add:
   `  - workspace: the resolved project workspace for this session, or null when unknown (then workspace_warning explains how to fix it).`
2. In the start handler:

```ts
        const workspace = getWorkspace(params.workspace);
        activeDb
          .prepare(
            `INSERT INTO reasoning_sessions (id, title, agent_id, status, conclusion, workspace, created_at, updated_at)
             VALUES (?, ?, ?, 'in_progress', NULL, ?, ?, ?)`
          )
          .run(id, params.title, params.agent_id ?? null, workspace, ts, ts);
```

   and `const relatedMemories = recallRelatedMemories(activeDb, params.title, workspace);`
   and in `output` after `status: "in_progress" as const,`:

```ts
          workspace,
          ...(workspace === null
            ? {
                workspace_warning:
                  "Project workspace could not be determined (the server's working directory is '/', your home directory, or unset), so recall cannot prefer this project's memories. Pass workspace=<absolute project path> to reasoning_start_session and memory_save.",
              }
            : {}),
```

3. Change the `recallRelatedMemories` signature to `(database: DatabaseSync, title: string, workspace: string | null)` and replace `getWorkspace()` inside its `.all(...)` call with `workspace` (the SQL otherwise stays as-is until Task 4).
4. In the complete handler replace `getWorkspace(),` (line ~1503) with `session.workspace ?? null,`.

- [ ] **Step 5: Run to verify pass**

Run: `npm run build && npm test 2>&1 | tail -12`
Expected: `# fail 0`. Existing tests that assert exact start-response shapes (if any fail on the new `workspace` key) are updated to expect it — note the reason in the final report.

- [ ] **Step 6: Checkpoint**

Run: `git diff --stat` — expect the files listed above and the new migration + test file.

---

### Task 3: Recall term stopwords

Covers AC-6.

**Files:**
- Modify: `src/utils.ts:54-71` (`toRecallTerms`)
- Test: `src/__tests__/workspace-identity.test.ts` (append)

**Interfaces:**
- Produces: `toRecallTerms(raw: string): string[]` (same signature) — now omits generic words; falls back to the unfiltered significant tokens when filtering would empty the list.

- [ ] **Step 1: Write the failing tests**

Append:

```ts
test("toRecallTerms drops generic task and function words (AC-6)", () => {
  assert.deepEqual(toRecallTerms("Fix the bug in recall ranking"), [
    '"recall"*',
    '"ranking"*',
  ]);
  assert.deepEqual(toRecallTerms("Fix, recall"), ['"recall"*']);
});

test("toRecallTerms falls back when every token is generic (AC-6)", () => {
  assert.deepEqual(toRecallTerms("fix bug"), ['"fix"*', '"bug"*']);
});

test("a memory sharing only generic words with the title is not recalled (AC-6)", async () => {
  const { toolDb, toolDir, tools } = await makeHarness("ws-stopwords");
  try {
    // Old behavior: terms fix/bug/payroll/export (N=4, floor 2) let this
    // match on "fix" + "bug" alone.
    insertMemory(toolDb, {
      id: "mem_generic",
      content: "fix bug in the login page redirect",
    });
    insertMemory(toolDb, {
      id: "mem_topical",
      content: "payroll export format uses fixed width columns",
    });
    assert.deepEqual(await recall(tools, "fix bug payroll export"), [
      "mem_topical",
    ]);
  } finally {
    cleanup(toolDb, toolDir);
  }
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run build && npm test 2>&1 | grep -E "^not ok|^# (pass|fail)"`
Expected: the three new tests FAIL (terms still include `"fix"*`/`"the"*`; generic memory is recalled).

- [ ] **Step 3: Implement**

In `src/utils.ts`, above `toRecallTerms`, add the stopword set and a helper, and rewrite the function:

```ts
/**
 * Generic task words and function words. They match nearly every memory,
 * so counting them toward the recall floor lets unrelated memories in.
 * Includes a few common Vietnamese words (titles are often mixed-language).
 */
const RECALL_STOPWORDS = new Set([
  "fix", "fixes", "fixing", "add", "adds", "adding", "update", "updates",
  "updating", "improve", "improves", "improving", "implement",
  "implementing", "review", "investigate", "investigating", "debug",
  "debugging", "bug", "bugs", "issue", "issues", "task", "tasks",
  "the", "and", "for", "with", "from", "into", "that", "this", "are", "not",
  "không", "của", "cho", "với", "các", "những", "một", "cải", "tiến",
  "sửa", "lỗi", "thêm",
]);

function bareToken(token: string): string {
  return token.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

/**
 * Term preparation for auto-recall only. Drops noise tokens (<=2 chars,
 * the main source of one-word junk matches) and generic stopwords, and caps
 * the count so long titles stay cheap. If filtering would leave nothing, it
 * falls back to the unfiltered tokens. memory_search keeps raw ftsTerms
 * behavior — an explicit query is the caller's intent.
 */
export function toRecallTerms(raw: string): string[] {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  const significant = tokens.filter((token) => token.length > 2);
  const topical = significant.filter(
    (token) => !RECALL_STOPWORDS.has(bareToken(token))
  );
  const base =
    topical.length > 0 ? topical : significant.length > 0 ? significant : tokens;
  // Dedupe case-insensitively: a repeated word must not raise the
  // match floor or double-count as two matched terms.
  const seen = new Set<string>();
  const chosen = base
    .filter((token) => {
      const key = token.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 8);
  return chosen.map((t) => `"${t.replace(/"/g, '""')}"*`);
}
```

(Delete the old `toRecallTerms` and its doc comment; keep everything else in the file.)

- [ ] **Step 3b: Verify the whole suite**

Run: `npm run build && npm test 2>&1 | tail -12`
Expected: all pass. The existing dedupe test (`"step by step migration guide"`) and the floor tests must be unaffected because none of their terms are stopwords.

- [ ] **Step 4: Checkpoint**

Run: `git diff --stat` — `src/utils.ts` plus the test file.

---

### Task 4: Recall rewrite — tiered pool, cross-project gate, preference bypass, stale exclusion, blended score, no lifeline

Covers AC-3, AC-4, AC-4b, AC-5, AC-7, AC-8, AC-11.

**Files:**
- Modify: `src/tools/reasoning.ts:247-353` (`RECALL_CANDIDATE_POOL` … `recallRelatedMemories`) and the `related_memories` bullet of the `reasoning_start_session` description (~line 372)
- Modify: `src/__tests__/wave3b-recall-scoping.test.ts` (replace the lifeline test)
- Modify: `src/__tests__/wave3-value-loop.test.ts` (split the importance/recency tie test)
- Test: `src/__tests__/workspace-identity.test.ts` (append)

**Interfaces:**
- Consumes: `recallRelatedMemories(database, title, workspace: string | null)` call site from Task 2; `toRecallTerms` from Task 3.
- Produces: final recall behavior per the Global Constraints.

- [ ] **Step 1: Write the failing tests**

Append to `src/__tests__/workspace-identity.test.ts`:

```ts
const TITLE = "payment gateway release checklist"; // 4 terms: floor 2, cross-project floor 3

test("another project's weak match is not recalled; the home one is (AC-3)", async () => {
  const { toolDb, toolDir, tools } = await makeHarness("ws-gate-weak");
  try {
    insertMemory(toolDb, {
      id: "mem_home",
      content: "payment gateway release notes",
      workspace: "/proj/a",
    });
    insertMemory(toolDb, {
      id: "mem_away",
      content: "payment gateway release notes",
      workspace: "/proj/b",
    });
    assert.deepEqual(await recall(tools, TITLE, "/proj/a"), ["mem_home"]);
  } finally {
    cleanup(toolDb, toolDir);
  }
});

test("another project's strong match is still recalled (AC-4)", async () => {
  const { toolDb, toolDir, tools } = await makeHarness("ws-gate-strong");
  try {
    insertMemory(toolDb, {
      id: "mem_home",
      content: "payment gateway release notes",
      workspace: "/proj/a",
    });
    insertMemory(toolDb, {
      id: "mem_away_strong",
      content: "payment gateway release checklist runbook",
      workspace: "/proj/b",
    });
    const ids = await recall(tools, TITLE, "/proj/a");
    assert.deepEqual(ids.sort(), ["mem_away_strong", "mem_home"]);
  } finally {
    cleanup(toolDb, toolDir);
  }
});

test("preference memories bypass the cross-project gate but not the base floor (AC-4b)", async () => {
  const { toolDb, toolDir, tools } = await makeHarness("ws-gate-preference");
  try {
    insertMemory(toolDb, {
      id: "mem_pref_2",
      type: "preference",
      content: "payment gateway conventions",
      workspace: "/proj/b",
    });
    insertMemory(toolDb, {
      id: "mem_fact_2",
      type: "fact",
      content: "payment gateway conventions overview",
      workspace: "/proj/b",
    });
    insertMemory(toolDb, {
      id: "mem_pref_1",
      type: "preference",
      content: "payment conventions",
      workspace: "/proj/b",
    });
    assert.deepEqual(await recall(tools, TITLE, "/proj/a"), ["mem_pref_2"]);
  } finally {
    cleanup(toolDb, toolDir);
  }
});

test("home memories enter the pool even when other projects saturate BM25 (AC-3)", async () => {
  const { toolDb, toolDir, tools } = await makeHarness("ws-pool-tier");
  try {
    for (let i = 0; i < 60; i += 1) {
      insertMemory(toolDb, {
        id: `mem_noise_${i}`,
        content: "payment gateway ledger",
        workspace: "/proj/b",
      });
    }
    const filler = Array.from({ length: 80 }, (_, i) => `filler${i}`).join(" ");
    insertMemory(toolDb, {
      id: "mem_home",
      content: `payment gateway ${filler}`,
      workspace: "/proj/a",
    });
    // The 60 short away memories match 2 of 4 terms (< cross floor 3) and
    // outrank the long home memory on BM25; only a workspace-tiered pool
    // lets the home memory through.
    assert.deepEqual(await recall(tools, TITLE, "/proj/a"), ["mem_home"]);
  } finally {
    cleanup(toolDb, toolDir);
  }
});

test("no lifeline: weak other-project matches return nothing (AC-5)", async () => {
  const { toolDb, toolDir, tools } = await makeHarness("ws-no-lifeline");
  try {
    insertMemory(toolDb, {
      id: "mem_away",
      content: "payment provider rotation schedule",
      workspace: "/proj/b",
    });
    assert.deepEqual(await recall(tools, TITLE, "/proj/a"), []);
  } finally {
    cleanup(toolDb, toolDir);
  }
});

test("unknown workspace keeps the base floor for everyone (AC-5)", async () => {
  const { toolDb, toolDir, tools } = await makeHarness("ws-unknown-floor");
  try {
    insertMemory(toolDb, {
      id: "mem_away",
      content: "payment gateway release notes",
      workspace: "/proj/b",
    });
    assert.deepEqual(await recall(tools, TITLE, "/"), ["mem_away"]);
  } finally {
    cleanup(toolDb, toolDir);
  }
});

test("memories reported stale or unsafe are not recalled; used/ignored do not exclude (AC-7)", async () => {
  const { toolDb, toolDir, tools } = await makeHarness("ws-stale-exclusion");
  try {
    const content = "payment gateway release checklist for staging";
    for (const id of ["mem_stale", "mem_unsafe", "mem_used", "mem_ignored", "mem_clean"]) {
      insertMemory(toolDb, { id, content, workspace: "/proj/a" });
    }
    for (const [memory_id, usefulness] of [
      ["mem_stale", "stale"],
      ["mem_unsafe", "unsafe_to_use"],
      ["mem_used", "used"],
      ["mem_ignored", "ignored"],
    ] as const) {
      const fb = await tools.memory_record_usage_feedback.handler({
        memory_id,
        usefulness,
      });
      assert.equal(fb.isError, undefined);
    }
    const ids = await recall(tools, TITLE, "/proj/a");
    assert.ok(!ids.includes("mem_stale"));
    assert.ok(!ids.includes("mem_unsafe"));
    // limit is 3, so assert the exclusions by querying a wide limit too.
    const all = toolDb
      .prepare(
        `SELECT DISTINCT memory_id FROM tool_usage_events
         WHERE operation_type = 'feedback' AND status = 'success'`
      )
      .all() as Array<{ memory_id: string }>;
    assert.equal(all.length, 4, "all four feedback events were recorded");
    assert.ok(ids.every((id) => ["mem_used", "mem_ignored", "mem_clean"].includes(id)));
    assert.equal(ids.length, 3);
  } finally {
    cleanup(toolDb, toolDir);
  }
});
```

- [ ] **Step 2: Update the two existing tests that encode removed behavior**

In `src/__tests__/wave3b-recall-scoping.test.ts` replace the test `"floor miss falls back to exactly one best match (AC-8.3)"` (lines ~100-124) with:

```ts
test("floor miss returns nothing: the lifeline is gone (spec 2026-10-05 G-4)", async () => {
  const { toolDb, toolDir, tools } = await makeHarness("scoping-no-fallback");

  try {
    // Each candidate matches exactly one different term of a 5-term title.
    insertMemory(toolDb, {
      id: "mem_one",
      content: "payment provider rotation schedule",
    });
    insertMemory(toolDb, {
      id: "mem_two",
      content: "gateway hardware inventory list",
    });

    assert.deepEqual(
      await recall(tools, "resolve checkout timeout payment gateway"),
      []
    );
  } finally {
    toolDb.close();
    fs.rmSync(toolDir, { recursive: true, force: true });
  }
});
```

In `src/__tests__/wave3-value-loop.test.ts` replace the test `"auto-recall breaks equal-relevance ties by importance then recency"` (lines ~108-150) with these three tests (reason: recency is now a continuous score component, so importance only breaks ties at equal recency; relevance still outranks recency):

```ts
test("auto-recall breaks equal-relevance, equal-recency ties by importance", async () => {
  const { toolDb, toolDir, tools } = await makeHarness("wave3-recall-ties");

  try {
    const content = "deploy pipeline rollback procedure for staging";
    for (const [id, importance] of [
      ["mem_low", 3],
      ["mem_top", 5],
      ["mem_mid", 4],
    ] as const) {
      insertMemory(toolDb, { id, content, importance });
    }

    const started = await tools.reasoning_start_session.handler({
      title: "deploy pipeline rollback staging",
    });
    assert.equal(started.isError, undefined);
    const payload = started.structuredContent as {
      related_memories: Array<{ id: string }>;
    };
    assert.deepEqual(
      payload.related_memories.map((row) => row.id),
      ["mem_top", "mem_mid", "mem_low"]
    );
  } finally {
    toolDb.close();
    fs.rmSync(toolDir, { recursive: true, force: true });
  }
});

test("auto-recall prefers the more recently updated of two equally relevant memories", async () => {
  const { toolDb, toolDir, tools } = await makeHarness("wave3-recall-recency");

  try {
    const content = "deploy pipeline rollback procedure for staging";
    insertMemory(toolDb, {
      id: "mem_old",
      content,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    insertMemory(toolDb, {
      id: "mem_fresh",
      content,
      updatedAt: new Date().toISOString(),
    });

    const started = await tools.reasoning_start_session.handler({
      title: "deploy pipeline rollback staging",
    });
    const payload = started.structuredContent as {
      related_memories: Array<{ id: string }>;
    };
    assert.deepEqual(
      payload.related_memories.map((row) => row.id),
      ["mem_fresh", "mem_old"]
    );
  } finally {
    toolDb.close();
    fs.rmSync(toolDir, { recursive: true, force: true });
  }
});

test("recency never outranks relevance in auto-recall (AC-8)", async () => {
  const { toolDb, toolDir, tools } = await makeHarness("wave3-recall-relevance-first");

  try {
    insertMemory(toolDb, {
      id: "mem_old_strong",
      content: "deploy pipeline rollback procedure for staging",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    insertMemory(toolDb, {
      id: "mem_fresh_weak",
      content: "deploy pipeline weekly cadence notes",
      updatedAt: new Date().toISOString(),
    });

    const started = await tools.reasoning_start_session.handler({
      title: "deploy pipeline rollback staging",
    });
    const payload = started.structuredContent as {
      related_memories: Array<{ id: string }>;
    };
    assert.deepEqual(
      payload.related_memories.map((row) => row.id),
      ["mem_old_strong", "mem_fresh_weak"]
    );
  } finally {
    toolDb.close();
    fs.rmSync(toolDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npm run build && npm test 2>&1 | grep -E "^not ok|^# (pass|fail)"`
Expected: FAIL — AC-3/4b/pool/no-lifeline/stale tests, the replaced wave3b test (old code returns 1 lifeline), and the recency/relevance wave3 tests (old comparator ignores recency).

- [ ] **Step 4: Implement the recall rewrite**

In `src/tools/reasoning.ts`, replace everything from `/** Candidate pool fetched by BM25 ... */` through the end of `recallRelatedMemories` (lines 247-353) with:

```ts
/** Candidate pool fetched by BM25 before the gate/score pass. */
const RECALL_CANDIDATE_POOL = 50;

/**
 * Blended auto-recall score weights — see
 * docs/design/2026-10-05-spec-recall-workspace-identity.md §3.4.
 * Relevance (coverage + bm25) is the largest block; workspace only orders
 * candidates that already passed the cross-project gate.
 */
const RECALL_WEIGHTS = {
  coverage: 0.45,
  bm25: 0.2,
  workspace: 0.3,
  recency: 0.05,
} as const;

/** recency = 1 / (1 + age_days / RECALL_RECENCY_DAYS). */
const RECALL_RECENCY_DAYS = 60;

function recallRelatedMemories(
  database: DatabaseSync,
  title: string,
  workspace: string | null
): RelatedMemoryRecord[] {
  if (AUTO_RECALL_LIMIT <= 0) return [];
  try {
    const terms = toRecallTerms(title);
    if (terms.length === 0) return [];

    // workspace_priority: 2 = current workspace, 1 = unknown (NULL) or a
    // user preference (cross-project by nature), 0 = another project. With
    // a known workspace the pool is ordered by it first so home memories are
    // never crowded out of the candidate pool by other projects' BM25 hits.
    // Memories already reported stale/unsafe are excluded outright.
    const candidates = database
      .prepare(
        `SELECT m.rowid AS row_id, m.id, m.type, m.content, m.tags,
                m.importance, m.metadata, m.created_at, m.updated_at,
                f.rank AS fts_rank,
                CASE
                  WHEN m.workspace = ?                              THEN 2
                  WHEN m.workspace IS NULL OR m.type = 'preference' THEN 1
                  ELSE 0
                END AS workspace_priority
         FROM memories m
         JOIN (
           SELECT rowid, rank FROM memories_fts WHERE memories_fts MATCH ?
         ) f ON m.rowid = f.rowid
         WHERE m.id NOT IN (
           SELECT memory_id FROM tool_usage_events
           WHERE operation_type = 'feedback' AND status = 'success'
             AND memory_id IS NOT NULL
             AND json_extract(metadata, '$.usefulness') IN ('stale', 'unsafe_to_use')
         )
         ORDER BY ${workspace === null ? "" : "workspace_priority DESC, "}f.rank ASC
         LIMIT ?`
      )
      .all(workspace, terms.join(" OR "), RECALL_CANDIDATE_POOL) as Array<{
      row_id: number;
      id: string;
      type: string;
      content: string;
      tags: string | null;
      importance: number;
      metadata: string | null;
      created_at: string;
      updated_at: string;
      fts_rank: number;
      workspace_priority: number;
    }>;
    if (candidates.length === 0) return [];

    // Count how many title terms each candidate matches (one cheap FTS
    // query per term, capped at 8 by toRecallTerms).
    const matchCounts = new Map<number, number>();
    for (const term of terms) {
      const rowIds = database
        .prepare(`SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?`)
        .all(term) as Array<{ rowid: number }>;
      for (const row of rowIds) {
        matchCounts.set(row.rowid, (matchCounts.get(row.rowid) ?? 0) + 1);
      }
    }

    // Eligibility gate. Other projects' non-preference memories must match
    // nearly the whole title; everyone else needs the base floor. Nothing
    // eligible means nothing returned — no best-effort lifeline.
    const total = terms.length;
    const baseFloor = total >= 3 ? 2 : 1;
    const crossProjectFloor = Math.max(2, Math.ceil(0.75 * total));
    const eligible = candidates
      .map((candidate) => ({
        ...candidate,
        matched: matchCounts.get(candidate.row_id) ?? 1,
      }))
      .filter((candidate) => {
        const crossProject =
          workspace !== null && candidate.workspace_priority === 0;
        return candidate.matched >= (crossProject ? crossProjectFloor : baseFloor);
      });
    if (eligible.length === 0) return [];

    // Blended score. bm25 rank is negative (more negative = better), so
    // min-max normalize within the eligible set; all-equal counts as best.
    const ranks = eligible.map((candidate) => candidate.fts_rank);
    const bestRank = Math.min(...ranks);
    const worstRank = Math.max(...ranks);
    const now = Date.now();
    const scored = eligible.map((candidate) => {
      const bm25 =
        worstRank === bestRank
          ? 1
          : (worstRank - candidate.fts_rank) / (worstRank - bestRank);
      const workspaceTerm =
        workspace === null ? 0.5 : candidate.workspace_priority / 2;
      const updatedMs = Date.parse(candidate.updated_at);
      const ageDays = Number.isFinite(updatedMs)
        ? Math.max(0, (now - updatedMs) / 86_400_000)
        : Infinity;
      const recency = 1 / (1 + ageDays / RECALL_RECENCY_DAYS);
      return {
        ...candidate,
        score:
          RECALL_WEIGHTS.coverage * (candidate.matched / total) +
          RECALL_WEIGHTS.bm25 * bm25 +
          RECALL_WEIGHTS.workspace * workspaceTerm +
          RECALL_WEIGHTS.recency * recency,
      };
    });

    scored.sort(
      (a, b) =>
        b.score - a.score ||
        b.importance - a.importance ||
        (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0)
    );

    return scored.slice(0, AUTO_RECALL_LIMIT).map((row) => {
      const metadata = parseJsonObject(row.metadata);
      const sourceSessionId = metadata?.source_session_id;
      const sourceSessionTitle = metadata?.session_title;
      return {
        id: row.id,
        type: row.type,
        importance: row.importance,
        tags: parseJsonArray(row.tags),
        snippet: compactSnippetText(row.content),
        ...(typeof sourceSessionId === "string" &&
        typeof sourceSessionTitle === "string"
          ? {
              source: {
                session_id: sourceSessionId,
                session_title: sourceSessionTitle,
                created_at: row.created_at,
              },
            }
          : {}),
      };
    });
  } catch {
    // Recall is best-effort; a bad FTS query must never block session creation.
    return [];
  }
}
```

Also update the `related_memories` bullet in the `reasoning_start_session` description (~line 372) to:

`  - related_memories: up to a few saved memories relevant to the title, auto-recalled by the server — ranked by a blend of term coverage, text relevance, workspace and recency; memories from other projects appear only when they match nearly the whole title (user preferences excepted); weak matches are filtered out, so a short or empty list is normal. Review them before starting work; if one helps, report it later via used_memory_ids on reasoning_complete_session. Memories persisted from a past reasoning session carry a 'source' field ({session_id, session_title, created_at}); pass source.session_id to reasoning_get_trace to replay how that conclusion was reached.`

- [ ] **Step 5: Run to verify pass, then triage**

Run: `npm run build && npm test 2>&1 | tail -15`
Expected: `# fail 0`. If anything still fails, classify it before touching it:
- the failing test encodes the removed lifeline or old importance-over-recency ordering → update it with a stated reason (AC-11);
- anything else (e.g. `json_extract` unavailable → every recall returns `[]` because the `catch` swallows the error) is an implementation bug: fix the code, not the test. Quick check for the latter: `node -e "const {DatabaseSync}=require('node:sqlite');console.log(new DatabaseSync(':memory:').prepare(\"select json_extract('{\\\"a\\\":1}','\$.a') as v\").get())"` must print `{ v: 1 }`.

- [ ] **Step 6: Checkpoint**

Run: `git diff --stat` — `src/tools/reasoning.ts`, the three test files.

---

### Task 5: Docs and version sync, real-DB replay, final verification

Covers spec §6 (replay), §7 (sync), AC-11.

**Files:**
- Modify: `package.json` (`version`), `src/constants.ts` (`MCP_VERSION`)
- Modify: `GUIDELINES.md`, `src/__tests__/reasoning-audit-tools.test.ts:1104`
- Modify: `README.md`, `CHANGELOG.md`, `docs/architecture.md`, `docs/roadmap.md`
- Modify: `docs/design/2026-10-05-spec-recall-workspace-identity.md` (status + §3.4 step 2), `docs/design/2026-08-07-spec-zero-mem-inspired-recall.md`, `docs/design/2026-07-12-spec-recall-precision-workspace.md` (one-line pointers in revision history)
- Scratch (not committed): `$SCRATCH/replay.mjs`, where `$SCRATCH` is any temporary directory outside the repo

- [ ] **Step 1: Bump versions**

`package.json`: `"version": "1.3.3"`. `src/constants.ts`: `export const MCP_VERSION = "1.3.3";`. `docs/architecture.md` line 3: `Version: 1.3.3` (after confirming the Section edits in Step 4 below).

- [ ] **Step 2: GUIDELINES v8 and its test assertion**

In `GUIDELINES.md` (read each target first; indentation must match):

1. `Version: 2026-07-18.v7` → `Version: 2026-10-05.v8`.
2. After the lines `The title doubles as the recall query — favor concrete keywords (component, module, error names) over generic phrasing.` add (same 5-space indent):
```
     Also pass `workspace` — the absolute path of the project directory you
     are working in. The server's own working directory is often `/` or your
     home directory when a desktop app launched it; those count as "unknown
     project" and turn project scoping off. If the response shows
     `workspace: null` with a `workspace_warning`, pass `workspace` on this
     and later calls (`reasoning_start_session`, `memory_save`).
```
3. Replace the `related_memories` sentence `ranked by text relevance and biased toward your current workspace. Weak one-word matches are filtered out, so an empty or short list is normal.` with:
```
ranked by a blend of term coverage, text relevance, workspace and recency.
     Memories from other projects appear only when they match nearly your
     whole title (user `preference` memories are the exception). Weak matches
     are filtered out, so an empty list is normal — do not pad the title just
     to get results.
```
4. In the Tool Reference replace `the server records the workspace automatically and prefers same-workspace memories at recall time` with `pass \`workspace\` (your project directory); if omitted the server records its own working directory (never \`/\` or the home directory) and prefers same-workspace memories at recall time`.

`src/__tests__/reasoning-audit-tools.test.ts:1104`: `guide_version: "2026-10-05.v8",`.

- [ ] **Step 3: README**

- "How it works" step 1 (lines ~117-120): replace `best text match first, current workspace preferred, weak one-word matches filtered out` with `ranked by relevance, workspace and recency; other projects' memories only when they match nearly the whole title; nothing returned when nothing is relevant`.
- Config table `MEMORY_WORKSPACE` row: replace the Purpose cell with `Pins the workspace identity stamped on saved memories and used at recall time. Default: the server's working directory — but "/" and your home directory count as "unknown project". Agents should pass \`workspace\` (their project path) to \`reasoning_start_session\` / \`memory_save\`; that overrides this.`
- "Shared vs project-scoped memory": append to the **Shared** bullet: `Since v1.3.3 an explicit \`workspace\` argument is honored, "/" and the home directory are treated as unknown, and memories from other projects are recalled only on a near-complete title match (user preferences excepted).`

- [ ] **Step 4: architecture.md, CHANGELOG, roadmap, specs**

- `docs/architecture.md`: line ~110 `0005_memory_workspace.ts` → `0006_workspace_identity.ts`; line ~120 replace `BM25-ranked, workspace-aware — see` with `scored by a blend of term coverage, BM25, workspace and recency, with a cross-project gate and no best-effort fallback — see`; the `reasoning_sessions` row of the data-model table: append `; \`workspace\` (added by \`0006_workspace_identity\`, copied to persisted conclusions)`; the `memories` row: change `workspace column added by 0005_memory_workspace` to add `; legacy "/" and home-dir values nulled by 0006`.
- `CHANGELOG.md`: new top entry:
```
## 1.3.3 (2026-10-05)

Theme: recall that respects project identity — fixes `reasoning_start_session` recalling other projects' memories, stale memories, and near-zero-relevance memories from the same project. Design: `docs/design/2026-10-05-spec-recall-workspace-identity.md`.

### Added
- Optional `workspace` input on `reasoning_start_session` and `memory_save`; `reasoning_start_session` returns the resolved `workspace` and a `workspace_warning` when it is unknown.
- Migration `0006_workspace_identity`: `reasoning_sessions.workspace`; legacy `memories.workspace` values of `/` and the home directory are set to NULL (unknown).

### Changed
- `getWorkspace` treats `/`, the home directory and empty as unknown instead of as a project.
- Auto-recall: other projects' non-preference memories need a near-complete title match; `preference` memories bypass that gate; one blended score (coverage 0.45, BM25 0.20, workspace 0.30, recency 0.05) replaces the lexicographic comparator; memories reported `stale`/`unsafe_to_use` are excluded; generic title words (fix, bug, update, …) no longer count as matches.
- **Behavior change:** the "serendipity lifeline" is removed — when nothing is relevant, `related_memories` is `[]`.
- `GUIDELINES.md` `2026-07-18.v7` → `2026-10-05.v8`.
```
- `docs/roadmap.md`: add Shipped row `| \`1.3.3\` | Recall workspace identity + scoped blended scoring (auto-recall slice of Option A) | [2026-10-05-spec-recall-workspace-identity.md](design/2026-10-05-spec-recall-workspace-identity.md) |`; in the Option A bullet and the Wave 4 gate table mark **G-c** as `✅ Met — owner-reported recall-quality complaint, 2026-10-05` and adjust the "Why this matters" sentence accordingly (G-d / WI-11 remains the open gate); add one line under the tool-removal gate: `GUIDELINES v8 (2026-10-05) starts a new observation window for the Tool Surface Policy — the 2026-08-07 → 2026-08-21 window above was measured on v7.`
- Spec revision pointers: in the new spec set `Document version` to `0.3 (Implemented in 1.3.3)`, add a `### 0.3` revision entry, and change §3.4 step 2 to say the pool priority is home 2 / NULL-or-preference 1 / other 0; in the other two specs add one sentence to their latest revision-history entry pointing at the new spec ("auto-recall slice of Option A shipped in 1.3.3 — see ...").

- [ ] **Step 5: Full verification**

Run: `npm run build && npm test 2>&1 | tail -12`
Expected: `# fail 0` (80+ new tests included; `architecture-doc-version` and `reasoning-audit-tools` pass).

- [ ] **Step 6: Real-DB replay (read-only evidence, spec §6)**

Copy the live DB (never run against it directly — `reasoning_start_session` writes):

```bash
sqlite3 ~/.memory-mcp-server/memory.db ".backup '$SCRATCH/replay.db'"
```

Create `$SCRATCH/replay.mjs`:

```js
import { DatabaseSync } from "node:sqlite";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runMigrations } from "/Users/macbook_343/Documents/mcp/memory-mcp-server/dist/migrations/index.js";
import { registerMemoryTools } from "/Users/macbook_343/Documents/mcp/memory-mcp-server/dist/tools/memory.js";
import { registerReasoningTools } from "/Users/macbook_343/Documents/mcp/memory-mcp-server/dist/tools/reasoning.js";

const db = new DatabaseSync(process.argv[2]);
runMigrations(db); // applies 0006 to the copy
const server = new McpServer({ name: "replay", version: "0" });
registerMemoryTools(server, db);
registerReasoningTools(server, db);
const tools = server._registeredTools;

const cases = [
  ["/Users/macbook_343/Documents/mcp/memory-mcp-server", "Improve related_memories recall for cross-project and stale results"],
  ["/Users/macbook_343/Documents/mcp/memory-mcp-server", "Review docs design specs for duplication"],
  ["/Users/macbook_343/Documents/nhatndq/DarkestTerminal", "Add missing sprites to data/sprites.json events"],
  ["/Users/macbook_343/Documents/mcp/GoalTracker", "Fix milestone approval flow"],
  ["/Users/macbook_343/Documents/seo/tsukrel-seo", "Weekly aggregation batch for dashboard"],
  ["/", "Add missing sprites to data/sprites.json events"],
];
for (const [workspace, title] of cases) {
  const res = await tools.reasoning_start_session.handler({ title, workspace });
  const rel = res.structuredContent.related_memories.map((m) => `${m.id.slice(0, 12)} ${m.snippet.slice(0, 70)}`);
  console.log(`\n[${workspace}] ${title}\n  workspace=${res.structuredContent.workspace}`);
  console.log(rel.length ? rel.map((r) => "  - " + r).join("\n") : "  (none)");
}
```

Run from the repo root: `node $SCRATCH/replay.mjs $SCRATCH/replay.db`.
Expected/judgment: DarkestTerminal and tsukrel-seo cases return only same-project memories (or none); the `/` case runs with `workspace=null` and shows the warning path; the memory-mcp-server cases do not return OpenWorking/DarkestTerminal memories. Record the output (before/after is the "before" from the 2026-10-05 brainstorm session, where an OpenWorking CSS memory surfaced for this repo's title) in the final report. If an ordering looks wrong, adjust only the `RECALL_WEIGHTS`/gate constants, rebuild, re-run tests and the replay.

- [ ] **Step 7: Final checkpoint**

Run: `git status --short && git diff --stat`
Expected: only the files listed in this plan's File Structure/Task file lists. Report validation status, the replay output, and any existing test that was updated (with reason) in the final report. Do not commit unless the owner asks.

---

## Self-Review (spec ↔ plan)

- **Spec §3.1/AC-1, AC-10** → Task 1. **§3.2/§3.3/AC-2, AC-9, AC-10** → Task 2. **§3.4 step 1/AC-6** → Task 3. **§3.4 steps 2-6/AC-3, 4, 4b, 5, 7, 8, 11** → Task 4 (AC-8 via the three wave3 tests; AC-11 via the two replaced tests plus full-suite triage). **§6, §7** → Task 5.
- Names are consistent across tasks: `normalizeWorkspace`, `getWorkspace(explicit?)`, `recallRelatedMemories(db, title, workspace)`, `RECALL_WEIGHTS`, `workspace_priority`, `workspace_warning`, column `reasoning_sessions.workspace`.
- Known judgment calls recorded for the owner: cross-project `preference` gets workspace term 0.5 (spec OQ-A note); GUIDELINES v8 resets the tool-removal observation window; the replaced lifeline and importance-over-recency tests are a deliberate behavior change, not a regression.
