import { diagnoseRun } from "../../lib/diagnostics";
import { formatClockTime, formatDuration } from "../../lib/format";
import type { Agent, AgentRun, SystemInfo } from "../../types";

export interface OverviewTabProps {
  agent: Agent;
  run: AgentRun | null;
  system: SystemInfo | null;
  nowMs: number;
}

export function OverviewTab({ agent, run, system, nowMs }: OverviewTabProps) {
  const stallThresholdMs = system?.runStallThresholdMs ?? 20_000;
  const diagnosis = run ? diagnoseRun(run, nowMs, stallThresholdMs) : null;

  return (
    <div className="tab-panel overview-tab">
      <section className="inspector-block">
        <span className="inspector-block-title">Agent</span>
        <dl className="fact-grid">
          <div><dt>Status</dt><dd>{agent.status}</dd></div>
          <div><dt>Workspace</dt><dd className="mono truncate">{agent.workspacePath}</dd></div>
          <div><dt>Codex thread</dt><dd className="mono truncate">{agent.codexThreadId ?? "—"}</dd></div>
          <div><dt>Updated</dt><dd className="mono">{formatClockTime(agent.updatedAt)}</dd></div>
        </dl>
      </section>

      {run ? (
        <section className="inspector-block">
          <span className="inspector-block-title">Selected run</span>
          <dl className="fact-grid">
            <div><dt>Run ID</dt><dd className="mono truncate">{run.id}</dd></div>
            <div><dt>Heimdall run</dt><dd className="mono truncate">{run.heimdallRunId ?? "—"}</dd></div>
            <div><dt>Status</dt><dd>{run.status}</dd></div>
            <div><dt>Stage</dt><dd>{diagnosis?.stageLabel ?? run.stage}</dd></div>
            <div><dt>Created</dt><dd className="mono">{formatClockTime(run.createdAt)}</dd></div>
            <div><dt>Started</dt><dd className="mono">{run.startedAt ? formatClockTime(run.startedAt) : "—"}</dd></div>
            <div><dt>Completed</dt><dd className="mono">{run.completedAt ? formatClockTime(run.completedAt) : "—"}</dd></div>
            <div>
              <dt>Duration</dt>
              <dd className="mono">
                {run.startedAt
                  ? formatDuration((run.completedAt ? new Date(run.completedAt).getTime() : nowMs) - new Date(run.startedAt).getTime())
                  : "—"}
              </dd>
            </div>
            <div><dt>Container</dt><dd className="mono truncate">{run.containerName ?? "—"}</dd></div>
            <div><dt>Exit code</dt><dd className="mono">{run.exitCode ?? "—"}</dd></div>
          </dl>
          {run.usage && (
            <dl className="fact-grid">
              <div><dt>Input tokens</dt><dd className="mono">{run.usage.inputTokens ?? "—"}</dd></div>
              <div><dt>Cached tokens</dt><dd className="mono">{run.usage.cachedInputTokens ?? "—"}</dd></div>
              <div><dt>Output tokens</dt><dd className="mono">{run.usage.outputTokens ?? "—"}</dd></div>
            </dl>
          )}
          <div className="prompt-preview">
            <span className="inspector-block-title">Prompt</span>
            <p>{run.prompt}</p>
          </div>
        </section>
      ) : (
        <p className="wr-empty">No run selected yet. Send this agent a task to see it here.</p>
      )}

      <section className="inspector-block">
        <span className="inspector-block-title">System</span>
        <dl className="fact-grid">
          <div><dt>Runtime</dt><dd>{system?.runtime ?? "—"}</dd></div>
          <div><dt>Sandbox mode</dt><dd className="mono">{system?.codexSandboxMode ?? "—"}</dd></div>
          <div><dt>Stall threshold</dt><dd className="mono">{formatDuration(system?.runStallThresholdMs ?? 0)}</dd></div>
          <div><dt>Max run age</dt><dd className="mono">{formatDuration(system?.runMaxAgeMs ?? 0)}</dd></div>
        </dl>
      </section>
    </div>
  );
}
