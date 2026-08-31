/**
 * END-TO-END PROOF of the "stream disconnected before completion" failure.
 *
 * A real codex-cli 0.111 container talks to a real HeimdallProxy, which forwards
 * to a provider that returns a `response.completed` WITHOUT `usage.total_tokens`
 * — the shape OpenRouter's /responses beta actually returns.
 *
 * Unpatched, Codex abandons the turn with
 *   "stream disconnected before completion:
 *    failed to parse ResponseCompleted: missing field `total_tokens`"
 * retries five times, and the run fails with no agent message. That is exactly
 * the bug reported from real OpenRouter runs.
 *
 * Skips itself cleanly when Docker or the runtime image is unavailable.
 */
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { HeimdallProxy } from "./proxy.js";
import type { Permit } from "./types.js";

const execFileAsync = promisify(execFile);
const RUNTIME_IMAGE = process.env["CONTAINER_RUNTIME_IMAGE"] ?? "volc-agent-runtime:local";
const CAP = "c".repeat(64);

let dockerReady = false;
beforeAll(async () => {
  try {
    await execFileAsync("docker", ["image", "inspect", RUNTIME_IMAGE], { timeout: 15_000 });
    dockerReady = true;
  } catch { dockerReady = false; }
}, 30_000);

/** A provider whose usage object omits total_tokens. */
function brokenProvider(): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    let b = ""; req.on("data", (c) => { b += String(c); });
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (o: Record<string, unknown>): void => {
        res.write(`event: ${String(o["type"])}\ndata: ${JSON.stringify(o)}\n\n`);
      };
      const item = {
        type: "message", id: "m1", role: "assistant", status: "completed",
        content: [{ type: "output_text", text: "Hello from the model.", annotations: [] }],
      };
      const response = {
        id: "r1", object: "response", status: "completed", model: "f", output: [item],
        usage: { input_tokens: 5, output_tokens: 3 },   // <-- no total_tokens
      };
      send({ type: "response.created", response: { ...response, status: "in_progress", output: [] } });
      send({ type: "response.output_item.done", output_index: 0, item });
      send({ type: "response.completed", response });
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "0.0.0.0", () => resolve({ server, port: (server.address() as AddressInfo).port }));
  });
}

let provider: Server | null = null;
let proxy: HeimdallProxy | null = null;
afterAll(async () => { await proxy?.close(); provider?.close(); });

describe("model stream normalisation (real codex)", () => {
  test("a provider that omits total_tokens no longer disconnects the stream", async () => {
    if (!dockerReady) { expect(true).toBe(true); return; }

    const { server, port: providerPort } = await brokenProvider();
    provider = server;
    const permit = {
      permitId: "p", runId: "r1", agentId: "a1", grantedHosts: ["127.0.0.1"],
      grantedWrites: [], grantedReads: [], grantedCommands: [],
      expiresAt: Date.now() + 300_000, capabilityToken: CAP,
    } as unknown as Permit;

    proxy = new HeimdallProxy({
      permitFor: (t) => (t === CAP ? permit : null),
      onDenial: () => {},
      providerHost: `127.0.0.1:${providerPort}`,
      providerKey: "the-real-key",
      providerScheme: "http",
    });
    const proxyPort = await proxy.listen(0, "0.0.0.0");

    const home = await mkdtemp(path.join(tmpdir(), "heimdall-ch-"));
    await writeFile(path.join(home, "config.toml"), [
      'model = "test/model"',
      'model_provider = "openrouter"',
      "",
      "[model_providers.openrouter]",
      'name = "OpenRouter"',
      `base_url = "http://host.docker.internal:${proxyPort}/v1"`,
      'env_key = "OPENROUTER_API_KEY"',
      'wire_api = "responses"',
      "requires_openai_auth = false",
      'env_http_headers = { "x-heimdall-capability" = "HEIMDALL_CAPABILITY" }',
      "",
    ].join("\n"), "utf8");
    const ws = await mkdtemp(path.join(tmpdir(), "heimdall-ws-"));

    const out = await new Promise<string>((resolve) => {
      execFile("docker", [
        "run", "--rm", "--add-host", "host.docker.internal:host-gateway",
        "-e", "CODEX_HOME=/codex-home", "-e", "HOME=/tmp",
        // the container holds only a placeholder; the proxy injects the real key
        "-e", "OPENROUTER_API_KEY=heimdall.proxy.injected",
        "-e", `HEIMDALL_CAPABILITY=${CAP}`,
        "-v", `${home}:/codex-home`, "-v", `${ws}:/workspace`, "-w", "/workspace",
        RUNTIME_IMAGE, "codex", "exec", "--json", "--sandbox", "danger-full-access",
        "--skip-git-repo-check", "say hello",
      ], { timeout: 120_000 }, (_e, so, se) => resolve(String(so) + String(se)));
    });

    expect(out).not.toContain("stream disconnected before completion");
    expect(out).toContain('"type":"agent_message"');
    expect(out).toContain("Hello from the model.");
  }, 180_000);
});
