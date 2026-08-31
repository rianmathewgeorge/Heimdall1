/**
 * Integration test for the real proxy sidecar architecture: exercises the
 * actual Dockerfile.proxy image and the dual-network topology broker.ts /
 * runner.ts build for it (isolated agent network + a normal egress network).
 *
 * Regression: the egress proxy used to run in-process on the host, reachable
 * via `host.docker.internal`. Verified directly (see HEIMDALL.md / commit
 * history): Docker Desktop's --internal networks have NO route back to the
 * host at all — not by that hostname, not by the network's own gateway IP —
 * so every agent container's very first proxied request failed before it
 * could reach the model provider. This test proves the fix: an agent-like
 * container on an isolated (--internal) network has no direct route to a
 * target host, but reaches it through the sidecar (which enforces the
 * granted-host permit) via the sidecar's own second, non-internal interface.
 *
 * The rest of the suite deliberately avoids Docker (see loop.test.ts); this
 * file is one of the exceptions and skips itself cleanly when Docker isn't
 * reachable.
 */
import { execFile, execSync } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const IMAGE_TAG = "heimdall-proxy-sidecar-test:local";
const INTERNAL_NET = "heimdall-internal-sidecar-test";
const EGRESS_NET = "heimdall-egress-sidecar-test";
const SIDECAR_NAME = "heimdall-proxy-sidecar-test";
const CAPABILITY = "a".repeat(64);
const TARGET_PORT = 19191;
const TARGET_RESPONSE = "heimdall-sidecar-target-reachable";
const GRANTED_HOST = "host.docker.internal";

function dockerReachable(): boolean {
  try { execSync("docker info", { stdio: "ignore", timeout: 5_000 }); return true; }
  catch { return false; }
}

async function cleanup(): Promise<void> {
  await execFileAsync("docker", ["rm", "--force", SIDECAR_NAME]).catch(() => {});
  await execFileAsync("docker", ["network", "rm", INTERNAL_NET]).catch(() => {});
  await execFileAsync("docker", ["network", "rm", EGRESS_NET]).catch(() => {});
}

describe.skipIf(!dockerReachable())("proxy sidecar: real dual-network egress", () => {
  let targetServer: net.Server;

  beforeAll(async () => {
    // Stands in for "the real internet" — a plain TCP target only reachable
    // via the sidecar's second (egress) network interface, not the isolated one.
    targetServer = net.createServer((socket) => socket.end(TARGET_RESPONSE));
    await new Promise<void>((resolve) => targetServer.listen(TARGET_PORT, "0.0.0.0", () => resolve()));

    await execFileAsync(
      "docker",
      ["build", "-f", path.join(REPO_ROOT, "Dockerfile.proxy"), "-t", IMAGE_TAG, REPO_ROOT],
      { timeout: 180_000 },
    );
    await cleanup();
    await execFileAsync("docker", ["network", "create", "--internal", INTERNAL_NET]);
    await execFileAsync("docker", ["network", "create", EGRESS_NET]);

    await execFileAsync("docker", [
      "run", "-d", "--rm", "--name", SIDECAR_NAME,
      "--network", INTERNAL_NET, "--network", EGRESS_NET,
      "--env", `HEIMDALL_CAPABILITY=${CAPABILITY}`,
      "--env", `HEIMDALL_GRANTED_HOSTS=${GRANTED_HOST}`,
      "--env", `HEIMDALL_PERMIT_EXPIRES_AT=${String(Date.now() + 300_000)}`,
      "--env", "HEIMDALL_RUN_ID=sidecar-it", "--env", "HEIMDALL_AGENT_ID=sidecar-it",
      "--env", "HEIMDALL_SIDECAR_PORT=8080",
      IMAGE_TAG,
    ]);

    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const { stdout } = await execFileAsync("docker", ["logs", SIDECAR_NAME]).catch(() => ({ stdout: "" }));
      if (stdout.includes("HEIMDALL_PROXY_READY")) return;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error("sidecar did not become ready in time");
  }, 180_000);

  afterAll(async () => {
    await cleanup();
    await execFileAsync("docker", ["image", "rm", "-f", IMAGE_TAG]).catch(() => {});
    await new Promise<void>((resolve) => targetServer.close(() => resolve()));
  }, 30_000);

  test("an agent-like container on the isolated network has no direct route to the target", async () => {
    await expect(execFileAsync("docker", [
      "run", "--rm", "--network", INTERNAL_NET, "busybox:stable",
      "sh", "-c", `nc -zv -w 2 ${GRANTED_HOST} ${String(TARGET_PORT)}`,
    ])).rejects.toThrow();
  }, 15_000);

  test("...but reaches it THROUGH the sidecar, which enforces the granted-host permit", async () => {
    const request = `CONNECT ${GRANTED_HOST}:${String(TARGET_PORT)} HTTP/1.1\r\n` +
      `Host: ${GRANTED_HOST}:${String(TARGET_PORT)}\r\n` +
      `x-heimdall-capability: ${CAPABILITY}\r\n\r\n`;
    const { stdout } = await execFileAsync("docker", [
      "run", "--rm", "--network", INTERNAL_NET, "busybox:stable",
      "sh", "-c", `printf '${request}' | nc -w 3 ${SIDECAR_NAME} 8080`,
    ]);
    expect(stdout).toContain("200 Connection Established");
    expect(stdout).toContain(TARGET_RESPONSE);
  }, 15_000);

  test("a host outside the permit is denied even through the sidecar", async () => {
    const request = "CONNECT example.com:443 HTTP/1.1\r\n" +
      "Host: example.com:443\r\n" +
      `x-heimdall-capability: ${CAPABILITY}\r\n\r\n`;
    const { stdout } = await execFileAsync("docker", [
      "run", "--rm", "--network", INTERNAL_NET, "busybox:stable",
      "sh", "-c", `printf '${request}' | nc -w 3 ${SIDECAR_NAME} 8080`,
    ]);
    expect(stdout).toContain("403");
    expect(stdout).not.toContain("200 Connection Established");
  }, 15_000);
});
