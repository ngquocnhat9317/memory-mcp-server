import type { Migration } from "./index.js";

export const migration0005MemoryWorkspace: Migration = {
  version: "0005_memory_workspace",
  apply(db) {
    db.exec(`
      ALTER TABLE memories ADD COLUMN workspace TEXT;
      CREATE INDEX IF NOT EXISTS idx_memories_workspace ON memories(workspace);
    `);
  },
};
