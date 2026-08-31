export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type MessageRole = "user" | "assistant";

export interface Agent {
  id: string;
  /** the HUMAN who owns this agent. Authorization is scoped to this, at the backend. */
  ownerId: string;
  /** the agent's OWN principal — never the owner's credential. Rotatable, revocable. */
  principalId: string | null;
  name: string;
  description: string;
  instructions: string;
  status: AgentStatus;
  workspacePath: string;
  codexThreadId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  agentId: string;
  runId: string;
  role: MessageRole;
  content: string;
  createdAt: string;
}

export interface RunUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
}

/**
 * The pipeline every run visibly moves through. Not every run passes through every
 * stage (e.g. "approval" only applies to a T3 permit; the runtime skips stages when
 * Heimdall is disabled) — the UI shows skipped stages as "skipped", not "pending".
 */
export type RunStage =
  | "queued"
  | "recon"
  | "manifest"
  | "permit"
  | "approval"
  | "container"
  | "codex"
  | "parsing"
  | "reconciliation"
  | "completed"
  | "failed"
  | "cancelled";

export type StageStatus = "pending" | "active" | "complete" | "failed" | "skipped" | "waiting";

export interface RunTimelineEntry {
  stage: RunStage;
  status: StageStatus;
  startedAt: string | null;
  endedAt: string | null;
  detail: string | null;
  data?: Record<string, unknown>;
}

export type EventSeverity = "info" | "warn" | "error" | "success";

/** One structured, correlated fact about a run's progress. The primary live-progress signal. */
export interface RunEvent {
  seq: number;
  ts: string;
  appRunId: string;
  heimdallRunId: string | null;
  agentId: string;
  stage: RunStage;
  severity: EventSeverity;
  message: string;
  data?: Record<string, unknown>;
}

/** The full causal chain behind a failure — never just the outermost message. */
export interface SerializedError {
  message: string;
  name: string;
  exitCode?: number | null;
  containerName?: string | null;
  stdout?: string;
  stderr?: string;
  cause?: SerializedError;
}

export interface RunLogs {
  stdout: string;
  stderr: string;
}

export type FileChangeKind = "added" | "modified" | "deleted";

export interface DiffHunk {
  value: string;
  added?: boolean;
  removed?: boolean;
}

export interface FileChange {
  path: string;
  kind: FileChangeKind;
  sizeBefore: number | null;
  sizeAfter: number | null;
  diffAvailable: boolean;
  diff?: DiffHunk[];
}

export interface AgentRun {
  id: string;
  agentId: string;
  status: RunStatus;
  prompt: string;
  output: string | null;
  error: string | null;
  errorDetail: SerializedError | null;
  usage: RunUsage | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  /** Current pipeline stage. Mirrors the latest timeline entry with status "active" or the terminal stage. */
  stage: RunStage;
  timeline: RunTimelineEntry[];
  /** Set once Heimdall assigns a run id for this app run; null when Heimdall is disabled or not yet reached. */
  heimdallRunId: string | null;
  containerName: string | null;
  exitCode: number | null;
  /** Timestamp of the most recent RunEvent for this run — the basis for "no progress detected". */
  lastEventAt: string | null;
  logs: RunLogs | null;
  fileChanges: FileChange[] | null;
}

/**
 * A stand-in for a protected business resource. It exists so ownership
 * isolation can be PROVEN rather than asserted: User A's agent must not be able
 * to read User B's record, and the check lives at the API boundary, not the UI.
 */
export interface ProtectedResource {
  id: string;
  ownerId: string;
  name: string;
  contents: string;
}

export interface Database {
  version: 1;
  agents: Agent[];
  messages: Message[];
  runs: AgentRun[];
  /** mock protected records, used to demonstrate ownership isolation */
  resources?: ProtectedResource[];
  /** persisted agent principals, so revocation survives a restart */
  agentPrincipals?: Array<{
    kind: "agent"; id: string; agentId: string; ownerId: string;
    createdAt: string; revokedAt: string | null; version: number;
  }>;
}

export interface CreateAgentInput {
  name: string;
  description?: string | undefined;
  instructions?: string | undefined;
}

export interface UpdateAgentInput {
  name?: string | undefined;
  description?: string | undefined;
  instructions?: string | undefined;
}

export interface RunnerResult {
  output: string;
  threadId: string | null;
  usage: RunUsage | null;
}

/** Callback runners use to report structured progress. Bound to one app run by AgentService. */
export type RunEventEmitter = (event: {
  stage: RunStage;
  severity?: EventSeverity;
  message: string;
  data?: Record<string, unknown>;
  heimdallRunId?: string;
}) => void;

export interface RunnerRequest {
  /** who initiated this run, resolved to a person and an agent principal */
  attribution?: {
    humanId: string; humanName: string;
    agentPrincipalId: string | null; agentPrincipalVersion: number | null;
    agentId: string;
  };
  agentId: string;
  workspacePath: string;
  prompt: string;
  threadId: string | null;
  /** The application-level run UUID — the correlation id events and API calls key off. */
  appRunId: string;
  emit: RunEventEmitter;
}

export interface AgentRunner {
  run(request: RunnerRequest): Promise<RunnerResult>;
  cancel(agentId: string): Promise<boolean>;
  isAvailable(): Promise<boolean>;
}
