import type {
  Agent, AgentRun, FileChange, FilePreview, Message, RunLogs, SystemInfo, TreeEntry,
} from "./types";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

let authToken = "";

export function setAuthToken(token: string): void {
  authToken = token.trim();
}

export function getAuthToken(): string {
  return authToken;
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const headers = {
    ...(options?.body ? { "Content-Type": "application/json" } : {}),
    ...(authToken ? { Authorization: "Bearer " + authToken } : {}),
    ...options?.headers,
  };
  const response = await fetch(url, {
    ...options,
    headers,
  });
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    throw new ApiError(data.error ?? "Request failed", response.status);
  }
  return data;
}

export const api = {
  auth: () => request<{ required: boolean }>("/api/auth"),
  system: () => request<SystemInfo>("/api/system"),
  listAgents: () => request<{ agents: Agent[] }>("/api/agents"),
  createAgent: (body: {
    name: string;
    description: string;
    instructions: string;
  }) =>
    request<{ agent: Agent }>("/api/agents", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateAgent: (
    id: string,
    body: { name: string; description: string; instructions: string },
  ) =>
    request<{ agent: Agent }>("/api/agents/" + id, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteAgent: (id: string) =>
    request<{ archivedWorkspace: string }>("/api/agents/" + id, {
      method: "DELETE",
    }),
  startAgent: (id: string) =>
    request<{ agent: Agent }>("/api/agents/" + id + "/start", {
      method: "POST",
    }),
  stopAgent: (id: string) =>
    request<{ agent: Agent }>("/api/agents/" + id + "/stop", {
      method: "POST",
    }),
  messages: (id: string) =>
    request<{ messages: Message[] }>("/api/agents/" + id + "/messages"),
  runs: (id: string) =>
    request<{ runs: AgentRun[] }>("/api/agents/" + id + "/runs"),
  sendMessage: (id: string, content: string) =>
    request<{ run: AgentRun; message: Message }>(
      "/api/agents/" + id + "/messages",
      {
        method: "POST",
        body: JSON.stringify({ content }),
      },
    ),
  run: (id: string) => request<{ run: AgentRun }>("/api/runs/" + id),
  cancelRun: (id: string) =>
    request<{ run: AgentRun }>("/api/runs/" + id + "/cancel", { method: "POST" }),
  retryRun: (id: string) =>
    request<{ run: AgentRun; message: Message }>("/api/runs/" + id + "/retry", { method: "POST" }),
  runLogs: (id: string) => request<{ logs: RunLogs | null }>("/api/runs/" + id + "/logs"),
  runChanges: (id: string) => request<{ changes: FileChange[] }>("/api/runs/" + id + "/changes"),
  filesTree: (agentId: string, path: string) =>
    request<{ entries: TreeEntry[] }>(
      "/api/agents/" + agentId + "/files/tree?path=" + encodeURIComponent(path),
    ),
  filesSearch: (agentId: string, query: string) =>
    request<{ paths: string[] }>(
      "/api/agents/" + agentId + "/files/search?q=" + encodeURIComponent(query),
    ),
  fileContent: (agentId: string, path: string) =>
    request<{ file: FilePreview }>(
      "/api/agents/" + agentId + "/files/content?path=" + encodeURIComponent(path),
    ),
};

/** URL for the SSE event stream — used directly by EventSource, not through `request`. */
export function runEventsStreamUrl(runId: string, afterSeq?: number): string {
  const query = afterSeq !== undefined ? "?after=" + afterSeq : "";
  return "/api/runs/" + runId + "/events" + query;
}
