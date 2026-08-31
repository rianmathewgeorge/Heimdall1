/**
 * HEIMDALL — proxy sidecar entrypoint.
 *
 * Docker Desktop's --internal networks have no route back to the host, so an
 * in-process, host-bound proxy is unreachable from an agent container on
 * heimdall-internal (verified directly: neither host.docker.internal nor the
 * network's own gateway IP resolve/connect from an --internal network on
 * Docker Desktop). This entrypoint runs the SAME HeimdallProxy class inside
 * its own container instead, attached to both heimdall-internal (so the agent
 * container can reach it as a peer, by container name) and a normal egress
 * network (so it — and only it — can reach the real internet).
 *
 * Scoped to exactly one permit (one run, one phase — recon or execution),
 * supplied entirely via environment variables at container start. Denials
 * are printed as a marked JSON line on stdout for the parent process, which
 * spawned this container and reads its logs, to fold into the run's ledger.
 */
import { capabilityMatches, HeimdallProxy, type ProxyHooks } from "./proxy.js";
import { DENIAL_MARKER, READY_MARKER } from "./proxy-standalone-markers.js";
import { log } from "./store.js";
import type { Permit } from "./types.js";

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<void> {
  const runId = process.env["HEIMDALL_RUN_ID"] ?? "unknown";
  const agentId = process.env["HEIMDALL_AGENT_ID"] ?? "unknown";
  const capabilityToken = required("HEIMDALL_CAPABILITY");
  const grantedHosts = required("HEIMDALL_GRANTED_HOSTS")
    .split(",").map((h) => h.trim().toLowerCase()).filter((h) => h !== "");
  const expiresAt = Number(required("HEIMDALL_PERMIT_EXPIRES_AT"));
  const providerHost = process.env["HEIMDALL_PROVIDER_HOST"] ?? "";
  const providerKey = process.env["HEIMDALL_PROVIDER_KEY"] ?? "";
  const providerScheme = process.env["HEIMDALL_PROVIDER_SCHEME"] === "http" ? "http" : "https";
  const selfHost = process.env["HEIMDALL_SELF_HOST"];
  const port = Number(process.env["HEIMDALL_SIDECAR_PORT"] ?? "8080");

  const permit: Permit = {
    permitId: "sidecar", runId, agentId, termSheetVersion: "sidecar",
    runTier: "T0", summary: "", verdicts: [],
    grantedWrites: [], grantedReads: [], grantedHosts, grantedCommands: [],
    expiresAt, requiresHumanApproval: false, denied: false,
    createdAt: new Date().toISOString(),
    requestHash: "", approvedHash: null,
    capabilityToken,
  };

  const hooks: ProxyHooks = {
    permitFor: (presented) => (capabilityMatches(presented, capabilityToken) ? permit : null),
    // the human-readable "egress blocked" line is already logged by HeimdallProxy
    // itself; this is the machine-readable line the parent process parses back
    // into the run's denial ledger once this container's phase finishes.
    onDenial: (rid, denial) => console.log(DENIAL_MARKER + JSON.stringify({ runId: rid, ...denial })),
    providerHost,
    providerKey,
    providerScheme,
    ...(selfHost !== undefined ? { selfHost } : {}),
  };

  const proxy = new HeimdallProxy(hooks);
  await proxy.listen(port, "0.0.0.0");
  console.log(READY_MARKER);
  log("info", runId, `sidecar proxy listening on :${port}`, { grantedHosts });

  const shutdown = (): void => { void proxy.close().then(() => process.exit(0)); };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

void main().catch((error: unknown) => {
  console.error("HEIMDALL: proxy sidecar failed to start:", error);
  process.exit(1);
});
