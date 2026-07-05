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
