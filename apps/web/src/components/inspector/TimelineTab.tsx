import { RunPipeline } from "../RunPipeline";
import { StuckRunDiagnostic } from "../StuckRunDiagnostic";
import type { Agent, AgentRun, SystemInfo } from "../../types";

export interface TimelineTabProps {
  agent: Agent;
  run: AgentRun | null;
  system: SystemInfo | null;
  nowMs: number;
  onCancelRun: () => void;
  onRetryRun: () => void;
  onOpenLogs: () => void;
  onRestartAgent: () => void;
  busy: boolean;
}

export function TimelineTab({ agent, run, system, nowMs, onCancelRun, onRetryRun, onOpenLogs, onRestartAgent, busy }: TimelineTabProps) {
  if (!run) {
    return <div className="tab-panel"><div className="tab-panel-empty"><p className="wr-empty">No run selected yet.</p></div></div>;
  }
  const stallThresholdMs = system?.runStallThresholdMs ?? 20_000;
  const runMaxAgeMs = system?.runMaxAgeMs ?? 3_600_000;

  return (
    <div className="tab-panel timeline-tab">
      <StuckRunDiagnostic
        run={run}
        nowMs={nowMs}
        stallThresholdMs={stallThresholdMs}
        runMaxAgeMs={runMaxAgeMs}
        agentStatus={agent.status}
        onCancel={onCancelRun}
        onRetry={onRetryRun}
        onOpenLogs={onOpenLogs}
        onRestartAgent={onRestartAgent}
        busy={busy}
      />
      <RunPipeline timeline={run.timeline} nowMs={nowMs} />
    </div>
  );
}
