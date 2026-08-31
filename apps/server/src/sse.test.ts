/**
 * The live event stream is the primary progress signal (replacing blind status
 * polling) — this exercises it end to end: HTTP route -> AgentService ->
 * RunEventBus -> SSE framing, including the stream closing itself once the
 * run reaches a terminal stage.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { JsonStore } from "./store.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

class EmittingRunner implements AgentRunner {
  async run(request: RunnerRequest): Promise<RunnerResult> {
    request.emit({ stage: "codex", message: "Starting Codex process" });
    request.emit({ stage: "parsing", message: "Parsed agent output" });
    return { output: "done: " + request.prompt, threadId: "thread-1", usage: null };
  }
  async cancel(): Promise<boolean> {
    return false;
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

async function makeApp() {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-sse-test-"));
  temporaryDirectories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
  });
  const service = new AgentService(
    config,
    new JsonStore(path.join(root, "data", "db.json")),
    new WorkspaceManager(path.join(root, "workspaces")),
    new EmittingRunner(),
  );
  await service.initialize();
  const app = await createApp(config, service);
  return { app, service };
}

function parseSseEvents(payload: string): Array<{ stage: string; appRunId: string; message: string }> {
  return payload
    .split("\n\n")
    .map((block) => block.split("\n").find((line) => line.startsWith("data: ")))
    .filter((line): line is string => Boolean(line))
    .map((line) => JSON.parse(line.slice("data: ".length)) as { stage: string; appRunId: string; message: string });
}

describe("run event stream (SSE)", () => {
  it("streams every lifecycle event for a run and closes once it is terminal", async () => {
    const { app, service } = await makeApp();
    const agent = await service.createAgent({ name: "Streamer" });
    const { run } = await service.sendMessage(agent.id, "build something");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    const response = await app.inject({ method: "GET", url: `/api/runs/${run.id}/events` });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");

    const events = parseSseEvents(response.payload);
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event) => event.appRunId === run.id)).toBe(true);
    expect(events.some((event) => event.stage === "codex")).toBe(true);
    expect(events.some((event) => event.stage === "parsing")).toBe(true);
    expect(events.at(-1)?.stage).toBe("completed");
    await app.close();
  });

  it("supports resuming from a given sequence number", async () => {
    const { app, service } = await makeApp();
    const agent = await service.createAgent({ name: "Resumer" });
    const { run } = await service.sendMessage(agent.id, "build something else");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    const full = parseSseEvents((await app.inject({ method: "GET", url: `/api/runs/${run.id}/events` })).payload);
    const firstSeq = service.getRunEvents(run.id)[0]?.seq ?? 0;

    const resumed = await app.inject({ method: "GET", url: `/api/runs/${run.id}/events?after=${firstSeq}` });
    const resumedEvents = parseSseEvents(resumed.payload);
    expect(resumedEvents.length).toBe(full.length - 1);
    await app.close();
  });

  it("404s for an unknown run id instead of opening a stream", async () => {
    const { app } = await makeApp();
    const response = await app.inject({ method: "GET", url: `/api/runs/${randomUUID()}/events` });
    expect(response.statusCode).toBe(404);
    await app.close();
  });
});
