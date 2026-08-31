import { useEffect, useMemo, useRef, useState } from "react";
import { formatClockTime } from "../../lib/format";
import type { AgentRun, EventSeverity, FileChange, RunEvent, RunStage } from "../../types";
import { IconCopy } from "../../HeimdallIcons";

type Filter = "all" | "errors" | "heimdall" | "runtime" | "codex" | "files";

const HEIMDALL_STAGES = new Set<RunStage>(["recon", "manifest", "permit", "approval", "reconciliation"]);
const RUNTIME_STAGES = new Set<RunStage>(["container"]);
const CODEX_STAGES = new Set<RunStage>(["codex", "parsing"]);

function sourceFor(stage: RunStage): string {
  if (HEIMDALL_STAGES.has(stage)) return "Heimdall";
  if (RUNTIME_STAGES.has(stage)) return "Runtime";
  if (CODEX_STAGES.has(stage)) return "Codex";
  if (stage === "completed" || stage === "failed" || stage === "cancelled") return "Run";
  return "Run";
}

function matchesFilter(event: RunEvent, filter: Filter): boolean {
  if (filter === "all") return true;
  if (filter === "errors") return event.severity === "error";
  if (filter === "heimdall") return HEIMDALL_STAGES.has(event.stage);
  if (filter === "runtime") return RUNTIME_STAGES.has(event.stage);
  if (filter === "codex") return CODEX_STAGES.has(event.stage);
  return false;
}

function severityClass(severity: EventSeverity): string {
  return "sev-" + severity;
}

function EventRow({ event }: { event: RunEvent }) {
  const [expanded, setExpanded] = useState(false);
  const hasPayload = event.data && Object.keys(event.data).length > 0;
  return (
    <div className={"log-row " + severityClass(event.severity)}>
      <span className="log-time mono">{formatClockTime(event.ts)}</span>
      <span className={"log-badge badge-" + sourceFor(event.stage).toLowerCase()}>{sourceFor(event.stage)}</span>
      <span className="log-stage">{event.stage}</span>
      <span className="log-message">{event.message}</span>
      {hasPayload && (
        <button className="log-expand" onClick={() => setExpanded((v) => !v)}>{expanded ? "hide" : "payload"}</button>
      )}
      {expanded && hasPayload && <pre className="raw-json log-payload">{JSON.stringify(event.data, null, 2)}</pre>}
    </div>
  );
}

function FileChangeRow({ change }: { change: FileChange }) {
  return (
    <div className="log-row sev-info">
      <span className="log-time mono">—</span>
      <span className="log-badge badge-files">Files</span>
      <span className="log-stage">{change.kind}</span>
      <span className="log-message mono">{change.path}</span>
    </div>
  );
}

function buildSanitizedBundle(run: AgentRun, events: RunEvent[]): string {
  return JSON.stringify(
    {
      runId: run.id,
      heimdallRunId: run.heimdallRunId,
      status: run.status,
      stage: run.stage,
      error: run.error,
      errorDetail: run.errorDetail,
      exitCode: run.exitCode,
      containerName: run.containerName,
      timeline: run.timeline,
      events: events.map((e) => ({ ts: e.ts, stage: e.stage, severity: e.severity, message: e.message })),
      logs: run.logs,
      fileChanges: run.fileChanges,
    },
    null,
    2,
  );
}

export interface LogsTabProps {
  run: AgentRun | null;
  events: RunEvent[];
}

export function LogsTab({ run, events }: LogsTabProps) {
  const [filter, setFilter] = useState<Filter>("all");
  const [copied, setCopied] = useState(false);
  const [showStdout, setShowStdout] = useState(false);
  const [showStderr, setShowStderr] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const userScrolledAway = useRef(false);

  const filtered = useMemo(() => {
    if (filter === "files") return [];
    return events.filter((event) => matchesFilter(event, filter));
  }, [events, filter]);

  const showFiles = filter === "all" || filter === "files";
  const fileChanges = showFiles ? run?.fileChanges ?? [] : [];

  useEffect(() => {
    const el = listRef.current;
    if (!el || userScrolledAway.current) return;
    el.scrollTop = el.scrollHeight;
  }, [filtered, fileChanges]);

  if (!run) return <div className="tab-panel"><div className="tab-panel-empty"><p className="wr-empty">No run selected yet.</p></div></div>;

  const copyBundle = async () => {
    try {
      await navigator.clipboard.writeText(buildSanitizedBundle(run, events));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <div className="tab-panel logs-tab">
      <div className="logs-toolbar">
        <div className="logs-filters">
          {(["all", "errors", "heimdall", "runtime", "codex", "files"] as Filter[]).map((f) => (
            <button key={f} className={"filter-chip " + (filter === f ? "active" : "")} onClick={() => setFilter(f)}>
              {f}
            </button>
          ))}
        </div>
        <button className="button button-ghost" onClick={() => void copyBundle()}>
          <IconCopy /> {copied ? "Copied" : "Copy diagnostic bundle"}
        </button>
      </div>

      <div
        className="logs-feed"
        ref={listRef}
        onScroll={(event) => {
          const el = event.currentTarget;
          userScrolledAway.current = el.scrollHeight - el.scrollTop - el.clientHeight > 48;
        }}
      >
        {filtered.length === 0 && fileChanges.length === 0 ? (
          <p className="wr-empty">No events match this filter yet.</p>
        ) : (
          <>
            {filtered.map((event) => <EventRow key={event.seq} event={event} />)}
            {fileChanges.map((change) => <FileChangeRow key={change.path} change={change} />)}
          </>
        )}
      </div>

      {run.logs && (
        <div className="logs-raw">
          <button className="log-section-toggle" onClick={() => setShowStdout((v) => !v)}>
            {showStdout ? "Hide" : "Show"} raw stdout ({run.logs.stdout.length} bytes)
          </button>
          {showStdout && <pre className="raw-json">{run.logs.stdout || "(empty)"}</pre>}
          <button className="log-section-toggle" onClick={() => setShowStderr((v) => !v)}>
            {showStderr ? "Hide" : "Show"} raw stderr ({run.logs.stderr.length} bytes)
          </button>
          {showStderr && <pre className="raw-json">{run.logs.stderr || "(empty)"}</pre>}
        </div>
      )}
    </div>
  );
}
