import type { Migration } from "./index.js";

export const migration0004ToolUsageEvents: Migration = {
  version: "0004_tool_usage_events",
  apply(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS tool_usage_events (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        agent_id TEXT,
        client_name TEXT,
        client_version TEXT,
        mcp_version TEXT NOT NULL,
        guidance_version TEXT,
        tool_name TEXT NOT NULL,
        operation_type TEXT NOT NULL
          CHECK (operation_type IN ('memory','reasoning','guidance','report','feedback')),
        access_type TEXT NOT NULL
          CHECK (access_type IN ('read','write','delete','derived')),
        status TEXT NOT NULL
          CHECK (status IN ('success','error','skipped')),
        error_code TEXT,
        latency_ms INTEGER,
        session_id TEXT,
        step_id TEXT,
        memory_id TEXT,
        related_event_id TEXT,
        input_shape TEXT,
        output_shape TEXT,
        metadata TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_tool_usage_events_created_at
        ON tool_usage_events(created_at);
      CREATE INDEX IF NOT EXISTS idx_tool_usage_events_agent_created_at
        ON tool_usage_events(agent_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_tool_usage_events_mcp_created_at
        ON tool_usage_events(mcp_version, created_at);
      CREATE INDEX IF NOT EXISTS idx_tool_usage_events_tool_created_at
        ON tool_usage_events(tool_name, created_at);
      CREATE INDEX IF NOT EXISTS idx_tool_usage_events_status_created_at
        ON tool_usage_events(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_tool_usage_events_session_id
        ON tool_usage_events(session_id);
      CREATE INDEX IF NOT EXISTS idx_tool_usage_events_memory_id
        ON tool_usage_events(memory_id);
    `);
  },
};
