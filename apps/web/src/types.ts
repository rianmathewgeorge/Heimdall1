export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface Agent {
  id: string;
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
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

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
  usage: {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
  } | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  stage: RunStage;
  timeline: RunTimelineEntry[];
  heimdallRunId: string | null;
  containerName: string | null;
  exitCode: number | null;
  lastEventAt: string | null;
  logs: RunLogs | null;
  fileChanges: FileChange[] | null;
}

export interface SystemInfo {
  arkConfigured: boolean;
  arkBaseUrl: string;
  arkModel: string | null;
  codexAvailable: boolean;
  codexSandboxMode: string;
  runtimeProvider: "local-process" | "container";
  containerEngine: string | null;
  runtime: string;
  runStallThresholdMs: number;
  runMaxAgeMs: number;
}

export interface TreeEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  size: number | null;
  mtimeMs: number | null;
}

export interface FilePreview {
  path: string;
  size: number;
  content: string;
  truncated: boolean;
  binary: boolean;
  language: string;
}
