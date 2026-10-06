import type { Migration } from "./index.js";

// Which memories reasoning_start_session recalled, as a JSON array (WI-18).
// NULL = not recorded (pre-1.4.0) or nothing recalled.
export const migration0008SessionRecalledMemoryIds: Migration = {
  version: "0008_session_recalled_memory_ids",
  apply(db) {
    db.exec(`ALTER TABLE reasoning_sessions ADD COLUMN recalled_memory_ids TEXT;`);
  },
};
