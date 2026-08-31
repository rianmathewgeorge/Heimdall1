import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { StuckRunDiagnostic } from "./StuckRunDiagnostic";
import { initialTimeline } from "../lib/timeline";
import type { AgentRun } from "../types";

const STALL_MS = 20_000;
const RUN_MAX_AGE_MS = 3_600_000;

function makeRun(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: "run-1",
    agentId: "agent-1",
    status: "running",
    prompt: "build something",
    output: null,
    error: null,
    errorDetail: null,
    usage: null,
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    stage: "codex",
    timeline: initialTimeline("2026-01-01T00:00:00.000Z"),
    heimdallRunId: "agent-1-abc123",
    containerName: null,
    exitCode: null,
    lastEventAt: "2026-01-01T00:00:00.000Z",
    logs: null,
    fileChanges: null,
    ...overrides,
  };
}

const noop = () => undefined;

describe("StuckRunDiagnostic", () => {
  it("renders nothing for a healthy, recently-active run", () => {
    const run = makeRun({ lastEventAt: "2026-01-01T00:00:00.000Z" });
    const nowMs = new Date("2026-01-01T00:00:01.000Z").getTime();
    const { container } = render(
      <StuckRunDiagnostic
        run={run} nowMs={nowMs} stallThresholdMs={STALL_MS} runMaxAgeMs={RUN_MAX_AGE_MS}
        agentStatus="busy" onCancel={noop} onRetry={noop} onOpenLogs={noop} onRestartAgent={noop}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("shows a plain-English 'no progress detected' diagnosis once the run stalls, with stage and elapsed time", () => {
    const timeline = initialTimeline("2026-01-01T00:00:00.000Z").map((entry) =>
      entry.stage === "codex" ? { ...entry, status: "active" as const, startedAt: "2026-01-01T00:00:00.000Z" } : entry,
    );
    const run = makeRun({ stage: "codex", timeline, lastEventAt: "2026-01-01T00:00:10.000Z" });
    const nowMs = new Date("2026-01-01T00:00:45.000Z").getTime(); // 35s of silence, past the 20s threshold

    render(
      <StuckRunDiagnostic
        run={run} nowMs={nowMs} stallThresholdMs={STALL_MS} runMaxAgeMs={RUN_MAX_AGE_MS}
        agentStatus="busy" onCancel={noop} onRetry={noop} onOpenLogs={noop} onRestartAgent={noop}
      />,
    );

    // Collapsed: icon, headline, short diagnosis, and elapsed time — no detail expansion needed yet.
    expect(screen.getByText("No progress detected")).toBeInTheDocument();
    expect(screen.getByText(/No response from the model/)).toBeInTheDocument();
    expect(screen.getByText("35s")).toBeInTheDocument(); // time since last event

    // Expanded: the full two-column metadata grid.
    fireEvent.click(screen.getByRole("button", { name: /Details/ }));
    expect(screen.getByText("Codex running")).toBeInTheDocument(); // current stage, in plain English
    expect(screen.getByText("45s")).toBeInTheDocument(); // time spent in this stage
    expect(screen.getByText("1h 00m")).toBeInTheDocument(); // the configured overall timeout
    expect(screen.getByText("Not yet observed")).toBeInTheDocument(); // runtime process state
    expect(screen.getByText("No")).toBeInTheDocument(); // not awaiting approval
  });

  it("renders the full causal error chain for a failed run, not just the outer message", () => {
    const run = makeRun({
      status: "failed",
      stage: "failed",
      error: "HEIMDALL: recon did not produce a valid manifest — execution refused (fail closed).",
      errorDetail: {
        message: "HEIMDALL: recon did not produce a valid manifest — execution refused (fail closed).",
        name: "Error",
        cause: {
          message: "Codex runtime exited with code 1: Failed to shutdown rollout recorder",
          name: "RuntimeExitError",
          exitCode: 1,
          containerName: "heimdall-recon-abc123",
        },
      },
      containerName: "heimdall-recon-abc123",
      exitCode: 1,
    });
    const nowMs = new Date("2026-01-01T00:05:00.000Z").getTime();

    render(
      <StuckRunDiagnostic
        run={run} nowMs={nowMs} stallThresholdMs={STALL_MS} runMaxAgeMs={RUN_MAX_AGE_MS}
        agentStatus="error" onCancel={noop} onRetry={noop} onOpenLogs={noop} onRestartAgent={noop}
      />,
    );

    // Collapsed: the short root cause (the deepest, most specific failure) is visible immediately.
    expect(screen.getByText("Run failed")).toBeInTheDocument();
    expect(screen.getByText(/Failed to shutdown rollout recorder/)).toBeInTheDocument();
    // a failed run offers a quick Retry, but there is nothing active left to cancel
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();

    // Expanded: the full causal chain — the outer, generic message is not the whole story.
    fireEvent.click(screen.getByRole("button", { name: /Details/ }));
    expect(screen.getByText(/recon did not produce a valid manifest/)).toBeInTheDocument();
    expect(screen.getByText("heimdall-recon-abc123")).toBeInTheDocument();
    expect(screen.getByText("exit code 1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Retry run/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Restart agent/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Cancel run/ })).not.toBeInTheDocument();
  });

  it("offers a quick Cancel action while active, and copies a diagnostic bundle from the expanded view", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    const timeline = initialTimeline("2026-01-01T00:00:00.000Z").map((entry) =>
      entry.stage === "container" ? { ...entry, status: "active" as const, startedAt: "2026-01-01T00:00:00.000Z" } : entry,
    );
    const run = makeRun({ stage: "container", timeline });
    const nowMs = new Date("2026-01-01T00:00:45.000Z").getTime();
    const onCancel = vi.fn();

    render(
      <StuckRunDiagnostic
        run={run} nowMs={nowMs} stallThresholdMs={STALL_MS} runMaxAgeMs={RUN_MAX_AGE_MS}
        agentStatus="busy" onCancel={onCancel} onRetry={noop} onOpenLogs={noop} onRestartAgent={noop}
      />,
    );

    expect(screen.getByText("Waiting for a runtime process")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: /Details/ }));
    fireEvent.click(screen.getByRole("button", { name: /Copy diagnostic bundle/ }));
    expect(writeText).toHaveBeenCalledOnce();
  });
});
