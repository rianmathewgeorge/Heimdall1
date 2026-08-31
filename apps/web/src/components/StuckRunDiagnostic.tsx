import { useMemo, useState } from "react";
import { diagnoseRun, isDiagnosisAlarming, type RunDiagnosis } from "../lib/diagnostics";
import { formatDuration } from "../lib/format";
import type { AgentRun, SerializedError } from "../types";
import {
  IconChevronDown, IconChevronRight, IconCopy, IconFile as IconFileIcon,
  IconAlert, IconPlay, IconRefresh, IconStop,
} from "../HeimdallIcons";

const HEALTH_ICON_TONE: Record<RunDiagnosis["health"], string> = {
  ok: "tone-slate",
  terminal: "tone-slate",
  "awaiting-approval": "tone-amber",
  "waiting-process": "tone-amber",
  "process-exited": "tone-red",
  "no-response": "tone-amber",
  "no-events": "tone-red",
  stalled: "tone-amber",
};

function deepestCause(error: SerializedError): SerializedError {
  let node = error;
  while (node.cause) node = node.cause;
  return node;
}

function CausalChain({ error, depth = 0 }: { error: SerializedError; depth?: number }) {
  return (
    <div className="causal-node" style={{ marginLeft: depth === 0 ? 0 : 12 }}>
      <div className="causal-row">
        <span className="causal-marker">{depth === 0 ? "error" : "caused by"}</span>
        <span className="causal-message">{error.message}</span>
      </div>
      {(error.exitCode !== undefined || error.containerName) && (
        <div className="causal-meta">
          {error.containerName ? <span>container {error.containerName}</span> : null}
          {error.exitCode !== undefined && error.exitCode !== null ? <span>exit code {error.exitCode}</span> : null}
        </div>
      )}
      {error.cause && <CausalChain error={error.cause} depth={depth + 1} />}
    </div>
  );
}

function buildDiagnosticBundle(run: AgentRun, diagnosis: RunDiagnosis): string {
  return JSON.stringify(
    {
      runId: run.id,
      agentId: run.agentId,
      heimdallRunId: run.heimdallRunId,
      status: run.status,
      stage: run.stage,
      diagnosis: { health: diagnosis.health, label: diagnosis.label },
      elapsedInStageMs: diagnosis.elapsedInStageMs,
      elapsedSinceLastEventMs: diagnosis.elapsedSinceLastEventMs,
      containerName: run.containerName,
      exitCode: run.exitCode,
      error: run.error,
      errorDetail: run.errorDetail,
      logs: run.logs,
      timeline: run.timeline,
    },
    null,
    2,
  );
}

export interface StuckRunDiagnosticProps {
  run: AgentRun;
  nowMs: number;
  stallThresholdMs: number;
  runMaxAgeMs: number;
  agentStatus: "ready" | "busy" | "stopped" | "error";
  onCancel: () => void;
  onRetry: () => void;
  onOpenLogs: () => void;
  onRestartAgent: () => void;
  busy?: boolean;
}

export function StuckRunDiagnostic({
  run, nowMs, stallThresholdMs, runMaxAgeMs, agentStatus,
  onCancel, onRetry, onOpenLogs, onRestartAgent, busy,
}: StuckRunDiagnosticProps) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const diagnosis = useMemo(() => diagnoseRun(run, nowMs, stallThresholdMs), [run, nowMs, stallThresholdMs]);
  const failed = run.status === "failed";
  const shouldShow = failed || isDiagnosisAlarming(diagnosis);
  if (!shouldShow) return null;

  const active = run.status === "queued" || run.status === "running";
  const canRetry = run.status === "failed" || run.status === "cancelled";
  const containerKnownRunning = active && run.containerName !== null && run.exitCode === null;
  const restartAppropriate = agentStatus === "error" || (failed && agentStatus !== "busy");
  const rootCause = run.errorDetail ? deepestCause(run.errorDetail).message : run.error;
  const tone = failed ? "tone-red" : HEALTH_ICON_TONE[diagnosis.health];
  const summaryDetail = failed ? rootCause : diagnosis.label;

  const copyBundle = async () => {
    const bundle = buildDiagnosticBundle(run, diagnosis);
    try {
      await navigator.clipboard.writeText(bundle);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard unavailable — the bundle stays visible for manual copy */
    }
  };

  return (
    <section
      className={"diagnostic" + (failed ? " is-failed" : "")}
      data-health={diagnosis.health}
      role="alert"
      aria-live="polite"
    >
      <div className="diagnostic-summary">
        <span className={"diagnostic-icon " + tone}><IconAlert /></span>
        <div className="diagnostic-summary-text">
          <strong>{failed ? "Run failed" : "No progress detected"}</strong>
          {summaryDetail && <span className="truncate">{summaryDetail}</span>}
        </div>
        <span
          className="mono diagnostic-elapsed"
          title="Time since last event — keeps counting up even after the run ends"
          aria-label={"time since last event: " + formatDuration(diagnosis.elapsedSinceLastEventMs)}
        >
          {formatDuration(diagnosis.elapsedSinceLastEventMs)}
        </span>
        <div className="diagnostic-quick-actions">
          {active && (
            <button className="button button-ghost button-xs" onClick={onCancel} disabled={busy}>Cancel</button>
          )}
          {canRetry && (
            <button className="button button-ghost button-xs" onClick={onRetry} disabled={busy}>Retry</button>
          )}
          <button className="button button-ghost button-xs" onClick={onOpenLogs} disabled={busy}>Logs</button>
          <button
            className="button button-ghost button-xs"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
          >
            Details {expanded ? <IconChevronDown /> : <IconChevronRight />}
          </button>
        </div>
      </div>

      {expanded && (
        <div className="diagnostic-detail">
          <dl className="diagnostic-facts">
            <div><dt>Current stage</dt><dd>{diagnosis.stageLabel}</dd></div>
            <div><dt>Time in this stage</dt><dd className="mono">{formatDuration(diagnosis.elapsedInStageMs)}</dd></div>
            <div><dt>Since last event</dt><dd className="mono">{formatDuration(diagnosis.elapsedSinceLastEventMs)}</dd></div>
            <div><dt>Configured timeout</dt><dd className="mono">{formatDuration(runMaxAgeMs)}</dd></div>
            <div>
              <dt>Runtime process</dt>
              <dd>
                {containerKnownRunning ? "Running" : run.exitCode !== null ? `Exited (code ${run.exitCode})` : "Not yet observed"}
              </dd>
            </div>
            <div><dt>Container</dt><dd className="mono truncate">{run.containerName ?? "—"}</dd></div>
            <div><dt>Awaiting approval</dt><dd>{diagnosis.awaitingApproval ? "Yes — a decision is required" : "No"}</dd></div>
            <div><dt>Heimdall run</dt><dd className="mono truncate">{run.heimdallRunId ?? "—"}</dd></div>
          </dl>

          {run.errorDetail ? (
            <div className="diagnostic-causes">
              <span className="diagnostic-subhead">Causal chain</span>
              <div className="causal-scroll">
                <CausalChain error={run.errorDetail} />
              </div>
            </div>
          ) : run.error ? (
            <div className="diagnostic-causes">
              <span className="diagnostic-subhead">Error</span>
              <pre className="causal-scroll mono">{run.error}</pre>
            </div>
          ) : null}

          <div className="diagnostic-actions">
            <button className="button button-ghost" onClick={() => void copyBundle()} disabled={busy}>
              <IconCopy /> {copied ? "Copied" : "Copy diagnostic bundle"}
            </button>
            <button className="button button-ghost" onClick={onOpenLogs} disabled={busy}>
              <IconFileIcon /> Open raw logs
            </button>
            {active && (
              <button className="button button-ghost" onClick={onCancel} disabled={busy}>
                <IconStop /> Cancel run
              </button>
            )}
            {canRetry && (
              <button className="button button-ghost" onClick={onRetry} disabled={busy}>
                <IconPlay /> Retry run
              </button>
            )}
            {restartAppropriate && (
              <button className="button button-ghost" onClick={onRestartAgent} disabled={busy}>
                <IconRefresh /> Restart agent
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
