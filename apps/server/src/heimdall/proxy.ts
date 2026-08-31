/**
 * HEIMDALL — egress broker.
 *
 * The container runs on an internal network with no route out. Its ONLY path to
 * the network is this proxy, which:
 *   1. enforces the permit's host allowlist (deny by default — no permit, nothing leaves)
 *   2. injects the real Ark credential, so the agent container never holds it
 *   3. inspects plain-HTTP payloads for credential-shaped values
 *   4. emits a counterfactual receipt for every blocked request
 *
 * LIMITATION (documented, not hidden): for CONNECT tunnels the body is TLS-encrypted
 * and opaque to us, so payload inspection applies to the Ark path (which we terminate)
 * and to plain HTTP. Host-level enforcement applies to everything.
 */
import { timingSafeEqual } from "node:crypto";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { Transform } from "node:stream";
import type { Denial, Permit } from "./types.js";
import { findSecret, redact } from "./engine.js";
import { log } from "./store.js";
import { PLATFORM_TELEMETRY_HOSTS } from "./termsheet.js";


/* ───────────────── model-stream normalisation ───────────────── */

/**
 * Codex's Responses-API client REFUSES a `response.completed` whose `usage` is
 * missing `total_tokens`, and reports it as:
 *
 *   stream disconnected before completion:
 *   failed to parse ResponseCompleted: missing field `total_tokens`
 *
 * It then retries the whole turn five times and gives up. VERIFIED against
 * codex-cli 0.111 by replaying a stream without the field.
 *
 * OpenRouter's /responses endpoint is beta and does not reliably send a
 * Responses-shaped usage object, which is why every run failed this way. We
 * already terminate the model channel, so we repair the event in flight: fill
 * in the canonical field names, mapping the chat-completions spellings when
 * that is what arrived. Nothing else in the stream is touched.
 */
export function normaliseUsage(value: unknown): Record<string, unknown> {
  const u = (value !== null && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const num = (...keys: string[]): number => {
    for (const k of keys) if (typeof u[k] === "number") return u[k] as number;
    return 0;
  };
  const input = num("input_tokens", "prompt_tokens");
  const output = num("output_tokens", "completion_tokens");
  const total = typeof u["total_tokens"] === "number" ? (u["total_tokens"] as number) : input + output;
  return { ...u, input_tokens: input, output_tokens: output, total_tokens: total };
}

/** Repairs one SSE `data:` payload. Returns the line unchanged when irrelevant. */
export function normaliseStreamLine(line: string): string {
  if (!line.startsWith("data:")) return line;
  const raw = line.slice(5).trim();
  if (raw === "" || raw === "[DONE]") return line;
  let event: Record<string, unknown>;
  try { event = JSON.parse(raw) as Record<string, unknown>; } catch { return line; }
  const type = event["type"];
  if (typeof type !== "string" || !/^response\.(completed|incomplete|failed)$/.test(type)) return line;
  const response = event["response"];
  if (response === null || typeof response !== "object") return line;
  const fixed = { ...event, response: { ...(response as Record<string, unknown>), usage: normaliseUsage((response as Record<string, unknown>)["usage"]) } };
  return "data: " + JSON.stringify(fixed);
}

/**
 * Streaming SSE rewriter. Holds only the current partial event, so the stream
 * still arrives incrementally -- buffering it whole would stall the agent.
 */
export function createStreamNormaliser(): Transform {
  let buffer = "";
  const flushEvents = (final: boolean): string => {
    const parts = buffer.split(/\n\n/);
    buffer = final ? "" : parts.pop() ?? "";
    if (parts.length === 0) return "";
    return parts.map((ev) => ev.split(/\n/).map(normaliseStreamLine).join("\n")).join("\n\n") + "\n\n";
  };
  return new Transform({
    transform(chunk, _enc, cb) {
      buffer += (chunk as Buffer).toString("utf8");
      cb(null, flushEvents(false));
    },
    flush(cb) { cb(null, buffer === "" ? "" : flushEvents(true)); },
  });
}

export interface EgressDecision {
  allow: boolean;
  rule: string;
  detail: string;
}

/** Pure decision function — unit-testable without a socket. */
export function decideEgress(
  permit: Permit | null, host: string, bodySample: string | null,
): EgressDecision {
  const clean = host.toLowerCase().replace(/:\d+$/, "");
  if (permit === null) {
    return { allow: false, rule: "P-00", detail: "no valid capability presented — deny by default" };
  }
  if (Date.now() > permit.expiresAt) {
    return { allow: false, rule: "P-09", detail: "permit expired" };
  }
  if (!permit.grantedHosts.includes(clean)) {
    return { allow: false, rule: "P-07", detail: `host "${clean}" is not in the permit` };
  }
  if (bodySample !== null) {
    const match = findSecret(bodySample);
    if (match !== null) {
      return { allow: false, rule: "P-11", detail: `credential-shaped value in the request body (${match.context})` };
    }
  }
  return { allow: true, rule: "P-OK", detail: `host "${clean}" granted by permit` };
}

export interface ProxyHooks {
  /** Resolves a permit from the unguessable per-run capability token. */
  permitFor(capabilityToken: string): Permit | null;
  onDenial(runId: string, denial: Denial): void;
  providerHost: string;
  providerKey: string;
  /**
   * Scheme used to reach providerHost for an origin-form request (one whose
   * request line is a bare path, not an absolute URI or CONNECT authority).
   * Real deployments always reach the real provider over "https"; tests can
   * point this at a plain local server instead.
   */
  providerScheme: "http" | "https";
  /**
   * This proxy's own address, as clients on `network` name it (the sidecar's
   * `--name`) — NOT necessarily reachable through NO_PROXY: a client whose
   * base_url is pointed here but which also honours HTTP(S)_PROXY for that
   * same host (Codex does — see buildHeimdallRunArgs) can still emit an
   * absolute-URI request-line naming this address as if it were forwarding to
   * a third party, regardless of NO_PROXY. When the resolved authority is
   * this value, handleRequest unwraps it exactly like an origin-form request
   * instead of treating "ourselves" as the destination (which no permit ever
   * grants). Omit only in tests that never construct such a request.
   */
  selfHost?: string;
}

const CAPABILITY_HEADER = "x-heimdall-capability";

/** Constant-time token comparison. Never compare capabilities with ===. */
export function capabilityMatches(presented: string, expected: string): boolean {
  if (presented.length !== expected.length || presented.length === 0) return false;
  return timingSafeEqual(Buffer.from(presented), Buffer.from(expected));
}

export class HeimdallProxy {
  private server: http.Server | null = null;

  constructor(private readonly hooks: ProxyHooks) {}

  async listen(port: number, host = "0.0.0.0"): Promise<number> {
    const server = http.createServer((req, res) => void this.handleRequest(req, res));
    server.on("connect", (req, socket, head) => this.handleConnect(req, socket as net.Socket, head));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => resolve());
    });
    this.server = server;
    const address = server.address();
    return typeof address === "object" && address !== null ? address.port : port;
  }

  async close(): Promise<void> {
    if (this.server === null) return;
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
    this.server = null;
  }

  private capabilityOf(req: http.IncomingMessage): string {
    const header = req.headers[CAPABILITY_HEADER];
    return typeof header === "string" ? header : "";
  }

  private refuse(
    runId: string, res: http.ServerResponse | net.Socket, host: string,
    decision: EgressDecision, attempted: string | null, isSocket: boolean,
  ): void {
    const clean = host.toLowerCase().replace(/:\d+$/, "");
    const denial: Denial = {
      at: new Date().toISOString(),
      rule: decision.rule, op: "NET", target: host,
      ...(PLATFORM_TELEMETRY_HOSTS.includes(clean) ? { platform: true } : {}),
      detail: decision.detail,
      attempted: attempted === null ? null : redact(attempted).slice(0, 800),
      sent: false,
    };
    this.hooks.onDenial(runId, denial);
    log("deny", runId, `egress blocked ${host}`, { rule: decision.rule, detail: decision.detail });
    if (isSocket) (res as net.Socket).end("HTTP/1.1 403 Forbidden\r\n\r\n");
    else {
      const r = res as http.ServerResponse;
      r.writeHead(403, { "content-type": "application/json" });
      r.end(JSON.stringify({ error: "HEIMDALL: egress denied", rule: decision.rule, detail: decision.detail }));
    }
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const capability = this.capabilityOf(req);
    const permit = this.hooks.permitFor(capability);
    const runId = permit?.runId ?? "unknown";
    const requestLine = req.url ?? "";
    const toProvider = (pathAndSearch: string): URL =>
      new URL(pathAndSearch, `${this.hooks.providerScheme}://${this.hooks.providerHost}`);
    let target: URL;
    try {
      if (!requestLine.startsWith("/")) {
        // Absolute-URI request line: ordinarily a genuine forward-proxy
        // request (HTTP_PROXY/HTTPS_PROXY) naming some third-party host.
        const asAbsolute = new URL(requestLine);
        target = this.hooks.selfHost !== undefined && asAbsolute.hostname.toLowerCase() === this.hooks.selfHost.toLowerCase()
          // ...except when its authority is OUR OWN address — see
          // ProxyHooks.selfHost. Unwrap it exactly like origin-form: resolve
          // against the real provider, not "ourselves".
          ? toProvider(asAbsolute.pathname + asAbsolute.search)
          : asAbsolute;
      } else {
        // Origin-form request (a bare path, no absolute URI or authority): the
        // only thing with a reason to talk to this server's own address
        // directly is a provider client whose base_url has been pointed here
        // (see writeProxiedCodexConfig) — resolve it against the real
        // provider, not the proxy's own host, which is all `req.headers.host`
        // would give us.
        target = toProvider(requestLine);
      }
    } catch {
      res.writeHead(400).end("HEIMDALL: unparseable request target");
      return;
    }

    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of req) {
      const buf = chunk as Buffer;
      bytes += buf.byteLength;
      if (bytes <= 256 * 1024) chunks.push(buf);
    }
    const body = Buffer.concat(chunks);
    const sample = body.subarray(0, 64 * 1024).toString("utf8");

    const decision = decideEgress(permit, target.host, sample);
    if (!decision.allow) {
      this.refuse(runId, res, target.host, decision, `${req.method} ${target.href}\n\n${sample.slice(0, 400)}`, false);
      return;
    }

    const headers: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined) continue;
      if (k === "proxy-connection" || k === CAPABILITY_HEADER) continue;
      headers[k] = v;
    }
    // The agent container never holds the real key — Heimdall injects it here.
    // Compared on the full authority (not just hostname) so a providerHost
    // that carries a non-default port (as tests do) still matches correctly.
    if (target.host.toLowerCase() === this.hooks.providerHost.toLowerCase() && this.hooks.providerKey !== "") {
      headers["authorization"] = "Bearer " + this.hooks.providerKey;
    }
    // The incoming Host header names this proxy's own address, not the real
    // destination — a Host mismatch can get a Cloudflare-fronted API routed
    // to the wrong backend (or rejected outright), so it must be rewritten.
    headers["host"] = target.host;

    const client = target.protocol === "https:" ? https : http;
    const defaultPort = target.protocol === "https:" ? 443 : 80;
    const upstream = client.request(
      { hostname: target.hostname, port: target.port || defaultPort, path: target.pathname + target.search, method: req.method, headers },
      (up) => {
        const isProvider = target.host.toLowerCase() === this.hooks.providerHost.toLowerCase();
        const isEventStream = String(up.headers["content-type"] ?? "").includes("text/event-stream");
        if (!isProvider || !isEventStream) {
          res.writeHead(up.statusCode ?? 502, up.headers);
          up.pipe(res);
          return;
        }
        // Rewriting changes the byte count, so any declared length must go.
        const headers = { ...up.headers };
        delete headers["content-length"];
        res.writeHead(up.statusCode ?? 502, headers);
        up.pipe(createStreamNormaliser()).pipe(res);
      },
    );
    upstream.on("error", (error) => {
      log("warn", runId, "upstream error", { host: target.host, message: (error as Error).message });
      if (!res.headersSent) res.writeHead(502);
      res.end("HEIMDALL: upstream error");
    });
    upstream.end(body);
  }

  private handleConnect(req: http.IncomingMessage, socket: net.Socket, head: Buffer): void {
    const capability = this.capabilityOf(req);
    const permit = this.hooks.permitFor(capability);
    const runId = permit?.runId ?? "unknown";
    const [rawHost, rawPort] = (req.url ?? "").split(":");
    const host = rawHost ?? "";
    const port = Number(rawPort ?? "443");

    const decision = decideEgress(permit, host, null);
    if (!decision.allow) {
      this.refuse(runId, socket, host, decision, `CONNECT ${host}:${port}`, true);
      return;
    }
    let established = false;
    const upstream = net.connect(port, host, () => {
      established = true;
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    upstream.on("error", (error) => {
      log("warn", runId, "egress tunnel error", { host, port, established, message: (error as Error).message });
      // Once the tunnel is up, the client is reading/writing raw TLS bytes through
      // it — writing an HTTP response line into that stream would corrupt it, so a
      // post-establishment error (e.g. the upstream resetting the connection) just
      // closes the socket like any other transport failure would.
      if (established) socket.destroy();
      else socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    });
    socket.on("error", () => upstream.destroy());
  }
}
