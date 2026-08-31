/** HEIMDALL — shared types. */

export type Op =
  | "FS_READ" | "FS_WRITE" | "FS_DELETE"
  | "EXEC" | "NET_READ" | "NET_WRITE" | "ENV_READ" | "PROC_SPAWN";

export type DataClass =
  | "none" | "metadata" | "public" | "dependency" | "source_code" | "undeclared";

export type Tier = "T0" | "T1" | "T2" | "T3" | "T4";

/** Written by the AGENT during recon. Facts only — never scores. */
export interface Capability {
  op: Op;
  paths?: string[];
  command?: string;
  host?: string;
  dataClass?: DataClass;
  payloadPaths?: string[];
}

export interface Manifest {
  version: "1";
  summary: string;
  capabilities: Capability[];
  maxDurationMs: number;
  /**
   * Capabilities the planner declared that did not survive validation. They are
   * NOT granted — dropping is fail-safe, since anything ungranted is refused at
   * execution — but they are recorded so a planner that keeps emitting malformed
   * entries is visible rather than silently ignored.
   */
  dropped?: string[];
}

/** Operator-authored. Versioned on disk. */
export interface StandingPolicy {
  agentId: string;
  workspaceRoot: string;
  allowedHosts: string[];
  standingGrants: Array<{ host: string; dataClass: DataClass }>;
  allowedCommands: string[];
  maxDurationMs: number;
  maxNarrowPaths: number;
}

export interface Precedent {
  fingerprint: string;
  agentId: string;
  decision: "approved" | "denied";
  expiresAt: number | null;
  termSheetVersion: string;
  createdAt: string;
  summary: string;
}

/** Everything HEIMDALL observes. Never supplied by the agent. */
export interface RunContext {
  runId: string;
  agentId: string;
  taint: "none" | "workspace" | "external";
  taintSource: string | null;
  gitTrackedPaths: string[];
  gitIgnoredPaths: string[];
  workspaceFiles: string[];
  completedRuns: number;
  canaryRelPath: string;
  precedents: Precedent[];
  payloadSamples: Record<string, string>;
}

export interface ReceiptLine { axis: string; pts: number; why: string }

export interface CapabilityVerdict {
  fingerprint: string;
  op: Op;
  target: string;
  score: number | null;
  tier: Tier;
  hardRule: string | null;
  receipt: ReceiptLine[];
  resolvedBy: string | null;
  narrowedTo: string[] | null;
  summary: string;
}

export interface Permit {
  permitId: string;
  runId: string;
  agentId: string;
  termSheetVersion: string;
  runTier: Tier;
  summary: string;
  verdicts: CapabilityVerdict[];
  grantedWrites: string[];
  grantedReads: string[];
  grantedHosts: string[];
  grantedCommands: string[];
  expiresAt: number;
  requiresHumanApproval: boolean;
  denied: boolean;
  createdAt: string;
  /** sha256 of the exact granted capability set. Recomputed before execution. */
  requestHash: string;
  /** the hash a human actually approved. Must still match at execution time. */
  approvedHash: string | null;
  /** unguessable per-run capability. The container presents this, never the run id. */
  capabilityToken: string;
}

export interface Denial {
  at: string;
  rule: string;
  op: string;
  target: string;
  detail: string;
  /** counterfactual: what WOULD have happened. Always redacted. */
  attempted: string | null;
  sent: false;
  /**
   * The Codex runtime's own phone-home, not anything the task asked for.
   * Still blocked and still recorded — but it must not make every benign run
   * look "contained", which would quietly inflate the security metric with
   * traffic the agent never chose to send.
   */
  platform?: boolean;
}

export interface Divergence {
  kind: "undeclared" | "unused";
  op: string;
  target: string;
}

export interface HeimdallEvent {
  index: number;
  ts: string;
  runId: string;
  agentId: string;
  type: string;
  data: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

export interface RunRecord {
  /**
   * Who is accountable. Resolved to a PERSON, not just a process: the human who
   * owns the agent, and the agent principal (with version) that executed.
   */
  attribution?: {
    humanId: string; humanName: string;
    agentPrincipalId: string | null; agentPrincipalVersion: number | null;
    agentId: string;
  } | null;
  runId: string;
  agentId: string;
  createdAt: string;
  prompt: string;
  manifest: Manifest | null;
  manifestError: string | null;
  permit: Permit | null;
  denials: Denial[];
  divergences: Divergence[];
  actual: Array<{ op: string; target: string; at: string }>;
  approval: { required: boolean; decidedBy: string | null; decision: "approved" | "denied" | null; at: string | null };
  reconMs: number;
  execMs: number;
  outcome: "completed" | "denied" | "failed" | "awaiting-approval";
  degraded: boolean;
}
