import { useState } from "react";
import type { Agent, AgentRun, RunEvent, SystemInfo } from "../../types";
import type { HeimdallStatus } from "../../heimdallClient";
import { IconX } from "../../HeimdallIcons";
import { FilesTab } from "./FilesTab";
import { LogsTab } from "./LogsTab";
import { OverviewTab } from "./OverviewTab";
import { PermissionsTab } from "./PermissionsTab";
import { TimelineTab } from "./TimelineTab";

type Tab = "overview" | "timeline" | "permissions" | "logs" | "files";
const TABS: Array<{ id: Tab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "timeline", label: "Timeline" },
  { id: "permissions", label: "Permissions" },
  { id: "logs", label: "Logs" },
  { id: "files", label: "Files" },
];

export interface InspectorProps {
  agent: Agent;
  run: AgentRun | null;
  events: RunEvent[];
  system: SystemInfo | null;
  heimdallStatus: HeimdallStatus | null;
  nowMs: number;
  open: boolean;
  onClose: () => void;
  onCancelRun: () => void;
  onRetryRun: () => void;
  onRestartAgent: () => void;
  busy: boolean;
}

export function Inspector({
  agent, run, events, system, heimdallStatus, nowMs, open, onClose, onCancelRun, onRetryRun, onRestartAgent, busy,
}: InspectorProps) {
  const [tab, setTab] = useState<Tab>("overview");
  const openLogs = () => setTab("logs");

  return (
    <>
      <div className={"inspector-backdrop" + (open ? " visible" : "")} onClick={onClose} />
      <aside className={"inspector" + (open ? " open" : "")}>
        <div className="inspector-tabs">
          {TABS.map((t) => (
            <button key={t.id} className={"inspector-tab " + (tab === t.id ? "active" : "")} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
          <button className="icon-button inspector-close" onClick={onClose} aria-label="Close inspector">
            <IconX />
          </button>
        </div>
        <div className="inspector-body">
          {tab === "overview" && <OverviewTab agent={agent} run={run} system={system} nowMs={nowMs} />}
          {tab === "timeline" && (
            <TimelineTab
              agent={agent} run={run} system={system} nowMs={nowMs}
              onCancelRun={onCancelRun} onRetryRun={onRetryRun} onOpenLogs={openLogs} onRestartAgent={onRestartAgent}
              busy={busy}
            />
          )}
          {tab === "permissions" && <PermissionsTab run={run} heimdallStatus={heimdallStatus} />}
          {tab === "logs" && <LogsTab run={run} events={events} />}
          {tab === "files" && <FilesTab agentId={agent.id} run={run} />}
        </div>
      </aside>
    </>
  );
}
