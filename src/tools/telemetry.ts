import type { DatabaseSync } from "node:sqlite";
import { MCP_VERSION, isTelemetryEnabled } from "../constants.js";
import { handleToolError, newId, nowIso } from "../utils.js";

type DatabaseProvider = DatabaseSync | (() => Promise<DatabaseSync>);

export type ToolResponse = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

type OperationType = "memory" | "reasoning" | "guidance" | "report" | "feedback";
type AccessType = "read" | "write" | "delete" | "derived";
type StatusType = "success" | "error" | "skipped";

export interface ToolUsageEventInput {
  toolName: string;
  operationType: OperationType;
  accessType: AccessType;
  status: StatusType;
  errorCode?: string | null;
  latencyMs?: number | null;
  agentId?: string | null;
  clientName?: string | null;
  clientVersion?: string | null;
  guidanceVersion?: string | null;
  sessionId?: string | null;
  stepId?: string | null;
  memoryId?: string | null;
  relatedEventId?: string | null;
  inputShape?: Record<string, unknown> | null;
  outputShape?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
}

export interface ToolTelemetryConfig<TParams> {
  database: DatabaseProvider;
  toolName: string;
  operationType: OperationType;
  accessType: AccessType;
  buildEvent: (
    params: TParams,
    result: ToolResponse,
    database: DatabaseSync
  ) =>
    | Omit<
    ToolUsageEventInput,
    "toolName" | "operationType" | "accessType" | "status" | "errorCode" | "latencyMs"
      >
    | Promise<
        Omit<
          ToolUsageEventInput,
          | "toolName"
          | "operationType"
          | "accessType"
          | "status"
          | "errorCode"
          | "latencyMs"
        >
      >;
}

function toJsonText(value: Record<string, unknown> | null | undefined): string | null {
  if (!value) return null;
  return JSON.stringify(value);
}

function normalizeErrorCode(text: string | null | undefined): string | null {
  if (!text) return null;
  const lower = text.toLowerCase();
  if (lower.includes("not found")) return "not_found";
  if (lower.includes("must be provided") || lower.includes("invalid")) {
    return "validation_error";
  }
  if (lower.includes("constraint")) return "constraint_violation";
  if (lower.includes("foreign key")) return "foreign_key_violation";
  return "tool_error";
}

async function resolveDatabase(provider: DatabaseProvider): Promise<DatabaseSync> {
  return typeof provider === "function" ? provider() : provider;
}

export async function recordToolUsageEvent(
  database: DatabaseSync,
  event: ToolUsageEventInput
): Promise<string | null> {
  // Successful usage-feedback is a first-party learning signal, not
  // diagnostics: it is always recorded locally so recall quality can be
  // evaluated and (later) improved. Everything else — including failed
  // feedback attempts (error_code/latency are diagnostics data) — stays
  // opt-in via MEMORY_TELEMETRY.
  if (
    !isTelemetryEnabled() &&
    !(event.operationType === "feedback" && event.status === "success")
  ) {
    return null;
  }

  try {
    const id = newId("evt");
    database
      .prepare(
        `INSERT INTO tool_usage_events (
          id,
          created_at,
          agent_id,
          client_name,
          client_version,
          mcp_version,
          guidance_version,
          tool_name,
          operation_type,
          access_type,
          status,
          error_code,
          latency_ms,
          session_id,
          step_id,
          memory_id,
          related_event_id,
          input_shape,
          output_shape,
          metadata
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        nowIso(),
        event.agentId ?? null,
        event.clientName ?? null,
        event.clientVersion ?? null,
        MCP_VERSION,
        event.guidanceVersion ?? null,
        event.toolName,
        event.operationType,
        event.accessType,
        event.status,
        event.errorCode ?? null,
        event.latencyMs ?? null,
        event.sessionId ?? null,
        event.stepId ?? null,
        event.memoryId ?? null,
        event.relatedEventId ?? null,
        toJsonText(event.inputShape),
        toJsonText(event.outputShape),
        toJsonText(event.metadata)
      );
    return id;
  } catch (error) {
    console.error("Telemetry recording failed:", error);
    return null;
  }
}

export function withTelemetry<TParams>(
  config: ToolTelemetryConfig<TParams>,
  handler: (params: TParams) => Promise<ToolResponse>
): (params: TParams) => Promise<ToolResponse> {
  return async (params: TParams) => {
    const startedAt = Date.now();

    try {
      const result = await handler(params);
      const database = await resolveDatabase(config.database);
      const event = await config.buildEvent(params, result, database);

      await recordToolUsageEvent(database, {
        toolName: config.toolName,
        operationType: config.operationType,
        accessType: config.accessType,
        status: result.isError ? "error" : "success",
        errorCode: result.isError
          ? normalizeErrorCode(result.content[0]?.text ?? null)
          : null,
        latencyMs: Date.now() - startedAt,
        ...event,
      });

      return result;
    } catch (error) {
      const database = await resolveDatabase(config.database);
      const text = handleToolError(error);
      const result: ToolResponse = {
        content: [{ type: "text" as const, text }],
        isError: true,
      };
      const event = await config.buildEvent(params, result, database);

      await recordToolUsageEvent(database, {
        toolName: config.toolName,
        operationType: config.operationType,
        accessType: config.accessType,
        status: "error",
        errorCode: normalizeErrorCode(text),
        latencyMs: Date.now() - startedAt,
        ...event,
      });

      return result;
    }
  };
}
