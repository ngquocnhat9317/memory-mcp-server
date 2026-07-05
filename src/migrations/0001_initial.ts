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
