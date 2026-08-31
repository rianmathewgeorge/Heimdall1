/**
 * Regression coverage for a real production bug: the container only ever
 * holds a placeholder credential and relies on the proxy to inject the real
 * one, but the model provider is always reached over HTTPS — which, through
 * an HTTP proxy, means an opaque CONNECT tunnel the proxy cannot read or
 * rewrite at all. Credential injection only ever ran in the plain-HTTP path
 * (handleRequest), which that traffic never took, so the real key never
 * reached the wire and only the placeholder did.
 *
 * The fix routes provider traffic through the proxy as a plain, same-network
 * "direct" (origin-form) request instead — see writeProxiedCodexConfig in
 * config.ts. These tests exercise that path directly against a real HTTP
 * server standing in for the provider, without Docker or TLS.
 */
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, test } from "vitest";
import { normaliseUsage, normaliseStreamLine, createStreamNormaliser, HeimdallProxy, type ProxyHooks } from "./proxy.js";
import type { Permit } from "./types.js";

function makePermit(overrides: Partial<Permit> = {}): Permit {
  return {
    permitId: "p1", runId: "r1", agentId: "a1", termSheetVersion: "t1",
    runTier: "T0", summary: "", verdicts: [],
    grantedWrites: [], grantedReads: [], grantedHosts: [], grantedCommands: [],
    expiresAt: Date.now() + 60_000, requiresHumanApproval: false, denied: false,
    createdAt: new Date().toISOString(), requestHash: "", approvedHash: null,
    capabilityToken: "test-capability-token",
    ...overrides,
  };
}

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function startMockProvider(): Promise<{ port: number; received: () => IncomingSnapshot | null }> {
  let snapshot: IncomingSnapshot | null = null;
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    req.on("end", () => {
      snapshot = { authorization: req.headers.authorization, host: req.headers.host, url: req.url ?? "", body };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { port: (server.address() as AddressInfo).port, received: () => snapshot };
}

interface IncomingSnapshot {
  authorization: string | undefined;
  host: string | undefined;
  url: string;
  body: string;
}

async function startProxy(hooks: ProxyHooks): Promise<number> {
  const proxy = new HeimdallProxy(hooks);
  const port = await proxy.listen(0, "127.0.0.1");
  closers.push(() => proxy.close());
  return port;
}

function post(port: number, path: string, headers: Record<string, string>, body: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path, method: "POST", headers },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => (data += chunk.toString("utf8")));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

describe("HeimdallProxy — direct (origin-form) requests to the model provider", () => {
  it("injects the real credential and rewrites Host, instead of forwarding the container's placeholder", async () => {
    const provider = await startMockProvider();
    const providerHost = `127.0.0.1:${provider.port}`;
    const permit = makePermit({ grantedHosts: ["127.0.0.1"] });

    const proxyPort = await startProxy({
      permitFor: (token) => (token === permit.capabilityToken ? permit : null),
      onDenial: () => undefined,
      providerHost,
      providerKey: "sk-real-secret-key",
      providerScheme: "http",
    });

    const response = await post(
      proxyPort,
      "/api/v1/responses",
      {
        "x-heimdall-capability": permit.capabilityToken,
        // what the container itself actually holds — never the real key
        authorization: "Bearer heimdall.proxy.injected",
        "content-type": "application/json",
      },
      JSON.stringify({ hello: "world" }),
    );

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ ok: true });

    const received = provider.received();
    expect(received?.authorization).toBe("Bearer sk-real-secret-key");
    expect(received?.host).toBe(providerHost);
    expect(received?.url).toBe("/api/v1/responses");
    expect(received?.body).toBe(JSON.stringify({ hello: "world" }));
  });

  it("still denies a direct request when the provider host is not granted by the permit", async () => {
    const provider = await startMockProvider();
    const permit = makePermit({ grantedHosts: ["some-other-host.example.com"] });
    const denials: unknown[] = [];

    const proxyPort = await startProxy({
      permitFor: (token) => (token === permit.capabilityToken ? permit : null),
      onDenial: (_runId, denial) => denials.push(denial),
      providerHost: `127.0.0.1:${provider.port}`,
      providerKey: "sk-real-secret-key",
      providerScheme: "http",
    });

    const response = await post(proxyPort, "/api/v1/responses", { "x-heimdall-capability": permit.capabilityToken }, "{}");

    expect(response.status).toBe(403);
    expect(denials).toHaveLength(1);
    expect(provider.received()).toBeNull();
  });

  it("denies a direct request with no valid capability token, before ever reaching the provider", async () => {
    const provider = await startMockProvider();
    const permit = makePermit({ grantedHosts: ["127.0.0.1"] });

    const proxyPort = await startProxy({
      permitFor: (token) => (token === permit.capabilityToken ? permit : null),
      onDenial: () => undefined,
      providerHost: `127.0.0.1:${provider.port}`,
      providerKey: "sk-real-secret-key",
      providerScheme: "http",
    });

    const response = await post(proxyPort, "/api/v1/responses", { "x-heimdall-capability": "wrong-token" }, "{}");

    expect(response.status).toBe(403);
    expect(provider.received()).toBeNull();
  });
});

/* ══ model-stream normalisation ══ */
describe("model stream normalisation", () => {
  /*
   * VERIFIED against codex-cli 0.111 with a real container: a response.completed
   * whose usage lacks `total_tokens` makes Codex abandon the turn with
   *   "stream disconnected before completion:
   *    failed to parse ResponseCompleted: missing field `total_tokens`"
   * and retry five times before failing the run. OpenRouter's /responses beta
   * does not reliably send a Responses-shaped usage object, which is exactly how
   * every run was failing. See heimdall-stream.integration.test.ts for the
   * end-to-end proof through a real Codex container.
   */
  test("total_tokens is filled in when the provider omits it", () => {
    expect(normaliseUsage({ input_tokens: 5, output_tokens: 3 }))
      .toEqual({ input_tokens: 5, output_tokens: 3, total_tokens: 8 });
  });

  test("chat-completions usage names are mapped to Responses names", () => {
    expect(normaliseUsage({ prompt_tokens: 11, completion_tokens: 4 }))
      .toMatchObject({ input_tokens: 11, output_tokens: 4, total_tokens: 15 });
  });

  test("a usage object that is absent or malformed still yields the required fields", () => {
    for (const bad of [undefined, null, "nope", {}]) {
      expect(normaliseUsage(bad)).toMatchObject({ input_tokens: 0, output_tokens: 0, total_tokens: 0 });
    }
  });

  test("an explicit total_tokens is preserved, not recomputed", () => {
    expect(normaliseUsage({ input_tokens: 1, output_tokens: 1, total_tokens: 99 }).total_tokens).toBe(99);
  });

  test("only response.completed-family events are rewritten", () => {
    const delta = 'data: {"type":"response.output_text.delta","delta":"hi"}';
    expect(normaliseStreamLine(delta)).toBe(delta);
    expect(normaliseStreamLine("event: response.completed")).toBe("event: response.completed");
    expect(normaliseStreamLine("data: [DONE]")).toBe("data: [DONE]");
    expect(normaliseStreamLine("data: not json")).toBe("data: not json");
    const fixed = normaliseStreamLine('data: {"type":"response.completed","response":{"usage":{"input_tokens":2,"output_tokens":2}}}');
    expect(JSON.parse(fixed.slice(5)).response.usage.total_tokens).toBe(4);
  });

  test("the rewriter streams: events are emitted as they arrive, split across chunks", async () => {
    const t = createStreamNormaliser();
    const out: string[] = [];
    t.on("data", (c: Buffer) => out.push(c.toString()));
    // one event delivered in three pieces, then a second event
    t.write('event: response.completed\ndata: {"type":"response.compl');
    expect(out.join("")).toBe("");                       // nothing emitted mid-event
    t.write('eted","response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n');
    await new Promise((r) => setImmediate(r));
    expect(out.join("")).toContain('"total_tokens":2');  // emitted as soon as it completed
    t.end();
    await new Promise((r) => t.on("end", r));
  });
});
