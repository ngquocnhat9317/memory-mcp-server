export type MemoryType =
  | "fact"
  | "preference"
  | "episodic"
  | "decision"
  | "reasoning_summary";

export interface MemoryRecord {
  id: string;
  type: MemoryType;
  content: string;
  tags: string[];
  agent_id: string | null;
  importance: number;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

/** Row shape as stored in SQLite (tags/metadata serialized as JSON text). */
export interface MemoryRow {
  id: string;
  type: string;
  content: string;
  tags: string | null;
  agent_id: string | null;
  importance: number;
  metadata: string | null;
  created_at: string;
  updated_at: string;
}

export type SessionStatus = "in_progress" | "completed" | "abandoned";
export type ReasoningMarkType =
  | "milestone"
  | "decision"
  | "conflict"
  | "important"
  | "hypothesis";

export interface ReasoningSessionRecord {
  id: string;
  title: string;
  agent_id: string | null;
  status: SessionStatus;
  conclusion: string | null;
  created_at: string;
  updated_at: string;
  step_count: number;
}

export interface ReasoningSessionRow {
  id: string;
  title: string;
  agent_id: string | null;
  status: string;
  conclusion: string | null;
  created_at: string;
  updated_at: string;
}

export interface ReasoningStepRecord {
  id: string;
  session_id: string;
  step_number: number;
  thought: string | null;
  action: string | null;
  observation: string | null;
  created_at: string;
}

export interface ReasoningSearchStepRecord extends ReasoningStepRecord {
  agent_id: string | null;
  snippet: string;
}

export interface ReasoningMilestoneRecord {
  session_id: string;
  step_id: string;
  step_number: number;
  mark_type: ReasoningMarkType;
  note: string | null;
  created_at: string;
  snippet: string;
}

export interface ReasoningOutlineStepRecord extends ReasoningStepRecord {
  mark_type: ReasoningMarkType | null;
  note: string | null;
}

export interface ReasoningStepMarkRecord {
  id: string;
  step_id: string;
  mark_type: ReasoningMarkType;
  note: string | null;
  created_at: string;
}

export interface ReasoningStepMarkRow {
  id: string;
  step_id: string;
  mark_type: string;
  note: string | null;
  created_at: string;
}
