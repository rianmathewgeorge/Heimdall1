/**
 * TRACE AND OBSERVABILITY.
 *
 * A run has to read as a connected sequence with a locatable failing step —
 * not a pile of log lines. Spans are derived from the run's own event stream,
 * so these tests feed realistic streams and check the shape that a trace UI
 * (and an export) actually depends on.
 */
import { describe, expect, test } from "vitest";
import { buildTrace, criticalPath, firstFailure, traceIdFor } from "./trace.js";
import type { RunEvent, RunStage } from "../types.js";

let seq = 0;
const ev = (stage: RunStage, message: string, offsetMs: number, severity: "info" | "warn" | "error" = "info",
            data?: Record<string, unknown>): RunEvent => ({
  seq: seq++,
  ts: new Date(Date.parse("2026-01-01T00:00:00.000Z") + offsetMs).toISOString(),
  appRunId: "run-1", heimdallRunId: "h-1", agentId: "agent-1",
  stage, severity, message, ...(data !== undefined ? { data } : {}),
});

const happyRun = (): RunEvent[] => { seq = 0; return [
  ev("queued", "Run queued", 0),
  ev("recon", "Planning", 10),
  ev("recon", "Manifest received", 900),
  ev("permit", "Permit issued tier=T1", 950),
  ev("container", "Container spawned", 1000),
  ev("codex", "Codex running", 1100),
  ev("codex", "Codex exited 0", 6000, "info", { usage: { inputTokens: 120, outputTokens: 40 } }),
  ev("reconciliation", "No divergences", 6100),
  ev("completed", "Run completed", 6200),
]; };

describe("trace assembly", () => {
  test("a run becomes one trace of connected spans with stable ids", () => {
    const trace = buildTrace("run-1", happyRun())!;
    expect(trace.traceId).toBe(traceIdFor("run-1"));
    expect(trace.status).toBe("ok");
    expect(trace.durationMs).toBe(6200);
    expect(trace.spans.map((s) => s.name)).toEqual([
      "queued", "recon", "permit", "container", "codex", "reconciliation", "completed",
    ]);
    // every span is parented to the run, and ids are stable across rebuilds
    expect(new Set(trace.spans.map((s) => s.parentSpanId)).size).toBe(1);
    expect(buildTrace("run-1", happyRun())!.spans[1]?.spanId).toBe(trace.spans[1]?.spanId);
  });

  test("spans carry the category the brief asks for", () => {
    const byName = Object.fromEntries(buildTrace("run-1", happyRun())!.spans.map((s) => [s.name, s.category]));
    expect(byName["recon"]).toBe("model_call");
    expect(byName["permit"]).toBe("policy_decision");
    expect(byName["container"]).toBe("cloud_operation");
    expect(byName["codex"]).toBe("sandbox_execution");
  });

  test("durations locate where the time actually went", () => {
    const trace = buildTrace("run-1", happyRun())!;
    const codex = trace.spans.find((s) => s.name === "codex")!;
    expect(codex.durationMs).toBe(5000);
    expect(criticalPath(trace)?.name).toBe("codex");
  });

  test("token usage is surfaced as a budget signal when the runtime reports it", () => {
    expect(buildTrace("run-1", happyRun())!.usage).toEqual({ inputTokens: 120, outputTokens: 40 });
  });

  /** The point of a trace view: find the failing step without reading everything. */
  test("a failure is attributed to the exact span that failed", () => {
    seq = 0;
    const events = [
      ev("queued", "Run queued", 0),
      ev("recon", "Planning", 10),
      ev("permit", "Permit issued", 500),
      ev("container", "Container spawned", 600),
      ev("codex", "Codex running", 700),
      ev("codex", "action blocked: EXEC curl (P-03)", 2000, "error"),
      ev("failed", "Run failed", 2100, "error"),
    ];
    const trace = buildTrace("run-1", events)!;
    expect(trace.status).toBe("error");
    const failing = firstFailure(trace)!;
    expect(failing.name).toBe("codex");
    expect(failing.error).toContain("P-03");
    // the spans BEFORE it are still ok, so the failure is isolated not smeared
    expect(trace.spans.filter((s) => s.status === "ok").map((s) => s.name))
      .toEqual(["queued", "recon", "permit", "container"]);
  });

  test("a run still in flight reports in_progress rather than a false completion", () => {
    seq = 0;
    const trace = buildTrace("run-1", [ev("queued", "Run queued", 0), ev("codex", "Codex running", 100)])!;
    expect(trace.status).toBe("in_progress");
    expect(trace.endedAt).toBeNull();
    expect(trace.durationMs).toBeNull();
    expect(trace.spans.at(-1)?.status).toBe("in_progress");
  });

  test("an approval pause is its own span, so waiting time is visible", () => {
    seq = 0;
    const trace = buildTrace("run-1", [
      ev("permit", "Permit issued tier=T3", 0),
      ev("approval", "Awaiting human approval", 10),
      ev("approval", "Approved by operator", 45_000),
      ev("container", "Container spawned", 45_100),
      ev("completed", "Run completed", 50_000),
    ])!;
    const approval = trace.spans.find((s) => s.name === "approval")!;
    expect(approval.category).toBe("human_approval");
    expect(approval.durationMs).toBe(45_090);
  });

  test("an empty stream has no trace, rather than an empty misleading one", () => {
    expect(buildTrace("run-1", [])).toBeNull();
  });
});
