import { describe, expect, it } from "vitest";
import { applyEventToTimeline, finalizeTimeline, initialTimeline, PIPELINE_STAGES } from "./timeline.js";
import type { RunEvent } from "./types.js";

function event(overrides: Partial<RunEvent> & Pick<RunEvent, "stage" | "message">): RunEvent {
  return {
    seq: 0, ts: new Date().toISOString(), appRunId: "run-1", heimdallRunId: null,
    agentId: "agent-1", severity: "info", ...overrides,
  };
}

describe("timeline", () => {
  it("starts with only 'queued' active and everything else pending", () => {
    const timeline = initialTimeline("2026-01-01T00:00:00.000Z");
    expect(timeline[0]).toMatchObject({ stage: "queued", status: "active" });
    expect(timeline.slice(1).every((entry) => entry.status === "pending")).toBe(true);
  });

  it("advances one stage at a time, completing what came before", () => {
    let timeline = initialTimeline("t0");
    timeline = applyEventToTimeline(timeline, event({ stage: "recon", message: "Reconnaissance starting" }));
    expect(timeline.find((e) => e.stage === "queued")?.status).toBe("complete");
    expect(timeline.find((e) => e.stage === "recon")?.status).toBe("active");
    expect(timeline.find((e) => e.stage === "manifest")?.status).toBe("pending");
  });

  it("marks a stage skipped when the run jumps past it (e.g. no approval needed)", () => {
    let timeline = initialTimeline("t0");
    for (const stage of ["recon", "manifest", "permit"] as const) {
      timeline = applyEventToTimeline(timeline, event({ stage, message: `${stage} event` }));
    }
    // no approval event for this run — it jumps straight to container
    timeline = applyEventToTimeline(timeline, event({ stage: "container", message: "Starting Runtime container" }));
    expect(timeline.find((e) => e.stage === "approval")?.status).toBe("skipped");
    expect(timeline.find((e) => e.stage === "container")?.status).toBe("active");
  });

  it("marks a stage 'waiting' for an awaiting-approval message", () => {
    let timeline = initialTimeline("t0");
    timeline = applyEventToTimeline(timeline, event({ stage: "permit", message: "Permit issued" }));
    timeline = applyEventToTimeline(
      timeline,
      event({ stage: "approval", severity: "warn", message: "Awaiting human approval" }),
    );
    const approval = timeline.find((e) => e.stage === "approval");
    expect(approval?.status).toBe("waiting");
  });

  it("marks a stage failed on an error-severity event without completing it", () => {
    let timeline = initialTimeline("t0");
    timeline = applyEventToTimeline(
      timeline,
      event({ stage: "manifest", severity: "error", message: "Recon did not produce a valid manifest" }),
    );
    const manifest = timeline.find((e) => e.stage === "manifest");
    expect(manifest?.status).toBe("failed");
    expect(manifest?.endedAt).not.toBeNull();
  });

  it("ignores events for a terminal stage — finalizeTimeline owns those", () => {
    const timeline = initialTimeline("t0");
    const next = applyEventToTimeline(timeline, event({ stage: "completed", message: "Run completed" }));
    expect(next).toEqual(timeline);
  });

  it("finalizeTimeline completes every unfinished stage and appends the terminal entry", () => {
    let timeline = initialTimeline("t0");
    timeline = applyEventToTimeline(timeline, event({ stage: "recon", message: "Reconnaissance starting" }));
    timeline = finalizeTimeline(timeline, "completed", "t-end");

    const withoutTerminal = timeline.filter((e) => !(e.stage === "completed"));
    expect(withoutTerminal.every((e) => e.status === "complete" || e.status === "skipped")).toBe(true);
    expect(timeline.at(-1)).toMatchObject({ stage: "completed", status: "complete", startedAt: "t-end", endedAt: "t-end" });
  });

  it("finalizeTimeline marks in-flight stages failed, and everything untouched skipped, on failure", () => {
    let timeline = initialTimeline("t0");
    timeline = applyEventToTimeline(timeline, event({ stage: "recon", message: "Reconnaissance starting" }));
    timeline = finalizeTimeline(timeline, "failed", "t-end");
    expect(timeline.find((e) => e.stage === "recon")?.status).toBe("failed");
    expect(timeline.find((e) => e.stage === "manifest")?.status).toBe("skipped");
    expect(timeline.at(-1)).toMatchObject({ stage: "failed", status: "failed" });
  });

  it("covers every pipeline stage named in the product brief", () => {
    expect(PIPELINE_STAGES).toEqual([
      "queued", "recon", "manifest", "permit", "approval", "container", "codex", "parsing", "reconciliation",
    ]);
  });
});
