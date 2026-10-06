import type { Migration } from "./index.js";

// reasoning_mark_step and every reader of marks were removed in 1.4.0;
// unread data is deleted, not kept (AGENTS.md Tool Surface Policy).
export const migration0007DropReasoningStepMarks: Migration = {
  version: "0007_drop_reasoning_step_marks",
  apply(db) {
    db.exec(`DROP TABLE IF EXISTS reasoning_step_marks;`);
  },
};
