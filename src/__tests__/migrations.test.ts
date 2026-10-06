import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { migration0001Initial } from "../migrations/0001_initial.js";
import { runMigrations } from "../migrations/index.js";

function makeTempDbPath(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-mcp-"));
  return path.join(dir, `${name}.db`);
}

test("runMigrations creates schema_migrations and applies baseline schema", () => {
  const dbPath = makeTempDbPath("fresh");
  const tempDir = path.dirname(dbPath);
  const db = new DatabaseSync(dbPath);

  try {
    runMigrations(db);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>;

    assert.ok(tables.some((row) => row.name === "schema_migrations"));
    assert.ok(tables.some((row) => row.name === "memories"));
    assert.ok(tables.some((row) => row.name === "reasoning_sessions"));
    assert.ok(tables.some((row) => row.name === "reasoning_steps"));
    assert.ok(tables.some((row) => row.name === "tool_usage_events"));
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("runMigrations records all registered migrations after creating the baseline schema", () => {
  const dbPath = makeTempDbPath("baseline");
  const tempDir = path.dirname(dbPath);
  const db = new DatabaseSync(dbPath);

  try {
    runMigrations(db);

    const versions = db
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all() as Array<{ version: string }>;

    assert.deepEqual(
      versions.map((row) => row.version),
      [
        "0001_initial",
        "0002_reasoning_step_marks",
        "0003_reasoning_steps_fts",
        "0004_tool_usage_events",
        "0005_memory_workspace",
        "0006_workspace_identity",
        "0007_drop_reasoning_step_marks",
      ]
    );
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("0003_reasoning_steps_fts backfills existing reasoning steps", () => {
  const dbPath = makeTempDbPath("fts");
  const tempDir = path.dirname(dbPath);
  const db = new DatabaseSync(dbPath);

  try {
    migration0001Initial.apply(db);

    db.prepare(
      "INSERT INTO reasoning_sessions (id, title, status, created_at, updated_at) VALUES (?, ?, 'in_progress', ?, ?)"
    ).run("sess_1", "search", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");

    db.prepare(
      "INSERT INTO reasoning_steps (id, session_id, step_number, thought, action, observation, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(
      "step_1",
      "sess_1",
      1,
      "searchable thought",
      null,
      null,
      "2026-01-01T00:00:00.000Z"
    );

    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      )
    `);
    db.prepare(
      "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)"
    ).run("0001_initial", "2026-01-01T00:00:00.000Z");
    db.prepare(
      "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)"
    ).run("0002_reasoning_step_marks", "2026-01-01T00:00:00.000Z");

    runMigrations(db);

    const rows = db
      .prepare(
        `SELECT rowid FROM reasoning_steps_fts
         WHERE reasoning_steps_fts MATCH ?`
      )
      .all('"searchable"*') as Array<{ rowid: number }>;

    assert.equal(rows.length, 1);
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("0007 drops reasoning_step_marks and keeps steps and their FTS index (AC-16.5)", () => {
  const dbPath = makeTempDbPath("drop-marks");
  const tempDir = path.dirname(dbPath);
  const db = new DatabaseSync(dbPath);
  try {
    runMigrations(db);
    db.prepare(
      "INSERT INTO reasoning_sessions (id, title, status, created_at, updated_at) VALUES ('s1', 't', 'in_progress', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')"
    ).run();
    db.prepare(
      "INSERT INTO reasoning_steps (id, session_id, step_number, thought, created_at) VALUES ('st1', 's1', 1, 'heron sighting', '2026-01-01T00:00:00.000Z')"
    ).run();
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','trigger')").all() as Array<{ name: string }>).map((r) => r.name);
    assert.ok(!tables.includes("reasoning_step_marks"));
    for (const name of ["reasoning_steps", "reasoning_steps_fts", "reasoning_steps_ai", "reasoning_steps_ad", "reasoning_steps_au"]) {
      assert.ok(tables.includes(name), `${name} should remain`);
    }
    const hit = db.prepare("SELECT rowid FROM reasoning_steps_fts WHERE reasoning_steps_fts MATCH 'heron'").all();
    assert.equal(hit.length, 1, "a step added after 0007 is still indexed");
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("0007 on a database at 0006 with marks keeps step rows (AC-16.5)", () => {
  const dbPath = makeTempDbPath("drop-marks-upgrade");
  const tempDir = path.dirname(dbPath);
  const db = new DatabaseSync(dbPath);
  try {
    runMigrations(db); // reaches 0007 already; rebuild the pre-0007 state:
    db.exec(`
      DELETE FROM schema_migrations WHERE version = '0007_drop_reasoning_step_marks';
      CREATE TABLE reasoning_step_marks (id TEXT PRIMARY KEY, step_id TEXT NOT NULL, mark_type TEXT NOT NULL, note TEXT, created_at TEXT NOT NULL);
      INSERT INTO reasoning_sessions (id, title, status, created_at, updated_at) VALUES ('s1', 't', 'completed', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      INSERT INTO reasoning_steps (id, session_id, step_number, thought, created_at) VALUES ('st1', 's1', 1, 'kept', '2026-01-01T00:00:00.000Z');
      INSERT INTO reasoning_step_marks VALUES ('m1', 'st1', 'decision', 'n', '2026-01-01T00:00:00.000Z');
    `);
    runMigrations(db);
    const marks = db.prepare("SELECT name FROM sqlite_master WHERE name = 'reasoning_step_marks'").all();
    assert.equal(marks.length, 0);
    const steps = db.prepare("SELECT COUNT(*) AS c FROM reasoning_steps").get() as { c: number };
    assert.equal(steps.c, 1);
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
