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
 * Inserts a memory row directly (memories_fts is kept in sync by triggers).
 * Replaces memory_save as a test fixture now that the tool is gone.
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
