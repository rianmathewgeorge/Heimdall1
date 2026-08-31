import { describe, expect, it } from "vitest";
import { diagnoseRun, isDiagnosisAlarming } from "./diagnostics";
import { finalizeTimeline, initialTimeline } from "./timeline";
import type { RunTimelineEntry } from "../types";

const STALL_MS = 20_000;

function baseRun(overrides: Partial<Parameters<typeof diagnoseRun>[0]> = {}) {
  return {
    status: "running" as const,
    stage: "queued" as const,
    timeline: initialTimeline("2026-01-01T00:00:00.000Z"),
    lastEventAt: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    containerName: null,
    exitCode: null,
    ...overrides,
  };
}

function withStage(stage: RunTimelineEntry["stage"], status: RunTimelineEntry["status"], timeline: RunTimelineEntry[]) {
  return timeline.map((entry) => (entry.stage === stage ? { ...entry, status, startedAt: entry.startedAt ?? "2026-01-01T00:00:00.000Z" } : entry));
}

describe("diagnoseRun", () => {
  it("reports 'ok' when the run is fresh and progressing", () => {
    const nowMs = new Date("2026-01-01T00:00:01.000Z").getTime();
    const diagnosis = diagnoseRun(baseRun(), nowMs, STALL_MS);
    expect(diagnosis.health).toBe("ok");
    expect(isDiagnosisAlarming(diagnosis)).toBe(false);
  });

  it("reports 'no-events' when nothing has happened past the stall threshold", () => {
    const nowMs = new Date("2026-01-01T00:00:30.000Z").getTime();
    const diagnosis = diagnoseRun(baseRun(), nowMs, STALL_MS);
    expect(diagnosis.health).toBe("no-events");
    expect(diagnosis.label).toBe("No events received");
  });

  it("reports 'awaiting-approval' distinctly from other stall states", () => {
    const timeline = withStage("recon", "complete", initialTimeline("t0"));
    const withApproval = withStage("approval", "waiting", timeline);
    const nowMs = new Date("2026-01-01T00:00:30.000Z").getTime();
    const diagnosis = diagnoseRun(
      baseRun({ stage: "approval", timeline: withApproval, lastEventAt: "2026-01-01T00:00:00.000Z" }),
      nowMs,
      STALL_MS,
    );
    expect(diagnosis.health).toBe("awaiting-approval");
    expect(diagnosis.awaitingApproval).toBe(true);
  });

  it("reports 'waiting-process' when stuck at container start", () => {
    const timeline = withStage("container", "active", initialTimeline("t0"));
    const nowMs = new Date("2026-01-01T00:00:30.000Z").getTime();
    const diagnosis = diagnoseRun(baseRun({ stage: "container", timeline }), nowMs, STALL_MS);
    expect(diagnosis.health).toBe("waiting-process");
  });

  it("reports 'no-response' when the codex/model call has been silent too long", () => {
    const timeline = withStage("codex", "active", initialTimeline("t0"));
    const nowMs = new Date("2026-01-01T00:00:30.000Z").getTime();
    const diagnosis = diagnoseRun(baseRun({ stage: "codex", timeline, exitCode: null }), nowMs, STALL_MS);
    expect(diagnosis.health).toBe("no-response");
  });

  it("reports 'process-exited' when the process finished but the pipeline stalled after it", () => {
    const timeline = withStage("codex", "active", initialTimeline("t0"));
    const nowMs = new Date("2026-01-01T00:00:30.000Z").getTime();
    const diagnosis = diagnoseRun(baseRun({ stage: "codex", timeline, exitCode: 1 }), nowMs, STALL_MS);
    expect(diagnosis.health).toBe("process-exited");
  });

  it("never shows a stall diagnosis once the run is terminal", () => {
    const nowMs = new Date("2026-01-01T02:00:00.000Z").getTime();
    const diagnosis = diagnoseRun(baseRun({ status: "completed", stage: "completed" }), nowMs, STALL_MS);
    expect(diagnosis.health).toBe("terminal");
    expect(diagnosis.isStale).toBe(false);
    expect(isDiagnosisAlarming(diagnosis)).toBe(false);
  });

  it("freezes elapsedInStageMs at the failed stage's own endedAt instead of ticking with nowMs", () => {
    // Mirrors finalizeTimeline's real shape: a "codex" stage that ran for a
    // while, then a zero-duration "failed" marker appended when the run died.
    const codexRunning = withStage("codex", "active", initialTimeline("2026-01-01T00:00:00.000Z"));
    const timelineAtFailure = finalizeTimeline(codexRunning, "failed", "2026-01-01T00:05:00.000Z");
    const run = baseRun({
      status: "failed", stage: "failed", timeline: timelineAtFailure,
      lastEventAt: "2026-01-01T00:05:00.000Z",
    });

    const atFailure = diagnoseRun(run, new Date("2026-01-01T00:05:00.000Z").getTime(), STALL_MS);
    // fiveMinutesLater: same run object, only the clock moved — as it does on
    // every 1s tick in App.tsx while the diagnostic panel stays open.
    const fiveMinutesLater = diagnoseRun(run, new Date("2026-01-01T00:10:00.000Z").getTime(), STALL_MS);

    expect(atFailure.elapsedInStageMs).toBe(0);
    expect(fiveMinutesLater.elapsedInStageMs).toBe(0);

    // elapsedSinceLastEventMs is allowed to keep climbing — it answers a
    // different question ("how long ago did we last hear from it") — but
    // callers must never present it as if it were the stage's own duration.
    expect(fiveMinutesLater.elapsedSinceLastEventMs).toBe(5 * 60 * 1000);
  });
});
