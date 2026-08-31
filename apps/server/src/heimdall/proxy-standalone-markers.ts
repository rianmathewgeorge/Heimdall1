/**
 * Shared between proxy-standalone.ts (the sidecar entrypoint, which prints
 * these) and runner.ts (the parent process, which greps the sidecar's
 * `docker logs` output for them). Its own tiny file so the parent never has
 * to import proxy-standalone.ts itself — that file's top-level `main()` call
 * would execute immediately and throw outside a real sidecar container.
 */
export const DENIAL_MARKER = "HEIMDALL_DENIAL_JSON ";
export const READY_MARKER = "HEIMDALL_PROXY_READY";
