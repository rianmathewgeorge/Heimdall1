import { mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { loadConfig } from "./config.js";
import { RuntimeExitError } from "./errors.js";
import { JsonStore } from "./store.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

class FakeRunner implements AgentRunner {
  async run(request: RunnerRequest): Promise<RunnerResult> {
    return {
      output: "Completed: " + request.prompt,
      threadId: request.threadId ?? "fake-thread",
      usage: { inputTokens: 12, outputTokens: 5 },
    };
  }
  async cancel(): Promise<boolean> {
    return false;
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function makeService(
  runner: AgentRunner = new FakeRunner(),
  envOverrides: Partial<Record<string, string>> = {},
): Promise<AgentService> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-test-"));
  temporaryDirectories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
    ...envOverrides,
  });
  const service = new AgentService(
    config,
    new JsonStore(path.join(root, "data", "db.json")),
    new WorkspaceManager(path.join(root, "workspaces")),
    runner,
  );
  await service.initialize();
  return service;
}

describe("Agent lifecycle", () => {
  it("creates, updates, stops, starts and deletes an Agent", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Builder" });
    expect(service.listAgents()).toHaveLength(1);
    expect((await service.updateAgent(agent.id, { description: "Builds apps" })).description)
      .toBe("Builds apps");
    expect((await service.stopAgent(agent.id)).status).toBe("stopped");
    expect((await service.startAgent(agent.id)).status).toBe("ready");
    await service.deleteAgent(agent.id);
    expect(service.listAgents()).toHaveLength(0);
  });

  it("persists a playground conversation", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Coder" });
    const { run } = await service.sendMessage(agent.id, "write hello world");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    const messages = service.getMessages(agent.id);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages[1]?.content).toContain("write hello world");
    expect(service.getAgent(agent.id).codexThreadId).toBe("fake-thread");
  });

  it("atomically accepts only one concurrent run per Agent", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const runner: AgentRunner = {
      run: () => pending,
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Concurrent" });
    const attempts = await Promise.allSettled([
      service.sendMessage(agent.id, "first"),
      service.sendMessage(agent.id, "second"),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find((attempt) => attempt.status === "rejected");
    expect(rejected).toMatchObject({ reason: { statusCode: 409 } });
    expect(service.getMessages(agent.id)).toHaveLength(1);

    finish({ output: "done", threadId: "thread", usage: null });
    const accepted = attempts.find((attempt) => attempt.status === "fulfilled");
    if (accepted?.status === "fulfilled") {
      await expect.poll(() => service.getRun(accepted.value.run.id).status).toBe("completed");
    }
  });

  it("does not let start reset a busy Agent and admit a second run", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const service = await makeService({
      run: () => pending,
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Busy" });
    const { run } = await service.sendMessage(agent.id, "first");

    await expect(service.startAgent(agent.id)).rejects.toMatchObject({ statusCode: 409 });
    await expect(service.sendMessage(agent.id, "second")).rejects.toMatchObject({
      statusCode: 409,
    });

    finish({ output: "done", threadId: "thread", usage: null });
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
  });

  it("persists the full causal error chain, exit code and logs when a run fails", async () => {
    const cause = new Error("Failed to shutdown rollout recorder");
    const runtimeError = new RuntimeExitError(
      "Codex exited with code 1: Failed to shutdown rollout recorder",
      { exitCode: 1, containerName: "heimdall-exec-abc", stdout: "step 1\nstep 2\n", stderr: "Failed to shutdown rollout recorder\n", cause },
    );
    const runner: AgentRunner = {
      run: async () => { throw runtimeError; },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Failer" });
    const { run } = await service.sendMessage(agent.id, "break the runtime");
    await expect.poll(() => service.getRun(run.id).status).toBe("failed");

    const persisted = service.getRun(run.id);
    expect(persisted.error).toContain("exited with code 1");
    expect(persisted.errorDetail?.message).toContain("exited with code 1");
    expect(persisted.errorDetail?.cause?.message).toBe("Failed to shutdown rollout recorder");
    expect(persisted.exitCode).toBe(1);
    expect(persisted.containerName).toBe("heimdall-exec-abc");
    expect(persisted.logs?.stdout).toContain("step 1");
    expect(persisted.logs?.stderr).toContain("Failed to shutdown rollout recorder");
    expect(persisted.timeline.at(-1)).toMatchObject({ stage: "failed", status: "failed" });
    expect(service.getAgent(agent.id).status).toBe("error");
  });

  it("records the files a run added, modified, and deleted", async () => {
    const runner: AgentRunner = {
      run: async (request) => {
        await writeFile(path.join(request.workspacePath, "new-file.txt"), "hello\nworld\n", "utf8");
        return { output: "done", threadId: null, usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Writer" });
    const { run } = await service.sendMessage(agent.id, "add a file");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    const changes = service.getRun(run.id).fileChanges ?? [];
    const added = changes.find((change) => change.path === "new-file.txt");
    expect(added).toMatchObject({ kind: "added", diffAvailable: true });
    expect(added?.diff?.some((hunk) => hunk.added === true && hunk.value.includes("hello"))).toBe(true);
  });

  it("emits a live event stream that a subscriber can observe as the run progresses", async () => {
    const runner: AgentRunner = {
      run: async (request) => {
        request.emit({ stage: "codex", message: "Starting Codex process" });
        request.emit({ stage: "parsing", message: "Parsed agent output" });
        return { output: "done", threadId: null, usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Streamer" });
    const seen: string[] = [];
    const { run } = await service.sendMessage(agent.id, "stream events");
    const unsubscribe = service.subscribeToRun(run.id, (event) => seen.push(event.stage));
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    unsubscribe();

    expect(seen).toContain("codex");
    expect(seen).toContain("parsing");
    expect(seen.at(-1)).toBe("completed");
    // the buffered history is available for a client that subscribes late (e.g. an SSE reconnect)
    expect(service.getRunEvents(run.id).map((event) => event.stage)).toEqual(seen);
  });

  it("force-terminates a run that has exceeded the maximum run age, as a safety net", async () => {
    const runner: AgentRunner = {
      run: () => new Promise(() => {}), // never resolves — simulates a hung child process
      cancel: async () => true,
      isAvailable: async () => true,
    };
    const service = await makeService(runner, { RUN_MAX_AGE_MS: "60000" });
    const agent = await service.createAgent({ name: "Stuck" });
    const { run } = await service.sendMessage(agent.id, "hang forever");

    const backdoor = service as unknown as {
      store: JsonStore;
      sweepStuckRuns(): Promise<void>;
    };
    await backdoor.store.mutate((database) => {
      const storedRun = database.runs.find((item) => item.id === run.id);
      if (storedRun) storedRun.createdAt = new Date(Date.now() - 120_000).toISOString();
    });
    await backdoor.sweepStuckRuns();

    const finished = service.getRun(run.id);
    expect(finished.status).toBe("failed");
    expect(finished.error).toMatch(/maximum duration/i);
    expect(finished.timeline.at(-1)).toMatchObject({ stage: "failed" });
    expect(service.getAgent(agent.id).status).toBe("error");

    // a normal completion arriving late must not resurrect an already-closed run
    await backdoor.sweepStuckRuns();
    expect(service.getRun(run.id).status).toBe("failed");
  });
});
