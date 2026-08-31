/** HEIMDALL — assembly + HTTP routes. One import point for the rest of the app. */
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { ContainerCodexRunner } from "../container-codex-runner.js";
import { CodexRunner } from "../codex-runner.js";
import type { AgentRunner } from "../types.js";
import { HeimdallRunner, type HeimdallOptions } from "./runner.js";
import { HeimdallStore, loadPolicy, savePolicy, log } from "./store.js";
import { TERM_SHEET_VERSION, BANDS, A1_OPERATION, A2_TARGET, A3_REVERSIBILITY, A4_BLAST, A5_EGRESS, A6_CONTEXT, DISCOUNTS, HARD } from "./termsheet.js";

export { HeimdallRunner } from "./runner.js";
export { HeimdallStore } from "./store.js";

export function heimdallOptions(env: NodeJS.ProcessEnv = process.env): HeimdallOptions {
  return {
    enabled: (env["HEIMDALL"] ?? "on").toLowerCase() !== "off",
    policyDir: env["HEIMDALL_POLICY_DIR"] ?? path.resolve("policy"),
    network: env["HEIMDALL_NETWORK"] ?? "heimdall-internal",
    egressNetwork: env["HEIMDALL_EGRESS_NETWORK"] ?? "heimdall-egress",
    approvalTimeoutMs: Number(env["HEIMDALL_APPROVAL_TIMEOUT_MS"] ?? 300_000),
    degradedFallback: (env["HEIMDALL_DEGRADED"] ?? "off").toLowerCase() === "on",
    directPlanner: (env["HEIMDALL_DIRECT_PLANNER"] ?? "on").toLowerCase() !== "off",
    reconTimeoutMs: Number(env["HEIMDALL_RECON_TIMEOUT_MS"] ?? 60_000),
  };
}

export interface Heimdall {
  runner: AgentRunner;
  store: HeimdallStore;
  wrapper: HeimdallRunner | null;
  options: HeimdallOptions;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Builds the runner chain. With HEIMDALL=off the baseline runner is returned
 * untouched — that toggle is the proof that we integrated at a real seam.
 */
export async function createHeimdall(config: AppConfig): Promise<Heimdall> {
  const options = heimdallOptions();
  const store = new HeimdallStore(config.dataDirectory);
  await store.initialize();
  const removed = await store.invalidateApprovals();
  if (removed > 0) log("info", "boot", `term sheet v${TERM_SHEET_VERSION}: invalidated ${removed} stale approval precedent(s)`);

  const base: AgentRunner = config.runtimeProvider === "container"
    ? new ContainerCodexRunner(config) : new CodexRunner(config);

  if (!options.enabled) {
    return { runner: base, store, wrapper: null, options, start: async () => {}, stop: async () => {} };
  }

  // recon executes with the SAME provider but forced to read-only
  const reconConfig: AppConfig = { ...config, codexSandboxMode: "read-only" };
  const recon: AgentRunner = config.runtimeProvider === "container"
    ? new ContainerCodexRunner(reconConfig) : new CodexRunner(reconConfig);

  const wrapper = new HeimdallRunner(base, recon, config, options, store);
  return {
    runner: wrapper, store, wrapper, options,
    start: () => wrapper.start(),
    stop: () => wrapper.stop(),
  };
}

/* ─────────────────────────── routes ─────────────────────────── */

const runIdParam = z.object({ id: z.string().min(1) });
const decideBody = z.object({
  decision: z.enum(["approved", "denied"]),
  by: z.string().trim().min(1).max(80).default("operator"),
});

export function registerHeimdallRoutes(app: FastifyInstance, heimdall: Heimdall): void {
  const { store, wrapper, options } = heimdall;

  app.get("/api/heimdall/status", async () => ({
    enabled: options.enabled,
    termSheetVersion: TERM_SHEET_VERSION,
    degradedFallback: options.degradedFallback,
    network: options.network,
    egressNetwork: options.egressNetwork,
    ledger: store.verify(),
    metrics: store.metrics(),
  }));

  app.get("/api/heimdall/termsheet", async () => ({
    version: TERM_SHEET_VERSION,
    bands: BANDS.map((b) => ({ ...b, max: Number.isFinite(b.max) ? b.max : null })),
    axes: {
      operation: A1_OPERATION, target: A2_TARGET, reversibility: A3_REVERSIBILITY,
      blast: A4_BLAST, egress: A5_EGRESS, context: A6_CONTEXT, discounts: DISCOUNTS,
    },
    hardRules: HARD,
  }));

  app.get("/api/heimdall/ledger/verify", async () => store.verify());

  app.get("/api/heimdall/ledger", async (request) => {
    const q = request.query as { runId?: string; limit?: string };
    const events = store.events(q.runId);
    const limit = Math.min(Number(q.limit ?? 200), 1000);
    return { events: events.slice(-limit) };
  });

  app.get("/api/heimdall/metrics", async () => store.metrics());

  app.get("/api/heimdall/pending", async () => ({
    pending: wrapper?.pendingPermits() ?? [],
  }));

  app.get("/api/heimdall/runs", async (request) => {
    const q = request.query as { agentId?: string };
    const runs = q.agentId ? store.runsFor(q.agentId) : store.allRuns();
    return { runs: runs.slice(-100).reverse() };
  });

  app.get("/api/heimdall/runs/:id", async (request, reply) => {
    const { id } = runIdParam.parse(request.params);
    const run = store.run(id);
    if (run === undefined) return reply.code(404).send({ error: "Run not found" });
    return { run, events: store.events(id) };
  });

  app.post("/api/heimdall/runs/:id/decide", async (request, reply) => {
    const { id } = runIdParam.parse(request.params);
    const body = decideBody.parse(request.body);
    if (wrapper === null) return reply.code(409).send({ error: "Heimdall is disabled" });
    const ok = wrapper.decide(id, body.decision, body.by);
    if (!ok) return reply.code(404).send({ error: "No permit awaiting a decision for that run" });
    return { ok: true, decision: body.decision };
  });

  app.get("/api/heimdall/precedents/:id", async (request) => {
    const { id } = runIdParam.parse(request.params);
    return { precedents: store.precedents(id) };
  });

  app.get("/api/heimdall/policy/:id", async (request) => {
    const { id } = runIdParam.parse(request.params);
    const q = request.query as { workspaceRoot?: string };
    return { policy: await loadPolicy(options.policyDir, id, q.workspaceRoot ?? "") };
  });

  app.put("/api/heimdall/policy/:id", async (request) => {
    const { id } = runIdParam.parse(request.params);
    const policy = request.body as Awaited<ReturnType<typeof loadPolicy>>;
    await savePolicy(options.policyDir, { ...policy, agentId: id });
    // a policy change invalidates approval precedents — that is the point
    const removed = await store.invalidateApprovals();
    return { ok: true, invalidatedPrecedents: removed };
  });
}
