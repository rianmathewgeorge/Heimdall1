/**
 * Client-side mirror of the server's timeline reducer (apps/server/src/timeline.ts).
 * Lets the UI update instantly from each streamed RunEvent instead of waiting on
 * a round trip — kept in lockstep with the server logic intentionally, since both
 * sides must agree on what "the pipeline advanced" means.
 */
import type { RunEvent, RunStage, RunTimelineEntry, StageStatus } from "../types";

export const PIPELINE_STAGES: readonly RunStage[] = [
  "queued", "recon", "manifest", "permit", "approval", "container", "codex", "parsing", "reconciliation",
];

export const STAGE_LABELS: Record<RunStage, string> = {
  queued: "Queued",
  recon: "Recon",
  manifest: "Manifest validation",
  permit: "Policy / permit evaluation",
  approval: "Awaiting approval",
  container: "Container starting",
  codex: "Codex running",
  parsing: "Parsing output",
  reconciliation: "Reconciliation",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

export function initialTimeline(startedAt: string): RunTimelineEntry[] {
  return PIPELINE_STAGES.map((stage, index) => ({
    stage,
    status: (index === 0 ? "active" : "pending") as StageStatus,
    startedAt: index === 0 ? startedAt : null,
    endedAt: null,
    detail: index === 0 ? "Run queued" : null,
  }));
}

export function applyEventToTimeline(timeline: RunTimelineEntry[], event: RunEvent): RunTimelineEntry[] {
  const stageIndex = PIPELINE_STAGES.indexOf(event.stage);
  if (stageIndex === -1) return timeline;
  const next = timeline.map((entry) => ({ ...entry }));

  for (let i = 0; i < stageIndex; i++) {
    const entry = next[i];
    if (entry === undefined) continue;
    if (entry.status === "active" || entry.status === "waiting") {
      entry.status = "complete";
      entry.endedAt = entry.endedAt ?? event.ts;
    } else if (entry.status === "pending") {
      entry.status = "skipped";
    }
  }

  const current = next[stageIndex];
  if (current !== undefined) {
    current.detail = event.message;
    if (event.data) current.data = event.data;
    if (current.startedAt === null) current.startedAt = event.ts;
    if (event.severity === "error") {
      current.status = "failed";
      current.endedAt = event.ts;
    } else if (/^awaiting\b/i.test(event.message)) {
      current.status = "waiting";
    } else {
      current.status = "active";
    }
  }
  return next;
}

export function finalizeTimeline(
  timeline: RunTimelineEntry[],
  terminal: "completed" | "failed" | "cancelled",
  ts: string,
): RunTimelineEntry[] {
  const next = timeline.map((entry) => ({ ...entry }));
  for (const entry of next) {
    if (entry.status === "active" || entry.status === "waiting") {
      entry.status = terminal === "completed" ? "complete" : terminal === "cancelled" ? "skipped" : "failed";
      entry.endedAt = entry.endedAt ?? ts;
    } else if (entry.status === "pending") {
      entry.status = "skipped";
    }
  }
  const terminalStatus: StageStatus = terminal === "completed" ? "complete" : terminal === "failed" ? "failed" : "skipped";
  next.push({ stage: terminal, status: terminalStatus, startedAt: ts, endedAt: ts, detail: null });
  return next;
}

export function reduceTimeline(timeline: RunTimelineEntry[], event: RunEvent): RunTimelineEntry[] {
  if (event.stage === "completed" || event.stage === "failed" || event.stage === "cancelled") {
    return finalizeTimeline(timeline, event.stage, event.ts);
  }
  return applyEventToTimeline(timeline, event);
}
