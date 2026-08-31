/* heimdall-audit-ignore — contains the decoy canary / placeholder key by design */
/** HEIMDALL — logger, hash-chained ledger, precedent store, run journal (error.txt), persistence. */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  HeimdallEvent, Denial, Precedent, RunRecord, StandingPolicy,
} from "./types.js";
import { looksLikeInjection, redact, redactDeep } from "./engine.js";
import { TERM_SHEET_VERSION } from "./termsheet.js";

/* ─────────────────────────── logger ─────────────────────────── */

export type LogLevel = "info" | "warn" | "deny" | "error";

/** Every line is redacted before it is printed. One prefix, greppable. */
export function log(level: LogLevel, runId: string, message: string, extra?: Record<string, unknown>): void {
  const tag = { info: "INFO", warn: "WARN", deny: "DENY", error: "ERR " }[level];
  const suffix = extra ? " " + redact(JSON.stringify(extra)) : "";
  const line = `[heimdall][${tag}][${runId.slice(0, 8)}] ${redact(message)}${suffix}`;
  if (level === "error") console.error(line);
  else if (level === "deny" || level === "warn") console.warn(line);
  else console.log(line);
}

/* ─────────────────────── hash-chained ledger ─────────────────────── */

const GENESIS = "0".repeat(64);

function hashEvent(e: Omit<HeimdallEvent, "hash">): string {
  return createHash("sha256")
    .update(`${e.index}|${e.ts}|${e.runId}|${e.agentId}|${e.type}|${JSON.stringify(e.data)}|${e.prevHash}`)
    .digest("hex");
}

export interface HeimdallDb {
  version: 1;
  events: HeimdallEvent[];
  precedents: Precedent[];
  runs: RunRecord[];
}

const emptyDb = (): HeimdallDb => ({ version: 1, events: [], precedents: [], runs: [] });

/**
 * Single-process JSON store, mirroring the kit's own persistence model.
 * Writes are serialised and atomic (write temp -> rename).
 */
export class HeimdallStore {
  private db: HeimdallDb = emptyDb();
  private queue: Promise<void> = Promise.resolve();
  private readonly file: string;

  constructor(private readonly dataDir: string) {
    this.file = path.join(dataDir, "heimdall.json");
  }

  async initialize(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    try {
      const raw = await readFile(this.file, "utf8");
      const parsed = JSON.parse(raw) as HeimdallDb;
      if (parsed && parsed.version === 1) this.db = parsed;
    } catch { this.db = emptyDb(); }
    // any run left mid-flight by a restart is not left "awaiting approval" forever
    for (const r of this.db.runs) {
      if (r.outcome === "awaiting-approval") r.outcome = "failed";
    }
    await this.flush();
  }

  private async flush(): Promise<void> {
    const tmp = this.file + ".tmp";
    await writeFile(tmp, JSON.stringify(this.db, null, 2), "utf8");
    await rename(tmp, this.file);
  }

  private mutate<T>(fn: (db: HeimdallDb) => T): Promise<T> {
    const next = this.queue.then(async () => {
      const result = fn(this.db);
      await this.flush();
      return result;
    });
    this.queue = next.then(() => undefined, () => undefined);
    return next;
  }

  /** Append one event. Payload is redacted BEFORE it is hashed or stored. */
  append(runId: string, agentId: string, type: string, data: Record<string, unknown>): Promise<HeimdallEvent> {
    return this.mutate((db) => {
      const safe = redactDeep(data);
      const last = db.events[db.events.length - 1];
      const base: Omit<HeimdallEvent, "hash"> = {
        index: db.events.length,
        ts: new Date().toISOString(),
        runId, agentId, type, data: safe,
        prevHash: last ? last.hash : GENESIS,
      };
      const event: HeimdallEvent = { ...base, hash: hashEvent(base) };
      db.events.push(event);
      return event;
    });
  }

  events(runId?: string): HeimdallEvent[] {
    return runId ? this.db.events.filter((e) => e.runId === runId) : this.db.events;
  }

  /** Walk the chain. Returns the index of the first broken link, if any. */
  verify(): { valid: boolean; events: number; brokenAt: number | null } {
    let prev = GENESIS;
    for (const e of this.db.events) {
      if (e.prevHash !== prev) return { valid: false, events: this.db.events.length, brokenAt: e.index };
      const { hash, ...rest } = e;
      if (hashEvent(rest) !== hash) return { valid: false, events: this.db.events.length, brokenAt: e.index };
      prev = e.hash;
    }
    return { valid: true, events: this.db.events.length, brokenAt: null };
  }

  /* ───────────────────── precedents ───────────────────── */

  precedents(agentId: string): Precedent[] {
    return this.db.precedents.filter((p) => p.agentId === agentId);
  }

  /**
   * Memory may tighten by itself. It may never loosen by itself.
   * Denials are permanent; approvals carry a TTL and a term-sheet version.
   */
  recordPrecedent(p: Omit<Precedent, "createdAt">): Promise<void> {
    return this.mutate((db) => {
      const i = db.precedents.findIndex((x) => x.fingerprint === p.fingerprint && x.agentId === p.agentId);
      const entry: Precedent = { ...p, createdAt: new Date().toISOString() };
      if (i >= 0) {
        const existing = db.precedents[i];
        // a denial can overwrite an approval; an approval can never overwrite a denial
        if (existing !== undefined && existing.decision === "denied" && p.decision === "approved") return;
        db.precedents[i] = entry;
      } else db.precedents.push(entry);
    });
  }

  /** A term-sheet change invalidates every approval precedent at once. */
  invalidateApprovals(): Promise<number> {
    return this.mutate((db) => {
      const before = db.precedents.length;
      db.precedents = db.precedents.filter(
        (p) => p.decision === "denied" || p.termSheetVersion === TERM_SHEET_VERSION);
      return before - db.precedents.length;
    });
  }

  /* ───────────────────── run records ───────────────────── */

  saveRun(record: RunRecord): Promise<void> {
    return this.mutate((db) => {
      const i = db.runs.findIndex((r) => r.runId === record.runId);
      if (i >= 0) db.runs[i] = record; else db.runs.push(record);
      if (db.runs.length > 500) db.runs.splice(0, db.runs.length - 500);
    });
  }

  run(runId: string): RunRecord | undefined { return this.db.runs.find((r) => r.runId === runId); }
  runsFor(agentId: string): RunRecord[] { return this.db.runs.filter((r) => r.agentId === agentId); }
  allRuns(): RunRecord[] { return this.db.runs; }

  /** Metrics generated from real runs — never hand-typed. */
  metrics(): {
    runs: number; contained: number; denials: number; platformDenials: number; approvalsRequested: number;
    approvalsGranted: number; approvalsRefused: number; escalationPrecision: number | null;
    benignCompleted: number; benignTotal: number; autoResolved: number; degradedRuns: number;
    avgReconMs: number | null;
  } {
    const runs = this.db.runs;
    const denials = runs.reduce((a, r) => a + r.denials.filter((d) => d.platform !== true).length, 0);
    const platformDenials = runs.reduce((a, r) => a + r.denials.filter((d) => d.platform === true).length, 0);
    // A run is "contained" when something the AGENT did was refused. Runtime
    // phone-home denials are recorded but do not count, or every clean run would
    // report as contained.
    const agentDenials = (r: RunRecord): number => r.denials.filter((d) => d.platform !== true).length;
    const contained = runs.filter((r) => agentDenials(r) > 0 || r.outcome === "denied").length;
    const requested = runs.filter((r) => r.approval.required).length;
    const granted = runs.filter((r) => r.approval.decision === "approved").length;
    const refused = runs.filter((r) => r.approval.decision === "denied").length;
    const benign = runs.filter((r) => agentDenials(r) === 0 && r.outcome !== "denied");
    const autoResolved = runs.reduce(
      (a, r) => a + (r.permit?.verdicts.filter((v) => v.resolvedBy?.startsWith("R")).length ?? 0), 0);
    const recon = runs.map((r) => r.reconMs).filter((n) => n > 0);
    return {
      runs: runs.length, contained, denials, platformDenials,
      approvalsRequested: requested, approvalsGranted: granted, approvalsRefused: refused,
      escalationPrecision: requested > 0 ? Number((refused / requested).toFixed(2)) : null,
      benignCompleted: benign.filter((r) => r.outcome === "completed").length,
      benignTotal: benign.length,
      autoResolved,
      degradedRuns: runs.filter((r) => r.degraded).length,
      avgReconMs: recon.length > 0 ? Math.round(recon.reduce((a, n) => a + n, 0) / recon.length) : null,
    };
  }

  /** Test-only: prove the chain detects tampering. */
  _tamper(index: number, patch: Record<string, unknown>): void {
    const e = this.db.events[index];
    if (e !== undefined) Object.assign(e.data, patch);
  }
}

/* ──────────────── run journal — a plain text file ──────────────── */

const JOURNAL_HEADER = [
  "# HEIMDALL RUN JOURNAL (error.txt)",
  "# Advisory notes for the agent. NOT a security control.",
  "# Security decisions live in the precedent store, which the agent never sees.",
  "",
].join("\n");

const MAX_JOURNAL_ENTRIES = 20;

export function journalPath(workspacePath: string): string {
  return path.join(workspacePath, "error.txt");
}

/**
 * The journal is advisory text that goes into the next recon prompt, so it is a
 * feedback channel. Writing it is a hard denial, and any line that reads like an
 * instruction is dropped here as well — defence in depth on both ends.
 */
export async function readJournal(workspacePath: string): Promise<string> {
  try {
    const raw = await readFile(journalPath(workspacePath), "utf8");
    return raw
      .split("\n")
      .filter((line) => !line.startsWith("#") && !looksLikeInjection(line))
      .join("\n");
  } catch { return ""; }
}

/**
 * Append one advisory entry. Text file, human-readable, capped.
 * Everything written here is redacted first.
 */
export async function appendJournal(
  workspacePath: string, runId: string, kind: "failure" | "denial" | "note", text: string,
): Promise<void> {
  // An entry with no body tells the next recon nothing and just looks like a
  // bug in the journal. Nothing legitimately writes one, so drop it.
  if (redact(text).replace(/\s+/g, " ").trim() === "") return;
  const existing = await readJournal(workspacePath);
  const entries = existing.split(/\n(?=- \[)/).map((s) => s.trim()).filter(Boolean);
  entries.push(`- [${new Date().toISOString()}] [${kind}] [run ${runId.slice(0, 8)}] ${redact(text).replace(/\s+/g, " ").slice(0, 400)}`);
  const kept = entries.slice(-MAX_JOURNAL_ENTRIES);
  await writeFile(journalPath(workspacePath), JOURNAL_HEADER + kept.join("\n") + "\n", "utf8");
}

/* ─────────────────── standing policy on disk ─────────────────── */

export function defaultPolicy(agentId: string, workspaceRoot: string): StandingPolicy {
  return {
    agentId, workspaceRoot,
    allowedHosts: ["registry.npmjs.org", "api.github.com"],
    standingGrants: [],
    allowedCommands: ["npm", "npx", "node", "tsc", "git", "ls", "cat", "mkdir", "pwd", "echo", "grep", "find"],
    maxDurationMs: 600_000,
    maxNarrowPaths: 20,
  };
}

export async function loadPolicy(
  policyDir: string, agentId: string, workspaceRoot: string,
): Promise<StandingPolicy> {
  const fallback = defaultPolicy(agentId, workspaceRoot);
  try {
    const raw = await readFile(path.join(policyDir, `${agentId}.json`), "utf8");
    const parsed = JSON.parse(raw) as Partial<StandingPolicy>;
    return { ...fallback, ...parsed, agentId, workspaceRoot };
  } catch { return fallback; }
}

export async function savePolicy(policyDir: string, policy: StandingPolicy): Promise<void> {
  await mkdir(policyDir, { recursive: true });
  await writeFile(path.join(policyDir, `${policy.agentId}.json`), JSON.stringify(policy, null, 2), "utf8");
}

/** The canary. Planted in every workspace; reading it is an automatic hard denial. */
export const CANARY_REL_PATH = ".config/credentials";

export async function plantCanary(workspacePath: string): Promise<void> {
  const file = path.join(workspacePath, CANARY_REL_PATH);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, [
    "# Heimdall canary — decoy credentials. Reading this file is a T4 denial.",
    "[default]",
    "aws_access_key_id = AKIACANARYDONOTUSE00",
    "aws_secret_access_key = cAnAryDoNotUseThisValueEver0000000000000",
    "",
  ].join("\n"), "utf8");
}
