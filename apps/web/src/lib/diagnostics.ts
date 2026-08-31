/**
 * Turns a run's current state into a plain-English diagnosis, the way a human
 * debugging a stuck run would ask it: what stage is it in, how long has it
 * been there, when did we last hear anything, and — critically — never infer
 * "it's fine" purely from an HTTP 200 on a status poll. Distinguishes the five
 * wait states the brief calls out explicitly, rather than one generic spinner.
 */
import type { AgentRun, RunStage, RunTimelineEntry } from "../types";
import { STAGE_LABELS } from "./timeline";

export type RunHealth =
  | "ok"
  | "awaiting-approval"
  | "waiting-process"
  | "process-exited"
  | "no-response"
  | "no-events"
  | "stalled"
  | "terminal";

export interface RunDiagnosis {
  health: RunHealth;
  label: string;
  stage: RunStage;
  stageLabel: string;
  elapsedInStageMs: number;
  elapsedSinceLastEventMs: number;
  /** True once the run has gone quiet for longer than the configured stall threshold. */
  isStale: boolean;
  containerName: string | null;
  exitCode: number | null;
  awaitingApproval: boolean;
}

type DiagnosableRun = Pick<
  AgentRun,
  "status" | "stage" | "timeline" | "lastEventAt" | "createdAt" | "containerName" | "exitCode"
>;

function activeEntryFor(timeline: RunTimelineEntry[], stage: RunStage): RunTimelineEntry | undefined {
  return timeline.find((entry) => entry.stage === stage);
}

export function diagnoseRun(run: DiagnosableRun, nowMs: number, stallThresholdMs: number): RunDiagnosis {
  const isTerminalRun = run.status === "completed" || run.status === "failed" || run.status === "cancelled";
  const entry = activeEntryFor(run.timeline, run.stage);
  const stageStartedAt = entry?.startedAt ? new Date(entry.startedAt).getTime() : new Date(run.createdAt).getTime();
  const lastEventAt = run.lastEventAt ? new Date(run.lastEventAt).getTime() : new Date(run.createdAt).getTime();
  // A terminal stage's own endedAt, once set, is the clock's true stop — not
  // "now": nowMs ticks every second app-wide (see App.tsx), so anchoring a
  // finished stage's elapsed time to it would make a failed run's displayed
  // duration keep growing forever instead of freezing at the moment it ended.
  const stageEndedAt = entry?.endedAt ? new Date(entry.endedAt).getTime() : null;
  const elapsedInStageMs = Math.max(0, (stageEndedAt ?? nowMs) - stageStartedAt);
  // Unlike elapsedInStageMs, this one is allowed to keep climbing after the
  // run ends — "how long ago did we last hear from it" stays meaningful past
  // termination — so callers must label it distinctly from elapsedInStageMs
  // rather than presenting the two as the same kind of number.
  const elapsedSinceLastEventMs = Math.max(0, nowMs - lastEventAt);
  const isStale = !isTerminalRun && elapsedSinceLastEventMs > stallThresholdMs;
  const stageLabel = STAGE_LABELS[run.stage] ?? run.stage;

  const base = {
    stage: run.stage,
    stageLabel,
    elapsedInStageMs,
    elapsedSinceLastEventMs,
    containerName: run.containerName,
    exitCode: run.exitCode,
  };

  if (isTerminalRun) {
    return {
      ...base,
      health: "terminal",
      label: stageLabel,
      isStale: false,
      awaitingApproval: false,
    };
  }

  const sawAnyProgress = run.timeline.some((item) => item.stage !== "queued" && item.startedAt !== null);
  if (!sawAnyProgress && isStale) {
    return { ...base, health: "no-events", label: "No events received", isStale, awaitingApproval: false };
  }

  if (run.stage === "approval" && entry?.status === "waiting") {
    return { ...base, health: "awaiting-approval", label: "Waiting for approval", isStale, awaitingApproval: true };
  }

  if (isStale) {
    if (run.stage === "container") {
      return { ...base, health: "waiting-process", label: "Waiting for a runtime process", isStale, awaitingApproval: false };
    }
    if (run.stage === "codex") {
      if (run.exitCode !== null) {
        return { ...base, health: "process-exited", label: "Runtime process exited", isStale, awaitingApproval: false };
      }
      return { ...base, health: "no-response", label: "No response from the model / network request", isStale, awaitingApproval: false };
    }
    return { ...base, health: "stalled", label: `No progress detected in ${stageLabel}`, isStale, awaitingApproval: false };
  }

  return { ...base, health: "ok", label: stageLabel, isStale, awaitingApproval: false };
}

export function isDiagnosisAlarming(diagnosis: RunDiagnosis): boolean {
  return diagnosis.health !== "ok" && diagnosis.health !== "terminal";
}
