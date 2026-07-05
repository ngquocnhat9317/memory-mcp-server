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
