/**
 * Recall evaluation cases: a small labelled set that locks the ranking
 * behavior of auto-recall (reasoning_start_session) and memory_search.
 * Seeds are deliberately separated (distinct vocabulary per case) so every
 * expectation is unambiguous. Recall cases describe shipped 1.3.3 behavior;
 * search cases describe the blended OR-matching behavior.
 */

/** ISO timestamp for `days` ago, so recency cases stay valid over time. */
export function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

export const HOME_WORKSPACE = "/eval/home";
export const OTHER_WORKSPACE = "/eval/other";

export interface EvalSeedMemory {
  id: string;
  content: string;
  type: "fact" | "decision" | "preference";
  tags: string[];
  importance: number;
  workspace: string | null;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

export interface EvalExpectation {
  /** Exact result id order. */
  order?: string[];
  /** First result id. */
  top?: string;
  includes?: string[];
  excludes?: string[];
  /** No results (empty related_memories / "No memories found"). */
  empty?: true;
  /** Concatenated pages of this size must equal the unpaged order. */
  paginationStableWithPageSize?: number;
  /** Recalled memory must carry this `source` block. */
  source?: { memoryId: string; sessionId: string; sessionTitle: string };
  /** The recalled memory's snippet must contain this text. */
  snippetContains?: { memoryId: string; text: string };
}

export interface RecallEvalCase {
  description: string;
  tool: "recall" | "search";
  /** Session title for recall, query text for search. */
  query: string;
  /** Sets MEMORY_WORKSPACE for the case; defaults to HOME_WORKSPACE. */
  workspace?: string;
  type?: "fact" | "decision" | "preference";
  tags?: string[];
  limit?: number;
  offset?: number;
  seedMemories: EvalSeedMemory[];
  expected: EvalExpectation;
}

function seed(
  id: string,
  content: string,
  overrides: Partial<EvalSeedMemory> = {}
): EvalSeedMemory {
  return {
    id,
    content,
    type: "fact",
    tags: [],
    importance: 3,
    workspace: HOME_WORKSPACE,
    updatedAt: daysAgo(10),
    ...overrides,
  };
}

export const RECALL_EVAL_CASES: RecallEvalCase[] = [
  // ---- Auto-recall (reasoning_start_session), shipped 1.3.3 behavior ----
  {
    description: "recall: multi-term match beats a single-shared-word match",
    tool: "recall",
    query: "invoice reconciliation",
    seedMemories: [
      seed("mem_both", "invoice reconciliation procedure for the ledger"),
      seed("mem_one", "invoice template styling guidelines"),
    ],
    expected: { order: ["mem_both", "mem_one"] },
  },
  {
    description: "recall: same-workspace beats NULL-workspace at equal coverage",
    tool: "recall",
    query: "analytics warehouse vacuum",
    seedMemories: [
      seed("mem_null", "analytics warehouse vacuum policy", { workspace: null }),
      seed("mem_home", "analytics warehouse vacuum policy"),
    ],
    expected: { order: ["mem_home", "mem_null"] },
  },
  {
    description:
      "recall: other-workspace non-preference memory with partial coverage is excluded",
    tool: "recall",
    query: "kafka consumer lag alerts",
    seedMemories: [
      seed("mem_home", "kafka consumer lag dashboard setup"),
      seed("mem_away", "kafka consumer retention policy", {
        workspace: OTHER_WORKSPACE,
      }),
    ],
    expected: { order: ["mem_home"], excludes: ["mem_away"] },
  },
  {
    description: "recall: other-workspace preference memory bypasses the gate",
    tool: "recall",
    query: "kafka consumer lag alerts",
    seedMemories: [
      seed("mem_pref", "kafka consumer retention policy", {
        type: "preference",
        workspace: OTHER_WORKSPACE,
      }),
    ],
    expected: { includes: ["mem_pref"] },
  },
  {
    description:
      "recall: title with 3+ significant terms excludes a one-word-overlap memory",
    tool: "recall",
    query: "elasticsearch shard rebalancing strategy",
    seedMemories: [
      seed("mem_two", "shard rebalancing notes from the last outage"),
      seed("mem_one", "elasticsearch license renewal reminder"),
    ],
    expected: { order: ["mem_two"], excludes: ["mem_one"] },
  },
  {
    description: "recall: short title keeps a single-term match",
    tool: "recall",
    query: "grafana tuning",
    seedMemories: [seed("mem_single", "grafana dashboards overview and conventions")],
    expected: { includes: ["mem_single"] },
  },
  {
    description: "recall: nothing eligible returns empty related_memories (no lifeline)",
    tool: "recall",
    query: "resolve checkout timeout payment gateway",
    seedMemories: [
      seed("mem_a", "payment provider rotation schedule"),
      seed("mem_b", "gateway hardware inventory list"),
    ],
    expected: { empty: true },
  },
  {
    description: "recall: memory with session metadata is recalled with source intact",
    tool: "recall",
    query: "cache invalidation strategy",
    seedMemories: [
      seed("mem_sourced", "cache invalidation strategy for the edge layer", {
        metadata: {
          source_session_id: "ses_origin_1",
          session_title: "Edge cache rollout",
        },
      }),
    ],
    expected: {
      includes: ["mem_sourced"],
      source: {
        memoryId: "mem_sourced",
        sessionId: "ses_origin_1",
        sessionTitle: "Edge cache rollout",
      },
    },
  },
  {
    description: "recall: recency orders two memories with otherwise equal relevance",
    tool: "recall",
    query: "feature flag cleanup",
    seedMemories: [
      // Older one has higher importance, so only the recency term can put
      // the newer one first.
      seed("mem_old", "feature flag cleanup checklist", {
        updatedAt: daysAgo(300),
        importance: 4,
      }),
      seed("mem_new", "feature flag cleanup checklist", { updatedAt: daysAgo(2) }),
    ],
    expected: { order: ["mem_new", "mem_old"] },
  },

  // ---- memory_search (A': OR matching + blended ranking) ----
  {
    description: "search: a memory lacking one query term is still returned",
    tool: "search",
    query: "terraform drift",
    seedMemories: [seed("mem_partial", "terraform state locking guide")],
    expected: { order: ["mem_partial"] },
  },
  {
    description: "search: all-terms match ranks above a partial match",
    tool: "search",
    query: "redis eviction",
    seedMemories: [
      seed("mem_partial", "redis cluster failover runbook", {
        importance: 5,
        updatedAt: daysAgo(1),
      }),
      seed("mem_full", "redis eviction tuning for the session cache"),
    ],
    expected: { order: ["mem_full", "mem_partial"] },
  },
  {
    description: "search: 3+ term query excludes a memory matching only one term",
    tool: "search",
    query: "postgres vacuum autovacuum",
    seedMemories: [
      seed("mem_full", "postgres vacuum and autovacuum tuning"),
      seed("mem_two", "postgres vacuum schedule for the reporting replica"),
      seed("mem_one", "postgres major version upgrade checklist"),
    ],
    expected: { order: ["mem_full", "mem_two"], excludes: ["mem_one"] },
  },
  {
    description: "search: concatenated pages equal the unpaged order",
    tool: "search",
    query: "kubernetes ingress",
    seedMemories: [
      seed("mem_p1", "kubernetes ingress controller timeouts", { updatedAt: daysAgo(5) }),
      seed("mem_p2", "kubernetes ingress annotations reference", { updatedAt: daysAgo(40) }),
      seed("mem_p3", "kubernetes node pool sizing", { updatedAt: daysAgo(20) }),
      seed("mem_p4", "ingress hostnames for the staging cluster", { updatedAt: daysAgo(90) }),
      seed("mem_p5", "kubernetes ingress tls renewal and kubernetes ingress class", {
        updatedAt: daysAgo(150),
      }),
      seed("mem_p6", "ingress rate limiting notes", { updatedAt: daysAgo(15) }),
    ],
    expected: { paginationStableWithPageSize: 2 },
  },
  {
    description: "search: recency breaks a tie between otherwise equal-relevance memories",
    tool: "search",
    query: "sprint retrospective",
    seedMemories: [
      seed("mem_old", "sprint retrospective format", {
        updatedAt: daysAgo(300),
        importance: 4,
      }),
      seed("mem_new", "sprint retrospective format", { updatedAt: daysAgo(2) }),
    ],
    expected: { order: ["mem_new", "mem_old"] },
  },
  {
    description: "search: type filter still applies",
    tool: "search",
    query: "deploy runbook",
    type: "decision",
    seedMemories: [
      seed("mem_fact", "deploy runbook for the billing service"),
      seed("mem_decision", "deploy runbook ownership moved to platform", {
        type: "decision",
      }),
    ],
    expected: { order: ["mem_decision"] },
  },
  {
    description: "search: tags filter still applies",
    tool: "search",
    query: "queue backlog",
    tags: ["infra"],
    seedMemories: [
      seed("mem_tagged", "queue backlog alert thresholds", { tags: ["infra"] }),
      seed("mem_untagged", "queue backlog dashboard layout", { tags: ["frontend"] }),
    ],
    expected: { order: ["mem_tagged"] },
  },
  {
    description: "search: punctuation-only tokens do not count toward the coverage floor",
    tool: "search",
    query: "invoice – reconciliation",
    seedMemories: [seed("mem_invoice", "invoice numbering scheme")],
    expected: { order: ["mem_invoice"] },
  },
  {
    description: "search: a query with no matching term returns no memories",
    tool: "search",
    query: "zzzunmatched qqqterm",
    seedMemories: [seed("mem_other", "unrelated note about onboarding")],
    expected: { empty: true },
  },
  {
    description: "recall snippet shows a title-term match that sits past character 160",
    tool: "recall",
    query: "pangolin quarantine",
    seedMemories: [
      {
        id: "mem_far_match",
        content: `Weekly ops notes. ${"Routine maintenance entries with no relevant subject. ".repeat(5)}Decision: the pangolin quarantine stays until the vet signs off.`,
        type: "decision",
        tags: [],
        importance: 3,
        workspace: HOME_WORKSPACE,
        updatedAt: daysAgo(1),
      },
    ],
    expected: { top: "mem_far_match", snippetContains: { memoryId: "mem_far_match", text: "pangolin quarantine" } },
  },
];
