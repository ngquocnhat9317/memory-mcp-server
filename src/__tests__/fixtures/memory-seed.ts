import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export interface SeedMemory {
  id?: string;
  type?: "fact" | "preference" | "episodic" | "decision" | "reasoning_summary";
  content: string;
  tags?: string[];
  agentId?: string | null;
  importance?: number;
  metadata?: Record<string, unknown> | null;
  workspace?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * Inserts a memory row straight into the memories table and returns its id.
 * memories_fts stays in sync through the table triggers, so tests can seed
 * memories without going through a tool.
 */
export function insertMemory(db: DatabaseSync, seed: SeedMemory): string {
  const id = seed.id ?? `mem_${randomUUID()}`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO memories (id, type, content, tags, agent_id, importance, metadata, workspace, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    seed.type ?? "fact",
    seed.content,
    JSON.stringify(seed.tags ?? []),
    seed.agentId ?? null,
    seed.importance ?? 3,
    seed.metadata ? JSON.stringify(seed.metadata) : null,
    seed.workspace ?? null,
    seed.createdAt ?? now,
    seed.updatedAt ?? seed.createdAt ?? now
  );
  return id;
}

type ToolHandlers = Record<
  string,
  {
    handler: (params: Record<string, unknown>) => Promise<{
      structuredContent?: Record<string, unknown>;
      isError?: boolean;
      content: Array<{ type: "text"; text: string }>;
    }>;
  }
>;

/** Returns the workspace stamped on a memory saved through a completed reasoning session. */
export async function saveConclusion(
  tools: ToolHandlers,
  db: DatabaseSync,
  workspace?: string
): Promise<string | null> {
  const started = await tools.reasoning_start_session.handler({
    title: "workspace stamping",
    ...(workspace !== undefined ? { workspace } : {}),
  });
  assert.equal(started.isError, undefined, started.content[0]?.text);
  const sessionId = (started.structuredContent as { session_id: string }).session_id;
  const step = await tools.reasoning_add_step.handler({ session_id: sessionId, thought: "t" });
  assert.equal(step.isError, undefined, step.content[0]?.text);
  const done = await tools.reasoning_complete_session.handler({
    session_id: sessionId,
    conclusion: "stamped",
    status: "completed",
    save_as_memory: true,
  });
  assert.equal(done.isError, undefined, done.content[0]?.text);
  const memoryId = (done.structuredContent as { memory_id: string }).memory_id;
  return (
    db.prepare(`SELECT workspace FROM memories WHERE id = ?`).get(memoryId) as {
      workspace: string | null;
    }
  ).workspace;
}
