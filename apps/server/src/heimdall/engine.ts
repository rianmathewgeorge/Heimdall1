/** HEIMDALL — secrets, paths, fingerprinting, scoring, resolver, permit. Pure functions. */
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type {
  Capability, CapabilityVerdict, Manifest, Permit, ReceiptLine,
  RunContext, StandingPolicy, Tier,
} from "./types.js";
import {
  A1_OPERATION as A1, A2_TARGET as A2, A3_REVERSIBILITY as A3, A4_BLAST as A4,
  A5_EGRESS as A5, A6_CONTEXT as A6, BANDS, CREDENTIAL_PATH_PATTERNS, DISCOUNTS,
  HARD, INJECTION_PATTERNS, JOURNAL_REL_PATH, PLATFORM_PATH_PATTERNS, TERM_SHEET_VERSION,
} from "./termsheet.js";

/* ───────────────────────────── secrets ───────────────────────────── */

const SECRET_PREFIX =
  /\b(sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{12,}|xox[baprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,})/g;
const ASSIGNED_SECRET =
  /\b([A-Za-z0-9_]*(?:key|token|secret|password|passwd|credential|auth)[A-Za-z0-9_]*)\s*[=:]\s*["']?([^\s"';,]{8,})["']?/gi;

/** High-entropy shapes that are NOT secrets (found by adversarial probing). */
const BENIGN_ENTROPY: readonly RegExp[] = [
  /^[0-9a-f]{7,64}$/i,                  // git sha / md5 / sha256 digest
  /^(sha\d{3}|md5)-[A-Za-z0-9+/=]+$/,   // lockfile integrity hash
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, // uuid
  /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/,     // SCREAMING_SNAKE identifier, e.g. an env var NAME
  // kebab/snake NAME: lowercase words joined by - or _, every segment short.
  // Container and network names look exactly like this ("heimdall-recon-abc123"),
  // and without this they were not merely flagged by the audit — redact() ate
  // them out of every log line and ledger entry, destroying the diagnostics you
  // need when a container fails to start. A generated secret does not survive
  // the per-segment length bound; long opaque blobs are still caught.
  /^[a-z][a-z0-9]{0,11}([-_][a-z0-9]{1,12}){2,}$/,
];

function shannon(value: string): number {
  const freq = new Map<string, number>();
  for (const ch of value) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) { const p = n / value.length; h -= p * Math.log2(p); }
  return h;
}

/**
 * The VALUE side of `KEY=value` must itself look like a credential, not like code.
 * Without this, `authToken = value.trim()` reads as a secret and redaction mangles
 * ordinary source — which also makes every legitimate source-code egress fail R5.
 * (Found by adversarial scan: 30 of 74 starter-kit files were false positives.)
 */
function looksLikeSecretValue(value: string): boolean {
  if (!/^[A-Za-z0-9+/=_-]{12,}$/.test(value)) return false;   // code punctuation disqualifies it
  if (BENIGN_ENTROPY.some((r) => r.test(value))) return false;
  SECRET_PREFIX.lastIndex = 0;
  if (SECRET_PREFIX.test(value)) return true;
  return shannon(value) >= 2.5;
}

/**
 * A BARE token (no `KEY=` in front) is only a credential if it mixes character
 * classes the way generated secrets do. Long camelCase identifiers such as
 * "forceConsistentCasingInFileNames" and kebab names such as "volc-agent-launchpad"
 * clear the entropy bar but are obviously not secrets — requiring a digit plus an
 * uppercase-or-symbol removes them. (Found by scanning the starter kit: this cut
 * false positives from 30 files to 0.)
 *
 * Known trade-off, stated in the README: an all-lowercase alphanumeric secret with
 * no key name in front is not caught by this path. Such values are still caught by
 * the prefix list and by the `KEY=value` path.
 */
function highEntropyToken(token: string): boolean {
  if (token.length < 20 || /\s/.test(token)) return false;
  if (!/^[A-Za-z0-9+/=_-]+$/.test(token)) return false;
  if (BENIGN_ENTROPY.some((r) => r.test(token))) return false;
  const hasDigit = /[0-9]/.test(token);
  const hasUpper = /[A-Z]/.test(token);
  const hasSymbol = /[+/=_-]/.test(token);
  if (!hasDigit || !(hasUpper || hasSymbol)) return false;
  return shannon(token) >= 3.4;
}

export interface SecretMatch {
  kind: "prefix" | "assigned" | "entropy";
  /** Safe to log or return to the caller — identifies what matched, never the value itself. */
  context: string;
}

/**
 * Same detection as containsSecret, but reports WHICH rule fired and enough
 * shape (a key name, a length) to diagnose a false positive — without ever
 * exposing the matched value itself. A bare "credential-shaped value" denial
 * gives an operator nothing to act on; this does.
 */
export function findSecret(text: string): SecretMatch | null {
  if (!text) return null;
  SECRET_PREFIX.lastIndex = 0;
  const prefixMatch = SECRET_PREFIX.exec(text);
  if (prefixMatch) return { kind: "prefix", context: `known secret-prefix pattern, ${prefixMatch[0].length} chars` };
  ASSIGNED_SECRET.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ASSIGNED_SECRET.exec(text)) !== null) {
    if (m[2] !== undefined && looksLikeSecretValue(m[2])) {
      return { kind: "assigned", context: `key-shaped field "${m[1]}", value ${m[2].length} chars` };
    }
  }
  for (const token of text.split(/[\s"';,]+/)) {
    if (highEntropyToken(token)) {
      return { kind: "entropy", context: `bare high-entropy token, ${token.length} chars` };
    }
  }
  return null;
}

export function containsSecret(text: string): boolean {
  return findSecret(text) !== null;
}

/** Applied to EVERY receipt, log line, trace and ledger event before storage. */
export function redact(text: string): string {
  if (!text) return text;
  let out = text.replace(SECRET_PREFIX, (m) => `<redacted:${m.length}-char secret detected>`);
  out = out.replace(ASSIGNED_SECRET, (full, key: string, value: string) =>
    looksLikeSecretValue(value) ? `${key}=<redacted:${value.length}-char secret detected>` : full);
  return out
    .split(/(\s+)/)
    .map((t) => (highEntropyToken(t) ? `<redacted:${t.length}-char secret detected>` : t))
    .join("");
}

export function redactDeep<T>(value: T): T {
  return JSON.parse(redact(JSON.stringify(value ?? null))) as T;
}

/** Observed, never declared: does this text try to give the agent new instructions? */
export function looksLikeInjection(text: string): boolean {
  return INJECTION_PATTERNS.some((r) => r.test(text));
}

/* ────────────────────────────── paths ────────────────────────────── */

export function insideWorkspace(root: string, target: string): boolean {
  const r = path.resolve(root);
  const t = path.resolve(r, target);
  return t === r || t.startsWith(r + path.sep);
}

export function isGlob(p: string): boolean { return /[*?]/.test(p); }

export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") { re += ".*"; i++; if (glob[i + 1] === "/") i++; }
      else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += (c ?? "").replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + re + "$");
}

export function resolveGlob(glob: string, files: readonly string[]): string[] {
  if (!isGlob(glob)) return [glob];
  const re = globToRegExp(glob);
  return files.filter((f) => re.test(f));
}

export function isCredentialPath(p: string): boolean {
  return CREDENTIAL_PATH_PATTERNS.some((r) => r.test(p));
}
export function isPlatformPath(p: string): boolean {
  return PLATFORM_PATH_PATTERNS.some((r) => r.test(p));
}

/**
 * A glob has no basename to classify: path.basename("test/**") is "**", which has
 * no extension and so fell through to UNKNOWN_PATH -- scoring an ordinary source
 * directory as sensitively as a path outside the workspace. An ANCHORED glob has
 * a literal directory prefix, so its sensitivity IS knowable; an unanchored one
 * could match anything and stays UNKNOWN_PATH.
 */
function classifyGlobTarget(p: string, base: string): number {
  const prefix = p.slice(0, p.length - base.length);
  const literalPrefix = prefix.replace(/[\\/]+$/, "");
  if (literalPrefix === "" || isGlob(literalPrefix)) return A2.UNKNOWN_PATH;
  if (/(^|[\\/])\.[A-Za-z]/.test(literalPrefix)) return A2.DOTFILE;
  if (prefix.includes(".github/")) return A2.BUILD_CI;
  if (/\.(json|ya?ml|toml|ini)$/.test(base)) return A2.CONFIG;
  return A2.SOURCE;
}

function classifyTarget(p: string, policy: StandingPolicy): number {
  if (!insideWorkspace(policy.workspaceRoot, p)) return A2.OUTSIDE_WORKSPACE;
  const base = path.basename(p);
  if (isGlob(base)) return classifyGlobTarget(path.normalize(p), base);
  if (/^\.[A-Za-z]/.test(base)) return A2.DOTFILE;
  if (/^(Dockerfile|Makefile)$/.test(base) || p.includes(".github/")) return A2.BUILD_CI;
  if (/^(package(-lock)?\.json|yarn\.lock|pnpm-lock\.yaml|requirements\.txt)$/.test(base)) return A2.DEPENDENCY;
  if (/\.(json|ya?ml|toml|ini)$/.test(base)) return A2.CONFIG;
  if (/\.[A-Za-z0-9]+$/.test(base)) return A2.SOURCE;
  return A2.UNKNOWN_PATH;
}

/* ─────────────────────────── fingerprint ─────────────────────────── */

function stable(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
  if (value !== null && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return "{" + Object.keys(o).sort().map((k) => JSON.stringify(k) + ":" + stable(o[k])).join(",") + "}";
  }
  return JSON.stringify(value ?? null);
}

/** Hash the NORMALISED capability — never the prompt text, which the attacker controls. */
export function fingerprint(c: Capability, policy: StandingPolicy): string {
  const norm = {
    op: c.op,
    host: c.host ? c.host.toLowerCase() : null,
    dataClass: c.dataClass ?? "none",
    command: c.command ? (c.command.trim().split(/\s+/)[0] ?? null) : null,
    paths: (c.paths ?? [])
      .map((p) => (insideWorkspace(policy.workspaceRoot, p) ? "IN:" : "OUT:") + path.normalize(p))
      .sort(),
  };
  return createHash("sha256").update(stable(norm)).digest("hex").slice(0, 16);
}

/* ─────────────────────────── hard rules ─────────────────────────── */

function hardRule(c: Capability, policy: StandingPolicy, ctx: RunContext): string | null {
  const allPaths = [...(c.paths ?? []), ...(c.payloadPaths ?? [])];
  for (const p of allPaths) {
    if (path.normalize(p) === path.normalize(ctx.canaryRelPath)) return HARD.CANARY;
    if (isCredentialPath(p)) return HARD.CREDENTIAL_PATH;
    if (isPlatformPath(p)) return HARD.PLATFORM_PATH;
  }
  if (c.op === "FS_DELETE") {
    for (const p of c.paths ?? []) {
      if (!insideWorkspace(policy.workspaceRoot, p)) return HARD.DELETE_OUTSIDE;
    }
  }
  if (c.op === "FS_WRITE" || c.op === "FS_DELETE") {
    for (const p of c.paths ?? []) {
      if (path.basename(path.normalize(p)) === JOURNAL_REL_PATH) return HARD.JOURNAL_WRITE;
    }
  }
  if (c.op === "EXEC" && c.command) {
    if (/(curl|wget)[^|]*\|\s*(sh|bash|zsh|python\d?|node|perl|ruby)/i.test(c.command)) return HARD.PIPE_INTERPRETER;
    if (/(^|\s)(rm|mv|cp|tee)\s+[^|]*(codex-home|launchpad\.json|\.heimdall)/i.test(c.command)) return HARD.RUNTIME_MODIFY;
  }
  if (c.op === "NET_WRITE") {
    for (const p of c.payloadPaths ?? []) {
      if (!insideWorkspace(policy.workspaceRoot, p)) return HARD.EGRESS_EXTERNAL_FILE;
      const sample = ctx.payloadSamples[p];
      if (sample !== undefined && containsSecret(sample)) return HARD.EGRESS_CREDENTIAL;
    }
  }
  const fp = fingerprint(c, policy);
  const denied = ctx.precedents.some(
    (p) => p.fingerprint === fp && p.agentId === ctx.agentId && p.decision === "denied");
  if (denied) return HARD.PRIOR_DENIAL;
  return null;
}

/* ──────────────────────────── scoring ──────────────────────────── */

export function tierFor(points: number): Tier {
  for (const b of BANDS) if (points <= b.max) return b.tier;
  return "T4";
}

const KNOWN_OPS = new Set<string>([
  "FS_READ", "FS_WRITE", "FS_DELETE", "EXEC", "NET_READ", "NET_WRITE", "ENV_READ", "PROC_SPAWN",
]);

function describe(c: Capability): string {
  if (c.op === "EXEC") return `run \`${c.command ?? ""}\``;
  if (c.op === "NET_READ") return `fetch from ${c.host ?? ""}`;
  if (c.op === "NET_WRITE") return `send ${c.dataClass ?? "data"} to ${c.host ?? ""}`;
  if (c.op === "ENV_READ") return "read environment variables";
  if (c.op === "PROC_SPAWN") return "start a background process";
  const paths = c.paths ?? [];
  const verb = c.op === "FS_READ" ? "read" : c.op === "FS_WRITE" ? "modify" : "delete";
  return `${verb} ${paths.length} path(s): ${paths.slice(0, 3).join(", ")}${paths.length > 3 ? "…" : ""}`;
}

export function scoreCapability(
  c: Capability, policy: StandingPolicy, ctx: RunContext,
): CapabilityVerdict {
  const fp = fingerprint(c, policy);
  const target = c.host ?? c.command ?? ((c.paths ?? []).join(", ") || "-");
  const summary = describe(c);

  const hard = hardRule(c, policy, ctx);
  if (hard !== null) {
    return {
      fingerprint: fp, op: c.op, target, score: null, tier: "T4", hardRule: hard,
      receipt: [{ axis: "hard-rule", pts: 0, why: hard }],
      resolvedBy: null, narrowedTo: null, summary,
    };
  }

  const receipt: ReceiptLine[] = [];
  let points = 0;
  const add = (axis: string, pts: number, why: string): void => {
    if (pts !== 0) receipt.push({ axis, pts, why });
    points += pts;
  };

  // axis 1 — operation class
  const paths = c.paths ?? [];
  const allIn = paths.every((p) => insideWorkspace(policy.workspaceRoot, p));
  const hostAllowed = c.host !== undefined && policy.allowedHosts.includes(c.host.toLowerCase());
  if (!KNOWN_OPS.has(c.op)) {
    add("operation", A1.UNKNOWN_OP, `unrecognised operation "${c.op}" — fail-safe`);
  } else if (c.op === "FS_READ") {
    add("operation", allIn ? A1.FS_READ_IN : A1.FS_READ_OUT, allIn ? "read inside workspace" : "read OUTSIDE workspace");
  } else if (c.op === "FS_WRITE") {
    add("operation", allIn ? A1.FS_WRITE_IN : A1.FS_WRITE_OUT, allIn ? "write inside workspace" : "write OUTSIDE workspace");
  } else if (c.op === "FS_DELETE") {
    add("operation", A1.FS_DELETE_IN, "delete inside workspace");
  } else if (c.op === "EXEC") {
    const bin = (c.command ?? "").trim().split(/\s+/)[0] ?? "";
    if (policy.allowedCommands.includes(bin)) add("operation", A1.EXEC_ALLOWLISTED, `allowlisted command "${bin}"`);
    else if (/^(npm|pnpm|yarn|pip|pip3|gem|cargo)$/.test(bin) && /\b(i|install|add)\b/.test(c.command ?? ""))
      add("operation", A1.EXEC_INSTALL, "package install");
    else add("operation", A1.EXEC_OTHER, `non-allowlisted binary "${bin}"`);
  } else if (c.op === "NET_READ") {
    add("operation", hostAllowed ? A1.NET_READ_ALLOWED : A1.NET_READ_NEW,
      hostAllowed ? "network read, allowlisted host" : "network read, host NOT in allowlist");
  } else if (c.op === "NET_WRITE") {
    add("operation", hostAllowed ? A1.NET_WRITE_ALLOWED : A1.NET_WRITE_NEW,
      hostAllowed ? "network write, allowlisted host" : "network write, host NOT in allowlist");
  } else if (c.op === "ENV_READ") {
    add("operation", A1.ENV_READ, "reads environment variables");
  } else if (c.op === "PROC_SPAWN") {
    add("operation", A1.PROC_SPAWN, "starts a background process");
  }

  // axis 2 — target sensitivity (worst path wins)
  if (paths.length > 0) {
    let worst = -1; let which = "";
    for (const p of paths) { const s = classifyTarget(p, policy); if (s > worst) { worst = s; which = p; } }
    add("target", worst, `target sensitivity (${which})`);
  }

  // axis 3 — reversibility
  // A GET changes nothing outside the workspace: only writes and spawned processes
  // are irreversible external effects. (Calibration fix — caught by the benign-run control.)
  if (c.op === "NET_WRITE" || c.op === "PROC_SPAWN") {
    add("reversibility", A3.IRREVERSIBLE_EXTERNAL, "irreversible external effect");
  } else if (c.op === "FS_DELETE") {
    add("reversibility", A3.IRREVERSIBLE_LOCAL, "irreversible local change");
  } else if (c.op === "FS_WRITE") {
    const tracked = paths.length > 0 && paths.every((p) => ctx.gitTrackedPaths.includes(p));
    add("reversibility", tracked ? A3.REVERSIBLE_TRACKED : A3.NEW_UNTRACKED,
      tracked ? "reversible (git-tracked, snapshot available)" : "creates untracked file");
  }

  // axis 4 — blast radius
  if (paths.length > 0) {
    const n = paths.reduce((a, p) => a + resolveGlob(p, ctx.workspaceFiles).length, 0);
    let b = n <= 3 ? A4.N_1_3 : n <= 10 ? A4.N_4_10 : n <= 50 ? A4.N_11_50 : A4.N_51_PLUS;
    // A glob is not bounded by what it matches TODAY -- the run may create files
    // under it -- so it never scores the smallest band. Treating "matches
    // nothing" as UNBOUNDED was inverted: it made writing into a new directory,
    // the commonest benign shape, score higher than ** over an existing tree,
    // pushing an ordinary "add a test" run to T4 and denying it outright.
    const hasGlob = paths.some(isGlob);
    if (hasGlob && b < A4.N_4_10) b = A4.N_4_10;
    add("blast", b, `scope: ${n} file(s)${hasGlob ? " matched now; glob may grow" : ""}`);
  }

  // axis 5 — egress class
  if (c.op === "NET_WRITE") {
    const dc = c.dataClass ?? "undeclared";
    add("egress", A5[dc] ?? A5.undeclared ?? 5, `payload class: ${dc}`);
  }

  // axis 6 — context (all OBSERVED by Heimdall)
  if (ctx.taint === "workspace") add("context", A6.TAINT_WORKSPACE, `untrusted content read (${ctx.taintSource ?? "workspace"})`);
  if (ctx.taint === "external") add("context", A6.TAINT_EXTERNAL, `untrusted content read from outside workspace (${ctx.taintSource ?? "?"})`);
  const seen = ctx.precedents.some((p) => p.fingerprint === fp && p.agentId === ctx.agentId);
  if (!seen) add("context", A6.NOVEL_FINGERPRINT, "capability not seen before");
  if (ctx.completedRuns < 5) add("context", A6.YOUNG_AGENT, "agent has fewer than 5 completed runs");

  // discounts — never below zero, never clear a hard rule
  if (c.host !== undefined && c.dataClass !== undefined) {
    const host = c.host.toLowerCase();
    if (policy.standingGrants.some((g) => g.host.toLowerCase() === host && g.dataClass === c.dataClass)) {
      add("discount", DISCOUNTS.STANDING_GRANT, `(${c.host}, ${c.dataClass}) pre-authorised in standing policy`);
    }
  }
  if (hasValidPrecedent(fp, ctx)) {
    add("discount", DISCOUNTS.PRECEDENT_APPROVED, "human-approved precedent (exact match, unexpired)");
  }
  if (paths.length > 0 && paths.every((p) => ctx.gitIgnoredPaths.some((g) => p.startsWith(g)))) {
    add("discount", DISCOUNTS.GIT_IGNORED, "target is a git-ignored build artifact");
  }

  points = Math.max(0, points);
  return {
    fingerprint: fp, op: c.op, target, score: points, tier: tierFor(points),
    hardRule: null, receipt, resolvedBy: null, narrowedTo: null, summary,
  };
}

function hasValidPrecedent(fp: string, ctx: RunContext): boolean {
  const now = Date.now();
  return ctx.precedents.some(
    (p) => p.fingerprint === fp && p.agentId === ctx.agentId && p.decision === "approved" &&
      p.termSheetVersion === TERM_SHEET_VERSION && (p.expiresAt === null || p.expiresAt > now));
}

/* ─────────────── conditional resolver — the T2 band ─────────────── */

export function resolveConditional(
  verdict: CapabilityVerdict, c: Capability, policy: StandingPolicy, ctx: RunContext,
): CapabilityVerdict {
  if (verdict.tier !== "T2") return verdict;

  // R1 — exact human-approved precedent
  if (hasValidPrecedent(verdict.fingerprint, ctx)) {
    return { ...verdict, tier: "T1", resolvedBy: "R1 precedent (human-approved before)" };
  }
  // R2 — standing grant
  if (c.host !== undefined && c.dataClass !== undefined) {
    const host = c.host.toLowerCase();
    if (policy.standingGrants.some((g) => g.host.toLowerCase() === host && g.dataClass === c.dataClass)) {
      return { ...verdict, tier: "T1", resolvedBy: "R2 standing grant" };
    }
  }
  // R6 — taint escalates BEFORE any remaining allow rule can fire
  if (ctx.taint !== "none") {
    return { ...verdict, tier: "T3", resolvedBy: "R6 untrusted content in context — escalated" };
  }
  // R3 — reversible via snapshot
  const paths = c.paths ?? [];
  if (c.op === "FS_WRITE" && paths.length > 0 && paths.every((p) => insideWorkspace(policy.workspaceRoot, p))) {
    return { ...verdict, tier: "T1", resolvedBy: "R3 auto-snapshot taken before write" };
  }
  // R4 — counter-offer: grant the concrete resolved set instead of the glob
  if (paths.some(isGlob)) {
    const concrete = [...new Set(paths.flatMap((p) => resolveGlob(p, ctx.workspaceFiles)))]
      .filter((p) => insideWorkspace(policy.workspaceRoot, p));
    if (concrete.length > 0 && concrete.length <= policy.maxNarrowPaths) {
      return { ...verdict, tier: "T1", resolvedBy: `R4 narrowed to ${concrete.length} concrete path(s)`, narrowedTo: concrete };
    }
  }
  // R5 — payload inspected and clean
  if (c.op === "NET_WRITE" && (c.payloadPaths ?? []).length > 0) {
    const joined = (c.payloadPaths ?? []).map((p) => ctx.payloadSamples[p] ?? "").join("\n");
    if (joined.trim() !== "" && !containsSecret(joined)) {
      return { ...verdict, tier: "T1", resolvedBy: "R5 payload inspected, no credentials found" };
    }
  }
  // DEFAULT — nothing resolved it. Escalate. NEVER allow.
  return { ...verdict, tier: "T3", resolvedBy: "default — no rule resolved this, escalated to human" };
}

/* ──────────────────────────── permit ──────────────────────────── */

/**
 * Binds a decision to the EXACT capability set it was made about.
 * Without this, a human approves "write src/app.ts" and the granted set could be
 * mutated before execution. Recomputed immediately before the container is built;
 * any drift between approval and execution fails closed.
 */
export function permitHash(p: Pick<Permit,
  "grantedWrites" | "grantedReads" | "grantedHosts" | "grantedCommands" | "runId" | "agentId">): string {
  return createHash("sha256").update(stable({
    runId: p.runId, agentId: p.agentId,
    writes: [...p.grantedWrites].sort(), reads: [...p.grantedReads].sort(),
    hosts: [...p.grantedHosts].sort(), commands: [...p.grantedCommands].sort(),
  })).digest("hex").slice(0, 32);
}

export class PermitIntegrityError extends Error {
  constructor(message: string) { super(message); this.name = "PermitIntegrityError"; }
}

/** Called immediately before the container is built. Fails closed on any drift. */
export function verifyPermitIntegrity(permit: Permit): void {
  const actual = permitHash(permit);
  if (actual !== permit.requestHash) {
    throw new PermitIntegrityError(
      "HEIMDALL: permit was modified after it was issued (expected " +
      permit.requestHash.slice(0, 12) + ", got " + actual.slice(0, 12) + ")");
  }
  if (permit.approvedHash !== null && permit.approvedHash !== actual) {
    throw new PermitIntegrityError(
      "HEIMDALL: the granted capability set no longer matches what the operator approved");
  }
}

const RANK: Record<Tier, number> = { T0: 0, T1: 1, T2: 2, T3: 3, T4: 4 };

export function buildPermit(
  manifest: Manifest, policy: StandingPolicy, ctx: RunContext,
): Permit {
  const verdicts: CapabilityVerdict[] = manifest.capabilities.map((c) =>
    resolveConditional(scoreCapability(c, policy, ctx), c, policy, ctx));

  if (manifest.maxDurationMs > policy.maxDurationMs) {
    verdicts.push({
      fingerprint: "duration", op: "EXEC", target: `maxDurationMs=${manifest.maxDurationMs}`,
      score: null, tier: "T4", hardRule: HARD.DURATION,
      receipt: [{ axis: "window", pts: 0, why: `requested ${manifest.maxDurationMs}ms > allowed ${policy.maxDurationMs}ms` }],
      resolvedBy: null, narrowedTo: null, summary: "run longer than the standing maximum",
    });
  }

  let runTier: Tier = "T0";
  for (const v of verdicts) if (RANK[v.tier] > RANK[runTier]) runTier = v.tier;

  const grantedWrites: string[] = [], grantedReads: string[] = [];
  const grantedHosts: string[] = [], grantedCommands: string[] = [];

  manifest.capabilities.forEach((c, i) => {
    const v = verdicts[i];
    if (v === undefined) return;
    if (v.tier !== "T0" && v.tier !== "T1") return;   // only granted tiers open doors
    const p = v.narrowedTo ?? c.paths ?? [];
    if (c.op === "FS_WRITE" || c.op === "FS_DELETE") grantedWrites.push(...p);
    if (c.op === "FS_READ") grantedReads.push(...p);
    if (c.host !== undefined) grantedHosts.push(c.host.toLowerCase());
    if (c.op === "EXEC" && c.command !== undefined) grantedCommands.push(c.command);
  });

  const granted = {
    runId: ctx.runId, agentId: ctx.agentId,
    grantedWrites: [...new Set(grantedWrites)], grantedReads: [...new Set(grantedReads)],
    grantedHosts: [...new Set(grantedHosts)], grantedCommands: [...new Set(grantedCommands)],
  };
  return {
    permitId: "prm_" + randomUUID().replace(/-/g, "").slice(0, 12),
    runId: ctx.runId, agentId: ctx.agentId, termSheetVersion: TERM_SHEET_VERSION,
    runTier, summary: manifest.summary, verdicts,
    grantedWrites: granted.grantedWrites,
    grantedReads: granted.grantedReads,
    grantedHosts: granted.grantedHosts,
    grantedCommands: granted.grantedCommands,
    expiresAt: Date.now() + Math.min(manifest.maxDurationMs, policy.maxDurationMs),
    requiresHumanApproval: runTier === "T3",
    denied: runTier === "T4",
    createdAt: new Date().toISOString(),
    requestHash: permitHash(granted),
    approvedHash: null,
    capabilityToken: randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, ""),
  };
}

/** Applied after a human approves: the approved verdicts become granted. */
/**
 * A permit's window is a DELEGATION window: it should run from the moment the
 * delegation takes effect, not from when it was drafted. While a permit sits
 * awaiting a human, the clock was still running — an operator who took a few
 * minutes to approve handed the run a permit that was already most of the way
 * expired, and the container was then killed almost immediately (or the model
 * connection died mid-run with P-09 egress denials).
 *
 * The window is re-based on approval, never lengthened beyond what the manifest
 * and the standing policy already allow.
 */
export function applyApproval(permit: Permit, manifest: Manifest, windowMs?: number): Permit {
  const writes = [...permit.grantedWrites], reads = [...permit.grantedReads];
  const hosts = [...permit.grantedHosts], commands = [...permit.grantedCommands];
  manifest.capabilities.forEach((c, i) => {
    const v = permit.verdicts[i];
    if (v === undefined || v.tier !== "T3") return;
    const p = v.narrowedTo ?? c.paths ?? [];
    if (c.op === "FS_WRITE" || c.op === "FS_DELETE") writes.push(...p);
    if (c.op === "FS_READ") reads.push(...p);
    if (c.host !== undefined) hosts.push(c.host.toLowerCase());
    if (c.op === "EXEC" && c.command !== undefined) commands.push(c.command);
  });
  const next: Permit = {
    ...permit,
    grantedWrites: [...new Set(writes)], grantedReads: [...new Set(reads)],
    grantedHosts: [...new Set(hosts)], grantedCommands: [...new Set(commands)],
    requiresHumanApproval: false,
    ...(windowMs !== undefined && windowMs > 0
      ? { expiresAt: Date.now() + Math.min(windowMs, manifest.maxDurationMs) }
      : {}),
  };
  const hash = permitHash(next);
  return { ...next, requestHash: hash, approvedHash: hash };
}
