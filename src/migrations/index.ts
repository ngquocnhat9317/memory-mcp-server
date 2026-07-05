import type { DatabaseSync } from "node:sqlite";
import { nowIso } from "../utils.js";
import { migration0001Initial } from "./0001_initial.js";
import { migration0002ReasoningStepMarks } from "./0002_reasoning_step_marks.js";
import { migration0003ReasoningStepsFts } from "./0003_reasoning_steps_fts.js";

export interface Migration {
  version: string;
  apply: (db: DatabaseSync) => void;
}

const migrations: Migration[] = [
  migration0001Initial,
  migration0002ReasoningStepMarks,
  migration0003ReasoningStepsFts,
];

export function runMigrations(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);

  const applied = new Set(
    (db.prepare("SELECT version FROM schema_migrations").all() as Array<{
      version: string;
    }>).map((row) => row.version)
  );

  const pending = migrations.filter((migration) => !applied.has(migration.version));
  if (pending.length === 0) return;

  const insertMigration = db.prepare(`
    INSERT INTO schema_migrations (version, applied_at)
    VALUES (?, ?)
  `);

  for (const migration of pending) {
    db.exec("BEGIN");
    try {
      migration.apply(db);
      insertMigration.run(migration.version, nowIso());
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}
