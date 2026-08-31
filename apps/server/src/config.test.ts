/**
 * Regression coverage for the Heimdall capability-header fix and its two
 * companion bugs (see codex-capability.integration.test.ts for the real,
 * containerised version of this same path):
 *
 *  - writeProxiedCodexConfig must tell Codex to send HEIMDALL_CAPABILITY (the
 *    per-run token already present in the container's own environment — see
 *    buildHeimdallRunArgs) as the x-heimdall-capability header the sidecar's
 *    deny-by-default rule P-00 requires. writeCodexConfig (the non-proxied,
 *    host-side path) must NOT — there is no sidecar to authenticate to there.
 *  - every provider must render `wire_api = "responses"`: the pinned Codex
 *    CLI hard-refuses to start with `wire_api = "chat"` ("no longer
 *    supported" — github.com/openai/codex/discussions/7782).
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  activeProvider, providerBaseUrlThroughProxy, writeCodexConfig, writeProxiedCodexConfig, type AppConfig,
} from "./config.js";

function cfg(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    codexHome: "/tmp/heimdall-config-test-unused",
    modelProvider: "openrouter",
    openrouterApiKey: "sk-test", openrouterModel: "test-model", openrouterBaseUrl: "https://openrouter.ai/api/v1",
    arkApiKey: "", arkModel: "", arkBaseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    ...overrides,
  } as unknown as AppConfig;
}

const cleanupDirs: string[] = [];
afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((d) => rm(d, { recursive: true, force: true }).catch(() => undefined)));
});

describe("activeProvider — wire_api", () => {
  test("openrouter uses \"responses\", never the removed \"chat\" value", () => {
    expect(activeProvider(cfg({ modelProvider: "openrouter" })).wireApi).toBe("responses");
  });
  test("ark uses \"responses\"", () => {
    expect(activeProvider(cfg({ modelProvider: "ark" })).wireApi).toBe("responses");
  });
});

describe("providerBaseUrlThroughProxy", () => {
  test("keeps the real base_url's path prefix on the proxy's own origin", () => {
    expect(providerBaseUrlThroughProxy("https://openrouter.ai/api/v1", "http://heimdall-proxy-x:8080"))
      .toBe("http://heimdall-proxy-x:8080/api/v1");
  });
});

describe("writeProxiedCodexConfig — the capability header Codex must send", () => {
  test("routes through the proxy AND tells Codex to send x-heimdall-capability from HEIMDALL_CAPABILITY", async () => {
    const dir = await writeProxiedCodexConfig(cfg(), "http://heimdall-proxy-run1:8080");
    cleanupDirs.push(dir);
    const toml = await readFile(path.join(dir, "config.toml"), "utf8");

    expect(toml).toContain('base_url = "http://heimdall-proxy-run1:8080/api/v1"');
    // The env var NAME goes in this file; the token VALUE never does — it
    // stays only in the container's own HEIMDALL_CAPABILITY, injected at
    // container-start by buildHeimdallRunArgs, never written to host disk.
    expect(toml).toContain('env_http_headers = { "x-heimdall-capability" = "HEIMDALL_CAPABILITY" }');
    expect(toml).toContain('wire_api = "responses"');
  });
});

describe("writeCodexConfig — the non-proxied, host-side path", () => {
  test("never emits env_http_headers: there is no sidecar to authenticate to here", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "heimdall-config-test-"));
    cleanupDirs.push(dir);
    await writeCodexConfig(cfg({ codexHome: dir }));
    const toml = await readFile(path.join(dir, "config.toml"), "utf8");

    expect(toml).toContain('base_url = "https://openrouter.ai/api/v1"');
    expect(toml).not.toContain("env_http_headers");
  });
});
