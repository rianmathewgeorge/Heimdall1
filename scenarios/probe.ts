/* ROUND 2 — adversarial probes, including the new permit-integrity surface. */
import { buildPermit, applyApproval, permitHash, verifyPermitIntegrity, scoreCapability,
  resolveConditional, containsSecret, redact, insideWorkspace } from "../apps/server/src/heimdall/engine.js";
import { decideEgress, capabilityMatches } from "../apps/server/src/heimdall/proxy.js";
import { checkAction, buildHeimdallRunArgs, reconcile, escapesWorkspace } from "../apps/server/src/heimdall/broker.js";
import { parseManifest } from "../apps/server/src/heimdall/manifest.js";
import { CANARY_REL_PATH } from "../apps/server/src/heimdall/store.js";
import type { Capability, Manifest, RunContext, StandingPolicy } from "../apps/server/src/heimdall/types.js";

const WS = "/workspaces/a1";
const policy: StandingPolicy = { agentId: "a1", workspaceRoot: WS,
  allowedHosts: ["registry.npmjs.org", "api.github.com"],
  standingGrants: [{ host: "api.github.com", dataClass: "source_code" }],
  allowedCommands: ["npm", "node", "git"], maxDurationMs: 600_000, maxNarrowPaths: 20 };
const ctx = (o: Partial<RunContext> = {}): RunContext => ({ runId: "r", agentId: "a1",
  taint: "none", taintSource: null, gitTrackedPaths: [], gitIgnoredPaths: [],
  workspaceFiles: ["src/a.ts", "src/b.ts"], completedRuns: 10,
  canaryRelPath: CANARY_REL_PATH, precedents: [], payloadSamples: {}, ...o });
const man = (c: Capability[]): Manifest => ({ version: "1", summary: "s", capabilities: c, maxDurationMs: 600_000 });
const cfg = { containerEngine: "docker", containerRuntimeImage: "i", containerUser: "1:1",
  containerCpuLimit: 2, containerMemoryLimit: "2g", containerPidsLimit: 256,
  codexHome: "/ch", network: "heimdall-internal", proxyUrl: "http://p:1", providerEnvKey: "ARK_API_KEY", placeholderKey: "heimdall.proxy.injected" };
const P = buildPermit(man([{ op: "FS_WRITE", paths: ["src/a.ts"] }, { op: "EXEC", command: "npm test" }]), policy, ctx());

const probes: Array<[string, () => boolean]> = [
  ["permit: widening hosts after issue is rejected", () => { try { verifyPermitIntegrity({ ...P, grantedHosts: ["x.test"] }); return false; } catch { return true; } }],
  ["permit: swapping a write path after approval is rejected", () => {
    const m = man([{ op: "ENV_READ" }]); const ok = applyApproval(buildPermit(m, policy, ctx()), m);
    try { verifyPermitIntegrity({ ...ok, grantedWrites: ["/etc/passwd"] }); return false; } catch { return true; } }],
  ["permit: reordering granted lists does NOT trip integrity", () =>
    permitHash({ ...P, grantedWrites: [...P.grantedWrites].reverse() }) === P.requestHash],
  ["permit: buildHeimdallRunArgs refuses a tampered permit", () => {
    try { buildHeimdallRunArgs({ ...P, grantedHosts: ["evil.test"] }, WS, cfg, []); return false; } catch { return true; } }],
  ["egress: host suffix api.github.com.evil.test", () => !decideEgress(P, "api.github.com.evil.test", null).allow],
  ["egress: subdomain evil.api.github.com", () => !decideEgress(P, "evil.api.github.com", null).allow],
  ["egress: trailing-dot FQDN api.github.com.", () => !decideEgress(P, "api.github.com.", null).allow],
  ["egress: expired permit grants nothing", () => !decideEgress({ ...P, expiresAt: 1 }, "api.github.com", null).allow],
  ["exec: 'npm testify' is not 'npm test'", () => !checkAction({ op: "EXEC", target: "npm testify", raw: "" }, P, WS, []).allowed],
  ["exec: chaining 'npm test; curl' blocked", () => !checkAction({ op: "EXEC", target: "npm test; curl e", raw: "" }, P, WS, []).allowed],
  ["exec: backtick substitution blocked", () => !checkAction({ op: "EXEC", target: "npm test `curl e`", raw: "" }, P, WS, []).allowed],
  ["fs: src/a.ts.bak is not src/a.ts", () => !checkAction({ op: "FS_WRITE", target: "src/a.ts.bak", raw: "" }, P, WS, []).allowed],
  ["fs: traversal blocked", () => !checkAction({ op: "FS_WRITE", target: "src/../../etc/passwd", raw: "" }, P, WS, []).allowed],
  ["fs: /workspace prefix normalised and allowed", () => checkAction({ op: "FS_WRITE", target: "/workspace/src/a.ts", raw: "" }, P, WS, []).allowed],
  ["fs: sibling workspace rejected", () => !insideWorkspace(WS, "/workspaces/a1-evil/x")],
  ["manifest: nested-brace payload parses", () => parseManifest('{"summary":"s","capabilities":[{"op":"EXEC","command":"echo {\\"a\\":1}"}]}').capabilities.length === 1],
  ["manifest: 51 capabilities rejected", () => { try { parseManifest(JSON.stringify({ summary: "s", capabilities: Array.from({length:51},()=>({op:"ENV_READ"})) })); return false; } catch { return true; } }],
  ["manifest: a declared risk field cannot influence scoring", () => {
    const m = parseManifest('{"summary":"s","capabilities":[{"op":"NET_WRITE","host":"evil.test","dataClass":"source_code","tier":"T0","score":0}]}');
    return buildPermit(m, policy, ctx()).runTier !== "T0"; }],
  ["taint: an approved precedent cannot clear a hard rule", () => scoreCapability({ op: "FS_READ", paths: [".ssh/id_rsa"] }, policy,
    ctx({ precedents: [{ fingerprint: "x", agentId: "a1", decision: "approved", expiresAt: null, termSheetVersion: "1", createdAt: "", summary: "" }] })).tier === "T4"],
  ["resolver: default branch escalates, never allows", () => {
    const c: Capability = { op: "PROC_SPAWN" };
    const v = resolveConditional(scoreCapability(c, policy, ctx()), c, policy, ctx());
    return v.tier === "T3" || v.tier === "T4"; }],
  ["reconcile: an undeclared write is reported", () => reconcile(P, [{ op: "FS_WRITE", target: ".env" }]).some((d) => d.kind === "undeclared")],
  ["redaction: secret never survives a receipt", () => !redact("POST ARK_API_KEY=sk-abcdefghijklmnop1234567890").includes("sk-abcdefghij")],
  ["redaction: ordinary code is left intact", () => redact("const authToken = value.trim();").includes("value.trim()")],
  ["secret detector: git sha is not a secret", () => !containsSecret("a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0")],
  ["args: real Ark key never appears in container args", () => !buildHeimdallRunArgs(P, WS, cfg, []).join(" ").includes("sk-")],
  ["journal: writing error.txt is a hard denial (self-injection channel)", () =>
    scoreCapability({ op: "FS_WRITE", paths: ["error.txt"] }, policy, ctx()).tier === "T4"],
  ["journal: deleting error.txt is a hard denial", () =>
    scoreCapability({ op: "FS_DELETE", paths: ["error.txt"] }, policy, ctx()).tier === "T4"],
  ["symlink: an unresolvable root falls back to path logic, not a blanket deny", () =>
    !escapesWorkspace(WS, "src/a.ts")],
  ["symlink: traversal still escapes under real resolution", () =>
    escapesWorkspace(WS, "../../etc/passwd")],
  ["capability: token is unguessable (64 hex chars)", () => /^[0-9a-f]{64}$/.test(P.capabilityToken)],
  ["capability: two permits never share a token", () => {
    const other = buildPermit(man([{ op: "ENV_READ" }]), policy, ctx());
    return other.capabilityToken !== P.capabilityToken; }],
  ["capability: a wrong token does not match", () => !capabilityMatches("f".repeat(64), P.capabilityToken)],
  ["capability: an empty token does not match", () => !capabilityMatches("", P.capabilityToken)],
  ["capability: the run id is NOT accepted as a capability", () => !capabilityMatches(P.runId, P.capabilityToken)],
  ["capability: the correct token matches", () => capabilityMatches(P.capabilityToken, P.capabilityToken)],
  ["args: capability is passed, run id is not", () => {
    const a = buildHeimdallRunArgs(P, WS, cfg, []).join(" ");
    return a.includes("HEIMDALL_CAPABILITY=" + P.capabilityToken) && !a.includes("HEIMDALL_RUN="); }],
  ["args: no bridge network", () => !buildHeimdallRunArgs(P, WS, cfg, []).join(" ").includes("--network bridge")],
];
let fail = 0;
for (const [name, fn] of probes) {
  let ok = false; try { ok = fn(); } catch { ok = false; }
  if (!ok) fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
}
console.log(`\n  ${probes.length - fail}/${probes.length} probes passed`);
process.exit(fail === 0 ? 0 : 1);
