import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import { HttpError } from "./errors.js";
import type { AgentRun } from "./types.js";
import { buildTrace, criticalPath, firstFailure, traceIdFor } from "./heimdall/trace.js";
import { listDirectory, readFilePreview, searchFiles, WorkspacePathError } from "./files.js";
import type { AgentService } from "./agent-service.js";
import { DEFAULT_PRINCIPAL_ID, type HumanPrincipal } from "./heimdall/identity.js";

/** The authenticated human, attached by the onRequest hook. */
declare module "fastify" {
  interface FastifyRequest {
    principal?: HumanPrincipal;
  }
}
import type { RunEvent } from "./types.js";

const agentIdParams = z.object({ id: z.string().uuid() });
const runIdParams = z.object({ id: z.string().uuid() });
const isTerminalStatus = (status: string): boolean =>
  status === "completed" || status === "failed" || status === "cancelled";
const isTerminalStage = (stage: string): boolean =>
  stage === "completed" || stage === "failed" || stage === "cancelled";
const createAgentBody = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).optional(),
  instructions: z.string().max(10_000).optional(),
});
const updateAgentBody = createAgentBody.partial().refine(
  (value) => Object.keys(value).length > 0,
  "At least one field is required",
);
const messageBody = z.object({
  content: z.string().trim().min(1).max(50_000),
});

export async function createApp(
  config: AppConfig,
  service: AgentService,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: ["req.headers.authorization", "req.headers.cookie"],
    },
    bodyLimit: 1_048_576,
  });

  await app.register(cors, {
    origin:
      config.nodeEnv === "development"
        ? ["http://localhost:5173", "http://127.0.0.1:5173"]
        : false,
  });

  /*
   * Resolve the caller to a HUMAN PRINCIPAL, not merely "authenticated".
   * Everything downstream authorizes against `request.principal`, so a request
   * can only ever reach the resources that person owns. The legacy shared
   * APP_AUTH_TOKEN still works and maps to the default operator, which keeps
   * single-user setups running unchanged.
   */
  app.addHook("onRequest", async (request, reply) => {
    if (
      !request.url.startsWith("/api/") ||
      request.url === "/api/health" ||
      request.url === "/api/auth"
    ) {
      return;
    }
    const header = request.headers.authorization ?? "";
    const candidate = header.startsWith("Bearer ") ? header.slice(7) : "";

    const human = service.identity.resolveHuman(candidate);
    if (human !== null) {
      request.principal = human;
      return;
    }

    if (!config.authToken) {
      // no auth configured: everything acts as the default operator, but it is
      // still a named principal so attribution and ownership still work
      const fallback = service.identity.human(DEFAULT_PRINCIPAL_ID);
      if (fallback !== undefined) { request.principal = fallback; return; }
      return reply.code(500).send({ error: "identity directory is not initialised" });
    }

    const expectedBuffer = Buffer.from(config.authToken);
    const candidateBuffer = Buffer.from(candidate);
    const valid =
      candidateBuffer.length === expectedBuffer.length &&
      timingSafeEqual(candidateBuffer, expectedBuffer);
    if (!valid) {
      return reply.code(401).send({ error: "Authentication required" });
    }
    const fallback = service.identity.human(DEFAULT_PRINCIPAL_ID);
    if (fallback === undefined) return reply.code(500).send({ error: "identity directory is not initialised" });
    request.principal = fallback;
  });

  /** The authenticated human for this request. Routes must never skip this. */
  const who = (request: FastifyRequest): HumanPrincipal => {
    if (request.principal === undefined) throw new HttpError(401, "Authentication required");
    return request.principal;
  };

  app.get("/api/health", async () => ({
    ok: true,
    service: "volc-agent-launchpad",
  }));

  app.get("/api/auth", async () => ({ required: config.authToken.length > 0 }));

  app.get("/api/system", async () => service.systemInfo());

  app.get("/api/agents", async (request) => ({ agents: service.listAgentsFor(who(request)) }));

  app.post("/api/agents", async (request, reply) => {
    const body = createAgentBody.parse(request.body);
    const agent = await service.createAgent(body, who(request).id);
    return reply.code(201).send({ agent });
  });

  app.get("/api/agents/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { agent: service.requireOwnedAgent(id, who(request)) };
  });

  app.patch("/api/agents/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    const body = updateAgentBody.parse(request.body);
    service.requireOwnedAgent(id, who(request));
    return { agent: await service.updateAgent(id, body) };
  });

  app.delete("/api/agents/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    service.requireOwnedAgent(id, who(request));
    return service.deleteAgent(id);
  });

  app.post("/api/agents/:id/start", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    service.requireOwnedAgent(id, who(request));
    return { agent: await service.startAgent(id) };
  });

  app.post("/api/agents/:id/stop", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    service.requireOwnedAgent(id, who(request));
    return { agent: await service.stopAgent(id) };
  });

  app.get("/api/agents/:id/messages", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    service.requireOwnedAgent(id, who(request));
    return { messages: service.getMessages(id) };
  });

  app.get("/api/agents/:id/runs", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    service.requireOwnedAgent(id, who(request));
    return { runs: service.getRuns(id) };
  });

  app.post("/api/agents/:id/messages", async (request, reply) => {
    const { id } = agentIdParams.parse(request.params);
    const body = messageBody.parse(request.body);
    service.requireOwnedAgent(id, who(request));
    const result = await service.sendMessage(id, body.content);
    return reply.code(202).send(result);
  });

  /** A run is reachable only through the agent that owns it. */
  const ownedRun = (id: string, request: FastifyRequest): AgentRun => {
    const run = service.getRun(id);
    service.requireOwnedAgent(run.agentId, who(request));
    return run;
  };

  /*
   * Mock protected records. They exist so ownership isolation can be PROVEN:
   * User A reading User B's record gets 404 from the backend, regardless of
   * what any UI would allow.
   */
  const resourceIdParams = z.object({ id: z.string().trim().min(1).max(64) });

  /* ─────────────── trace and observability ─────────────── */

  /**
   * A run's trace: spans with ids, categories, durations and status, derived
   * from the run's own event stream so there is no second source of truth.
   */
  app.get("/api/traces/:id", async (request, reply) => {
    const { id } = runIdParams.parse(request.params);
    ownedRun(id, request);
    const trace = buildTrace(id, service.events.events(id));
    if (trace === null) return reply.code(404).send({ error: "No trace for that run" });
    return {
      trace,
      criticalPath: criticalPath(trace),
      firstFailure: firstFailure(trace),
    };
  });

  /** Machine-readable export of the whole trace, for an external backend. */
  app.get("/api/traces/:id/export", async (request, reply) => {
    const { id } = runIdParams.parse(request.params);
    ownedRun(id, request);
    const trace = buildTrace(id, service.events.events(id));
    if (trace === null) return reply.code(404).send({ error: "No trace for that run" });
    return reply
      .header("content-disposition", `attachment; filename="trace-${id}.json"`)
      .send(trace);
  });

  /** The run list a trace UI needs: newest first, with status and duration. */
  app.get("/api/traces", async (request) => {
    const me = who(request);
    const mine = new Set(service.listAgentsFor(me).map((a) => a.id));
    const runs = service.listAllRuns().filter((r: AgentRun) => mine.has(r.agentId));
    return {
      traces: runs.slice(-100).reverse().map((r: AgentRun) => ({
        appRunId: r.id,
        traceId: traceIdFor(r.id),
        agentId: r.agentId,
        status: r.status,
        stage: r.stage,
        startedAt: r.startedAt,
        completedAt: r.completedAt,
        durationMs: r.startedAt !== null && r.completedAt !== null
          ? Date.parse(r.completedAt) - Date.parse(r.startedAt) : null,
        usage: r.usage,
        error: r.error,
      })),
    };
  });

  /* ─────────────── multi-agent coordination ─────────────── */

  const sessionBody = z.object({
    topic: z.string().trim().min(1).max(120).default("countdown"),
    agentIds: z.array(z.string().uuid()).min(1).max(8),
    from: z.number().int().min(1).max(100).default(10),
    to: z.number().int().min(0).max(99).default(1),
  });

  app.post("/api/coordination/sessions", async (request, reply) => {
    const me = who(request);
    const body = sessionBody.parse(request.body);
    // every participant must be one the caller actually owns
    const participants = body.agentIds.map((id) => {
      const agent = service.requireOwnedAgent(id, me);
      return { agentId: agent.id, name: agent.name };
    });
    const session = service.coordinator.create({
      topic: body.topic, ownerId: me.id, participants, from: body.from, to: body.to,
    });
    // drive it in the background; the client watches via GET
    void service.runCoordination(session.id).catch(() => undefined);
    return reply.code(202).send({ session });
  });

  app.get("/api/coordination/sessions", async (request) => ({
    sessions: service.coordinator.forOwner(who(request).id),
  }));

  app.get("/api/coordination/sessions/:id", async (request, reply) => {
    const { id } = resourceIdParams.parse(request.params);
    const session = service.coordinator.get(id);
    if (session === undefined || session.ownerId !== who(request).id) {
      return reply.code(404).send({ error: "Session not found" });
    }
    return { session, verification: service.coordinator.verify(session) };
  });

  app.post("/api/coordination/sessions/:id/stop", async (request, reply) => {
    const { id } = resourceIdParams.parse(request.params);
    const session = service.coordinator.get(id);
    if (session === undefined || session.ownerId !== who(request).id) {
      return reply.code(404).send({ error: "Session not found" });
    }
    return { session: service.coordinator.stop(id) };
  });

  /* ─────────────── identity plane ─────────────── */

  app.get("/api/identity/me", async (request) => {
    const me = who(request);
    return { principal: { id: me.id, displayName: me.displayName, kind: me.kind } };
  });

  /** The agent's own principals — current and revoked — for audit. */
  app.get("/api/identity/agents/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    service.requireOwnedAgent(id, who(request));
    return {
      active: service.identity.activeFor(id),
      history: service.identity.forAgent(id),
    };
  });

  /**
   * Revoke an agent's execution authority. The owner's own credential is
   * untouched; the agent simply stops being able to run.
   */
  app.post("/api/identity/agents/:id/revoke", async (request, reply) => {
    const { id } = agentIdParams.parse(request.params);
    service.requireOwnedAgent(id, who(request));
    const active = service.identity.activeFor(id);
    if (active === null) return reply.code(409).send({ error: "Agent has no active principal" });
    const revoked = service.identity.revoke(active.id);
    await service.persistPrincipals();
    return { revoked };
  });

  /** Rotate: revoke the current principal and mint a successor. */
  app.post("/api/identity/agents/:id/rotate", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    service.requireOwnedAgent(id, who(request));
    const next = service.identity.rotate(id);
    await service.persistPrincipals();
    return { principal: next };
  });

  app.get("/api/resources", async (request) => ({
    resources: service.listResourcesFor(who(request)),
  }));

  app.get("/api/resources/:id", async (request) => {
    const { id } = resourceIdParams.parse(request.params);
    return { resource: service.readResource(id, who(request)) };
  });

  app.get("/api/runs/:id", async (request) => {
    const { id } = runIdParams.parse(request.params);
    return { run: ownedRun(id, request) };
  });

  app.get("/api/runs/:id/logs", async (request) => {
    const { id } = runIdParams.parse(request.params);
    const run = ownedRun(id, request);
    return { logs: run.logs };
  });

  app.get("/api/runs/:id/changes", async (request) => {
    const { id } = runIdParams.parse(request.params);
    const run = ownedRun(id, request);
    return { changes: run.fileChanges ?? [] };
  });

  app.post("/api/runs/:id/cancel", async (request) => {
    const { id } = runIdParams.parse(request.params);
    return { run: await service.cancelRun(id) };
  });

  app.post("/api/runs/:id/retry", async (request, reply) => {
    const { id } = runIdParams.parse(request.params);
    const result = await service.retryRun(id);
    return reply.code(202).send(result);
  });

  /**
   * Live run events over SSE — the primary progress signal (see events.ts).
   * Replays buffered events since `?after=<seq>` for resume, then streams new
   * ones. Closes the stream itself once the run reaches a terminal stage, so
   * a finished run's connection does not linger and a test client can await
   * the whole response instead of managing an open socket.
   */
  app.get("/api/runs/:id/events", async (request, reply) => {
    const { id } = runIdParams.parse(request.params);
    const { after } = z.object({ after: z.coerce.number().int().optional() }).parse(request.query);
    const run = service.getRun(id); // throws 404 before we touch the raw response

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const write = (event: RunEvent): void => {
      reply.raw.write(`id: ${event.seq}\n`);
      reply.raw.write("event: run-event\n");
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    for (const event of service.getRunEvents(id, after ?? -1)) write(event);

    if (isTerminalStatus(run.status)) {
      reply.raw.end();
      return;
    }

    const heartbeat = setInterval(() => reply.raw.write(": heartbeat\n\n"), 15_000);
    heartbeat.unref();
    const close = (): void => {
      clearInterval(heartbeat);
      unsubscribe();
      reply.raw.end();
    };
    const unsubscribe = service.subscribeToRun(id, (event) => {
      write(event);
      if (isTerminalStage(event.stage)) close();
    });
    request.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  app.get("/api/agents/:id/files/tree", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    const { path: relPath } = z.object({ path: z.string().default("") }).parse(request.query);
    const agent = service.getAgent(id);
    try {
      return { entries: await listDirectory(agent.workspacePath, relPath) };
    } catch (error) {
      if (error instanceof WorkspacePathError) throw new HttpError(400, error.message);
      throw error;
    }
  });

  app.get("/api/agents/:id/files/search", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    const { q } = z.object({ q: z.string().default("") }).parse(request.query);
    const agent = service.getAgent(id);
    return { paths: await searchFiles(agent.workspacePath, q) };
  });

  app.get("/api/agents/:id/files/content", async (request, reply) => {
    const { id } = agentIdParams.parse(request.params);
    const { path: relPath } = z.object({ path: z.string().min(1) }).parse(request.query);
    const agent = service.getAgent(id);
    try {
      return { file: await readFilePreview(agent.workspacePath, relPath) };
    } catch (error) {
      if (error instanceof WorkspacePathError) throw new HttpError(400, error.message);
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return reply.code(404).send({ error: "File not found" });
      }
      throw error;
    }
  });

  if (config.nodeEnv === "production") {
    const webRoot = fileURLToPath(new URL("../../web/dist", import.meta.url));
    await app.register(fastifyStatic, {
      root: webRoot,
      prefix: "/",
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) {
        return reply.code(404).send({ error: "API route not found" });
      }
      return reply.sendFile("index.html");
    });
  }

  app.setErrorHandler((error, request, reply) => {
    const appError = error instanceof Error ? error : new Error(String(error));
    const validationError = error instanceof z.ZodError;
    const frameworkStatus =
      typeof (error as { statusCode?: unknown }).statusCode === "number"
        ? (error as { statusCode: number }).statusCode
        : null;
    const statusCode =
      error instanceof HttpError
        ? error.statusCode
        : validationError
          ? 400
          : frameworkStatus && frameworkStatus >= 400 && frameworkStatus <= 599
            ? frameworkStatus
            : 500;
    if (statusCode >= 500) {
      request.log.error(appError);
    }
    return reply.code(statusCode).send({
      error: appError.message,
      ...(validationError ? { details: error.issues } : {}),
    });
  });

  return app;
}
