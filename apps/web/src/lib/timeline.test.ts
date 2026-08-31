import { describe, expect, it } from "vitest";
import { initialTimeline, reduceTimeline } from "./timeline";
import type { RunEvent } from "../types";

function event(overrides: Partial<RunEvent> & Pick<RunEvent, "stage" | "message">): RunEvent {
  return {
    seq: 0, ts: new Date().toISOString(), appRunId: "run-1", heimdallRunId: null,
    agentId: "agent-1", severity: "info", ...overrides,
  };
}

describe("client timeline reducer (mirrors the server one)", () => {
  it("advances the active stage and completes what came before", () => {
    let timeline = initialTimeline("t0");
    timeline = reduceTimeline(timeline, event({ stage: "recon", message: "Reconnaissance starting" }));
    expect(timeline.find((e) => e.stage === "queued")?.status).toBe("complete");
    expect(timeline.find((e) => e.stage === "recon")?.status).toBe("active");
  });

  it("finalizes every open stage once a terminal event arrives", () => {
    let timeline = initialTimeline("t0");
    timeline = reduceTimeline(timeline, event({ stage: "codex", message: "Codex process running" }));
    timeline = reduceTimeline(timeline, event({ stage: "completed", message: "Run completed" }));
    expect(timeline.find((e) => e.stage === "codex")?.status).toBe("complete");
    expect(timeline.at(-1)).toMatchObject({ stage: "completed", status: "complete" });
  });
});
