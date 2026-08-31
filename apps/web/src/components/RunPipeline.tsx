import { formatClockTime, formatDuration } from "../lib/format";
import { STAGE_LABELS } from "../lib/timeline";
import type { RunTimelineEntry, StageStatus } from "../types";
import { IconAlert, IconLoader } from "../HeimdallIcons";

const STATUS_ORDER: Record<StageStatus, number> = {
  active: 0, waiting: 0, failed: 0, complete: 1, skipped: 1, pending: 2,
};

function StageDot({ status }: { status: StageStatus }) {
  if (status === "active") return <span className="stage-dot stage-active"><IconLoader /></span>;
  if (status === "waiting") return <span className="stage-dot stage-waiting" />;
  if (status === "failed") return <span className="stage-dot stage-failed"><IconAlert /></span>;
  if (status === "complete") return <span className="stage-dot stage-complete" />;
  if (status === "skipped") return <span className="stage-dot stage-skipped" />;
  return <span className="stage-dot stage-pending" />;
}

export interface RunPipelineProps {
  timeline: RunTimelineEntry[];
  nowMs: number;
  compact?: boolean;
}

export function RunPipeline({ timeline, nowMs, compact }: RunPipelineProps) {
  const visible = compact ? timeline.filter((entry) => entry.status !== "skipped") : timeline;
  return (
    <ol className={"pipeline" + (compact ? " pipeline-compact" : "")}>
      {visible.map((entry) => {
        const elapsed = entry.startedAt
          ? formatDuration((entry.endedAt ? new Date(entry.endedAt).getTime() : nowMs) - new Date(entry.startedAt).getTime())
          : null;
        return (
          <li key={entry.stage} className={"pipeline-step step-" + entry.status} data-order={STATUS_ORDER[entry.status]}>
            <StageDot status={entry.status} />
            <div className="pipeline-copy">
              <span className="pipeline-label">{STAGE_LABELS[entry.stage] ?? entry.stage}</span>
              {!compact && entry.detail && <span className="pipeline-detail">{entry.detail}</span>}
              {!compact && entry.startedAt && (
                <span className="pipeline-meta mono">
                  {formatClockTime(entry.startedAt)}
                  {elapsed ? " · " + elapsed : ""}
                </span>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
