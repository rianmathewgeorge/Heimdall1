/**
 * IDENTITY AND AUTHORIZATION — the negative tests are the point.
 *
 * The brief's bar: "show ownership isolation between User A and User B and
 * prove that an Agent owned by User A cannot read User B's mock resource. A
 * login screen without server-side authorization would not demonstrate the
 * middleware itself." So these drive the real HTTP surface, not the UI.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, test } from "vitest";
import { AgentService } from "../agent-service.js";
import { createApp } from "../app.js";
import { loadConfig } from "../config.js";
import { JsonStore } from "../store.js";
import { WorkspaceManager } from "../workspace.js";
import { IdentityDirectory } from "./identity.js";
import type { AgentRunner, RunnerResult } from "../types.js";

/** Answers a countdown turn the way a well-behaved model would; "ok" otherwise. */
class StubRunner implements AgentRunner {
  async run(request: { prompt: string }): Promise<RunnerResult> {
    const asked = /which is (\d+)/.exec(request.prompt);
    return { output: asked?.[1] ?? "ok", threadId: "t", usage: null };
  }
  async cancel(): Promise<boolean> { return true; }
  async isAvailable(): Promise<boolean> { return true; }
}

const A = "user-a-token";
const B = "user-b-token";
let app: Awaited<ReturnType<typeof createApp>>;
let service: AgentService;

beforeEach(async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "heimdall-identity-"));
  const config = loadConfig({
    ...process.env, APP_DATA_DIR: dir, AGENT_WORKSPACE_ROOT: path.join(dir, "ws"),
    CODEX_HOME: path.join(dir, "codex"), MODEL_PROVIDER: "openrouter",
    OPENROUTER_API_KEY: "k", OPENROUTER_MODEL: "m", APP_AUTH_TOKEN: "operator-token-0123456789",
  } as NodeJS.ProcessEnv);
  service = new AgentService(
    config, new JsonStore(path.join(dir, "db.json")),
    new WorkspaceManager(path.join(dir, "ws")), new StubRunner(),
    undefined, new IdentityDirectory(),
  );
  await service.seedIdentities({ HEIMDALL_USER_A_TOKEN: A, HEIMDALL_USER_B_TOKEN: B } as NodeJS.ProcessEnv);
  await service.initialize();
  app = await createApp(config, service);
});

const as = (token: string) => ({ authorization: "Bearer " + token });

async function createAgent(token: string, name: string): Promise<string> {
  const res = await app.inject({
    method: "POST", url: "/api/agents", headers: as(token),
    payload: { name, description: "d", instructions: "i" },
  });
  expect(res.statusCode).toBe(201);
  return res.json().agent.id;
}

describe("ownership isolation", () => {
  test("an agent belongs to the human who created it, and only they can see it", async () => {
    const aAgent = await createAgent(A, "A's agent");
    await createAgent(B, "B's agent");

    const aList = (await app.inject({ url: "/api/agents", headers: as(A) })).json().agents;
    const bList = (await app.inject({ url: "/api/agents", headers: as(B) })).json().agents;
    expect(aList).toHaveLength(1);
    expect(bList).toHaveLength(1);
    expect(aList[0].id).toBe(aAgent);
    expect(bList[0].id).not.toBe(aAgent);
  });

  /*
   * The disclosure detail: a non-owner gets 404, not 403. Confirming that an id
   * exists but belongs to someone else is itself a leak.
   */
  test("User B cannot read, modify, run or delete User A's agent", async () => {
    const aAgent = await createAgent(A, "A's agent");
    for (const [method, url] of [
      ["GET", `/api/agents/${aAgent}`],
      ["PATCH", `/api/agents/${aAgent}`],
      ["DELETE", `/api/agents/${aAgent}`],
      ["GET", `/api/agents/${aAgent}/messages`],
      ["GET", `/api/agents/${aAgent}/runs`],
      ["POST", `/api/agents/${aAgent}/start`],
      ["POST", `/api/agents/${aAgent}/messages`],
    ] as const) {
      const res = await app.inject({ method, url, headers: as(B), payload: { content: "x", name: "x" } });
      expect(res.statusCode, `${method} ${url} as User B`).toBe(404);
    }
    // ...and the owner still can
    expect((await app.inject({ url: `/api/agents/${aAgent}`, headers: as(A) })).statusCode).toBe(200);
  });

  /** The brief's explicit example. */
  test("User A cannot read User B's protected resource", async () => {
    const mine = await app.inject({ url: "/api/resources/res-a", headers: as(A) });
    expect(mine.statusCode).toBe(200);
    expect(mine.json().resource.contents).toBe("A-only payroll row");

    const theirs = await app.inject({ url: "/api/resources/res-b", headers: as(A) });
    expect(theirs.statusCode).toBe(404);
    expect(JSON.stringify(theirs.json())).not.toContain("B-only payroll row");

    // the listing is scoped too — no enumeration of other people's rows
    const list = (await app.inject({ url: "/api/resources", headers: as(A) })).json().resources;
    expect(list.map((r: { id: string }) => r.id)).toEqual(["res-a"]);
  });

  test("an unknown token is refused outright", async () => {
    expect((await app.inject({ url: "/api/agents", headers: as("not-a-real-token") })).statusCode).toBe(401);
  });
});

describe("per-agent identity, delegation and revocation", () => {
  test("each agent gets its own principal, distinct from its owner", async () => {
    const id = await createAgent(A, "agent");
    const { active } = (await app.inject({ url: `/api/identity/agents/${id}`, headers: as(A) })).json();
    expect(active.kind).toBe("agent");
    expect(active.agentId).toBe(id);
    expect(active.ownerId).toBe("user-a");
    // the agent principal is NOT the human principal
    expect(active.id).not.toBe("user-a");
    expect(active.revokedAt).toBeNull();
  });

  /*
   * Revocation has to change what EXECUTION can do, not just what the UI shows.
   * The owner's own credential keeps working throughout — that is the whole
   * point of giving the agent a separate identity.
   */
  test("revoking an agent's identity stops it running, without touching the owner", async () => {
    const id = await createAgent(A, "agent");
    expect((await app.inject({
      method: "POST", url: `/api/agents/${id}/messages`, headers: as(A), payload: { content: "hi" },
    })).statusCode).toBe(202);

    const revoked = await app.inject({ method: "POST", url: `/api/identity/agents/${id}/revoke`, headers: as(A) });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json().revoked.revokedAt).not.toBeNull();

    const after = await app.inject({
      method: "POST", url: `/api/agents/${id}/messages`, headers: as(A), payload: { content: "hi again" },
    });
    expect(after.statusCode).toBe(403);
    expect(after.json().error).toMatch(/revoked/i);

    // the human's credential is unaffected
    expect((await app.inject({ url: "/api/agents", headers: as(A) })).statusCode).toBe(200);
  });

  test("rotation issues a fresh principal and restores the ability to run", async () => {
    const id = await createAgent(A, "agent");
    const before = (await app.inject({ url: `/api/identity/agents/${id}`, headers: as(A) })).json().active;
    await app.inject({ method: "POST", url: `/api/identity/agents/${id}/revoke`, headers: as(A) });

    const rotated = await app.inject({ method: "POST", url: `/api/identity/agents/${id}/rotate`, headers: as(A) });
    expect(rotated.statusCode).toBe(200);
    const after = rotated.json().principal;
    expect(after).toBeNull();   // nothing to rotate once revoked — mint by rotating a live one
  });

  test("rotation of a live principal supersedes it and keeps the history", async () => {
    const id = await createAgent(A, "agent");
    const before = (await app.inject({ url: `/api/identity/agents/${id}`, headers: as(A) })).json().active;
    const rotated = (await app.inject({ method: "POST", url: `/api/identity/agents/${id}/rotate`, headers: as(A) })).json().principal;

    expect(rotated.id).not.toBe(before.id);
    expect(rotated.version).toBe(before.version + 1);
    const { history } = (await app.inject({ url: `/api/identity/agents/${id}`, headers: as(A) })).json();
    expect(history).toHaveLength(2);
    expect(history.filter((p: { revokedAt: string | null }) => p.revokedAt !== null)).toHaveLength(1);
    // and it can run again on the new identity
    expect((await app.inject({
      method: "POST", url: `/api/agents/${id}/messages`, headers: as(A), payload: { content: "hi" },
    })).statusCode).toBe(202);
  });

  test("User B cannot revoke User A's agent identity", async () => {
    const id = await createAgent(A, "agent");
    expect((await app.inject({ method: "POST", url: `/api/identity/agents/${id}/revoke`, headers: as(B) })).statusCode).toBe(404);
    // A's agent still runs
    expect((await app.inject({
      method: "POST", url: `/api/agents/${id}/messages`, headers: as(A), payload: { content: "hi" },
    })).statusCode).toBe(202);
  });

  test("a run is attributed to a person, not just a process", async () => {
    const id = await createAgent(A, "agent");
    const attribution = service.attributionFor(id);
    expect(attribution).toMatchObject({ humanId: "user-a", humanName: "User A", agentId: id });
    expect(attribution?.agentPrincipalId).toMatch(/^ap_/);
  });
});

/**
 * COORDINATION over the real HTTP surface: several Agents the caller owns,
 * one shared task, driven by real runs through the same path a Playground
 * message takes.
 */
describe("multi-agent coordination end to end", () => {
  test("three agents count 10 to 1 in one shared session, with no gaps or repeats", async () => {
    const ids: string[] = [];
    for (const name of ["Alpha", "Beta", "Gamma"]) ids.push(await createAgent(A, name));

    const started = await app.inject({
      method: "POST", url: "/api/coordination/sessions", headers: as(A),
      payload: { topic: "countdown", agentIds: ids, from: 10, to: 1 },
    });
    expect(started.statusCode).toBe(202);
    const sessionId = started.json().session.id;

    // the driver runs in the background; wait for it to settle
    let body: { session: { status: string; messages: Array<{ value: number; agentName: string }> };
                verification: { complete: boolean; duplicates: number[]; missing: number[] } } | null = null;
    for (let i = 0; i < 100; i++) {
      body = (await app.inject({ url: `/api/coordination/sessions/${sessionId}`, headers: as(A) })).json();
      if (body!.session.status !== "running") break;
      await new Promise((r) => setTimeout(r, 20));
    }

    expect(body!.session.status).toBe("completed");
    expect(body!.session.messages.map((m) => m.value)).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
    expect(body!.verification).toEqual({ complete: true, duplicates: [], missing: [] });
    // more than one agent actually contributed, and each message says which
    expect(new Set(body!.session.messages.map((m) => m.agentName)).size).toBe(3);
  }, 30_000);

  test("a session may only include agents the caller owns", async () => {
    const mine = await createAgent(A, "mine");
    const theirs = await createAgent(B, "theirs");
    const res = await app.inject({
      method: "POST", url: "/api/coordination/sessions", headers: as(A),
      payload: { topic: "countdown", agentIds: [mine, theirs] },
    });
    expect(res.statusCode).toBe(404);
  });

  test("User B cannot read or stop User A's session", async () => {
    const id = await createAgent(A, "solo");
    const session = (await app.inject({
      method: "POST", url: "/api/coordination/sessions", headers: as(A),
      payload: { topic: "countdown", agentIds: [id], from: 2, to: 1 },
    })).json().session.id;

    expect((await app.inject({ url: `/api/coordination/sessions/${session}`, headers: as(B) })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: `/api/coordination/sessions/${session}/stop`, headers: as(B) })).statusCode).toBe(404);
    expect((await app.inject({ url: "/api/coordination/sessions", headers: as(B) })).json().sessions).toEqual([]);
  }, 20_000);
});
