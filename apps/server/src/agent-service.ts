import { randomUUID } from "node:crypto";
import type { AppConfig } from "./config.js";
import { isArkConfigured } from "./config.js";
import { HttpError, RunCancelledError, serializeError, findLogsInChain, findRuntimeMetaInChain } from "./errors.js";
import { RunEventBus } from "./events.js";
import { diffSnapshots, snapshotWorkspace } from "./files.js";
import { JsonStore } from "./store.js";
import { applyEventToTimeline, finalizeTimeline, initialTimeline } from "./timeline.js";
import type {
  Agent,
  AgentRun,
  AgentRunner,
  CreateAgentInput,
  Message,
  RunEvent,
  RunEventEmitter,
  RunStage,
  ProtectedResource,
  UpdateAgentInput,
} from "./types.js";
import { WorkspaceManager } from "./workspace.js";
import { Coordinator } from "./heimdall/coordination.js";
import {
  attributionFor, DEFAULT_PRINCIPAL_ID, IdentityDirectory,
  type Attribution, type HumanPrincipal,
} from "./heimdall/identity.js";

const now = () => new Date().toISOString();

/** Backfills run records written before the event/timeline model existed. */
function migrateRun(run: AgentRun): AgentRun {
  const legacy = run as AgentRun & Record<string, unknown>;
  if (Array.isArray(legacy["timeline"])) return run; // already on the current shape
  const stage: RunStage =
    run.status === "completed" || run.status === "failed" || run.status === "cancelled" ? run.status : "queued";
  const migrated: AgentRun = {
    id: run.id,
    agentId: run.agentId,
    status: run.status,
    prompt: run.prompt,
    output: run.output,
    error: run.error,
    usage: run.usage,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    createdAt: run.createdAt,
    errorDetail: null,
    stage,
    timeline: initialTimeline(run.createdAt),
    heimdallRunId: null,
    containerName: null,
    exitCode: null,
    lastEventAt: run.completedAt ?? run.startedAt ?? run.createdAt,
    logs: null,
    fileChanges: null,
  };
  return migrated;
}

export class AgentService {
  private readonly activeExecutions = new Map<string, Promise<void>>();
  private readonly cancellationRequests = new Set<string>();
  private watchdogTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly store: JsonStore,
    private readonly workspaces: WorkspaceManager,
    private readonly runner: AgentRunner,
    public readonly events: RunEventBus = new RunEventBus(),
    public readonly identity: IdentityDirectory = new IdentityDirectory(),
    public readonly coordinator: Coordinator = new Coordinator(),
  ) {
    // There is ALWAYS a default operator principal, so every request resolves to
    // a person even in a single-user setup with no token configured. Without
    // this, authorization has no subject to check against and the whole plane
    // has to special-case "nobody".
    this.identity.addHuman(DEFAULT_PRINCIPAL_ID, "Operator", this.config.authToken || "operator-token");
  }

  /**
   * Seeds the mock identity directory and the protected records that make
   * ownership isolation demonstrable. Tokens come from the environment when
   * set, so a demo can use real values; the defaults are obvious placeholders.
   */
  async seedIdentities(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
    const a = environment["HEIMDALL_USER_A_TOKEN"] ?? "user-a-token";
    const b = environment["HEIMDALL_USER_B_TOKEN"] ?? "user-b-token";
    this.identity.addHuman("user-a", "User A", a);
    this.identity.addHuman("user-b", "User B", b);

    await this.store.mutate((database) => {
      // agent principals outlive a restart, so a revocation stays revoked
      this.identity.restore(database.agentPrincipals ?? []);
      if ((database.resources ?? []).length === 0) {
        database.resources = [
          { id: "res-a", ownerId: "user-a", name: "User A payroll export", contents: "A-only payroll row" },
          { id: "res-b", ownerId: "user-b", name: "User B payroll export", contents: "B-only payroll row" },
        ];
      }
    });
  }

  async initialize(): Promise<void> {
    await this.store.initialize();
    await this.workspaces.initialize();
    await this.store.mutate((database) => {
      database.runs = database.runs.map(migrateRun);
      for (const run of database.runs) {
        if (run.status === "queued" || run.status === "running") {
          run.status = "cancelled";
          run.error = "Server restarted while this run was active";
          run.completedAt = now();
          run.timeline = finalizeTimeline(run.timeline, "cancelled", run.completedAt);
          run.stage = "cancelled";
        }
      }
      for (const agent of database.agents) {
        if (agent.status === "busy") {
          agent.status = "ready";
          agent.updatedAt = now();
        }
      }
    });
    this.watchdogTimer = setInterval(() => void this.sweepStuckRuns(), 15_000);
    this.watchdogTimer.unref();
  }

  async shutdown(): Promise<void> {
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
  }

  listAgents(): Agent[] {
    return this.store
      .snapshot()
      .agents.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  getAgent(id: string): Agent {
    const agent = this.store.snapshot().agents.find((item) => item.id === id);
    if (!agent) {
      throw new HttpError(404, "Agent not found");
    }
    return agent;
  }

  async createAgent(input: CreateAgentInput, ownerId: string): Promise<Agent> {
    const timestamp = now();
    const id = randomUUID();
    // Every agent gets its OWN principal at creation. It is never the owner's
    // credential, and it can be rotated or revoked without touching the human.
    const principal = this.identity.mintAgentPrincipal(id, ownerId);
    const agent: Agent = {
      id,
      ownerId,
      principalId: principal.id,
      name: input.name.trim(),
      description: input.description?.trim() ?? "",
      instructions: input.instructions?.trim() ?? "",
      status: "ready",
      workspacePath: this.workspaces.workspacePath(id),
      codexThreadId: null,
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.workspaces.create(agent);
    await this.store.mutate((database) => {
      database.agents.push(agent);
      database.agentPrincipals = [...(database.agentPrincipals ?? []), principal];
    });
    return agent;
  }

  /* ─────────────────── multi-agent coordination ─────────────────── */

  /**
   * Drives a shared session to completion, one real Agent turn at a time.
   *
   * Each turn is a genuine run through the same path a Playground message takes
   * — same identity, same permit, same broker — so coordination is a platform
   * capability rather than a script pretending to be one. The Coordinator owns
   * the invariant; this loop only offers turns and reports what came back.
   */
  async runCoordination(sessionId: string, options: { maxTurns?: number } = {}): Promise<void> {
    const session = this.coordinator.get(sessionId);
    if (session === undefined) throw new HttpError(404, "Session not found");
    // a bound on total attempts, so a model that never says the right number
    // cannot spin forever
    const maxTurns = options.maxTurns ?? (session.from - session.to + 1) * 4;

    for (let attempt = 0; attempt < maxTurns; attempt++) {
      const turn = this.coordinator.claim(sessionId);
      if (turn === null) break;                       // finished, or nothing to do
      try {
        const agent = this.store.snapshot().agents.find((a) => a.id === turn.agentId);
        if (agent === undefined) {
          this.coordinator.fail(sessionId, turn.agentId, "agent no longer exists");
          continue;
        }
        const result = await this.runner.run({
          agentId: agent.id,
          workspacePath: agent.workspacePath,
          prompt: turn.prompt,
          threadId: null,
          appRunId: "coord-" + sessionId + "-" + String(attempt),
          emit: () => {},
          ...(this.attributionFor(agent.id) !== null ? { attribution: this.attributionFor(agent.id)! } : {}),
        });
        this.coordinator.commit(sessionId, turn.agentId, result.output);
      } catch (error) {
        this.coordinator.fail(sessionId, turn.agentId, (error as Error).message);
      }
      if (this.coordinator.get(sessionId)?.status !== "running") break;
    }
  }

  /** Resolve an agent to the person accountable for it, and the principal executing. */
  attributionFor(agentId: string): Attribution | null {
    const agent = this.store.snapshot().agents.find((a) => a.id === agentId);
    if (agent === undefined) return null;
    const owner = this.identity.human(agent.ownerId);
    if (owner === undefined) return null;
    return attributionFor(owner, agentId, this.identity.activeFor(agentId));
  }

  /** Persist the principal table so a revocation survives a restart. */
  async persistPrincipals(): Promise<void> {
    const { agents } = this.identity.snapshot();
    await this.store.mutate((database) => { database.agentPrincipals = agents; });
  }

  /* ─────────────────── ownership-scoped access ─────────────────── */

  /**
   * The authorization boundary. Every agent-scoped route resolves through here,
   * so a caller can only ever reach agents they own — enforced at the API, not
   * in the UI. A non-owner gets 404, not 403: telling them the agent exists but
   * is someone else's is itself a disclosure.
   */
  requireOwnedAgent(id: string, principal: HumanPrincipal): Agent {
    const agent = this.store.snapshot().agents.find((a) => a.id === id);
    if (agent === undefined || agent.ownerId !== principal.id) {
      throw new HttpError(404, "Agent not found");
    }
    return agent;
  }

  /** Agents belonging to one human. Never the whole table. */
  listAgentsFor(principal: HumanPrincipal): Agent[] {
    return this.listAgents().filter((a) => a.ownerId === principal.id);
  }

  /**
   * A protected record, readable only by its owner. The negative case is the
   * point: an agent acting for User A cannot read User B's row.
   */
  readResource(id: string, principal: HumanPrincipal): ProtectedResource {
    const found = (this.store.snapshot().resources ?? []).find((r) => r.id === id);
    if (found === undefined || found.ownerId !== principal.id) {
      throw new HttpError(404, "Resource not found");
    }
    return found;
  }

  listResourcesFor(principal: HumanPrincipal): ProtectedResource[] {
    return (this.store.snapshot().resources ?? []).filter((r) => r.ownerId === principal.id);
  }

  async updateAgent(id: string, input: UpdateAgentInput): Promise<Agent> {
    const current = this.getAgent(id);
    if (current.status === "busy") {
      throw new HttpError(409, "Stop the active run before editing this Agent");
    }
    const updated = await this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) {
        throw new HttpError(404, "Agent not found");
      }
      if (agent.status === "busy") {
        throw new HttpError(409, "Stop the active run before editing this Agent");
      }
      if (input.name !== undefined) agent.name = input.name.trim();
      if (input.description !== undefined) agent.description = input.description.trim();
      if (input.instructions !== undefined) agent.instructions = input.instructions.trim();
      agent.lastError = null;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
    await this.workspaces.writeInstructions(updated);
    return updated;
  }

  async deleteAgent(id: string): Promise<{ archivedWorkspace: string }> {
    const agent = this.getAgent(id);
    await this.cancelExecution(id);
    const archivedWorkspace = await this.workspaces.archive(agent);
    await this.store.mutate((database) => {
      database.agents = database.agents.filter((item) => item.id !== id);
      database.messages = database.messages.filter((item) => item.agentId !== id);
      database.runs = database.runs.filter((item) => item.agentId !== id);
    });
    return { archivedWorkspace };
  }

  async startAgent(id: string): Promise<Agent> {
    return this.setStatus(id, "ready");
  }

  async stopAgent(id: string): Promise<Agent> {
    this.getAgent(id);
    await this.cancelExecution(id);
    return this.setStatus(id, "stopped");
  }

  getMessages(agentId: string): Message[] {
    this.getAgent(agentId);
    return this.store
      .snapshot()
      .messages.filter((message) => message.agentId === agentId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  getRun(runId: string): AgentRun {
    const run = this.store.snapshot().runs.find((item) => item.id === runId);
    if (!run) {
      throw new HttpError(404, "Run not found");
    }
    return run;
  }

  /** Every run, newest last. Callers are responsible for scoping to an owner. */
  listAllRuns(): AgentRun[] {
    return this.store.snapshot().runs;
  }

  getRuns(agentId: string): AgentRun[] {
    this.getAgent(agentId);
    return this.store
      .snapshot()
      .runs.filter((run) => run.agentId === agentId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  /** Buffered live events for a run. Pass the last seen `seq` to resume a stream. */
  getRunEvents(runId: string, afterSeq = -1): RunEvent[] {
    return this.events.events(runId, afterSeq);
  }

  subscribeToRun(runId: string, listener: (event: RunEvent) => void): () => void {
    return this.events.subscribe(runId, listener);
  }

  async sendMessage(
    agentId: string,
    prompt: string,
  ): Promise<{ run: AgentRun; message: Message }> {
    /*
     * Delegated authority is revocable, and revocation has to BITE at the
     * execution boundary — not merely grey out a button. An agent whose
     * principal has been revoked cannot start a run, even though its owner's
     * own credential still works perfectly.
     */
    const principal = this.identity.activeFor(agentId);
    if (principal === null) {
      throw new HttpError(403,
        "This Agent's identity has been revoked. Rotate it to issue a new one before running again.");
    }

    if (!isArkConfigured(this.config)) {
      throw new HttpError(
        503,
        "Ark is not configured. Set ARK_API_KEY and ARK_MODEL, then restart.",
      );
    }
    const timestamp = now();
    const runId = randomUUID();
    const run: AgentRun = {
      id: runId,
      agentId,
      status: "queued",
      prompt,
      output: null,
      error: null,
      errorDetail: null,
      usage: null,
      startedAt: null,
      completedAt: null,
      createdAt: timestamp,
      stage: "queued",
      timeline: initialTimeline(timestamp),
      heimdallRunId: null,
      containerName: null,
      exitCode: null,
      lastEventAt: timestamp,
      logs: null,
      fileChanges: null,
    };
    const message: Message = {
      id: randomUUID(),
      agentId,
      runId,
      role: "user",
      content: prompt,
      createdAt: timestamp,
    };
    const agentAtStart = await this.store.mutate((database) => {
      const storedAgent = database.agents.find((item) => item.id === agentId);
      if (!storedAgent) {
        throw new HttpError(404, "Agent not found");
      }
      if (storedAgent.status === "stopped") {
        throw new HttpError(409, "Start the Agent before sending a message");
      }
      if (storedAgent.status === "busy") {
        throw new HttpError(409, "This Agent is already running");
      }
      database.runs.push(run);
      database.messages.push(message);
      const snapshot = structuredClone(storedAgent);
      storedAgent.status = "busy";
      storedAgent.lastError = null;
      storedAgent.updatedAt = timestamp;
      return snapshot;
    });
    const execution = this.executeRun(agentAtStart, run);
    this.activeExecutions.set(agentId, execution);
    void execution
      .finally(() => {
        if (this.activeExecutions.get(agentId) === execution) {
          this.activeExecutions.delete(agentId);
        }
      })
      .catch(() => undefined);
    return { run, message };
  }

  /** Cancel one active run without changing the Agent's start/stop state. */
  async cancelRun(runId: string): Promise<AgentRun> {
    const run = this.getRun(runId);
    if (run.status !== "queued" && run.status !== "running") {
      throw new HttpError(409, "This run is not active");
    }
    await this.cancelExecution(run.agentId);
    return this.getRun(runId);
  }

  /** Resubmit a failed or cancelled run's prompt as a new run. */
  async retryRun(runId: string): Promise<{ run: AgentRun; message: Message }> {
    const run = this.getRun(runId);
    if (run.status !== "failed" && run.status !== "cancelled") {
      throw new HttpError(409, "Only a failed or cancelled run can be retried");
    }
    return this.sendMessage(run.agentId, run.prompt);
  }

  async systemInfo(): Promise<Record<string, unknown>> {
    return {
      arkConfigured: isArkConfigured(this.config),
      arkBaseUrl: this.config.arkBaseUrl,
      arkModel: this.config.arkModel || null,
      codexAvailable: await this.runner.isAvailable(),
      codexSandboxMode: this.config.codexSandboxMode,
      runtimeProvider: this.config.runtimeProvider,
      containerEngine:
        this.config.runtimeProvider === "container"
          ? this.config.containerEngine
          : null,
      runtime:
        this.config.runtimeProvider === "container"
          ? "Codex CLI in " + this.config.containerEngine + " Runtime"
          : "Codex CLI in application container",
      runStallThresholdMs: this.config.runStallThresholdMs,
      runMaxAgeMs: this.config.runMaxAgeMs,
    };
  }

  /** Applies one RunEvent to the persisted run: timeline, stage, correlation ids, terminal state. */
  private async applyRunEvent(appRunId: string, event: RunEvent): Promise<void> {
    await this.store.mutate((database) => {
      const run = database.runs.find((item) => item.id === appRunId);
      if (!run) return;
      run.lastEventAt = event.ts;
      if (event.heimdallRunId && !run.heimdallRunId) run.heimdallRunId = event.heimdallRunId;
      const containerName = event.data?.["containerName"];
      if (typeof containerName === "string") run.containerName = containerName;
      const exitCode = event.data?.["exitCode"];
      if (typeof exitCode === "number") run.exitCode = exitCode;

      if (event.stage === "completed" || event.stage === "failed" || event.stage === "cancelled") {
        run.timeline = finalizeTimeline(run.timeline, event.stage, event.ts);
        run.stage = event.stage;
        return;
      }
      run.timeline = applyEventToTimeline(run.timeline, event);
      const active = run.timeline.find(
        (entry) => entry.status === "active" || entry.status === "waiting" || entry.status === "failed",
      );
      run.stage = active?.stage ?? event.stage;
    });
  }

  private async executeRun(agentAtStart: Agent, run: AgentRun): Promise<void> {
    const appRunId = run.id;
    const agentId = agentAtStart.id;
    const emit: RunEventEmitter = (partial) => this.events.emit({ appRunId, agentId, ...partial });
    const unsubscribe = this.events.subscribe(appRunId, (event) => void this.applyRunEvent(appRunId, event));

    await this.store.mutate((database) => {
      const storedRun = database.runs.find((item) => item.id === run.id);
      if (storedRun) {
        storedRun.status = "running";
        storedRun.startedAt = now();
      }
    });

    const beforeSnapshot = await snapshotWorkspace(agentAtStart.workspacePath).catch(() => new Map());

    try {
      if (this.cancellationRequests.has(agentAtStart.id)) {
        throw new RunCancelledError();
      }
      const result = await this.runner.run({
        agentId: agentAtStart.id,
        workspacePath: agentAtStart.workspacePath,
        prompt: run.prompt,
        threadId: agentAtStart.codexThreadId,
        appRunId,
        emit,
        ...(this.attributionFor(agentAtStart.id) !== null
          ? { attribution: this.attributionFor(agentAtStart.id)! }
          : {}),
      });
      const fileChanges = await this.computeFileChanges(agentAtStart.workspacePath, beforeSnapshot);
      const completedAt = now();
      // Persist the terminal state BEFORE emitting the terminal event: a client
      // that reacts to "completed" by immediately re-fetching /api/runs/:id must
      // never observe a stale "running" record.
      let alreadyClosed = false;
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (!storedRun || !agent) return;
        if (storedRun.status !== "running") {
          alreadyClosed = true; // a watchdog already closed this run out
          return;
        }
        storedRun.status = "completed";
        storedRun.output = result.output;
        storedRun.usage = result.usage;
        storedRun.completedAt = completedAt;
        storedRun.fileChanges = fileChanges;
        database.messages.push({
          id: randomUUID(),
          agentId: agent.id,
          runId: run.id,
          role: "assistant",
          content: result.output,
          createdAt: completedAt,
        });
        agent.status = "ready";
        agent.codexThreadId = result.threadId;
        agent.lastError = null;
        agent.updatedAt = completedAt;
      });
      if (!alreadyClosed) emit({ stage: "completed", severity: "success", message: "Run completed" });
    } catch (error) {
      const completedAt = now();
      const cancelled = error instanceof RunCancelledError;
      const message = error instanceof Error ? error.message : String(error);
      const errorDetail = serializeError(error);
      const logs = findLogsInChain(errorDetail);
      const runtimeMeta = findRuntimeMetaInChain(errorDetail);
      const fileChanges = await this.computeFileChanges(agentAtStart.workspacePath, beforeSnapshot);
      let alreadyClosed = false;
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (storedRun && storedRun.status === "running") {
          storedRun.status = cancelled ? "cancelled" : "failed";
          storedRun.error = message;
          storedRun.errorDetail = errorDetail;
          storedRun.completedAt = completedAt;
          storedRun.fileChanges = fileChanges;
          if (logs) storedRun.logs = logs;
          if (runtimeMeta?.exitCode !== null && runtimeMeta?.exitCode !== undefined) {
            storedRun.exitCode = runtimeMeta.exitCode;
          }
          if (runtimeMeta?.containerName) storedRun.containerName = runtimeMeta.containerName;
        } else {
          alreadyClosed = true; // a watchdog already closed this run out
        }
        if (agent && agent.status !== "stopped" && (!storedRun || storedRun.status !== "completed")) {
          agent.status = cancelled ? "ready" : "error";
          agent.lastError = cancelled ? null : message;
          agent.updatedAt = completedAt;
        }
      });
      if (!alreadyClosed) {
        emit({
          stage: cancelled ? "cancelled" : "failed",
          severity: cancelled ? "warn" : "error",
          message: cancelled ? "Run cancelled" : message,
        });
      }
    } finally {
      unsubscribe();
    }
  }

  private async computeFileChanges(
    workspacePath: string,
    beforeSnapshot: Awaited<ReturnType<typeof snapshotWorkspace>>,
  ) {
    try {
      const afterSnapshot = await snapshotWorkspace(workspacePath);
      return diffSnapshots(beforeSnapshot, afterSnapshot);
    } catch {
      return [];
    }
  }

  private async setStatus(id: string, status: Agent["status"]): Promise<Agent> {
    return this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) {
        throw new HttpError(404, "Agent not found");
      }
      if (status === "ready" && agent.status === "busy") {
        throw new HttpError(409, "Stop the active run before starting this Agent");
      }
      agent.status = status;
      if (status === "ready") agent.lastError = null;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
  }

  private async cancelExecution(agentId: string): Promise<void> {
    this.cancellationRequests.add(agentId);
    try {
      await this.runner.cancel(agentId);
      const execution = this.activeExecutions.get(agentId);
      if (execution) {
        await execution;
      }
    } finally {
      this.cancellationRequests.delete(agentId);
    }
  }

  /** Safety net: a run that has been queued/running longer than runMaxAgeMs is force-terminated. */
  private async sweepStuckRuns(): Promise<void> {
    const cutoff = Date.now() - this.config.runMaxAgeMs;
    const stale = this.store
      .snapshot()
      .runs.filter((run) => (run.status === "queued" || run.status === "running") && new Date(run.createdAt).getTime() < cutoff);
    for (const run of stale) {
      await this.forceTerminateStaleRun(run.id).catch(() => undefined);
    }
  }

  private async forceTerminateStaleRun(runId: string): Promise<void> {
    const before = this.store.snapshot().runs.find((item) => item.id === runId);
    if (!before || (before.status !== "queued" && before.status !== "running")) return;
    const message =
      `Run exceeded the maximum duration of ${this.config.runMaxAgeMs}ms with no terminal ` +
      "event from the runtime — force-terminated as a safety net.";
    const completedAt = now();
    let agentId: string | null = null;
    let applied = false;
    await this.store.mutate((database) => {
      const storedRun = database.runs.find((item) => item.id === runId);
      if (!storedRun || (storedRun.status !== "queued" && storedRun.status !== "running")) return;
      storedRun.status = "failed";
      storedRun.error = message;
      storedRun.errorDetail = { message, name: "RunMaxAgeExceededError" };
      storedRun.completedAt = completedAt;
      storedRun.timeline = finalizeTimeline(storedRun.timeline, "failed", completedAt);
      storedRun.stage = "failed";
      const agent = database.agents.find((item) => item.id === storedRun.agentId);
      if (agent && agent.status !== "stopped") {
        agent.status = "error";
        agent.lastError = message;
        agent.updatedAt = completedAt;
      }
      agentId = storedRun.agentId;
      applied = true;
    });
    // Persist first, emit second — a client reacting to this event by re-fetching
    // /api/runs/:id must see the terminal state that is already on disk.
    if (applied) this.events.emit({ appRunId: before.id, agentId: before.agentId, stage: "failed", severity: "error", message });
    if (agentId) await this.runner.cancel(agentId).catch(() => undefined);
  }
}
