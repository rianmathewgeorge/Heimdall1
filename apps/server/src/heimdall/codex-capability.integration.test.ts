/**
 * End-to-end regression test for the real capability-header path:
 * buildReconPermit -> buildHeimdallProxyRunArgs (real Dockerfile.proxy image)
 * -> writeProxiedCodexConfig -> buildHeimdallRunArgs (real Dockerfile.runtime
 * image, the actual @openai/codex binary) -> HeimdallProxy.capabilityOf.
 *
 * Regression: the per-run Codex config only ever set base_url; nothing told
 * Codex to send HEIMDALL_CAPABILITY (already present in the container's own
 * environment) as the x-heimdall-capability header the sidecar requires, so
 * every real run failed closed with rule P-00 ("no valid capability
 * presented"). proxy.test.ts's unit tests send that header by hand and would
 * pass even if Codex itself never sent it — they never touch the Codex
 * runtime. This test does: a real `codex exec` process, inside the real
 * runtime container, talking to the real sidecar container, reaching a mock
 * HTTP server standing in for OpenRouter/Ark.
 *
 * Building this test surfaced two more real bugs, fixed alongside the header
 * itself (see config.ts / broker.ts / proxy.ts / proxy-standalone.ts):
 *  - `wire_api = "chat"` is rejected outright by the pinned Codex CLI
 *    ("no longer supported" — github.com/openai/codex/discussions/7782);
 *    every provider now gets `wire_api = "responses"`.
 *  - Codex still honours HTTP(S)_PROXY for the very host base_url already
 *    points it at, so it sometimes sends a self-referential absolute-URI
 *    request whose "destination" (as far as the proxy could tell without the
 *    fix below) was its OWN address — denied by rule P-07, since no permit
 *    ever grants a proxy's own name. ProxyHooks.selfHost now makes the proxy
 *    unwrap that the same way it already unwraps a bare-path request.
 *
 * Skips itself cleanly when Docker isn't reachable, like this file's sibling
 * integration tests (proxy-sidecar.integration.test.ts,
 * recon-container.integration.test.ts).
 */
import { execFile, execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { AppConfig } from "../config.js";
import { writeProxiedCodexConfig } from "../config.js";
import { buildHeimdallProxyRunArgs, buildHeimdallRunArgs, PROXY_SIDECAR_PORT } from "./broker.js";
import { READY_MARKER } from "./proxy-standalone-markers.js";
import { buildReconPermit } from "./runner.js";
import type { Permit } from "./types.js";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const RUNTIME_IMAGE = "heimdall-runtime-capability-test:local";
const PROXY_IMAGE = "heimdall-proxy-capability-test:local";
const INTERNAL_NET = "heimdall-internal-capability-test";
const EGRESS_NET = "heimdall-egress-capability-test";
const SIDECAR_NAME = "heimdall-proxy-capability-test";
const MOCK_PORT = 19292;
const PROVIDER_KEY = "sk-real-key-never-in-agent-container";

function dockerReachable(): boolean {
  try { execSync("docker info", { stdio: "ignore", timeout: 5_000 }); return true; }
  catch { return false; }
}

interface ReceivedRequest {
  method: string | undefined;
  capabilityHeader: string | null;
  authorization: string | null;
  bodyLength: number;
}

async function cleanup(): Promise<void> {
  await execFileAsync("docker", ["rm", "--force", SIDECAR_NAME]).catch(() => {});
  await execFileAsync("docker", ["network", "rm", INTERNAL_NET]).catch(() => {});
  await execFileAsync("docker", ["network", "rm", EGRESS_NET]).catch(() => {});
}

describe.skipIf(!dockerReachable())(
  "codex capability header: real recon runtime -> sidecar -> provider path",
  () => {
    let mockServer: Server;
    const received: ReceivedRequest[] = [];
    let workspaceDir = "";
    let proxiedCodexHome = "";
    let permit: Permit;

    beforeAll(async () => {
      // Real images, same Dockerfiles the app itself builds (start-local-poc.sh)
      // — this is the one test in the suite that actually installs and runs
      // the real @openai/codex binary, so it can prove Codex itself sends the
      // header, not just that the proxy accepts one sent by hand.
      await execFileAsync("docker", ["build", "-f", path.join(REPO_ROOT, "Dockerfile.runtime"), "-t", RUNTIME_IMAGE, REPO_ROOT], { timeout: 300_000 });
      await execFileAsync("docker", ["build", "-f", path.join(REPO_ROOT, "Dockerfile.proxy"), "-t", PROXY_IMAGE, REPO_ROOT], { timeout: 180_000 });

      // Stands in for the real OpenRouter/Ark endpoint. Records exactly what
      // reached it — x-heimdall-capability must NEVER show up here (the
      // sidecar strips it before forwarding upstream), while the real
      // provider key SHOULD, injected by the sidecar in place of the
      // placeholder the container itself held.
      mockServer = createServer((req, res) => {
        let body = "";
        req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
        req.on("end", () => {
          const capabilityHeader = req.headers["x-heimdall-capability"];
          const authorization = req.headers["authorization"];
          received.push({
            method: req.method,
            capabilityHeader: typeof capabilityHeader === "string" ? capabilityHeader : null,
            authorization: typeof authorization === "string" ? authorization : null,
            bodyLength: body.length,
          });
          // Deliberately not a real streaming Responses-API reply: this test
          // proves the request reaches the provider with the right identity,
          // not that Codex can complete a full model turn against a stub.
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "mock provider: no model configured" } }));
        });
      });
      await new Promise<void>((resolve) => mockServer.listen(MOCK_PORT, "0.0.0.0", () => resolve()));

      await cleanup();
      await execFileAsync("docker", ["network", "create", "--internal", INTERNAL_NET]);
      await execFileAsync("docker", ["network", "create", EGRESS_NET]);

      workspaceDir = await mkdtemp(path.join(tmpdir(), "heimdall-capability-workspace-"));

      const fakeConfig = {
        modelProvider: "openrouter",
        openrouterApiKey: PROVIDER_KEY,
        openrouterModel: "test-model",
        // host.docker.internal: Docker Desktop's route from a container on a
        // normal (egress) network back to a process on the host — see
        // proxy-sidecar.integration.test.ts for the same trick used from the
        // other side (the sidecar's target, not its own listener).
        openrouterBaseUrl: `http://host.docker.internal:${String(MOCK_PORT)}/v1`,
        codexTimeoutMs: 60_000,
      } as unknown as AppConfig;

      permit = buildReconPermit(fakeConfig, "capability-it-" + randomUUID().slice(0, 8), "capability-it-agent");

      const proxyArgs = buildHeimdallProxyRunArgs(permit, {
        containerEngine: "docker", proxyImage: PROXY_IMAGE,
        network: INTERNAL_NET, egressNetwork: EGRESS_NET,
        providerHost: `host.docker.internal:${String(MOCK_PORT)}`,
        providerKey: PROVIDER_KEY,
        providerScheme: "http",
      }, SIDECAR_NAME);
      await execFileAsync("docker", proxyArgs, { timeout: 15_000 });

      const deadline = Date.now() + 10_000;
      for (;;) {
        const { stdout } = await execFileAsync("docker", ["logs", SIDECAR_NAME]).catch(() => ({ stdout: "" }));
        if (stdout.includes(READY_MARKER)) break;
        if (Date.now() > deadline) throw new Error("sidecar did not become ready in time");
        await new Promise((r) => setTimeout(r, 200));
      }

      proxiedCodexHome = await writeProxiedCodexConfig(fakeConfig, `http://${SIDECAR_NAME}:${String(PROXY_SIDECAR_PORT)}`);
    }, 300_000);

    afterAll(async () => {
      await cleanup();
      await execFileAsync("docker", ["image", "rm", "-f", RUNTIME_IMAGE, PROXY_IMAGE]).catch(() => {});
      if (proxiedCodexHome) await rm(proxiedCodexHome, { recursive: true, force: true }).catch(() => {});
      if (workspaceDir) await rm(workspaceDir, { recursive: true, force: true }).catch(() => {});
      await new Promise<void>((resolve) => mockServer.close(() => resolve()));
    }, 30_000);

    test("codex sends the capability header itself, the sidecar permits the provider host, and the request reaches it", async () => {
      const runtimeConfig = {
        containerEngine: "docker", containerRuntimeImage: RUNTIME_IMAGE,
        containerUser: `${String(process.getuid?.() ?? 1000)}:${String(process.getgid?.() ?? 1000)}`,
        containerCpuLimit: 1, containerMemoryLimit: "512m", containerPidsLimit: 128,
        codexHome: proxiedCodexHome,
        network: INTERNAL_NET,
        proxyUrl: `http://${SIDECAR_NAME}:${String(PROXY_SIDECAR_PORT)}`,
        providerEnvKey: "OPENROUTER_API_KEY",
        placeholderKey: "heimdall.proxy.injected",
      };
      const codexArgs = ["exec", "--json", "--sandbox", "read-only", "--skip-git-repo-check", "-C", "/workspace", "say hi"];
      const args = buildHeimdallRunArgs(permit, workspaceDir, runtimeConfig, codexArgs);

      // Exit code is not asserted: the mock above deliberately doesn't speak
      // the real streaming Responses protocol, so Codex is expected to retry
      // and eventually fail the TURN. What this test proves is that every one
      // of those attempts got past the sidecar's permit check and physically
      // reached the provider — the P-00/P-07 denials this guards against
      // would have made that impossible.
      await execFileAsync("docker", args, { timeout: 60_000 }).catch(() => {});

      const sidecarLog = await execFileAsync("docker", ["logs", SIDECAR_NAME]).then((r) => r.stdout).catch(() => "");
      expect(sidecarLog).not.toContain("HEIMDALL_DENIAL_JSON");

      expect(received.length).toBeGreaterThan(0);
      for (const r of received) {
        expect(r.method).toBe("POST");
        expect(r.bodyLength).toBeGreaterThan(0);
        // The sidecar authenticated this request via the header, then
        // stripped it before forwarding upstream — proved here against a
        // request Codex itself constructed, not a hand-built one.
        expect(r.capabilityHeader).toBeNull();
        expect(r.authorization).toBe(`Bearer ${PROVIDER_KEY}`);
      }
    }, 90_000);
  },
);
