import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChatPanel } from "./components/ChatPanel";
import { Inspector } from "./components/inspector/Inspector";
import { Sidebar } from "./components/Sidebar";
import { PermissionCard, useHeimdall } from "./Heimdall";
import { setHeimdallToken } from "./heimdallClient";
import { useRunEvents } from "./hooks/useRunEvents";
import { api, ApiError, setAuthToken } from "./api";
import type { Agent, AgentRun, Message, SystemInfo } from "./types";

const emptyForm = {
  name: "",
  description: "",
  instructions:
    "Help me build and test software in this workspace. Keep changes small and explain the result.",
};

function Spinner() {
  return <span className="spinner" aria-label="Loading" />;
}

export default function App() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [prompt, setPrompt] = useState("");
  const [inspectedRunId, setInspectedRunId] = useState<string | null>(null);
  const [recentRuns, setRecentRuns] = useState<AgentRun[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authRequired, setAuthRequired] = useState<boolean | null>(null);
  const [authInput, setAuthInput] = useState("");
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const selectedIdRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  selectedIdRef.current = selectedId;

  const selected = useMemo(
    () => agents.find((agent) => agent.id === selectedId) ?? null,
    [agents, selectedId],
  );

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const refreshAgents = useCallback(async () => {
    const { agents: next } = await api.listAgents();
    setAgents(next);
    setSelectedId((current) =>
      current && next.some((agent) => agent.id === current)
        ? current
        : (next[0]?.id ?? null),
    );
  }, []);

  const refreshMessages = useCallback(async (agentId: string) => {
    const result = await api.messages(agentId);
    if (mountedRef.current && selectedIdRef.current === agentId) {
      setMessages(result.messages);
    }
  }, []);

  const refreshRuns = useCallback(async (agentId: string) => {
    const result = await api.runs(agentId);
    if (mountedRef.current && selectedIdRef.current === agentId) {
      setRecentRuns(result.runs);
      return result.runs;
    }
    return result.runs;
  }, []);

  const bootstrap = useCallback(async () => {
    await Promise.all([refreshAgents(), api.system().then(setSystem)]);
  }, [refreshAgents]);

  useEffect(() => {
    mountedRef.current = true;
    void api
      .auth()
      .then(async ({ required }) => {
        if (!mountedRef.current) return;
        setAuthRequired(required);
        if (!required) await bootstrap();
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
    return () => {
      mountedRef.current = false;
    };
  }, [bootstrap]);

  useEffect(() => {
    setShowSettings(false);
    setInspectedRunId(null);
    setRecentRuns([]);
    if (!selectedId) {
      setMessages([]);
      return;
    }
    void Promise.all([refreshMessages(selectedId), refreshRuns(selectedId)])
      .then(([, runs]) => {
        if (selectedIdRef.current !== selectedId) return;
        setInspectedRunId(runs[0]?.id ?? null);
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, [refreshMessages, refreshRuns, selectedId]);

  useEffect(() => {
    if (selected) {
      setForm({
        name: selected.name,
        description: selected.description,
        instructions: selected.instructions,
      });
    }
  }, [selected]);

  const heimdall = useHeimdall(selectedId, authRequired === false);
  const { run: inspectedRun, events } = useRunEvents(inspectedRunId);

  // Keep the sidebar's recent-run list and the message list in sync while a run is live.
  useEffect(() => {
    if (!inspectedRun || !selectedId || inspectedRun.agentId !== selectedId) return;
    setRecentRuns((current) => {
      const idx = current.findIndex((run) => run.id === inspectedRun.id);
      if (idx === -1) return [inspectedRun, ...current];
      const next = [...current];
      next[idx] = inspectedRun;
      return next;
    });
    if (inspectedRun.status === "completed" || inspectedRun.status === "failed") {
      void refreshMessages(selectedId);
    }
    if (inspectedRun.status !== "queued" && inspectedRun.status !== "running") {
      void refreshAgents();
    }
  }, [inspectedRun, selectedId, refreshMessages, refreshAgents]);

  const createAgent = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { agent } = await api.createAgent(form);
      await refreshAgents();
      setSelectedId(agent.id);
      setShowCreate(false);
      setForm(emptyForm);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const saveAgent = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await api.updateAgent(selected.id, form);
      await refreshAgents();
      setShowSettings(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const toggleAgent = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      if (selected.status === "stopped") {
        await api.startAgent(selected.id);
      } else {
        await api.stopAgent(selected.id);
      }
      await refreshAgents();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const restartAgent = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await api.stopAgent(selected.id);
      await api.startAgent(selected.id);
      await refreshAgents();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const deleteAgent = async () => {
    if (!selected) return;
    if (!window.confirm("Delete " + selected.name + "? Its workspace will be archived.")) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.deleteAgent(selected.id);
      await refreshAgents();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const sendMessage = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected || !prompt.trim()) return;
    const content = prompt.trim();
    setPrompt("");
    setError(null);
    try {
      const result = await api.sendMessage(selected.id, content);
      if (selectedIdRef.current === selected.id) {
        setMessages((current) => [...current, result.message]);
        setInspectedRunId(result.run.id); // always follow a newly started run
      }
      setAgents((current) =>
        current.map((agent) => (agent.id === selected.id ? { ...agent, status: "busy" } : agent)),
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      await refreshAgents();
    }
  };

  const cancelRun = async () => {
    if (!inspectedRunId) return;
    setBusy(true);
    try {
      await api.cancelRun(inspectedRunId);
      await refreshAgents();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const retryRun = async () => {
    if (!inspectedRunId || !selected) return;
    setBusy(true);
    try {
      const result = await api.retryRun(inspectedRunId);
      setInspectedRunId(result.run.id);
      await refreshAgents();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const unlock = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setAuthToken(authInput);
    setHeimdallToken(authInput);
    try {
      await bootstrap();
      setAuthRequired(false);
      setAuthInput("");
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) {
        setError("The access token is not valid.");
      } else {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      setBusy(false);
    }
  };

  if (authRequired === null) {
    return (
      <main className="auth-screen">
        <section className="auth-card" aria-live="polite">
          <div className="brand-mark">A</div>
          <span className="eyebrow">Agent Launchpad</span>
          <h1>Connecting to the control plane</h1>
          {error ? <div className="error-banner" role="alert">{error}</div> : <Spinner />}
        </section>
      </main>
    );
  }

  if (authRequired) {
    return (
      <main className="auth-screen">
        <form className="auth-card" onSubmit={unlock}>
          <div className="brand-mark">A</div>
          <span className="eyebrow">Agent Launchpad</span>
          <h1>Enter the access token</h1>
          <p>This shared demo token is configured by the platform operator.</p>
          {error && <div className="error-banner" role="alert">{error}</div>}
          <label>
            Access token
            <input
              autoFocus
              type="password"
              value={authInput}
              onChange={(event) => setAuthInput(event.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
          <button className="button button-primary" disabled={busy || !authInput.trim()}>
            {busy ? <Spinner /> : "Open Launchpad"}
          </button>
        </form>
      </main>
    );
  }

  return (
    <div className={"app-shell" + (inspectorOpen ? " inspector-open" : "")}>
      <Sidebar
        agents={agents}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onCreate={() => { setForm(emptyForm); setShowCreate(true); }}
        system={system}
        recentRuns={recentRuns}
        inspectedRunId={inspectedRunId}
        onSelectRun={setInspectedRunId}
        nowMs={nowMs}
      />

      <main className="main">
        {!system?.arkConfigured || !system?.codexAvailable ? (
          <div className="config-banner">
            <span>!</span>
            <div>
              <strong>Runtime configuration needed</strong>
              <p>
                {!system?.arkConfigured
                  ? "Set ARK_API_KEY and ARK_MODEL in .env before using the Playground."
                  : system.runtimeProvider === "container"
                    ? "The local container engine or Agent Runtime image is unavailable. Rerun npm run poc."
                    : "Codex CLI was not found. Use the Docker image or install @openai/codex."}
              </p>
            </div>
          </div>
        ) : null}

        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button onClick={() => setError(null)}>×</button>
          </div>
        )}

        {selected ? (
          <>
            {showSettings && (
              <form className="settings-panel" onSubmit={saveAgent}>
                <div className="settings-title">
                  <div>
                    <span className="eyebrow">Agent configuration</span>
                    <h2>Instructions and identity</h2>
                  </div>
                  <button type="button" onClick={() => setShowSettings(false)}>×</button>
                </div>
                <div className="form-grid">
                  <label>
                    Name
                    <input
                      value={form.name}
                      onChange={(event) => setForm({ ...form, name: event.target.value })}
                      required
                      maxLength={80}
                    />
                  </label>
                  <label>
                    Description
                    <input
                      value={form.description}
                      onChange={(event) => setForm({ ...form, description: event.target.value })}
                      maxLength={500}
                    />
                  </label>
                </div>
                <label>
                  System instructions
                  <textarea
                    value={form.instructions}
                    onChange={(event) => setForm({ ...form, instructions: event.target.value })}
                    rows={5}
                    maxLength={10_000}
                  />
                </label>
                <div className="panel-footer">
                  <code>{selected.workspacePath}</code>
                  <button className="button button-primary" disabled={busy}>
                    {busy ? <Spinner /> : "Save changes"}
                  </button>
                </div>
              </form>
            )}

            {heimdall.pending && (
              <PermissionCard
                permit={heimdall.pending}
                onDecide={() => { heimdall.setPending(null); void heimdall.refresh(); }}
              />
            )}

            <ChatPanel
              agent={selected}
              messages={messages}
              activeRun={inspectedRun}
              nowMs={nowMs}
              system={system}
              prompt={prompt}
              setPrompt={setPrompt}
              onSend={sendMessage}
              onToggleAgent={toggleAgent}
              onDeleteAgent={deleteAgent}
              onOpenSettings={() => setShowSettings((v) => !v)}
              onCancelRun={cancelRun}
              onRetryRun={retryRun}
              onOpenLogs={() => setInspectorOpen(true)}
              onRestartAgent={restartAgent}
              onToggleInspector={() => setInspectorOpen((v) => !v)}
              inspectorOpen={inspectorOpen}
              busy={busy}
            />
          </>
        ) : (
          <div className="no-agent">
            <div className="no-agent-art">A</div>
            <span className="eyebrow">Agent Launchpad</span>
            <h1>Your runtime is ready for an Agent.</h1>
            <p>Create a workspace, give Codex a job, and continue the conversation here.</p>
            <button
              className="button button-primary"
              onClick={() => { setForm(emptyForm); setShowCreate(true); }}
            >
              Create your first Agent
            </button>
          </div>
        )}
      </main>

      {selected && (
        <Inspector
          agent={selected}
          run={inspectedRun}
          events={events}
          system={system}
          heimdallStatus={heimdall.status}
          nowMs={nowMs}
          open={inspectorOpen}
          onClose={() => setInspectorOpen(false)}
          onCancelRun={cancelRun}
          onRetryRun={retryRun}
          onRestartAgent={restartAgent}
          busy={busy}
        />
      )}

      {showCreate && (
        <div className="modal-backdrop" onMouseDown={() => setShowCreate(false)}>
          <form
            className="modal"
            onSubmit={createAgent}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="modal-heading">
              <div>
                <span className="eyebrow">New workspace</span>
                <h2>Create an Agent</h2>
                <p>Each Agent gets a persistent folder and a resumable Codex session.</p>
              </div>
              <button type="button" onClick={() => setShowCreate(false)}>×</button>
            </div>
            <label>
              Name
              <input
                autoFocus
                placeholder="Frontend Builder"
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                required
                maxLength={80}
              />
            </label>
            <label>
              Description
              <input
                placeholder="Builds polished React prototypes"
                value={form.description}
                onChange={(event) => setForm({ ...form, description: event.target.value })}
                maxLength={500}
              />
            </label>
            <label>
              Instructions
              <textarea
                value={form.instructions}
                onChange={(event) => setForm({ ...form, instructions: event.target.value })}
                rows={6}
                maxLength={10_000}
              />
            </label>
            <div className="modal-footer">
              <button type="button" className="button button-ghost" onClick={() => setShowCreate(false)}>
                Cancel
              </button>
              <button className="button button-primary" disabled={busy}>
                {busy ? <Spinner /> : "Create Agent"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
