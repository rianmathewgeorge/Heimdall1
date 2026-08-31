import { formatDuration } from "../lib/format";
import type { Agent, AgentRun, SystemInfo } from "../types";
import { IconPlus } from "../HeimdallIcons";

function StatusDot({ status }: { status: Agent["status"] }) {
  return <span className={"mini-dot mini-" + status} />;
}

export interface SidebarProps {
  agents: Agent[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  system: SystemInfo | null;
  recentRuns: AgentRun[];
  inspectedRunId: string | null;
  onSelectRun: (runId: string) => void;
  nowMs: number;
}

export function Sidebar({
  agents, selectedId, onSelect, onCreate, system, recentRuns, inspectedRunId, onSelectRun, nowMs,
}: SidebarProps) {
  const activeAgents = agents.filter((agent) => agent.status === "busy");

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">A</div>
        <div>
          <strong>Agent Launchpad</strong>
          <span>
            {system?.runtimeProvider === "container" ? "Container runtime · Codex CLI" : "Local process · Codex CLI"}
          </span>
        </div>
      </div>

      <button className="button button-primary create-button" onClick={onCreate}>
        <IconPlus /> Create Agent
      </button>

      <div className="sidebar-scroll">
        {activeAgents.length > 0 && (
          <div className="active-strip">
            <span className="sidebar-label"><span>Currently active</span><span>{activeAgents.length}</span></span>
            {activeAgents.map((agent) => (
              <button key={agent.id} className="active-row" onClick={() => onSelect(agent.id)}>
                <span className="pulse-dot" />
                <span className="active-name">{agent.name}</span>
                <span className="mono active-elapsed">{formatDuration(nowMs - new Date(agent.updatedAt).getTime())}</span>
              </button>
            ))}
          </div>
        )}

        <div className="sidebar-label">
          <span>Your Agents</span>
          <span>{agents.length}</span>
        </div>
        <nav className="agent-list">
          {agents.map((agent) => (
            <button
              className={"agent-card " + (agent.id === selectedId ? "selected" : "")}
              key={agent.id}
              onClick={() => onSelect(agent.id)}
            >
              <div className="agent-avatar">{agent.name.slice(0, 1).toUpperCase()}</div>
              <div className="agent-card-copy">
                <strong>{agent.name}</strong>
                <span>{agent.description || "Coding Agent"}</span>
              </div>
              <StatusDot status={agent.status} />
            </button>
          ))}
          {agents.length === 0 && (
            <div className="empty-sidebar">
              <span>◇</span>
              Create your first coding Agent.
            </div>
          )}
        </nav>

        {selectedId && recentRuns.length > 0 && (
          <div className="recent-runs">
            <div className="sidebar-label"><span>Recent runs</span><span>{recentRuns.length}</span></div>
            <div className="recent-runs-list">
              {recentRuns.slice(0, 6).map((run) => (
                <button
                  key={run.id}
                  className={"recent-run " + (run.id === inspectedRunId ? "selected" : "")}
                  onClick={() => onSelectRun(run.id)}
                >
                  <span className={"run-status-dot status-dot-" + run.status} />
                  <span className="recent-run-stage">{run.prompt.slice(0, 40) || run.stage}</span>
                  <span className="mono recent-run-time">
                    {run.completedAt
                      ? formatDuration(nowMs - new Date(run.completedAt).getTime()) + " ago"
                      : formatDuration(nowMs - new Date(run.createdAt).getTime())}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="runtime-card">
        <span className="eyebrow">Runtime</span>
        <strong>{system?.runtime ?? "Checking…"}</strong>
        <span>
          {system?.arkModel ?? "Ark model not configured"}
          {system?.containerEngine ? " · " + system.containerEngine : ""}
        </span>
      </div>
    </aside>
  );
}
