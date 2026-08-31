import { useEffect, useRef } from "react";
import { RunPipeline } from "./RunPipeline";
import { StuckRunDiagnostic } from "./StuckRunDiagnostic";
import type { Agent, AgentRun, Message, SystemInfo } from "../types";
import { IconPanel } from "../HeimdallIcons";
import { MessageBody } from "./MessageBody.js";

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function StatusPill({ status }: { status: Agent["status"] }) {
  return (
    <span className={"status status-" + status}>
      <span className="status-dot" />
      {status}
    </span>
  );
}

const starterPrompts = [
  "Create a small TypeScript CLI that prints a weather summary from sample JSON.",
  "Inspect this workspace and explain what you would improve first.",
  "Build a responsive single-page todo app with tests.",
];

export interface ChatPanelProps {
  agent: Agent;
  messages: Message[];
  activeRun: AgentRun | null;
  nowMs: number;
  system: SystemInfo | null;
  prompt: string;
  setPrompt: (value: string) => void;
  onSend: (event: React.FormEvent) => void;
  onToggleAgent: () => void;
  onDeleteAgent: () => void;
  onOpenSettings: () => void;
  onCancelRun: () => void;
  onRetryRun: () => void;
  onOpenLogs: () => void;
  onRestartAgent: () => void;
  onToggleInspector: () => void;
  inspectorOpen: boolean;
  busy: boolean;
}

export function ChatPanel({
  agent, messages, activeRun, nowMs, system, prompt, setPrompt, onSend,
  onToggleAgent, onDeleteAgent, onOpenSettings, onCancelRun, onRetryRun, onOpenLogs, onRestartAgent,
  onToggleInspector, inspectorOpen, busy,
}: ChatPanelProps) {
  const messageEnd = useRef<HTMLDivElement>(null);
  useEffect(() => {
    messageEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, activeRun]);

  const running = activeRun !== null && (activeRun.status === "queued" || activeRun.status === "running");
  const stallThresholdMs = system?.runStallThresholdMs ?? 20_000;
  const runMaxAgeMs = system?.runMaxAgeMs ?? 3_600_000;

  return (
    <section className="chat-panel">
      <header className="chat-context-bar">
        <div className="chat-context-identity">
          <span className="chat-context-name">{agent.name}</span>
          <StatusPill status={agent.status} />
          <span className="chat-context-desc truncate">{agent.description || "Codex coding agent"}</span>
        </div>
        <div className="chat-context-actions">
          <button className="button button-ghost" onClick={onOpenSettings} disabled={busy || agent.status === "busy"}>
            Settings
          </button>
          <button className="button button-ghost" onClick={onToggleAgent} disabled={busy}>
            {agent.status === "stopped" ? "Start" : "Stop"}
          </button>
          <button className="button button-danger" onClick={onDeleteAgent} disabled={busy || agent.status === "busy"}>
            Delete
          </button>
          <button
            className={"icon-button inspector-toggle" + (inspectorOpen ? " active" : "")}
            onClick={onToggleInspector}
            aria-label={inspectorOpen ? "Hide inspector" : "Show inspector"}
            title={inspectorOpen ? "Hide inspector" : "Show inspector"}
          >
            <IconPanel />
          </button>
        </div>
      </header>

      <div className="transcript">
        {messages.length === 0 && !activeRun ? (
          <div className="welcome">
            <h3>What should {agent.name} build?</h3>
            <p>
              The agent can inspect files, write code, run commands, and continue the same Codex session
              across messages. Every step is visible in the inspector.
            </p>
            <div className="prompt-grid">
              {starterPrompts.map((item) => (
                <button key={item} onClick={() => setPrompt(item)}>
                  {item}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((message) => (
            <article className={"message message-" + message.role} key={message.id}>
              <div className="message-meta">
                <strong>{message.role === "user" ? "You" : agent.name}</strong>
                <span>{formatTime(message.createdAt)}</span>
              </div>
              <MessageBody content={message.content} />
            </article>
          ))
        )}

        {running && activeRun && (
          <article className="message message-assistant thinking">
            <div className="message-meta">
              <strong>{agent.name}</strong>
              <span>working in the agent workspace</span>
            </div>
            <RunPipeline timeline={activeRun.timeline} nowMs={nowMs} compact />
          </article>
        )}

        {activeRun && (activeRun.status === "failed" || running) && (
          <StuckRunDiagnostic
            run={activeRun}
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
        )}

        <div ref={messageEnd} />
      </div>

      <form className="composer" onSubmit={onSend}>
        <textarea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          placeholder={agent.status === "stopped" ? "Start this agent to continue…" : "Describe what you want the agent to do…"}
          disabled={agent.status === "stopped" || agent.status === "busy" || running}
          rows={2}
        />
        <div className="composer-footer">
          <span>
            Enter to send · Shift+Enter for newline · {agent.codexThreadId ? "session connected" : "new session"} ·{" "}
            {system?.codexSandboxMode ?? "checking sandbox"}
          </span>
          <button
            className="send-button"
            disabled={!prompt.trim() || agent.status === "stopped" || agent.status === "busy" || running}
            aria-label="Send message"
          >
            ↑
          </button>
        </div>
      </form>
    </section>
  );
}
