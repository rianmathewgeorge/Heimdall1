/**
 * HEIMDALL — trace assembly.
 *
 * A Run is one TRACE: a connected sequence of reasoning and actions, not a pile
 * of unrelated log lines. The run already emits structured events for every
 * stage transition, permit decision, container lifecycle point and
 * reconciliation result; this turns that stream into spans with stable ids,
 * durations, statuses and categories, so a failing step can be located rather
 * than searched for.
 *
 * Spans are DERIVED from the event stream rather than emitted separately. That
 * matters: there is no second source of truth to drift, and a trace is exactly
 * what the run actually reported. Payloads arrive already redacted (every event
 * passes through `redact` before storage), so nothing here has to be trusted to
 * scrub secrets a second time.
 */
import { createHash } from "node:crypto";
import type { RunEvent, RunStage } from "../types.js";

/** What kind of work a span represents. Mirrors the brief's span categories. */
export type SpanCategory =
  | "orchestration"
  | "model_call"
  | "policy_decision"
  | "human_approval"
  | "sandbox_execution"
  | "tool_call"
  | "memory_access"
  | "cloud_operation";

export type SpanStatus = "ok" | "error" | "in_progress";

export interface TraceSpan {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  category: SpanCategory;
  stage: RunStage;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  status: SpanStatus;
  /** the events that make up this span, already redacted */
  events: Array<{ at: string; severity: string; message: string; data?: Record<string, unknown> }>;
  error: string | null;
}

export interface RunTrace {
  traceId: string;
  appRunId: string;
  agentId: string;
  heimdallRunId: string | null;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  status: SpanStatus;
  spans: TraceSpan[];
  /** budget signals, when the runtime reported them */
  usage: { inputTokens?: number; cachedInputTokens?: number; outputTokens?: number } | null;
}

/** Which category a stage belongs to. */
const STAGE_CATEGORY: Record<RunStage, SpanCategory> = {
  queued: "orchestration",
  recon: "model_call",
  manifest: "policy_decision",
  permit: "policy_decision",
  approval: "human_approval",
  container: "cloud_operation",
  codex: "sandbox_execution",
  parsing: "orchestration",
  reconciliation: "policy_decision",
  completed: "orchestration",
  failed: "orchestration",
  cancelled: "orchestration",
};

/** Stable, deterministic ids — the same run always yields the same trace id. */
function stableId(seed: string, length = 16): string {
  return createHash("sha256").update(seed).digest("hex").slice(0, length);
}

export function traceIdFor(appRunId: string): string { return stableId("trace:" + appRunId, 32); }

/**
 * Fold a run's events into a trace. Consecutive events for one stage collapse
 * into a single span, so the shape follows the run's actual phases instead of
 * producing one span per log line.
 */
export function buildTrace(appRunId: string, events: readonly RunEvent[]): RunTrace | null {
  if (events.length === 0) return null;
  const traceId = traceIdFor(appRunId);
  const first = events[0] as RunEvent;

  const rootSpanId = stableId(traceId + ":root");
  const spans: TraceSpan[] = [];
  let current: TraceSpan | null = null;
  let usage: RunTrace["usage"] = null;

  for (const event of events) {
    const data = event.data as Record<string, unknown> | undefined;
    if (data?.["usage"] !== undefined && typeof data["usage"] === "object") {
      usage = data["usage"] as RunTrace["usage"];
    }

    if (current === null || current.stage !== event.stage) {
      if (current !== null) closeSpan(current, event.ts);
      current = {
        traceId,
        spanId: stableId(`${traceId}:${event.stage}:${String(spans.length)}`),
        parentSpanId: rootSpanId,
        name: event.stage,
        category: STAGE_CATEGORY[event.stage] ?? "orchestration",
        stage: event.stage,
        startedAt: event.ts,
        endedAt: null,
        durationMs: null,
        status: "in_progress",
        events: [],
        error: null,
      };
      spans.push(current);
    }
    current.events.push({
      at: event.ts,
      severity: event.severity,
      message: event.message,
      ...(event.data !== undefined ? { data: event.data } : {}),
    });
    if (event.severity === "error") {
      current.status = "error";
      current.error = event.message;
    }
  }

  const last = events[events.length - 1] as RunEvent;
  const terminal = last.stage === "completed" || last.stage === "failed" || last.stage === "cancelled";
  if (current !== null) {
    if (terminal) closeSpan(current, last.ts);
    else current.status = current.status === "error" ? "error" : "in_progress";
  }

  const failed = spans.some((s) => s.status === "error") || last.stage === "failed";
  const startedAt = first.ts;
  const endedAt = terminal ? last.ts : null;

  return {
    traceId,
    appRunId,
    agentId: first.agentId,
    heimdallRunId: first.heimdallRunId ?? null,
    startedAt,
    endedAt,
    durationMs: endedAt === null ? null : Date.parse(endedAt) - Date.parse(startedAt),
    status: failed ? "error" : terminal ? "ok" : "in_progress",
    spans,
    usage,
  };
}

function closeSpan(span: TraceSpan, at: string): void {
  span.endedAt = at;
  span.durationMs = Date.parse(at) - Date.parse(span.startedAt);
  if (span.status === "in_progress") span.status = "ok";
}

/** The slowest span — where a run actually spent its time. */
export function criticalPath(trace: RunTrace): TraceSpan | null {
  let worst: TraceSpan | null = null;
  for (const span of trace.spans) {
    if (span.durationMs === null) continue;
    if (worst === null || span.durationMs > (worst.durationMs ?? 0)) worst = span;
  }
  return worst;
}

/** The first span that failed — the step to look at. */
export function firstFailure(trace: RunTrace): TraceSpan | null {
  return trace.spans.find((s) => s.status === "error") ?? null;
}
