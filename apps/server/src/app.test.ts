import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import type { AgentService } from "./agent-service.js";
import { DEFAULT_PRINCIPAL_ID, IdentityDirectory } from "./heimdall/identity.js";

/**
 * The HTTP boundary now resolves every caller to a PRINCIPAL, so the identity
 * directory is a real dependency of the app, not an optional extra — the stub
 * carries one with the default operator registered, exactly as the service does.
 */
function stubService(token: string): AgentService {
  const identity = new IdentityDirectory();
  identity.addHuman(DEFAULT_PRINCIPAL_ID, "Operator", token || "operator-token");
  return {
    identity,
    listAgents: () => [],
    listAgentsFor: () => [],
    systemInfo: async () => ({}),
  } as unknown as AgentService;
}

describe("HTTP boundary", () => {
  it("protects API routes with the configured shared token", async () => {
    const app = await createApp(
      loadConfig({ NODE_ENV: "test", APP_AUTH_TOKEN: "a-strong-test-token" }),
      stubService("a-strong-test-token"),
    );
    const denied = await app.inject({ method: "GET", url: "/api/agents" });
    expect(denied.statusCode).toBe(401);

    const allowed = await app.inject({
      method: "GET",
      url: "/api/agents",
      headers: { authorization: "Bearer a-strong-test-token" },
    });
    expect(allowed.statusCode).toBe(200);
    await app.close();
  });

  it("preserves Fastify client error status codes", async () => {
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), stubService(""));
    const malformed = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { "content-type": "application/json" },
      payload: "{not-json",
    });
    expect(malformed.statusCode).toBe(400);

    const oversized = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ name: "x".repeat(1_100_000) }),
    });
    expect(oversized.statusCode).toBe(413);
    await app.close();
  });
});

/**
 * A port already in use is the commonest way to fail to start, and it is a
 * STARTUP failure, not a crash. Routing it through the uncaughtException
 * handler buried the one useful fact ("port 3000 is taken") under a stack trace
 * and the words "unhandled error — shutting down cleanly", which reads as if
 * the app broke rather than as if another copy is already running.
 */
describe("startup failures", () => {
  it("reports a port conflict as an actionable message, not a crash", async () => {
    const blocker = createServer(() => {});
    await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", r));
    const port = (blocker.address() as AddressInfo).port;

    const app = await createApp(loadConfig({ NODE_ENV: "test" }), stubService(""));
    let code: string | undefined;
    try {
      await app.listen({ host: "127.0.0.1", port });
    } catch (error) {
      code = (error as NodeJS.ErrnoException).code;
    }
    // listen() REJECTS rather than emitting an unhandled error, which is what
    // lets index.ts translate it into a clear message and a clean exit
    expect(code).toBe("EADDRINUSE");

    await app.close();
    await new Promise<void>((r) => blocker.close(() => r()));
  });
});
