/**
 * Integration test for the real recon-container path: exercises the actual
 * Dockerfile.runtime entrypoint script and the exact bind-mount topology
 * broker.ts uses for a Heimdall run (read-only shared config, writable
 * CODEX_HOME), without needing a real Codex install or a model API key.
 *
 * Regression: CODEX_HOME used to be bind-mounted read-only directly, so
 * Codex could never write its own session state — the rollout recorder
 * among it — and every real recon container exited non-zero before
 * producing a manifest ("Failed to shutdown rollout recorder"). This test
 * builds the same entrypoint script that ships in the runtime image and
 * proves: (1) it copies config.toml into a writable CODEX_HOME, (2) that
 * CODEX_HOME is actually writable, (3) the shared read-only mount stays
 * read-only throughout.
 *
 * The rest of the suite deliberately avoids Docker (see loop.test.ts) so it
 * runs everywhere; this file is the one exception and skips itself cleanly
 * when Docker isn't reachable.
 */
import { execFile, execSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const IMAGE_TAG = "heimdall-entrypoint-test:local";

function dockerReachable(): boolean {
  try {
    execSync("docker info", { stdio: "ignore", timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!dockerReachable())("recon container: real entrypoint + mount topology", () => {
  let codexHomeHost = "";

  beforeAll(async () => {
    codexHomeHost = await mkdtemp(path.join(tmpdir(), "heimdall-codex-home-"));
    await chmod(codexHomeHost, 0o755);
    const configPath = path.join(codexHomeHost, "config.toml");
    await writeFile(configPath, 'model = "test-model"\nmodel_provider = "volcengine_ark"\n', "utf8");
    await chmod(configPath, 0o644);

    const dockerfileDir = await mkdtemp(path.join(tmpdir(), "heimdall-entrypoint-dockerfile-"));
    await writeFile(path.join(dockerfileDir, "Dockerfile"), [
      "FROM busybox:stable",
      "COPY docker/heimdall-entrypoint.sh /usr/local/bin/heimdall-entrypoint.sh",
      "RUN chmod +x /usr/local/bin/heimdall-entrypoint.sh",
      // must match Dockerfile.runtime: pre-created, sticky + world-writable so an
      // arbitrary --user uid can write into it (mkdir -p on / itself would fail)
      "RUN mkdir -p /codex-home-rw && chmod 1777 /codex-home-rw",
      'ENTRYPOINT ["/usr/local/bin/heimdall-entrypoint.sh"]',
      "",
    ].join("\n"), "utf8");

    await execFileAsync(
      "docker", ["build", "-f", path.join(dockerfileDir, "Dockerfile"), "-t", IMAGE_TAG, REPO_ROOT],
      { timeout: 120_000 },
    );
    await rm(dockerfileDir, { recursive: true, force: true });
  }, 120_000);

  afterAll(async () => {
    await execFileAsync("docker", ["image", "rm", "-f", IMAGE_TAG]).catch(() => {});
    if (codexHomeHost) await rm(codexHomeHost, { recursive: true, force: true });
  });

  test("copies config into a writable CODEX_HOME while the shared mount stays read-only", async () => {
    // Stands in for the real "codex ...args" the entrypoint hands off to in
    // production: proves CODEX_HOME is writable (as Codex's own rollout
    // recorder needs) and that the read-only shared mount really is read-only.
    const script = [
      "set -e",
      'test -f "$CODEX_HOME/config.toml"',
      'cat "$CODEX_HOME/config.toml"',
      'touch "$CODEX_HOME/rollout-recorder.tmp"',
      'if touch "$HEIMDALL_CODEX_HOME_RO/should-fail" 2>/dev/null; then echo WROTE_TO_RO_MOUNT; else echo RO_MOUNT_ENFORCED; fi',
    ].join(" && ");

    const { stdout } = await execFileAsync("docker", [
      "run", "--rm",
      "--env", "CODEX_HOME=/codex-home-rw",
      "--env", "HEIMDALL_CODEX_HOME_RO=/codex-home-ro",
      "--env", "HOME=/tmp",
      "--mount", `type=bind,src=${codexHomeHost},dst=/codex-home-ro,readonly`,
      "--user", `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
      IMAGE_TAG,
      "sh", "-c", script,
    ], { timeout: 30_000 });

    expect(stdout).toContain('model = "test-model"');
    expect(stdout).toContain("RO_MOUNT_ENFORCED");
    expect(stdout).not.toContain("WROTE_TO_RO_MOUNT");
  }, 30_000);
});
