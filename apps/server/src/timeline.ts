/**
 * Turns the flat RunEvent stream into the pipeline shown in the UI:
 * Queued -> Recon -> Manifest validation -> Policy/permit evaluation ->
 * Awaiting approval -> Container starting -> Codex running -> Parsing output
 * -> Reconciliation -> Completed/Failed/Cancelled.
 *
 * Not every run visits every stage (a T0/T1 run skips "approval"; HEIMDALL=off
 * skips everything before "codex"). A stage is only ever marked "skipped" once
 * the run has visibly moved past it — this module never guesses ahead of time
 * which stages a given run will use.
 */
import type { RunEvent, RunStage, RunTimelineEntry, StageStatus } from "./types.js";

export const PIPELINE_STAGES: readonly RunStage[] = [
  "queued",
  "recon",
  "manifest",
  "permit",
  "approval",
  "container",
  "codex",
  "parsing",
  "reconciliation",
];

export const TERMINAL_STAGES = new Set<RunStage>(["completed", "failed", "cancelled"]);

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
  if (stageIndex === -1) return timeline; // a terminal-stage event; see finalizeTimeline
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
