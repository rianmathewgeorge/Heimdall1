/** HEIMDALL — web client types + API. */
export type Tier = "T0" | "T1" | "T2" | "T3" | "T4";

export interface ReceiptLine { axis: string; pts: number; why: string }

export interface CapabilityVerdict {
  fingerprint: string; op: string; target: string;
  score: number | null; tier: Tier; hardRule: string | null;
  receipt: ReceiptLine[]; resolvedBy: string | null;
  narrowedTo: string[] | null; summary: string;
}

export interface Permit {
  permitId: string; runId: string; agentId: string; termSheetVersion: string;
  runTier: Tier; summary: string; verdicts: CapabilityVerdict[];
  grantedWrites: string[]; grantedReads: string[];
  grantedHosts: string[]; grantedCommands: string[];
  expiresAt: number; requiresHumanApproval: boolean; denied: boolean; createdAt: string;
  requestHash: string; approvedHash: string | null; capabilityToken: string;
}

export interface Denial {
  at: string; rule: string; op: string; target: string;
  detail: string; attempted: string | null; sent: false;
}

export interface Divergence { kind: "undeclared" | "unused"; op: string; target: string }

export interface HeimdallRun {
  runId: string; agentId: string; createdAt: string; prompt: string;
  manifest: { summary: string; capabilities: unknown[] } | null;
  manifestError: string | null;
  permit: Permit | null; denials: Denial[]; divergences: Divergence[];
  actual: Array<{ op: string; target: string; at: string }>;
  approval: { required: boolean; decidedBy: string | null; decision: string | null; at: string | null };
  reconMs: number; execMs: number; outcome: string; degraded: boolean;
}

export interface Metrics {
  runs: number; contained: number; denials: number;
  approvalsRequested: number; approvalsGranted: number; approvalsRefused: number;
  escalationPrecision: number | null; benignCompleted: number; benignTotal: number;
  autoResolved: number; degradedRuns: number; avgReconMs: number | null;
}

export interface HeimdallStatus {
  enabled: boolean; termSheetVersion: string; degradedFallback: boolean; network: string;
  ledger: { valid: boolean; events: number; brokenAt: number | null };
  metrics: Metrics;
}

export interface LedgerEvent {
  index: number; ts: string; runId: string; agentId: string;
  type: string; data: Record<string, unknown>; prevHash: string; hash: string;
}

let token = "";
export function setHeimdallToken(value: string): void { token = value.trim(); }

async function get<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: token ? { Authorization: "Bearer " + token } : {} });
  if (!res.ok) throw new Error("Heimdall request failed: " + res.status);
  return (await res.json()) as T;
}

export const heimdallApi = {
  status: () => get<HeimdallStatus>("/api/heimdall/status"),
  pending: () => get<{ pending: Permit[] }>("/api/heimdall/pending"),
  runs: (agentId: string) => get<{ runs: HeimdallRun[] }>("/api/heimdall/runs?agentId=" + agentId),
  run: (runId: string) => get<{ run: HeimdallRun; events: LedgerEvent[] }>("/api/heimdall/runs/" + runId),
  verify: () => get<{ valid: boolean; events: number; brokenAt: number | null }>("/api/heimdall/ledger/verify"),
  decide: async (runId: string, decision: "approved" | "denied") => {
    const res = await fetch("/api/heimdall/runs/" + runId + "/decide", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
      body: JSON.stringify({ decision, by: "operator" }),
    });
    if (!res.ok) throw new Error("Decision failed");
    return (await res.json()) as { ok: boolean };
  },
};

