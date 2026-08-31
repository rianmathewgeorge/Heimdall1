import path from "node:path";
import { AgentService } from "./agent-service.js";
import { createApp } from "./app.js";
import { loadConfig, writeCodexConfig } from "./config.js";
import { createHeimdall, registerHeimdallRoutes } from "./heimdall/index.js";
import { log } from "./heimdall/store.js";
import { JsonStore } from "./store.js";
import { WorkspaceManager } from "./workspace.js";

const config = loadConfig();
await writeCodexConfig(config);

const store = new JsonStore(path.join(config.dataDirectory, "launchpad.json"));
const workspaces = new WorkspaceManager(config.workspaceRoot);
const heimdall = await createHeimdall(config);
await heimdall.start();
const runner = heimdall.runner;
const service = new AgentService(config, store, workspaces, runner);
await service.seedIdentities();
await service.initialize();

const app = await createApp(config, service);
registerHeimdallRoutes(app, heimdall);

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Shutting down");
  await app.close();
  await heimdall.stop();
  await service.shutdown();
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

/*
 * A run executes in the background, so a rejection inside it reaches no caller.
 * Node's default is to print the stack and kill the process — which, observed in
 * a real run, took the whole server down mid-flight and left the run's proxy
 * sidecar still running with the provider key in its environment. Log it, tear
 * the containers down, and exit deliberately instead of abruptly.
 */
const fatal = (kind: string) => (error: unknown) => {
  app.log.error({ err: error, kind }, "unhandled error — shutting down cleanly");
  void shutdown(kind);
};
process.on("unhandledRejection", fatal("unhandledRejection"));
process.on("uncaughtException", fatal("uncaughtException"));

/*
 * Startup failures are not crashes, and must not be reported as one. A port
 * that is already in use is the commonest way to fail to start, and routing it
 * through the uncaughtException handler buried the one useful fact under a
 * stack trace and the words "unhandled error". Say what is wrong and what to do.
 */
try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "EADDRINUSE") {
    log("error", "boot",
      `port ${String(config.port)} is already in use — another server is running.\n` +
      `  Stop it:      lsof -ti tcp:${String(config.port)} | xargs kill\n` +
      `  Or use another port:  PORT=3001 npm start`);
  } else if (code === "EACCES") {
    log("error", "boot",
      `not permitted to bind port ${String(config.port)} — ports below 1024 need elevated privileges. ` +
      "Use PORT=3000 or higher.");
  } else {
    log("error", "boot", `could not start the server: ${(error as Error).message}`);
  }
  await heimdall.stop().catch(() => undefined);
  process.exit(1);
}
