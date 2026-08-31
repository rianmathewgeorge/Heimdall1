import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

const envSchema = z.object({
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.string().default("info"),
  APP_DATA_DIR: z.string().default(path.resolve(".data")),
  AGENT_WORKSPACE_ROOT: z.string().default(path.resolve("workspaces")),
  CODEX_HOME: z.string().default(path.resolve("codex-home")),
  CODEX_BIN: z.string().default("codex"),
  CODEX_SANDBOX_MODE: z
    .enum(["read-only", "workspace-write", "danger-full-access"])
    .default("workspace-write"),
  CODEX_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(600_000),
  CODEX_MAX_OUTPUT_BYTES: z.coerce.number().int().min(65_536).default(2_097_152),
  /** No RunEvent for this long while queued/running -> the UI shows "no progress detected". */
  RUN_STALL_THRESHOLD_MS: z.coerce.number().int().min(1_000).default(20_000),
  /**
   * Safety net, not the normal path: every phase (recon, approval wait, execute)
   * already has its own timeout that resolves to a terminal state. This bounds the
   * *whole* run in case a lower-level timeout is ever bypassed (a hung docker CLI
   * call, for instance), so the UI can never buffer in "running" forever.
   */
  RUN_MAX_AGE_MS: z.coerce.number().int().min(60_000).default(3_600_000),
  RUNTIME_PROVIDER: z.enum(["local-process", "container"]).default("local-process"),
  CONTAINER_ENGINE: z.string().min(1).default("docker"),
  CONTAINER_RUNTIME_IMAGE: z.string().min(1).default("volc-agent-runtime:local"),
  CONTAINER_PROXY_IMAGE: z.string().min(1).default("heimdall-proxy:local"),
  CONTAINER_CPU_LIMIT: z.coerce.number().positive().default(2),
  CONTAINER_MEMORY_LIMIT: z
    .string()
    .regex(/^\d+(?:\.\d+)?[bkmg]$/i)
    .default("2g"),
  CONTAINER_PIDS_LIMIT: z.coerce.number().int().positive().default(256),
  CONTAINER_USER: z.string().optional(),
  RUNTIME_INSTANCE_ID: z
    .string()
    .trim()
    .min(1)
    .max(48)
    .regex(/^[a-zA-Z0-9_.-]+$/)
    .default("default"),
  APP_AUTH_TOKEN: z
    .string()
    .trim()
    .max(128)
    .regex(/^[A-Za-z0-9._~-]*$/, "APP_AUTH_TOKEN must use URL-safe characters")
    .optional(),
  MODEL_PROVIDER: z.enum(["ark", "openrouter"]).default("ark"),
  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_MODEL: z.string().optional(),
  OPENROUTER_BASE_URL: z.string().url().default("https://openrouter.ai/api/v1"),
  ARK_API_KEY: z.string().optional(),
  ARK_MODEL: z.string().optional(),
  ARK_BASE_URL: z
    .string()
    .url()
    .default("https://ark.cn-beijing.volces.com/api/v3"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env) {
  const env = envSchema.parse(environment);
  const authToken = env.APP_AUTH_TOKEN?.trim() ?? "";
  const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);
  if (env.NODE_ENV === "production" && !loopbackHosts.has(env.HOST)) {
    if (authToken.length < 24 || authToken.startsWith("replace-")) {
      throw new Error(
        "APP_AUTH_TOKEN must contain at least 24 characters for a non-loopback production server",
      );
    }
  }
  const defaultContainerUser =
    typeof process.getuid === "function" && typeof process.getgid === "function"
      ? process.getuid() + ":" + process.getgid()
      : "1000:1000";
  return {
    host: env.HOST,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    dataDirectory: path.resolve(env.APP_DATA_DIR),
    workspaceRoot: path.resolve(env.AGENT_WORKSPACE_ROOT),
    codexHome: path.resolve(env.CODEX_HOME),
    codexBin: env.CODEX_BIN,
    codexSandboxMode: env.CODEX_SANDBOX_MODE,
    codexTimeoutMs: env.CODEX_TIMEOUT_MS,
    codexMaxOutputBytes: env.CODEX_MAX_OUTPUT_BYTES,
    runStallThresholdMs: env.RUN_STALL_THRESHOLD_MS,
    runMaxAgeMs: env.RUN_MAX_AGE_MS,
    runtimeProvider: env.RUNTIME_PROVIDER,
    containerEngine: env.CONTAINER_ENGINE,
    containerRuntimeImage: env.CONTAINER_RUNTIME_IMAGE,
    containerProxyImage: env.CONTAINER_PROXY_IMAGE,
    containerCpuLimit: env.CONTAINER_CPU_LIMIT,
    containerMemoryLimit: env.CONTAINER_MEMORY_LIMIT,
    containerPidsLimit: env.CONTAINER_PIDS_LIMIT,
    containerUser: env.CONTAINER_USER?.trim() || defaultContainerUser,
    runtimeInstanceId: env.RUNTIME_INSTANCE_ID,
    authToken,
    modelProvider: env.MODEL_PROVIDER,
    arkApiKey: env.ARK_API_KEY?.trim() ?? "",
    arkModel: env.ARK_MODEL?.trim() ?? "",
    arkBaseUrl: env.ARK_BASE_URL.replace(/\/+$/, ""),
    openrouterApiKey: env.OPENROUTER_API_KEY?.trim() ?? "",
    openrouterModel: env.OPENROUTER_MODEL?.trim() ?? "",
    openrouterBaseUrl: env.OPENROUTER_BASE_URL.replace(/\/+$/, ""),
    nodeEnv: env.NODE_ENV,
  };
}

/** The active provider, normalised. Heimdall's egress broker injects this key upstream. */
export function activeProvider(config: AppConfig): {
  id: "ark" | "openrouter"; key: string; model: string; baseUrl: string; envKey: string; wireApi: "responses";
} {
  // Codex >=0.111 hard-refuses to start with `wire_api = "chat"` ("no longer
  // supported" — see github.com/openai/codex/discussions/7782); "responses" is
  // the only value it accepts now. OpenRouter's /v1/responses endpoint (beta,
  // OpenAI-compatible) is what makes that work for this provider too.
  if (config.modelProvider === "openrouter") {
    return {
      id: "openrouter", key: config.openrouterApiKey, model: config.openrouterModel,
      baseUrl: config.openrouterBaseUrl, envKey: "OPENROUTER_API_KEY", wireApi: "responses",
    };
  }
  return {
    id: "ark", key: config.arkApiKey, model: config.arkModel,
    baseUrl: config.arkBaseUrl, envKey: "ARK_API_KEY", wireApi: "responses",
  };
}

export function isArkConfigured(config: AppConfig): boolean {
  const p = activeProvider(config);
  return (
    p.key.length > 0 && !p.key.startsWith("replace-") &&
    p.model.length > 0 && !p.model.includes("replace-")
  );
}

/** `baseUrlOverride` lets a caller point Codex at the proxy instead of the real provider. */
function renderCodexConfigToml(config: AppConfig, baseUrlOverride?: string): string {
  const p = activeProvider(config);
  const providerId = p.id === "openrouter" ? "openrouter" : "volcengine_ark";
  const lines = [
    "# Generated by Volc Agent Launchpad. Edit environment variables, not this file.",
    "model = " + JSON.stringify(p.model || "not-configured"),
    "model_provider = " + JSON.stringify(providerId),
    "",
    "[model_providers." + providerId + "]",
    "name = " + JSON.stringify(p.id === "openrouter" ? "OpenRouter" : "Volcengine Ark"),
    "base_url = " + JSON.stringify(baseUrlOverride ?? p.baseUrl),
    "env_key = " + JSON.stringify(p.envKey),
    "wire_api = " + JSON.stringify(p.wireApi),
    "requires_openai_auth = false",
  ];
  if (baseUrlOverride !== undefined) {
    // Going through the proxy: the sidecar authenticates every request via this
    // header (HeimdallProxy.capabilityOf / CAPABILITY_HEADER in proxy.ts) — deny
    // by default otherwise (rule P-00). env_http_headers names the header and
    // an IN-CONTAINER environment variable to read it from at request time —
    // Codex substitutes the value itself, so the token (already injected into
    // the container as HEIMDALL_CAPABILITY by buildHeimdallRunArgs) never has to
    // be written into this file, which sits on the host filesystem.
    lines.push('env_http_headers = { "x-heimdall-capability" = "HEIMDALL_CAPABILITY" }');
  }
  lines.push("");
  return lines.join("\n");
}

export async function writeCodexConfig(config: AppConfig): Promise<void> {
  await mkdir(config.codexHome, { recursive: true });
  await writeFile(path.join(config.codexHome, "config.toml"), renderCodexConfigToml(config), {
    encoding: "utf8",
    mode: 0o600,
  });
}

/**
 * Rewrites a provider's real base URL onto the proxy's own origin, preserving
 * its path prefix (e.g. "https://openrouter.ai/api/v1" + "http://proxy:8080"
 * -> "http://proxy:8080/api/v1"), so the same path Codex would have requested
 * on the real host lands on the proxy instead.
 */
export function providerBaseUrlThroughProxy(realBaseUrl: string, proxyOrigin: string): string {
  const real = new URL(realBaseUrl);
  return proxyOrigin.replace(/\/+$/, "") + real.pathname.replace(/\/+$/, "");
}

/**
 * A per-run Codex config directory whose base_url points at this run's proxy
 * sidecar instead of the real provider host. Model traffic then reaches the
 * proxy as a plain, same-network HTTP request it can actually read and inject
 * the real credential into — an HTTPS CONNECT tunnel to the real host would be
 * opaque to it, so it could only relay the placeholder key blindly. Returns
 * the directory path; the caller owns cleanup (it's a temp directory, not
 * shared state like the real codexHome).
 */
export async function writeProxiedCodexConfig(config: AppConfig, proxyOrigin: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "heimdall-codex-"));
  const toml = renderCodexConfigToml(config, providerBaseUrlThroughProxy(activeProvider(config).baseUrl, proxyOrigin));
  await writeFile(path.join(dir, "config.toml"), toml, { encoding: "utf8", mode: 0o600 });
  return dir;
}
