# Audit Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add migration-based schema management and the first audit-layer reasoning tools without breaking existing databases or existing tool contracts.

**Architecture:** Replace inline schema bootstrap in `src/db.ts` with a small migration runner and ordered migration files. Then add audit storage (`reasoning_step_marks`), reasoning-step FTS, and new reasoning read/write tools on top of the migrated schema while keeping current `memory_*` and `reasoning_*` behavior intact.

**Tech Stack:** TypeScript, Node.js `node:sqlite`, MCP SDK, Zod, Node built-in test runner (`node --test`)

---

## File Structure

**Create:**
- `src/migrations/0001_initial.ts` — baseline schema migration matching the current shipped DB
- `src/migrations/0002_reasoning_step_marks.ts` — additive schema for audit markers
- `src/migrations/0003_reasoning_steps_fts.ts` — additive FTS index and backfill for reasoning-step search
- `src/migrations/index.ts` — migration runner and migration registry
- `src/__tests__/migrations.test.ts` — fresh DB and upgrade-path coverage
- `src/__tests__/reasoning-audit-tools.test.ts` — milestone/search/outline behavior coverage

**Modify:**
- `package.json` — add `test` script
- `src/db.ts` — open DB, set pragmas, run migrations, stop owning inline schema
- `src/index.ts` — import DB bootstrap via the migrated entry path
- `src/schemas/reasoning.ts` — add schemas for new audit tools
- `src/tools/reasoning.ts` — add new tools and replace N+1 session counting
- `src/types.ts` — add row/record types for step marks and outline/search outputs if needed
- `src/utils.ts` — add tiny shared helpers only if they remove duplication in reasoning tools

---

### Task 1: Add Test Harness And Migration Skeleton

**Files:**
- Modify: `package.json`
- Create: `src/migrations/index.ts`
- Create: `src/__tests__/migrations.test.ts`

- [ ] **Step 1: Add a failing test command**

```json
{
  "scripts": {
    "start": "node dist/index.js",
    "dev": "tsx watch src/index.ts",
    "build": "tsc && node -e \"require('fs').chmodSync('dist/index.js','755')\"",
    "test": "npm run build && node --test dist/__tests__/*.test.js",
    "clean": "rm -rf dist"
  }
}
```

- [ ] **Step 2: Write the failing migration bootstrap test**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runMigrations } from "../migrations/index.js";

function makeTempDbPath(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-mcp-"));
  return path.join(dir, `${name}.db`);
}

test("runMigrations creates schema_migrations and applies baseline schema", () => {
  const db = new DatabaseSync(makeTempDbPath("fresh"));

  runMigrations(db);

  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as Array<{ name: string }>;

  assert.ok(tables.some((row) => row.name === "schema_migrations"));
  assert.ok(tables.some((row) => row.name === "memories"));
  assert.ok(tables.some((row) => row.name === "reasoning_sessions"));
  assert.ok(tables.some((row) => row.name === "reasoning_steps"));
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- --test-name-pattern="runMigrations creates schema_migrations and applies baseline schema"`

Expected: FAIL with module or export errors because `runMigrations` does not exist yet

- [ ] **Step 4: Write the minimal migration runner skeleton**

```ts
import type { DatabaseSync } from "node:sqlite";

export interface Migration {
  version: string;
  apply: (db: DatabaseSync) => void;
}

const migrations: Migration[] = [];

export function runMigrations(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);

  for (const migration of migrations) {
    void migration;
  }
}
```

- [ ] **Step 5: Run test to verify it still fails for the right reason**

Run: `npm test -- --test-name-pattern="runMigrations creates schema_migrations and applies baseline schema"`

Expected: FAIL because baseline schema tables are still missing

- [ ] **Step 6: Commit**

```bash
git add package.json src/migrations/index.ts src/__tests__/migrations.test.ts
git commit -m "test: add migration runner harness"
```

### Task 2: Move Current Schema Into `0001_initial` And Wire DB Startup

**Files:**
- Create: `src/migrations/0001_initial.ts`
- Modify: `src/migrations/index.ts`
- Modify: `src/db.ts`
- Test: `src/__tests__/migrations.test.ts`

- [ ] **Step 1: Extend the failing migration test to verify baseline tables**

```ts
test("runMigrations records 0001_initial after creating the baseline schema", () => {
  const db = new DatabaseSync(makeTempDbPath("baseline"));

  runMigrations(db);

  const versions = db
    .prepare("SELECT version FROM schema_migrations ORDER BY version")
    .all() as Array<{ version: string }>;

  assert.deepEqual(versions.map((row) => row.version), ["0001_initial"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern="0001_initial"`

Expected: FAIL because the migration list is empty

- [ ] **Step 3: Write `0001_initial` with the current schema exactly once**

```ts
import type { Migration } from "./index.js";

export const migration0001Initial: Migration = {
  version: "0001_initial",
  apply(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        tags TEXT,
        agent_id TEXT,
        importance INTEGER NOT NULL DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),
        metadata TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
      CREATE INDEX IF NOT EXISTS idx_memories_agent ON memories(agent_id);
      CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at);

      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        content,
        tags,
        content='memories',
        content_rowid='rowid'
      );

      CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, content, tags)
        VALUES (new.rowid, new.content, coalesce(new.tags, ''));
      END;

      CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content, tags)
        VALUES ('delete', old.rowid, old.content, coalesce(old.tags, ''));
      END;

      CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content, tags)
        VALUES ('delete', old.rowid, old.content, coalesce(old.tags, ''));
        INSERT INTO memories_fts(rowid, content, tags)
        VALUES (new.rowid, new.content, coalesce(new.tags, ''));
      END;

      CREATE TABLE IF NOT EXISTS reasoning_sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        agent_id TEXT,
        status TEXT NOT NULL DEFAULT 'in_progress'
          CHECK (status IN ('in_progress','completed','abandoned')),
        conclusion TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_agent ON reasoning_sessions(agent_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_status ON reasoning_sessions(status);

      CREATE TABLE IF NOT EXISTS reasoning_steps (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES reasoning_sessions(id) ON DELETE CASCADE,
        step_number INTEGER NOT NULL,
        thought TEXT,
        action TEXT,
        observation TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(session_id, step_number)
      );

      CREATE INDEX IF NOT EXISTS idx_steps_session ON reasoning_steps(session_id, step_number);
    `);
  },
};
```

- [ ] **Step 4: Register the migration and persist applied versions**

```ts
import { nowIso } from "../utils.js";
import { migration0001Initial } from "./0001_initial.js";

const migrations: Migration[] = [migration0001Initial];

export function runMigrations(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);

  const applied = new Set(
    (db.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: string }>)
      .map((row) => row.version)
  );

  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;

    db.exec("BEGIN");
    try {
      migration.apply(db);
      db.prepare(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)"
      ).run(migration.version, nowIso());
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}
```

- [ ] **Step 5: Replace inline schema ownership in `src/db.ts`**

```ts
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { DB_PATH } from "./constants.js";
import { runMigrations } from "./migrations/index.js";

function ensureDir(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

ensureDir(DB_PATH);

export const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");
runMigrations(db);
```

- [ ] **Step 6: Run migration tests**

Run: `npm test -- --test-name-pattern="baseline schema|0001_initial"`

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/migrations/0001_initial.ts src/migrations/index.ts src/db.ts src/__tests__/migrations.test.ts
git commit -m "refactor: move baseline schema into migrations"
```

### Task 3: Add `reasoning_step_marks` And `reasoning_mark_step`

**Files:**
- Create: `src/migrations/0002_reasoning_step_marks.ts`
- Modify: `src/migrations/index.ts`
- Modify: `src/schemas/reasoning.ts`
- Modify: `src/types.ts`
- Modify: `src/tools/reasoning.ts`
- Test: `src/__tests__/reasoning-audit-tools.test.ts`

- [ ] **Step 1: Write a failing audit mark test**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { runMigrations } from "../migrations/index.js";

test("reasoning_step_marks enforces one row per step and mark type", () => {
  const db = new DatabaseSync(makeTempDbPath("marks"));
  runMigrations(db);

  db.prepare(
    "INSERT INTO reasoning_sessions (id, title, status, created_at, updated_at) VALUES (?, ?, 'in_progress', ?, ?)"
  ).run("sess_1", "test", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");

  db.prepare(
    "INSERT INTO reasoning_steps (id, session_id, step_number, thought, created_at) VALUES (?, ?, ?, ?, ?)"
  ).run("step_1", "sess_1", 1, "first", "2026-01-01T00:00:00.000Z");

  db.prepare(
    "INSERT INTO reasoning_step_marks (id, step_id, mark_type, note, created_at) VALUES (?, ?, ?, ?, ?)"
  ).run("mark_1", "step_1", "decision", null, "2026-01-01T00:00:00.000Z");

  assert.throws(() => {
    db.prepare(
      "INSERT INTO reasoning_step_marks (id, step_id, mark_type, note, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run("mark_2", "step_1", "decision", "updated", "2026-01-01T00:00:01.000Z");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern="reasoning_step_marks enforces one row per step and mark type"`

Expected: FAIL because `reasoning_step_marks` does not exist

- [ ] **Step 3: Add the migration and register it**

```ts
import type { Migration } from "./index.js";

export const migration0002ReasoningStepMarks: Migration = {
  version: "0002_reasoning_step_marks",
  apply(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS reasoning_step_marks (
        id TEXT PRIMARY KEY,
        step_id TEXT NOT NULL REFERENCES reasoning_steps(id) ON DELETE CASCADE,
        mark_type TEXT NOT NULL
          CHECK (mark_type IN ('milestone','decision','conflict','important','hypothesis')),
        note TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(step_id, mark_type)
      );

      CREATE INDEX IF NOT EXISTS idx_reasoning_step_marks_step_id
        ON reasoning_step_marks(step_id);
      CREATE INDEX IF NOT EXISTS idx_reasoning_step_marks_type_created
        ON reasoning_step_marks(mark_type, created_at);
    `);
  },
};
```

- [ ] **Step 4: Add schema/type support for `reasoning_mark_step`**

```ts
export const ReasoningMarkTypeEnum = z.enum([
  "milestone",
  "decision",
  "conflict",
  "important",
  "hypothesis",
]);

export const ReasoningMarkStepInputSchema = z.object({
  step_id: z.string().min(1),
  mark_type: ReasoningMarkTypeEnum,
  note: z.string().max(1000).optional(),
}).strict();
```

- [ ] **Step 5: Implement `reasoning_mark_step` with idempotent update semantics**

```ts
server.registerTool(
  "reasoning_mark_step",
  {
    title: "Mark Reasoning Step",
    description: "Attach an audit marker to an existing reasoning step.",
    inputSchema: ReasoningMarkStepInputSchema.shape,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (params) => {
    try {
      const step = db.prepare("SELECT id FROM reasoning_steps WHERE id = ?").get(params.step_id);
      if (!step) {
        return {
          content: [{ type: "text" as const, text: `Error: Step '${params.step_id}' not found.` }],
          isError: true,
        };
      }

      const ts = nowIso();
      db.prepare(`
        INSERT INTO reasoning_step_marks (id, step_id, mark_type, note, created_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(step_id, mark_type)
        DO UPDATE SET note = excluded.note
      `).run(newId("mark"), params.step_id, params.mark_type, params.note ?? null, ts);

      const output = { step_id: params.step_id, mark_type: params.mark_type, note: params.note ?? null };
      return {
        content: [{ type: "text" as const, text: toLimitedJson(output) }],
        structuredContent: output,
      };
    } catch (error) {
      return { content: [{ type: "text" as const, text: handleToolError(error) }], isError: true };
    }
  }
);
```

- [ ] **Step 6: Run tests**

Run: `npm test -- --test-name-pattern="reasoning_step_marks|Mark Reasoning Step"`

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/migrations/0002_reasoning_step_marks.ts src/migrations/index.ts src/schemas/reasoning.ts src/types.ts src/tools/reasoning.ts src/__tests__/reasoning-audit-tools.test.ts
git commit -m "feat: add reasoning step marks"
```

### Task 4: Add `reasoning_steps_fts`, `reasoning_search_steps`, And Session Count Fix

**Files:**
- Create: `src/migrations/0003_reasoning_steps_fts.ts`
- Modify: `src/migrations/index.ts`
- Modify: `src/schemas/reasoning.ts`
- Modify: `src/types.ts`
- Modify: `src/tools/reasoning.ts`
- Test: `src/__tests__/migrations.test.ts`
- Test: `src/__tests__/reasoning-audit-tools.test.ts`

- [ ] **Step 1: Write a failing upgrade/backfill test**

```ts
test("0003_reasoning_steps_fts backfills existing reasoning steps", () => {
  const db = new DatabaseSync(makeTempDbPath("fts"));
  migration0001Initial.apply(db);

  db.prepare(
    "INSERT INTO reasoning_sessions (id, title, status, created_at, updated_at) VALUES (?, ?, 'in_progress', ?, ?)"
  ).run("sess_1", "search", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
  db.prepare(
    "INSERT INTO reasoning_steps (id, session_id, step_number, thought, action, observation, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run("step_1", "sess_1", 1, "searchable thought", null, null, "2026-01-01T00:00:00.000Z");

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);
  db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run("0001_initial", "2026-01-01T00:00:00.000Z");
  db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run("0002_reasoning_step_marks", "2026-01-01T00:00:00.000Z");

  runMigrations(db);

  const rows = db.prepare(`
    SELECT rowid FROM reasoning_steps_fts
    WHERE reasoning_steps_fts MATCH ?
  `).all('"searchable"*') as Array<{ rowid: number }>;

  assert.equal(rows.length, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern="0003_reasoning_steps_fts backfills existing reasoning steps"`

Expected: FAIL because `reasoning_steps_fts` does not exist

- [ ] **Step 3: Add the FTS migration**

```ts
import type { Migration } from "./index.js";

export const migration0003ReasoningStepsFts: Migration = {
  version: "0003_reasoning_steps_fts",
  apply(db) {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS reasoning_steps_fts USING fts5(
        thought,
        action,
        observation,
        content='reasoning_steps',
        content_rowid='rowid'
      );

      CREATE TRIGGER IF NOT EXISTS reasoning_steps_ai AFTER INSERT ON reasoning_steps BEGIN
        INSERT INTO reasoning_steps_fts(rowid, thought, action, observation)
        VALUES (new.rowid, coalesce(new.thought, ''), coalesce(new.action, ''), coalesce(new.observation, ''));
      END;

      CREATE TRIGGER IF NOT EXISTS reasoning_steps_ad AFTER DELETE ON reasoning_steps BEGIN
        INSERT INTO reasoning_steps_fts(reasoning_steps_fts, rowid, thought, action, observation)
        VALUES ('delete', old.rowid, coalesce(old.thought, ''), coalesce(old.action, ''), coalesce(old.observation, ''));
      END;

      CREATE TRIGGER IF NOT EXISTS reasoning_steps_au AFTER UPDATE ON reasoning_steps BEGIN
        INSERT INTO reasoning_steps_fts(reasoning_steps_fts, rowid, thought, action, observation)
        VALUES ('delete', old.rowid, coalesce(old.thought, ''), coalesce(old.action, ''), coalesce(old.observation, ''));
        INSERT INTO reasoning_steps_fts(rowid, thought, action, observation)
        VALUES (new.rowid, coalesce(new.thought, ''), coalesce(new.action, ''), coalesce(new.observation, ''));
      END;

      INSERT INTO reasoning_steps_fts(reasoning_steps_fts) VALUES ('rebuild');
    `);
  },
};
```

- [ ] **Step 4: Replace N+1 session counting with one grouped query**

```ts
const rows = db.prepare(`
  SELECT
    s.*,
    COUNT(rs.id) AS step_count
  FROM reasoning_sessions s
  LEFT JOIN reasoning_steps rs ON rs.session_id = s.id
  WHERE ${conditions.join(" AND ")}
  GROUP BY s.id
  ORDER BY s.updated_at DESC
  LIMIT ? OFFSET ?
`).all(...sqlParams, params.limit, params.offset) as Array<ReasoningSessionRow & { step_count: number }>;

const sessions = rows.map((row) => sessionRowToRecord(row, row.step_count));
```

- [ ] **Step 5: Add `reasoning_search_steps`**

```ts
server.registerTool(
  "reasoning_search_steps",
  {
    title: "Search Reasoning Steps",
    description: "Search reasoning steps across thought, action, and observation.",
    inputSchema: ReasoningSearchStepsInputSchema.shape,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (params) => {
    try {
      const conditions = ["rs.rowid IN (SELECT rowid FROM reasoning_steps_fts WHERE reasoning_steps_fts MATCH ?)"];
      const sqlParams: Array<string | number> = [toFtsQuery(params.query)];

      if (params.session_id) {
        conditions.push("rs.session_id = ?");
        sqlParams.push(params.session_id);
      }
      if (params.agent_id) {
        conditions.push("sess.agent_id = ?");
        sqlParams.push(params.agent_id);
      }
      if (params.mark_type) {
        conditions.push("EXISTS (SELECT 1 FROM reasoning_step_marks sm WHERE sm.step_id = rs.id AND sm.mark_type = ?)");
        sqlParams.push(params.mark_type);
      }

      const rows = db.prepare(`
        SELECT rs.*, sess.agent_id
        FROM reasoning_steps rs
        JOIN reasoning_sessions sess ON sess.id = rs.session_id
        WHERE ${conditions.join(" AND ")}
        ORDER BY rs.created_at DESC, rs.step_number DESC
        LIMIT ? OFFSET ?
      `).all(...sqlParams, params.limit, params.offset);

      return {
        content: [{ type: "text" as const, text: toLimitedJson({ results: rows }) }],
        structuredContent: { results: rows },
      };
    } catch (error) {
      return { content: [{ type: "text" as const, text: handleToolError(error) }], isError: true };
    }
  }
);
```

- [ ] **Step 6: Run targeted tests**

Run: `npm test -- --test-name-pattern="0003_reasoning_steps_fts|Search Reasoning Steps|List Reasoning Sessions"`

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/migrations/0003_reasoning_steps_fts.ts src/migrations/index.ts src/schemas/reasoning.ts src/types.ts src/tools/reasoning.ts src/__tests__/migrations.test.ts src/__tests__/reasoning-audit-tools.test.ts
git commit -m "feat: add reasoning search and session aggregation"
```

### Task 5: Add `reasoning_list_milestones` And `reasoning_get_session_outline`

**Files:**
- Modify: `src/schemas/reasoning.ts`
- Modify: `src/types.ts`
- Modify: `src/tools/reasoning.ts`
- Test: `src/__tests__/reasoning-audit-tools.test.ts`

- [ ] **Step 1: Write failing outline and milestone tests**

```ts
test("reasoning_get_session_outline falls back to first middle last deterministically", async () => {
  const output = await getSessionOutlineForTest({
    steps: [
      { id: "s1", step_number: 1, thought: "first", action: null, observation: null, created_at: "2026-01-01T00:00:00.000Z" },
      { id: "s2", step_number: 2, thought: "middle", action: null, observation: null, created_at: "2026-01-01T00:00:01.000Z" },
      { id: "s3", step_number: 3, thought: "last", action: null, observation: null, created_at: "2026-01-01T00:00:02.000Z" },
    ],
    marks: [],
    conclusion: null,
  });

  assert.deepEqual(
    output.steps.map((step) => step.step_number),
    [1, 2, 3]
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern="falls back to first middle last deterministically|list milestones"`

Expected: FAIL because the tools or helper do not exist yet

- [ ] **Step 3: Add the missing schemas**

```ts
export const ReasoningListMilestonesInputSchema = z.object({
  session_id: z.string().min(1).optional(),
  agent_id: z.string().max(100).optional(),
  mark_type: ReasoningMarkTypeEnum.optional(),
  limit: z.number().int().min(1).max(200).default(20),
  offset: z.number().int().min(0).default(0),
}).strict();

export const ReasoningGetSessionOutlineInputSchema = z.object({
  session_id: z.string().min(1),
}).strict();
```

- [ ] **Step 4: Implement the two tools with deterministic ordering**

```ts
function selectFallbackOutlineSteps(steps: ReasoningStepRecord[]): ReasoningStepRecord[] {
  if (steps.length <= 2) return steps;
  const middleIndex = Math.floor((steps.length - 1) / 2);
  return [steps[0], steps[middleIndex], steps[steps.length - 1]];
}
```

```ts
server.registerTool("reasoning_list_milestones", /* query marked steps ordered by created_at, step_number */);
server.registerTool("reasoning_get_session_outline", /* prefer marked steps, else deterministic fallback */);
```

- [ ] **Step 5: Run focused tests**

Run: `npm test -- --test-name-pattern="milestones|session outline"`

Expected: PASS

- [ ] **Step 6: Run the full suite**

Run: `npm test`

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/schemas/reasoning.ts src/types.ts src/tools/reasoning.ts src/__tests__/reasoning-audit-tools.test.ts
git commit -m "feat: add reasoning audit read tools"
```

## Spec Coverage Check

- Migration-first bootstrap: covered by Tasks 1-2
- `reasoning_step_marks`: covered by Task 3
- `reasoning_steps_fts` with backfill: covered by Task 4
- `reasoning_search_steps`: covered by Task 4
- `reasoning_list_sessions` aggregation fix: covered by Task 4
- `reasoning_list_milestones`: covered by Task 5
- `reasoning_get_session_outline` deterministic fallback: covered by Task 5

## Placeholder Scan

- No `TODO`
- No `TBD`
- No “write tests later”

## Type Consistency Check

- `mark_type` uses the same enum in migrations, schemas, and tools
- migration versions are `0001_initial`, `0002_reasoning_step_marks`, `0003_reasoning_steps_fts`
- fallback outline contract uses first/middle/last ordering consistently

