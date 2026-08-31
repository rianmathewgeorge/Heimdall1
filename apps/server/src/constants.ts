/**
 * The path inside every agent container where the workspace bind-mount lands.
 * Fixed by the `--mount ...,dst=` / `--workdir` args in broker.ts and
 * container-codex-runner.ts — the agent always sees its workspace here,
 * regardless of where it lives on the host. Anything that reasons about paths
 * the agent reports (policy scoring, `-C` for codex) must agree with this.
 */
export const CONTAINER_WORKSPACE_ROOT = "/workspace";
