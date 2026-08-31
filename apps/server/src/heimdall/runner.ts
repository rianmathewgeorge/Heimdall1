/**
 * HEIMDALL — the AgentRunner wrapper. This is the whole loop.
 *
 *   recon (read-only)  ->  manifest  ->  score  ->  resolve  ->  permit
 *   ->  container built FROM the permit  ->  broker on every action
 *   ->  reconcile declared vs actual  ->  ledger + precedent + journal
 *
 * Integrates at the AgentRunner seam, so app.ts and agent-service.ts are untouched.
 */
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { activeProvider, writeProxiedCodexConfig, type AppConfig } from "../config.js";
import { buildCodexArgs, parseCodexEventLine, type ParsedEvents } from "../codex-runner.js";
import { CONTAINER_WORKSPACE_ROOT } from "../constants.js";
import { RunCancelledError, RuntimeExitError } from "../errors.js";
import type { AgentRunner, RunEventEmitter, RunnerRequest, RunnerResult } from "../types.js";
import {
  buildHeimdallProxyRunArgs, buildHeimdallRunArgs, checkAction, observeEvents, PROXY_SIDECAR_PORT,
  reconcile, type HeimdallRuntimeConfig,
} from "./broker.js";
import { applyApproval, buildPermit, looksLikeInjection, permitHash, redact } from "./engine.js";
import { ManifestError, parseManifest, reconPrompt } from "./manifest.js";
import { plan } from "./planner.js";
import { DENIAL_MARKER, READY_MARKER } from "./proxy-standalone-markers.js";
import {
  appendJournal, CANARY_REL_PATH, loadPolicy, log, plantCanary, readJournal, HeimdallStore,
} from "./store.js";
import type { Denial, Manifest, Permit, RunContext, RunRecord, StandingPolicy } from "./types.js";

const execFileAsync = promisify(execFile);

export interface HeimdallOptions {
  enabled: boolean;
  policyDir: string;
  /** the isolated network agent containers run on — no route out except the proxy sidecar */
  network: string;
  /** a normal, non-internal network — the proxy sidecar's only route to the internet */
  egressNetwork: string;
  approvalTimeoutMs: number;
  /** false (default) = fail closed when recon fails. true = degrade to standing policy. */
  degradedFallback: boolean;
  /**
   * true (default) = plan by calling the provider directly instead of booting a
   * Codex container for recon. Roughly a third of the tokens and none of the
   * boot latency; the container path still runs if it fails. Set
   * HEIMDALL_DIRECT_PLANNER=off to always use the container.
   */
  directPlanner: boolean;
  /** how long recon may take before it fails over or the run degrades */
  reconTimeoutMs: number;
}

interface Pending {
  permit: Permit;
  manifest: Manifest;
  resolve(decision: "approved" | "denied", by: string): void;
}

/**
 * A recon permit grants the provider host and NOTHING else, so
 * buildHeimdallRunArgs mounts the workspace read-only. Codex's own
 * `--sandbox read-only` relies on Landlock, which is unavailable on some
 * hosts (macOS Docker among them) — the mount is enforcement that does not
 * depend on it. Recon provably cannot write, whatever the sandbox reports.
 *
 * requestHash must be a real permitHash of the granted set: buildHeimdallRunArgs
 * calls verifyPermitIntegrity on every permit it launches a container from,
 * recon included, so a placeholder hash here fails closed before recon can run.
 */
export function buildReconPermit(config: AppConfig, runId: string, agentId: string): Permit {
  const provider = activeProvider(config);
  const host = new URL(provider.baseUrl).hostname.toLowerCase();
  const grantedWrites: string[] = [], grantedReads: string[] = [];
  const grantedHosts = [host], grantedCommands: string[] = [];
  return {
    permitId: "prm_recon", runId, agentId, termSheetVersion: "recon",
    runTier: "T0", summary: "reconnaissance (read-only)", verdicts: [],
    grantedWrites, grantedReads, grantedHosts, grantedCommands,
    expiresAt: Date.now() + Math.min(config.codexTimeoutMs, 300_000),
    requiresHumanApproval: false, denied: false,
    createdAt: new Date().toISOString(),
    requestHash: permitHash({ runId, agentId, grantedWrites, grantedReads, grantedHosts, grantedCommands }),
    approvedHash: null,
    capabilityToken: randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, ""),
  };
}

/**
 * The container's only route out (the egress proxy) enforces grantedHosts
 * against EVERY outbound host, including Codex's own calls to the model
 * backend — not just capabilities the manifest declares. buildReconPermit
 * grants this host explicitly for recon; the real execution permit needs the
 * same grant, or its own inference traffic gets denied by the same rule
 * recon was built to avoid (P-07).
 */
/**
 * A runtime that cannot start at all is not a planning failure, and must not be
 * reported as one. Without this the operator was told "recon did not produce a
 * valid manifest — execution refused", which is true but useless: the actual
 * cause was that the `codex` binary does not exist on the host. Name it.
 */
export function explainRuntimeFailure(message: string, runtimeProvider: string, codexBin: string): string | null {
  const missingBinary = message.includes("ENOENT") || /spawn .* ENOENT/.test(message);
  if (!missingBinary) return null;
  if (runtimeProvider === "container") {
    return `the container engine could not be started (${message}). Is Docker running?`;
  }
  return (
    `the "${codexBin}" binary is not installed on this host, so RUNTIME_PROVIDER=local-process cannot run anything.\n` +
    "  Run the containerised runtime instead:  npm run poc\n" +
    `  ...or install Codex on the host:        npm i -g @openai/codex`
  );
}

export function grantProviderHost(permit: Permit, config: AppConfig): Permit {
  const host = new URL(activeProvider(config).baseUrl).hostname.toLowerCase();
  if (permit.grantedHosts.includes(host)) return permit;
  const next: Permit = { ...permit, grantedHosts: [...permit.grantedHosts, host] };
  return { ...next, requestHash: permitHash(next) };
}

interface ActiveRun {
  name: string;
  proxyName: string | null;
  killed: boolean;
  /**
   * An operator cancellation, which tears the containers down the same way a
   * denial does. Kept separate because reporting a cancel as "a blocked action
   * was attempted" is not just confusing in the UI — it counts the run as
   * CONTAINED in the metrics, inflating the security numbers with user actions.
   */
  cancelled: boolean;
  emit: RunEventEmitter;
}


/* ─────────── workspace snapshot, for truthful reconciliation ─────────── */

/** Files the run never authored, so a diff must ignore them. */
const SNAPSHOT_IGNORED = new Set(["error.txt", CANARY_REL_PATH]);

async function snapshotWorkspace(
  root: string, prefix = "", depth = 0, out = new Map<string, number>(),
): Promise<Map<string, number>> {
  if (depth > 6 || out.size > 5000) return out;
  let entries;
  try { entries = await readdir(path.join(root, prefix), { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === ".git" || e.name === "dist") continue;
    const rel = prefix ? path.posix.join(prefix, e.name) : e.name;
    if (e.isDirectory()) await snapshotWorkspace(root, rel, depth + 1, out);
    else if (e.isFile()) {
      try { out.set(rel, (await stat(path.join(root, rel))).mtimeMs); } catch { /* vanished */ }
    }
  }
  return out;
}

/** Paths created or modified since the snapshot, relative to the workspace. */
async function changedSince(root: string, before: Map<string, number>): Promise<string[]> {
  const after = await snapshotWorkspace(root);
  const changed: string[] = [];
  for (const [rel, mtime] of after) {
    if (SNAPSHOT_IGNORED.has(rel)) continue;
    const previous = before.get(rel);
    if (previous === undefined || previous !== mtime) changed.push(rel);
  }
  return changed;
}

export class HeimdallRunner implements AgentRunner {
  private readonly pending = new Map<string, Pending>();
  private readonly denials = new Map<string, Denial[]>();
  private readonly active = new Map<string, ActiveRun>();

  constructor(
    private readonly inner: AgentRunner,
    private readonly reconRunner: AgentRunner,
    private readonly config: AppConfig,
    private readonly options: HeimdallOptions,
    private readonly store: HeimdallStore,
  ) {}

  async start(): Promise<void> {
    const state = this.options.enabled ? "HEIMDALL=on" : "HEIMDALL=off — baseline runner in the path";
    log("info", "boot", state);
    if (!this.options.enabled) return;
    await this.reapOrphans();
    /*
     * Advisory only, and one of them starts a container — so they must not sit in
     * front of the server accepting requests. Awaiting them added seconds to every
     * boot (and to every test that starts a runner). Fire them off and let the
     * warnings arrive when they arrive.
     */
    void this.preflightProxyImage().catch(() => undefined);
    void this.preflightRuntimeImage().catch(() => undefined);
    void this.preflightRuntimeProvider().catch(() => undefined);
  }

  /**
   * RUNTIME_PROVIDER defaults to local-process, which needs the `codex` binary
   * ON THE HOST. `npm run poc` sets container mode; `npm start` and `npm run dev`
   * do not — so a machine without Codex installed fails on its first run with a
   * message about manifests. Check once, at boot, and say what to run.
   */
  private async preflightRuntimeProvider(): Promise<void> {
    if (this.config.runtimeProvider !== "local-process") return;
    if (await this.inner.isAvailable()) return;
    log("warn", "boot",
      `RUNTIME_PROVIDER=local-process but "${this.config.codexBin}" is not runnable on this host — ` +
      "every run will fail before it starts.\n" +
      "  Use the containerised runtime:  npm run poc\n" +
      `  ...or install Codex here:       npm i -g @openai/codex`);
  }

  /**
   * The sidecar runs a COPY of proxy.ts baked into its image, so editing the
   * proxy and restarting the server changes nothing until the image is rebuilt —
   * the server silently keeps enforcing the old code. Compare the image against
   * the newest source file and say so.
   */
  private async warnIfImageStale(image: string, builtAtMs: number): Promise<void> {
    if (!Number.isFinite(builtAtMs)) return;
    const dir = path.resolve(fileURLToPath(new URL(".", import.meta.url)));
    let newest = 0;
    try {
      for (const entry of await readdir(dir)) {
        if (!entry.endsWith(".ts") || entry.includes(".test.")) continue;
        newest = Math.max(newest, (await stat(path.join(dir, entry))).mtimeMs);
      }
    } catch { return; }
    if (newest > builtAtMs) {
      log("warn", "boot",
        `image "${image}" was built before the current proxy source — it is running OLD code. ` +
        `Rebuild with: ${this.config.containerEngine} build --file Dockerfile.proxy --tag ${image} .`);
    }
  }

  /**
   * A runtime image built before the writable-CODEX_HOME change has no
   * /codex-home-rw, and Codex then dies with "Error finding codex home: ...
   * that path does not exist" — a message that says nothing about the image
   * being stale. Since --rm removes the corpse immediately, `docker ps -a` shows
   * nothing either. Check the one directory the run args depend on and name the
   * rebuild command.
   */
  private async preflightRuntimeImage(): Promise<void> {
    const image = this.config.containerRuntimeImage;
    try {
      await execFileAsync(this.config.containerEngine,
        ["run", "--rm", "--entrypoint", "sh", image, "-c", "test -d /codex-home-rw"], { timeout: 30_000 });
    } catch {
      log("warn", "boot",
        `runtime image "${image}" is missing or predates the writable CODEX_HOME layout — ` +
        "Codex will fail with \"Error finding codex home\" and the container is removed before you can see it. " +
        `Rebuild with: ${this.config.containerEngine} build --file Dockerfile.runtime --tag ${image} .  ` +
        "(npm run poc does this for you.)");
    }
  }

  /**
   * The sidecar image must exist BEFORE a run starts. When it does not, the
   * `docker run` fails at image resolution, so no container is ever created and
   * nothing appears in `docker ps -a` — which reads exactly like "the sidecar
   * silently refuses to start" and is very hard to diagnose from the run error.
   * Say it once, at boot, with the command that fixes it.
   */
  private async preflightProxyImage(): Promise<void> {
    const image = this.config.containerProxyImage;
    try {
      const { stdout } = await execFileAsync(this.config.containerEngine,
        ["image", "inspect", "-f", "{{.Created}}", image], { timeout: 10_000 });
      await this.warnIfImageStale(image, Date.parse(stdout.trim()));
      return;
    } catch {
      log("warn", "boot",
        `egress proxy image "${image}" is not present — every run will fail before its sidecar starts. ` +
        `Build it with: ${this.config.containerEngine} build --file Dockerfile.proxy --tag ${image} .  ` +
        "(npm run poc does this for you.)");
    }
  }

  /**
   * A crashed or killed server leaves its per-run containers running: they are
   * started detached and only removed on the run's own teardown path. Reaping by
   * label at boot keeps a previous crash from leaking sidecars that still hold a
   * provider key.
   */
  private async reapOrphans(): Promise<void> {
    // io.warrant.* is the pre-rename label: a container left by a build from
    // before the rename would otherwise never be reaped, and a stale sidecar
    // still holds a provider key.
    for (const label of ["io.heimdall.proxy", "io.heimdall.run", "io.warrant.proxy", "io.warrant.run"]) {
      try {
        const { stdout } = await execFileAsync(this.config.containerEngine,
          ["ps", "-aq", "--filter", "label=" + label], { timeout: 10_000 });
        const ids = stdout.split(/\s+/).filter(Boolean);
        if (ids.length === 0) continue;
        await execFileAsync(this.config.containerEngine, ["rm", "--force", ...ids], { timeout: 20_000 });
        log("info", "boot", `removed ${ids.length} orphaned container(s) from a previous run`);
      } catch { /* nothing to reap, or the engine is unavailable */ }
    }
  }

  async stop(): Promise<void> {
    // Containers outlive the process unless we remove them; a Ctrl-C mid-run
    // otherwise leaves a sidecar holding the provider key.
    if (!this.options.enabled) return;
    await this.reapOrphans();
  }

  isAvailable(): Promise<boolean> { return this.inner.isAvailable(); }

  async cancel(agentId: string): Promise<boolean> {
    const entry = this.active.get(agentId);
    if (entry !== undefined) {
      entry.cancelled = true;
      entry.killed = true;
      entry.emit({
        stage: "codex",
        severity: "warn",
        message: "Cancelling run — removing containers",
        data: { containerName: entry.name },
      });
      await this.removeContainer(entry.name);
      if (entry.proxyName !== null) await this.removeContainer(entry.proxyName);
      return true;
    }
    return this.inner.cancel(agentId);
  }

  /* ─────────────────────── approval surface ─────────────────────── */

  pendingPermits(): Permit[] { return [...this.pending.values()].map((p) => p.permit); }
  pendingFor(runId: string): Permit | null { return this.pending.get(runId)?.permit ?? null; }

  decide(runId: string, decision: "approved" | "denied", by: string): boolean {
    const entry = this.pending.get(runId);
    if (entry === undefined) return false;
    entry.resolve(decision, by);
    return true;
  }

  private recordDenial(runId: string, denial: Denial): void {
    const list = this.denials.get(runId) ?? [];
    list.push(denial);
    this.denials.set(runId, list);
    void this.store.append(runId, "-", "denial", { ...denial });
  }

  /* ──────────────────────────── run ──────────────────────────── */

  async run(request: RunnerRequest): Promise<RunnerResult> {
    if (!this.options.enabled) return this.inner.run(request);

    const runId = request.agentId + "-" + Date.now().toString(36);
    const started = Date.now();
    this.denials.set(runId, []);
    const originalEmit = request.emit;
    const emit: RunEventEmitter = (event) => originalEmit({ ...event, heimdallRunId: runId });
    request = { ...request, emit };

    const record: RunRecord = {
      runId, agentId: request.agentId, createdAt: new Date().toISOString(),
      prompt: redact(request.prompt).slice(0, 2000),
      manifest: null, manifestError: null, permit: null,
      denials: [], divergences: [], actual: [],
      approval: { required: false, decidedBy: null, decision: null, at: null },
      reconMs: 0, execMs: 0, outcome: "failed", degraded: false,
      attribution: request.attribution ?? null,
    };

    /** Advisory notes for the next recon. Written exactly once, on every path. */
    let journalled = false;
    const journalDenials = async (): Promise<void> => {
      if (journalled) return;
      journalled = true;
      for (const d of this.denials.get(runId) ?? []) {
        if (d.platform === true) continue;   // runtime phone-home is not the agent's business
        await appendJournal(request.workspacePath, runId, "denial",
          `${d.op} ${d.target} was blocked (${d.rule}: ${d.detail}). Declare it in the manifest or avoid it.`)
          .catch(() => undefined);
      }
    };

    try {
      /*
       * Attribution is the FIRST thing on the ledger, before anything can fail.
       * Written at permit time it was absent from exactly the runs an auditor
       * cares about most — the ones that never got a permit because recon or
       * policy refused them. "Who tried this" must survive the failure.
       */
      await this.store.append(runId, request.agentId, "attribution", {
        ...(request.attribution ?? { note: "no identity plane in this path" }),
      });
      await plantCanary(request.workspacePath);
      // The agent runs inside a container where the workspace is always mounted at
      // CONTAINER_WORKSPACE_ROOT (see broker.ts), so it reports capability paths
      // relative to THAT root, never the host path. Scoring must compare against
      // the same root the agent actually saw, or every FS_* capability looks like
      // it targets somewhere outside the workspace.
      const policy = await loadPolicy(this.options.policyDir, request.agentId, CONTAINER_WORKSPACE_ROOT);
      const journal = await readJournal(request.workspacePath);

      // ── 1. RECON (read-only) ─────────────────────────────────────
      log("info", runId, "recon starting (read-only)");
      emit({ stage: "recon", message: "Reconnaissance starting (read-only)" });
      const reconStart = Date.now();
      let manifest: Manifest | null = null;
      let manifestError: string | null = null;
      let manifestCause: unknown = null;

      /*
       * FAST PATH — ask the provider directly. Recon only has to read the
       * workspace and emit one JSON object; it needs no shell, so it needs no
       * container. Measured against codex-cli 0.111, a container recon attempt
       * spends ~7,600 tokens before it even states the task (~5,200 of Codex's
       * own system prompt plus ~1,400 of tool schemas that recon never calls)
       * and pays a container boot on top. This path spends ~2,300 and boots
       * nothing. The container path below still runs if this one fails, so the
       * stricter "recon provably cannot write" guarantee remains available.
       */
      if (this.options.directPlanner) {
        try {
          emit({ stage: "recon", message: "Planning (direct, no container)" });
          const planned = await plan(this.config, request.prompt, request.workspacePath, journal, {
            timeoutMs: this.options.reconTimeoutMs,
          });
          manifest = relativizeManifestPaths(planned.manifest, CONTAINER_WORKSPACE_ROOT);
          log("info", runId, `recon produced ${manifest.capabilities.length} capabilities in ${planned.ms}ms (direct)`);
        } catch (error) {
          manifestError = error instanceof ManifestError ? error.message : (error as Error).message;
          manifestCause = error;
          log("warn", runId, "direct planner failed — falling back to container recon", { reason: manifestError });
          emit({
            stage: "recon", severity: "warn",
            message: "Direct planning failed — falling back to container recon",
            data: { reason: manifestError },
          });
        }
      }

      for (let attempt = 0; attempt < 2 && manifest === null; attempt++) {
        try {
          emit({ stage: "recon", message: `Recon attempt ${attempt + 1}`, data: { attempt: attempt + 1 } });
          const suffix = attempt === 0 ? "" :
            `\n\nYour previous reply was rejected: ${manifestError ?? "invalid manifest"}. ` +
            "Fix that specific problem and reply with ONLY the corrected JSON object.";
          const permit = this.reconPermit(runId, request.agentId);
          const out: RunnerResult = this.config.runtimeProvider === "container"
            ? await this.spawnCodex(runId, {
                agentId: request.agentId, workspacePath: request.workspacePath,
                prompt: reconPrompt(request.prompt, journal) + suffix, threadId: null,
                appRunId: request.appRunId, emit,
              }, permit, "read-only", null)
            : await this.reconRunner.run({
                agentId: request.agentId, workspacePath: request.workspacePath,
                prompt: reconPrompt(request.prompt, journal) + suffix, threadId: null,
                appRunId: request.appRunId, emit,
              });
          emit({ stage: "recon", message: "Recon output received", data: { attempt: attempt + 1 } });
          manifest = parseManifest(out.output);
          manifest = relativizeManifestPaths(manifest, CONTAINER_WORKSPACE_ROOT);
        } catch (error) {
          manifestError = error instanceof ManifestError ? error.message : (error as Error).message;
          manifestCause = error;
          const explained = explainRuntimeFailure(manifestError, this.config.runtimeProvider, this.config.codexBin);
          if (explained !== null) {
            // the runtime never ran: stop retrying something that cannot work,
            // and report the cause instead of the symptom
            log("error", runId, "runtime is not runnable — " + explained);
            emit({ stage: "recon", severity: "error", message: explained });
            throw new Error("HEIMDALL: " + explained, { cause: error });
          }
          log("warn", runId, `recon attempt ${attempt + 1} failed`, { reason: manifestError });
          emit({
            stage: "manifest", severity: "warn",
            message: `Recon attempt ${attempt + 1} did not produce a valid manifest`,
            data: { attempt: attempt + 1, reason: manifestError },
          });
        }
      }
      record.reconMs = Date.now() - reconStart;
      record.manifest = manifest;
      record.manifestError = manifestError;
      if (manifest?.dropped !== undefined && manifest.dropped.length > 0) {
        log("warn", runId, "planner emitted capabilities that did not validate — they were NOT granted",
          { dropped: manifest.dropped });
        emit({
          stage: "manifest", severity: "warn",
          message: `${manifest.dropped.length} declared capability(ies) were malformed and dropped`,
          data: { dropped: manifest.dropped },
        });
      }
      await this.store.append(runId, request.agentId, "recon", {
        ok: manifest !== null, ms: record.reconMs, error: manifestError,
        dropped: manifest?.dropped ?? [],
        summary: manifest?.summary ?? null, capabilities: manifest?.capabilities.length ?? 0,
      });

      if (manifest === null) {
        if (!this.options.degradedFallback) {
          // FAIL CLOSED. No valid manifest never means "no restrictions".
          record.outcome = "denied";
          await appendJournal(request.workspacePath, runId, "failure",
            `recon did not produce a valid manifest (${manifestError ?? "unknown"}); run refused`);
          await this.store.saveRun(record);
          log("deny", runId, "fail-closed: no valid manifest, execution refused");
          emit({
            stage: "manifest", severity: "error",
            message: "Recon did not produce a valid manifest — execution refused (fail closed)",
            data: { reason: manifestError },
          });
          throw new Error("HEIMDALL: recon did not produce a valid manifest — execution refused (fail closed). " +
            (manifestError ?? ""), manifestCause !== null ? { cause: manifestCause } : undefined);
        }
        record.degraded = true;
        manifest = { version: "1", summary: "degraded: standing policy only", capabilities: [], maxDurationMs: policy.maxDurationMs };
        log("warn", runId, "degraded mode: standing policy only, no manifest");
        emit({ stage: "manifest", severity: "warn", message: "Degraded mode: standing policy only, no manifest" });
      } else {
        emit({
          stage: "manifest", severity: "success", message: "Manifest parsed",
          data: { summary: manifest.summary, capabilities: manifest.capabilities.length },
        });
      }

      // ── 2. OBSERVE (never declared by the agent) ─────────────────
      const ctx = await this.buildContext(runId, request, policy, manifest);
      if (ctx.taint !== "none") {
        log("warn", runId, `untrusted content observed in ${ctx.taintSource ?? "workspace"}`);
        emit({
          stage: "manifest", severity: "warn", message: `Untrusted content observed in ${ctx.taintSource ?? "workspace"}`,
          data: { taint: ctx.taint, source: ctx.taintSource },
        });
      }

      // ── 3. SCORE + RESOLVE -> PERMIT ────────────────────────────
      let permit = buildPermit(manifest, policy, ctx);
      permit = grantProviderHost(permit, this.config);
      record.permit = permit;
      await this.store.append(runId, request.agentId, "permit", {
        permitId: permit.permitId, runTier: permit.runTier, summary: permit.summary,
        verdicts: permit.verdicts.map((v) => ({ op: v.op, target: v.target, tier: v.tier, score: v.score, hardRule: v.hardRule, resolvedBy: v.resolvedBy })),
      });
      log("info", runId, `permit ${permit.permitId} tier=${permit.runTier}`, {
        writes: permit.grantedWrites.length, hosts: permit.grantedHosts.length, commands: permit.grantedCommands.length,
      });
      emit({
        stage: "permit", message: `Permit ${permit.permitId} issued — tier ${permit.runTier}`,
        data: {
          permitId: permit.permitId, runTier: permit.runTier,
          writes: permit.grantedWrites.length, hosts: permit.grantedHosts.length, commands: permit.grantedCommands.length,
        },
      });

      if (permit.denied) {
        record.outcome = "denied";
        record.denials = this.denials.get(runId) ?? [];
        for (const v of permit.verdicts.filter((x) => x.tier === "T4")) {
          await this.store.recordPrecedent({
            fingerprint: v.fingerprint, agentId: request.agentId, decision: "denied",
            expiresAt: null, termSheetVersion: permit.termSheetVersion, summary: v.summary,
          });
          await appendJournal(request.workspacePath, runId, "denial",
            `${v.summary} was refused (${v.hardRule ?? "score " + String(v.score)}). Do not attempt this again.`);
        }
        await this.store.saveRun(record);
        const reasons = permit.verdicts.filter((v) => v.tier === "T4")
          .map((v) => `${v.hardRule ?? "score " + String(v.score)}: ${v.summary}`).join("; ");
        log("deny", runId, "run denied at adjudication", { reasons });
        emit({ stage: "permit", severity: "error", message: "Run denied at adjudication", data: { reasons } });
        throw new Error("HEIMDALL: run denied — " + reasons);
      }

      // ── 4. HUMAN APPROVAL (T3) ──────────────────────────────────
      if (permit.requiresHumanApproval) {
        record.approval.required = true;
        record.outcome = "awaiting-approval";
        await this.store.saveRun(record);
        log("info", runId, "awaiting human approval");
        emit({
          stage: "approval", severity: "warn", message: "Awaiting human approval",
          data: { permitId: permit.permitId, timeoutMs: this.options.approvalTimeoutMs },
        });
        const decision = await this.awaitApproval(runId, permit, manifest);
        record.approval.decision = decision.decision;
        record.approval.decidedBy = decision.by;
        record.approval.at = new Date().toISOString();
        await this.store.append(runId, request.agentId, "approval", { ...decision });
        emit({
          stage: "approval", severity: decision.decision === "approved" ? "success" : "error",
          message: `Approval ${decision.decision} by ${decision.by}`,
          data: { decision: decision.decision, by: decision.by },
        });

        for (const v of permit.verdicts.filter((x) => x.tier === "T3")) {
          await this.store.recordPrecedent({
            fingerprint: v.fingerprint, agentId: request.agentId,
            decision: decision.decision === "approved" ? "approved" : "denied",
            expiresAt: decision.decision === "approved" ? Date.now() + 7 * 24 * 3600 * 1000 : null,
            termSheetVersion: permit.termSheetVersion, summary: v.summary,
          });
        }
        if (decision.decision !== "approved") {
          record.outcome = "denied";
          await this.store.saveRun(record);
          await appendJournal(request.workspacePath, runId, "denial", "operator refused this permit");
          log("deny", runId, "operator refused the permit");
          throw new Error("HEIMDALL: operator refused this permit");
        }
        // re-base the permit window on the approval, not on when it was drafted
        permit = applyApproval(permit, manifest, policy.maxDurationMs);
        record.permit = permit;
      }

      // ── 5. EXECUTE under the permit ─────────────────────────────
      const execStart = Date.now();
      const before = await snapshotWorkspace(request.workspacePath);
      const result = await this.execute(runId, request, permit, ctx);
      /*
       * codex 0.111 has no patch TOOL — it creates files by running shell
       * commands, so a write produces an EXEC event and no FS event at all.
       * Reconciling only what the event stream reported therefore claimed every
       * declared write was "unused" even when the file was plainly created.
       * Diffing the workspace makes declared-vs-actual tell the truth.
       */
      for (const rel of await changedSince(request.workspacePath, before)) {
        result.actual.push({ op: "FS_WRITE", target: rel, at: new Date().toISOString() });
      }
      record.execMs = Date.now() - execStart;
      record.actual = result.actual;

      // ── 6. RECONCILE ────────────────────────────────────────────
      record.divergences = reconcile(permit, result.actual);
      record.denials = this.denials.get(runId) ?? [];
      record.outcome = "completed";
      await this.store.append(runId, request.agentId, "reconciliation", {
        declaredWrites: permit.grantedWrites, actual: result.actual.length,
        divergences: record.divergences,
      });
      emit({
        stage: "reconciliation", message: "Reconciled declared capabilities against observed actions",
        data: { actual: result.actual.length, divergences: record.divergences.length, denials: record.denials.length },
      });
      if (record.divergences.some((d) => d.kind === "undeclared")) {
        log("warn", runId, "contract violation: actions outside the manifest", {
          count: record.divergences.filter((d) => d.kind === "undeclared").length,
        });
        emit({
          stage: "reconciliation", severity: "warn", message: "Contract violation: actions outside the manifest",
          data: { count: record.divergences.filter((d) => d.kind === "undeclared").length },
        });
      }
      await journalDenials();
      await this.store.saveRun(record);
      log("info", runId, `run completed in ${Date.now() - started}ms`, {
        denials: record.denials.length, divergences: record.divergences.length,
      });
      return result.result;
    } catch (error) {
      if (record.outcome === "failed") {
        record.denials = this.denials.get(runId) ?? [];
        await this.store.saveRun(record);
        // A blocked action ABORTS the run, so this is the path that matters most:
        // without it the journal only said "terminated", and the next recon was
        // never told WHICH action was refused or why — the feedback loop the
        // design depends on never ran for the case it exists to handle.
        await journalDenials();
        await appendJournal(request.workspacePath, runId, "failure", (error as Error).message)
          .catch(() => undefined);
      }
      throw error;
    } finally {
      this.pending.delete(runId);
      this.denials.delete(runId);
    }
  }

  /* ─────────────────────── observation ─────────────────────── */

  private async buildContext(
    runId: string, request: RunnerRequest, policy: StandingPolicy, manifest: Manifest,
  ): Promise<RunContext> {
    const files = await listWorkspace(request.workspacePath);
    const gitTracked = await gitList(request.workspacePath, ["ls-files"]);
    const gitIgnored = ["node_modules/", "dist/", "build/", ".cache/", "coverage/"];

    // TAINT is observed, never declared: scan the files the manifest says it will read.
    let taint: RunContext["taint"] = "none";
    let taintSource: string | null = null;
    const readTargets = manifest.capabilities
      .filter((c) => c.op === "FS_READ" || c.op === "FS_WRITE")
      .flatMap((c) => c.paths ?? []);
    const scanList = [...new Set([...readTargets, "README.md", "AGENTS.md"])];
    for (const rel of scanList) {
      if (rel.includes("*")) continue;
      try {
        const abs = path.resolve(request.workspacePath, rel);
        const info = await stat(abs);
        if (!info.isFile() || info.size > 512 * 1024) continue;
        const text = await readFile(abs, "utf8");
        if (looksLikeInjection(text)) {
          taint = path.resolve(request.workspacePath, rel).startsWith(path.resolve(request.workspacePath))
            ? "workspace" : "external";
          taintSource = rel;
          await this.store.append(runId, request.agentId, "taint", { source: rel, level: taint });
          break;
        }
      } catch { /* unreadable is not taint */ }
    }

    const payloadSamples: Record<string, string> = {};
    for (const c of manifest.capabilities) {
      for (const p of c.payloadPaths ?? []) {
        try { payloadSamples[p] = (await readFile(path.resolve(request.workspacePath, p), "utf8")).slice(0, 64 * 1024); }
        catch { /* absent file cannot be sampled */ }
      }
    }

    return {
      runId, agentId: request.agentId, taint, taintSource,
      gitTrackedPaths: gitTracked, gitIgnoredPaths: gitIgnored,
      workspaceFiles: files, completedRuns: this.store.runsFor(request.agentId).length,
      canaryRelPath: CANARY_REL_PATH,
      precedents: this.store.precedents(request.agentId),
      payloadSamples,
    };
  }

  /* ─────────────────────── recon ─────────────────────── */

  private reconPermit(runId: string, agentId: string): Permit {
    return buildReconPermit(this.config, runId, agentId);
  }

  /* ─────────────────────── execution ─────────────────────── */

  private runtimeConfig(proxyContainerName: string, codexHome: string): HeimdallRuntimeConfig {
    return {
      containerEngine: this.config.containerEngine,
      containerRuntimeImage: this.config.containerRuntimeImage,
      containerUser: this.config.containerUser,
      containerCpuLimit: this.config.containerCpuLimit,
      containerMemoryLimit: this.config.containerMemoryLimit,
      containerPidsLimit: this.config.containerPidsLimit,
      codexHome,
      network: this.options.network,
      // reachable by container name — both are on `network` (heimdall-internal)
      proxyUrl: `http://${proxyContainerName}:${PROXY_SIDECAR_PORT}`,
      providerEnvKey: activeProvider(this.config).envKey,
      placeholderKey: "heimdall.proxy.injected",
    };
  }

  /**
   * Starts the per-phase proxy sidecar and waits for it to be listening.
   * Docker Desktop's --internal networks have no route back to the host, so
   * the proxy cannot run in-process anymore — it runs as its own container,
   * attached to both the isolated agent network (reachable by the agent
   * container, by name) and a normal egress network (its only route out).
   */
  private async startProxySidecar(permit: Permit, name: string): Promise<void> {
    const provider = activeProvider(this.config);
    const providerUrl = new URL(provider.baseUrl);
    const args = buildHeimdallProxyRunArgs(permit, {
      containerEngine: this.config.containerEngine,
      proxyImage: this.config.containerProxyImage,
      network: this.options.network,
      egressNetwork: this.options.egressNetwork,
      // `.host`, not `.hostname` — must carry a non-default port when the
      // provider URL has one, since proxy.ts matches it against the full
      // authority (target.host) to decide whether to inject the real key.
      providerHost: providerUrl.host,
      providerKey: provider.key,
      providerScheme: providerUrl.protocol === "http:" ? "http" : "https",
    }, name);
    await execFileAsync(this.config.containerEngine, args, { timeout: 15_000 });

    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      try {
        const { stdout } = await execFileAsync(this.config.containerEngine, ["logs", name], { timeout: 3_000 });
        if (stdout.includes(READY_MARKER)) return;
      } catch { /* container may not have produced logs yet */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    await this.removeContainer(name);
    throw new Error("HEIMDALL: proxy sidecar did not become ready in time");
  }

  /** Reads the (about-to-be-removed) sidecar's logs once for denials to fold into the ledger. */
  private async collectSidecarDenials(runId: string, proxyName: string): Promise<void> {
    try {
      const { stdout } = await execFileAsync(this.config.containerEngine, ["logs", proxyName], { timeout: 5_000 });
      for (const line of stdout.split(/\r?\n/)) {
        if (!line.startsWith(DENIAL_MARKER)) continue;
        try { this.recordDenial(runId, JSON.parse(line.slice(DENIAL_MARKER.length)) as Denial); }
        catch { /* malformed line */ }
      }
    } catch { /* sidecar already gone */ }
  }

  private async execute(
    runId: string, request: RunnerRequest, permit: Permit, ctx: RunContext,
  ): Promise<{ result: RunnerResult; actual: Array<{ op: string; target: string; at: string }> }> {
    const actual: Array<{ op: string; target: string; at: string }> = [];
    const result = await this.spawnCodex(runId, request, permit, this.config.codexSandboxMode, {
      permit, workspaceFiles: ctx.workspaceFiles, actual,
    });
    return { result, actual };
  }

  /**
   * One spawn path for both phases. When `broker` is null the run is
   * reconnaissance: the permit grants no writes, so the workspace is mounted
   * read-only and nothing it does can persist.
   */
  private async spawnCodex(
    runId: string, request: RunnerRequest, permit: Permit,
    sandboxMode: AppConfig["codexSandboxMode"],
    broker: { permit: Permit; workspaceFiles: readonly string[]; actual: Array<{ op: string; target: string; at: string }> } | null,
  ): Promise<RunnerResult> {
    const codexArgs = buildCodexArgs(request, sandboxMode, CONTAINER_WORKSPACE_ROOT);
    const name = "heimdall-" + permit.permitId.slice(0, 12) + "-" + permit.runId.slice(0, 16);
    const proxyName = "heimdall-proxy-" + permit.permitId.slice(0, 12) + "-" + permit.runId.slice(0, 16);
    const entry: ActiveRun = { name, proxyName, killed: false, cancelled: false, emit: request.emit };
    this.active.set(request.agentId, entry);
    const recon = broker === null;

    request.emit({
      stage: "container", message: recon ? "Starting recon container" : "Starting Runtime container",
      data: { containerName: name, recon },
    });

    let timer: NodeJS.Timeout | undefined;
    let proxiedCodexHome: string | null = null;
    try {
      await this.startProxySidecar(permit, proxyName);
      // Route model-provider traffic through the proxy as a plain, same-network
      // request (see writeProxiedCodexConfig) instead of an HTTPS CONNECT tunnel
      // to the real host — a blind tunnel is opaque to the proxy, so it could
      // never actually inject the real credential the container never holds.
      proxiedCodexHome = await writeProxiedCodexConfig(this.config, `http://${proxyName}:${PROXY_SIDECAR_PORT}`);
      const args = buildHeimdallRunArgs(permit, request.workspacePath, this.runtimeConfig(proxyName, proxiedCodexHome), codexArgs);
      request.emit({ stage: "container", severity: "success", message: "Container spawned", data: { containerName: name, recon } });
      request.emit({ stage: "codex", message: "Codex process running inside container", data: { containerName: name, recon } });

      const parsed: ParsedEvents = { messages: [], threadId: request.threadId, usage: null, errors: [] };
      const unknownTypes = new Set<string>();
      // Codex reports the same action at item.started and again at item.completed.
      // Both are checked (so a refusal lands while the command is still running)
      // but each is recorded and denied exactly once.
      const seenActions = new Set<string>();
      let outputExceeded = false;
      let timedOut = false;
      // Teardown is started from stream callbacks; it must settle before the run
      // resolves, or a denied run returns while its container is still alive.
      const teardown: Array<Promise<void>> = [];

      const child = spawn(this.config.containerEngine, args, {
        cwd: request.workspacePath,
        env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", NO_COLOR: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "", stderr = "", bytes = 0;
      const onLine = (line: string): void => {
        parseCodexEventLine(line, parsed);
        let event: Record<string, unknown>;
        try { event = JSON.parse(line) as Record<string, unknown>; } catch { return; }
        if (broker === null) return;                 // recon observes nothing; the mount is the control
        for (const action of observeEvents(event)) {
          const key = action.id ?? `${action.op}\u0000${action.target}`;
          if (seenActions.has(key)) continue;
          seenActions.add(key);
          log("info", runId, `observed ${action.op} ${action.target.slice(0, 120)}`, { raw: action.raw });

          if (action.op === "UNKNOWN") {
            unknownTypes.add(action.raw);
            // An item naming no command, path or host cannot BE an action, so it
            // is reported only. One that names something we could not classify is
            // an unclassified action and the broker refuses it — fail safe.
            if (action.inert === true) continue;
            log("warn", runId, `unclassified action-shaped event "${action.raw}" — refusing`);
          }

          broker.actual.push({ op: action.op, target: action.target, at: new Date().toISOString() });
          const check = checkAction(action, broker.permit, request.workspacePath, broker.workspaceFiles);
          if (!check.allowed && check.denial !== null) {
            this.recordDenial(runId, check.denial);
            log("deny", runId, `action blocked: ${action.op} ${action.target.slice(0, 80)}`, { rule: check.denial.rule });
            entry.killed = true;
            teardown.push(this.removeContainer(name));
          }
        }
      };

      child.stdout.on("data", (chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (bytes > this.config.codexMaxOutputBytes) {
          outputExceeded = true;
          teardown.push(this.removeContainer(name));
          return;
        }
        stdout += chunk.toString("utf8");
        const lines = stdout.split(/\r?\n/);
        stdout = lines.pop() ?? "";
        for (const l of lines) if (l.trim()) onLine(l);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString("utf8")).slice(-16_384);
      });

      /*
       * Stop at whichever comes first: the container budget, or the permit's own
       * expiry. Both default to 600s, so a long run would otherwise reach expiry
       * while still executing and start collecting P-09 egress denials — the
       * agent sees the model connection die for no stated reason instead of a
       * clean, explained timeout.
       */
      const permitRemaining = permit.expiresAt - Date.now();
      const budget = Math.max(1_000, Math.min(this.config.codexTimeoutMs, permitRemaining));
      timer = setTimeout(() => {
        timedOut = true;
        teardown.push(this.removeContainer(name));
      }, budget);
      timer.unref();

      const code = await new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (c) => resolve(c ?? 1));
      });
      if (stdout.trim()) onLine(stdout.trim());
      if (unknownTypes.size > 0) {
        log("info", runId, "unmapped codex event types", { types: [...unknownTypes] });
        await this.store.append(runId, request.agentId, "unmapped-events", { types: [...unknownTypes] });
      }
      request.emit({
        stage: "codex", severity: code === 0 ? "info" : "error",
        message: "Codex process exited with code " + code,
        data: { exitCode: code, containerName: name, recon },
      });
      await Promise.allSettled(teardown);
      if (timedOut) {
        const why = permit.expiresAt - Date.now() <= 0 ? "the permit expired" : "CODEX_TIMEOUT_MS was reached";
        throw new RuntimeExitError(
          `HEIMDALL: run terminated — ${why} (budget ${budget}ms)`,
          { exitCode: code, containerName: name, stdout: redact(stdout), stderr: redact(stderr) });
      }
      if (outputExceeded) {
        throw new RuntimeExitError("HEIMDALL: run exceeded CODEX_MAX_OUTPUT_BYTES and was terminated",
          { exitCode: code, containerName: name, stdout: redact(stdout), stderr: redact(stderr) });
      }
      if (entry.cancelled) throw new RunCancelledError();
      if (entry.killed) {
        throw new RuntimeExitError("HEIMDALL: run terminated — a blocked action was attempted", {
          exitCode: code, containerName: name, stdout: redact(stdout), stderr: redact(stderr),
        });
      }
      if (code !== 0) {
        // Keep the full picture: the last parsed error is often just the final
        // symptom (e.g. "Failed to shutdown rollout recorder"); stderr usually
        // carries the preceding cause (permission/filesystem detail) that a
        // "last error only" summary would silently drop.
        const parts: string[] = [];
        if (parsed.errors.length > 0) parts.push(parsed.errors.join(" | "));
        if (stderr.trim()) parts.push("stderr: " + stderr.trim());
        const detail = parts.length > 0 ? parts.join(" — ") : "no detail";
        throw new RuntimeExitError(`HEIMDALL: runtime exited with code ${code}: ${redact(detail)}`, {
          exitCode: code, containerName: name, stdout: redact(stdout), stderr: redact(stderr),
          cause: new Error(redact(detail)),
        });
      }
      const output = parsed.messages.at(-1)?.trim();
      if (output === undefined || output === "") {
        throw new RuntimeExitError("HEIMDALL: run produced no agent message", {
          exitCode: code, containerName: name, stdout: redact(stdout), stderr: redact(stderr),
        });
      }
      request.emit({ stage: "parsing", message: "Parsed agent output", data: { threadId: parsed.threadId, recon } });
      return { output, threadId: parsed.threadId, usage: parsed.usage };
    } finally {
      clearTimeout(timer);
      await this.collectSidecarDenials(runId, proxyName);
      await this.removeContainer(proxyName);
      if (proxiedCodexHome) await rm(proxiedCodexHome, { recursive: true, force: true }).catch(() => undefined);
      this.active.delete(request.agentId);
    }
  }

  private async removeContainer(name: string): Promise<void> {
    try {
      await execFileAsync(this.config.containerEngine, ["rm", "--force", name], { timeout: 8_000 });
    } catch { /* already gone */ }
  }

  private awaitApproval(
    runId: string, permit: Permit, manifest: Manifest,
  ): Promise<{ decision: "approved" | "denied"; by: string }> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(runId);
        resolve({ decision: "denied", by: "timeout" });   // fail closed
      }, this.options.approvalTimeoutMs);
      timer.unref();
      this.pending.set(runId, {
        permit, manifest,
        resolve: (decision, by) => { clearTimeout(timer); this.pending.delete(runId); resolve({ decision, by }); },
      });
    });
  }
}

/* ───────────────────────── helpers ───────────────────────── */

/**
 * Codex reports capability paths container-absolute (e.g. "/workspace/star.ts"),
 * but every downstream consumer — git-tracked-file checks, the workspace file
 * list, the canary path, taint-scan reads, the runtime permit check, and
 * reconciliation — expects workspace-relative paths. Normalise once, right
 * after the manifest is parsed, instead of teaching every consumer the prefix.
 */
export function relativizeManifestPaths(manifest: Manifest, root: string): Manifest {
  const strip = (p: string): string =>
    p === root || p.startsWith(root + "/") ? (p.slice(root.length + 1) || ".") : p;
  return {
    ...manifest,
    capabilities: manifest.capabilities.map((c) => ({
      ...c,
      ...(c.paths ? { paths: c.paths.map(strip) } : {}),
      ...(c.payloadPaths ? { payloadPaths: c.payloadPaths.map(strip) } : {}),
    })),
  };
}

async function listWorkspace(root: string, prefix = "", depth = 0): Promise<string[]> {
  if (depth > 6) return [];
  const out: string[] = [];
  let entries;
  try { entries = await readdir(path.join(root, prefix), { withFileTypes: true }); } catch { return []; }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === ".git" || e.name === "dist") continue;
    const rel = prefix ? path.posix.join(prefix, e.name) : e.name;
    if (e.isDirectory()) out.push(...await listWorkspace(root, rel, depth + 1));
    else out.push(rel);
    if (out.length > 5000) break;
  }
  return out;
}

async function gitList(cwd: string, args: string[]): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, timeout: 5_000 });
    return stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  } catch { return []; }
}