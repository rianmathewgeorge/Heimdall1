/* heimdall-audit-ignore — contains the decoy canary / placeholder key by design */
/**
 * HEIMDALL — action broker + reconciliation + container args.
 *
 * The broker taps Codex's JSON event stream and checks every OBSERVED action
 * against the permit. Everything not granted is a denial by construction —
 * there is no blocklist to maintain.
 *
 * EVENT SHAPES (verified against codex-cli 0.111, not guessed): Codex wraps
 * thread items in a lifecycle envelope — the outer `type` is item.started /
 * item.completed and the item's own kind is `item.type` (older builds used
 * `item_type`, so both are accepted). Actions are classified on the item's SHAPE
 * as well as its name, so a renamed kind still maps. Anything unclassifiable is
 * reported, and denied when it names a command, path or host.
 */
import { realpathSync } from "node:fs";
import path from "node:path";
import { CONTAINER_WORKSPACE_ROOT } from "../constants.js";
import type { Denial, Divergence, Permit } from "./types.js";
import { globToRegExp, insideWorkspace, isGlob, redact, resolveGlob, verifyPermitIntegrity } from "./engine.js";

export interface ObservedAction {
  /** Codex item id, so item.started and item.completed count as ONE action. */
  id?: string | null;
  /** UNKNOWN only: the item named no command, path or host, so it is not an action. */
  inert?: boolean;
  op: "FS_WRITE" | "FS_DELETE" | "FS_READ" | "EXEC" | "NET" | "UNKNOWN";
  target: string;
  raw: string;
}

/**
 * Codex's file writes are wrapped in a shell/exec-typed event whose command
 * is an `apply_patch` invocation with a heredoc body. Classifying that as a
 * raw EXEC misfiles it against grantedCommands instead of grantedWrites, so
 * a permit that correctly declared only FS_WRITE gets denied for a write it
 * did grant. Parse the patch header and reclassify by the file op it
 * actually performs.
 */
const APPLY_PATCH_FILE = /^\*\*\* (Add File|Update File|Delete File): (.+)$/gm;

/**
 * Unwrap `/bin/bash -lc '<script>'` to `<script>`.
 *
 * VERIFIED against codex-cli 0.111: every command arrives wrapped, e.g.
 *   /bin/bash -lc 'echo hi > made.txt && ls'
 * The wrapper contains `>` and `&&`, so SHELL_META marked it risky and required
 * an exact match against the permit — which no declared command can ever be.
 * Every command was therefore refused.
 *
 * Unwrapping is only safe when the remainder is exactly one quoted span. A
 * trailing `; curl evil` OUTSIDE the quotes would otherwise be discarded along
 * with the wrapper, so in that case the original is returned and the
 * metacharacter rule refuses it.
 */
export function unwrapShellCommand(command: string): string {
  const m = /^(?:\S*\/)?(?:bash|sh|zsh|dash)\s+-[lic]+\s+([\s\S]+)$/.exec(command.trim());
  const rest = m?.[1]?.trim();
  if (rest === undefined || rest.length < 2) return command;
  const quote = rest[0];
  if (quote !== "'" && quote !== '"') return command;
  if (!rest.endsWith(quote)) return command;
  const inner = rest.slice(1, -1);
  // An ESCAPED same-kind quote is still inside one span; a BARE one would mean
  // the wrapper ended early with a payload after it. Codex routinely quotes
  // scripts that themselves contain quotes, so rejecting all of them refused
  // most real commands.
  if (inner.replace(/\\./g, "").includes(quote)) return command;
  return inner;
}

export function normaliseCommand(command: string): string {
  return unwrapShellCommand(command).trim().replace(/\s+/g, " ");
}

function classifyExecCommand(command: string, type: string, id: string | null): ObservedAction[] {
  const inner = unwrapShellCommand(command);
  if (!/(^|\s)apply_patch\b/.test(inner)) {
    // target keeps the RAW command so the ledger stays faithful; the permit check
    // and reconciliation unwrap it themselves.
    return [{ op: "EXEC", target: command, raw: type, id }];
  }
  // Codex 0.111 has no patch TOOL — it writes files by running `apply_patch`,
  // so this is the path that actually carries file writes. A patch can touch
  // several files; taking only the first left the rest unobserved.
  const out: ObservedAction[] = [];
  APPLY_PATCH_FILE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = APPLY_PATCH_FILE.exec(inner)) !== null) {
    const file = m[2]?.trim();
    if (file === undefined || file === "") continue;
    out.push({
      op: m[1] === "Delete File" ? "FS_DELETE" : "FS_WRITE",
      target: file, raw: type, id: id === null ? null : `${id}:${file}`,
    });
  }
  // apply_patch fired but we could not parse a path — fail safe, not allowed
  if (out.length === 0) return [{ op: "FS_WRITE", target: "<unparsed apply_patch>", raw: type, id }];
  return out;
}

export function observeEvents(event: Record<string, unknown>): ObservedAction[] {
  const envelope = typeof event["type"] === "string" ? event["type"] : "";
  const wrapped = event["item"] ?? event["msg"];
  const item = (wrapped !== null && typeof wrapped === "object")
    ? wrapped as Record<string, unknown>
    : event;
  // codex 0.111 puts the kind in item.type; older builds used item_type. Accept both.
  const kindRaw = item["item_type"] ?? item["type"];
  const type = typeof kindRaw === "string" && kindRaw !== "" ? kindRaw : envelope;
  const id = typeof item["id"] === "string" ? item["id"] : null;
  const action = (item["action"] ?? {}) as Record<string, unknown>;

  /*
   * Codex emits item.started AND item.completed for the same action, and the
   * started event already carries the command. Observing BOTH lets the broker
   * refuse a command while it is still running rather than after it has already
   * finished; the runner dedupes by item id so the action is still recorded once.
   * item.updated carries no new decision, so it is skipped.
   */
  if (envelope === "item.updated") return [];

  const rawCommand = item["command"] ?? action["command"];
  const command = typeof rawCommand === "string" ? rawCommand
    : Array.isArray(rawCommand) ? (rawCommand as unknown[]).join(" ") : null;
  if (command !== null && /command|exec|shell|bash/i.test(type)) {
    return classifyExecCommand(command, type, id);
  }
  if (/file_?change|patch|edit|apply/i.test(type)) {
    const changes = item["changes"] ?? item["files"] ?? item["path"];
    const out: ObservedAction[] = [];
    const push = (t: unknown, kind?: unknown): void => {
      if (typeof t === "string" && t !== "") {
        out.push({
          op: typeof kind === "string" && /^(delete|remove)/i.test(kind) ? "FS_DELETE" : "FS_WRITE",
          target: t, raw: type, id: id === null ? null : `${id}:${t}`,
        });
      }
    };
    if (typeof changes === "string") push(changes);
    else if (Array.isArray(changes)) {
      for (const c of changes) {
        if (typeof c === "string") push(c);
        else if (c !== null && typeof c === "object") {
          const o = c as Record<string, unknown>;
          push(o["path"] ?? o["file"], o["kind"] ?? o["type"]);
        }
      }
    } else if (changes !== null && typeof changes === "object") {
      for (const [k, v] of Object.entries(changes as Record<string, unknown>)) {
        push(k, v !== null && typeof v === "object" ? (v as Record<string, unknown>)["kind"] : undefined);
      }
    }
    if (out.length > 0) return out;
  }
  if (/web|fetch|http|network/i.test(type)) {
    const url = item["url"] ?? item["host"];
    if (typeof url === "string") return [{ op: "NET", target: url, raw: type, id }];
  }
  if (type !== "" && !/thread\.|turn\.|agent_message|reasoning|error|todo_list|plan_update|token_count/i.test(type)) {
    // An item naming a command, path or host is an action we failed to classify
    // and must be refused. One naming none of those cannot be an action, so it
    // is reported only — otherwise every new Codex item type blocks a run.
    const inert = command === null && typeof item["url"] !== "string"
      && item["changes"] === undefined && item["path"] === undefined;
    return [{ op: "UNKNOWN", target: type, raw: type, id, inert }];
  }
  return [];
}

/** Back-compat single-action view. Prefer `observeEvents`. */
export function observeEvent(event: Record<string, unknown>): ObservedAction | null {
  return observeEvents(event)[0] ?? null;
}

/**
 * Resolves symlinks before deciding. Path normalisation alone handles ".." but a
 * symlink inside the workspace pointing outside it would otherwise classify as inside.
 * A path we cannot resolve is treated as escaping — fail safe, not fail open.
 */
export function escapesWorkspace(workspaceRoot: string, relative: string): boolean {
  if (!insideWorkspace(workspaceRoot, relative)) return true;

  let realRoot: string;
  try { realRoot = realpathSync.native(workspaceRoot); }
  catch { return false; }   // root not on disk (unit fixtures): pure path logic already passed

  const absolute = path.resolve(realRoot, relative);
  let probe = absolute;
  for (let i = 0; i < 64; i++) {
    try {
      const realProbe = realpathSync.native(probe);
      const tail = path.relative(probe, absolute);
      const resolved = tail === "" ? realProbe : path.join(realProbe, tail);
      return resolved !== realRoot && !resolved.startsWith(realRoot + path.sep);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return true;
      const parent = path.dirname(probe);
      if (parent === probe) return false;   // never resolved anything: path logic stands
      probe = parent;
    }
  }
  return true;
}

/** Strips the container mount prefix a path was reported under, if present. */
function stripContainerPrefix(target: string): string {
  const prefix = CONTAINER_WORKSPACE_ROOT + "/";
  return target.startsWith(prefix) ? target.slice(prefix.length) : target;
}

/**
 * A granted glob is matched as a PATTERN, not by expanding it against the files
 * that happen to exist. Expanding it means a write to a file the run is about to
 * CREATE never matches -- "grant test/**, then add test/cli.test.ts" was denied,
 * which is the shape of most real tasks. Expansion is still consulted so a listed
 * file that normalises differently from the pattern still matches.
 *
 * This does not widen the grant: the tier was already scored against the glob's
 * blast radius, and escapesWorkspace still bounds it to the workspace.
 */
export function pathMatchesGrant(norm: string, grant: string, files: readonly string[]): boolean {
  if (!isGlob(grant)) return path.normalize(grant) === norm;
  if (globToRegExp(grant).test(norm)) return true;
  return resolveGlob(grant, files).some((f) => path.normalize(f) === norm);
}

function pathGranted(target: string, granted: readonly string[], workspaceRoot: string, files: readonly string[]): boolean {
  const norm = path.normalize(stripContainerPrefix(target));
  if (escapesWorkspace(workspaceRoot, norm)) return false;
  return granted.some((g) => pathMatchesGrant(norm, g, files));
}

/**
 * Shell metacharacters let a granted prefix carry an ungranted payload:
 * `npm test ` + "`curl evil`" prefix-matches "npm test" but is a different command.
 * A prefix match is therefore only honoured when the remainder is inert.
 * (Found by adversarial probing — this was a live bypass.)
 */
const SHELL_META = /[;|&$`()<>\n\r\\]|&&|\|\|/;

/**
 * Constructs whose effect cannot be read off the text: command substitution,
 * backgrounding, and redirection (which writes files the broker never sees as
 * an FS event). A script containing any of these is not decomposed.
 */
const UNANALYSABLE = /\$\(|`|<\(|(?<!&)&(?!&)/;

/**
 * Redirections with no filesystem effect: file-descriptor duplication (2>&1),
 * and writes to the null device. Blanket-denying every `>` refused `npm test
 * 2>&1`, which is one of the commonest things an agent types.
 */
const INERT_REDIRECT = /(?:\d?>>?\s*\/dev\/null|\d?>&\d?|\d?<\s*\/dev\/null)/g;

/** A redirect that writes a real path, e.g. `> out.txt`. */
const FILE_REDIRECT = /(?:^|\s)\d?>>?\s*([^\s;|&<>]+)/g;

/** Input redirection reads a file; the mount already bounds what is readable. */
const INPUT_REDIRECT = /(?:^|\s)\d?<\s*([^\s;|&<>]+)/g;

/**
 * Strips redirections that cannot write a file, so the rest of the command can
 * still be decomposed and checked.
 */
export function stripInertRedirects(script: string): string {
  return script.replace(INERT_REDIRECT, " ").replace(INPUT_REDIRECT, " ");
}

/** Paths a script would WRITE via redirection, or null when it cannot be read. */
export function redirectWriteTargets(script: string): string[] | null {
  const cleaned = stripInertRedirects(script);
  const targets: string[] = [];
  FILE_REDIRECT.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FILE_REDIRECT.exec(cleaned)) !== null) {
    const t = m[1];
    if (t === undefined || t === "") return null;      // unparseable redirect
    targets.push(t);
  }
  return targets;
}

/** Top-level shell operators. Splitting inside quotes would be wrong, so we track them. */
export function splitShellSegments(script: string): string[] | null {
  if (UNANALYSABLE.test(script)) return null;
  const out: string[] = [];
  let current = "", quote: string | null = null;
  for (let i = 0; i < script.length; i++) {
    const c = script[i] ?? "";
    // A backslash escape covers the next character, quote or not. Without this,
    // an escaped closing quote never closed the span and the whole command was
    // treated as unparseable — which is exactly how Codex quotes real scripts.
    if (c === "\\" && i + 1 < script.length) { current += c + script[i + 1]; i++; continue; }
    if (quote !== null) {
      current += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; current += c; continue; }
    const two = c + (script[i + 1] ?? "");
    if (two === "&&" || two === "||") { out.push(current); current = ""; i++; continue; }
    if (c === ";" || c === "|" || c === "\n") { out.push(current); current = ""; continue; }
    current += c;
  }
  if (quote !== null) return null;           // unbalanced quoting — do not guess
  out.push(current);
  const trimmed = out.map((p) => p.trim().replace(/\s+/g, " ")).filter((p) => p !== "");
  return trimmed.length > 0 ? trimmed : null;
}

function segmentGranted(segment: string, granted: readonly string[]): boolean {
  return granted.some((g) => {
    const gn = g.trim().replace(/\s+/g, " ");
    return segment === gn || segment.startsWith(gn + " ");
  });
}

function commandGranted(
  command: string, granted: readonly string[],
  permit: Permit, workspaceRoot: string, files: readonly string[],
): boolean {
  const unwrapped = unwrapShellCommand(command);
  /*
   * A redirect writes a file the broker never sees as an FS event, so it is
   * checked here against the SAME grants an FS_WRITE would need. `2>&1` and
   * `>/dev/null` write nothing and are stripped first.
   */
  const redirects = redirectWriteTargets(unwrapped);
  if (redirects === null) return false;
  for (const target of redirects) {
    if (!pathGranted(target, permit.grantedWrites, workspaceRoot, files)) return false;
  }
  const norm = unwrapped.trim().replace(/\s+/g, " ");
  // Test the RAW unwrapped string: whitespace normalisation would erase a
  // newline before we saw it. The SCRIPT is tested, so `bash -lc 'a; b'` is
  // still caught by `;` — unwrapping never loosens the metacharacter rule.
  const analysable = stripInertRedirects(unwrapped).replace(FILE_REDIRECT, " ");
  const risky = SHELL_META.test(analysable);
  if (granted.some((g) => norm === g.trim().replace(/\s+/g, " "))) return true;
  if (!risky) return segmentGranted(normaliseCommand(analysable), granted);

  /*
   * A compound command is not one command. Codex chains work as
   * `mkdir -p test && node -e "..."`, which a single prefix match can never
   * satisfy, so blanket-denying anything with a metacharacter refused almost
   * every real command. Decompose into top-level segments instead and require
   * EVERY segment to be granted independently — stricter than prefix matching,
   * and it still refuses anything it cannot read (see UNANALYSABLE).
   */
  const segments = splitShellSegments(analysable);
  if (segments === null) return false;
  return segments.every((seg) => segmentGranted(seg, granted));
}

export interface BrokerCheck {
  allowed: boolean;
  denial: Denial | null;
}

/** POLICY ∩ PERMIT. Anything not explicitly granted is refused. */
export function checkAction(
  action: ObservedAction, permit: Permit, workspaceRoot: string, workspaceFiles: readonly string[],
): BrokerCheck {
  const deny = (rule: string, detail: string): BrokerCheck => ({
    allowed: false,
    denial: {
      at: new Date().toISOString(), rule, op: action.op, target: action.target.slice(0, 200),
      detail, attempted: redact(action.target).slice(0, 800), sent: false,
    },
  });

  if (Date.now() > permit.expiresAt) return deny("P-09", "permit expired mid-run");

  switch (action.op) {
    case "EXEC":
      return commandGranted(action.target, permit.grantedCommands, permit, workspaceRoot, workspaceFiles)
        ? { allowed: true, denial: null }
        : deny("P-03", "command is not in the permit");
    case "FS_WRITE":
    case "FS_DELETE":
      return pathGranted(action.target, permit.grantedWrites, workspaceRoot, workspaceFiles)
        ? { allowed: true, denial: null }
        : deny("P-02", "write path is not in the permit");
    case "FS_READ": {
      const readable = [...permit.grantedReads, ...permit.grantedWrites];
      return pathGranted(action.target, readable, workspaceRoot, workspaceFiles)
        ? { allowed: true, denial: null }
        : deny("P-01", "read path is not in the permit");
    }
    case "NET": {
      let host = action.target;
      try { host = new URL(action.target).host.toLowerCase().replace(/:\d+$/, ""); } catch { /* raw host */ }
      return permit.grantedHosts.includes(host)
        ? { allowed: true, denial: null }
        : deny("P-07", `host "${host}" is not in the permit`);
    }
    default:
      // Fail safe: an action shape we do not recognise is recorded, not silently allowed.
      return deny("P-99", `unrecognised action type "${action.raw}" — fail-safe denial`);
  }
}

/** DECLARED vs ACTUAL. The audit record, the UI, and half the metric. */
export function reconcile(
  permit: Permit, actual: ReadonlyArray<{ op: string; target: string }>,
): Divergence[] {
  const out: Divergence[] = [];
  const declaredWrites = permit.grantedWrites.map((p) => path.normalize(p));
  const declaredCommands = permit.grantedCommands.map(normaliseCommand);
  const seenWrites = new Set<string>(), seenCommands = new Set<string>();

  for (const a of actual) {
    if (a.op === "FS_WRITE" || a.op === "FS_DELETE") {
      const norm = path.normalize(stripContainerPrefix(a.target));
      seenWrites.add(norm);
      // A declared glob covers the concrete path it expanded to. Comparing
      // literally reported every glob run as BOTH undeclared and unused.
      if (!declaredWrites.some((g) => pathMatchesGrant(norm, g, []))) {
        out.push({ kind: "undeclared", op: a.op, target: norm });
      }
    } else if (a.op === "EXEC") {
      const norm = normaliseCommand(a.target);
      // Record each top-level segment too: a chained `mkdir -p x && node y` uses
      // BOTH grants, and comparing only the whole string reported the second one
      // as never used.
      for (const seg of splitShellSegments(norm) ?? [norm]) seenCommands.add(seg);
      seenCommands.add(norm);
      if (!declaredCommands.some((c) => norm === c || norm.startsWith(c + " "))) {
        out.push({ kind: "undeclared", op: "EXEC", target: norm });
      }
    }
  }
  for (const w of declaredWrites) {
    if (![...seenWrites].some((seen) => pathMatchesGrant(seen, w, []))) {
      out.push({ kind: "unused", op: "FS_WRITE", target: w });
    }
  }
  for (const c of declaredCommands) {
    if (![...seenCommands].some((s) => s === c || s.startsWith(c + " "))) {
      out.push({ kind: "unused", op: "EXEC", target: c });
    }
  }
  return out;
}

/* ─────────────── container args derived from the permit ─────────────── */

export interface HeimdallRuntimeConfig {
  containerEngine: string;
  containerRuntimeImage: string;
  containerUser: string;
  containerCpuLimit: number;
  containerMemoryLimit: string;
  containerPidsLimit: number;
  codexHome: string;
  network: string;
  proxyUrl: string;
  providerEnvKey: string;
  placeholderKey: string;
}

/**
 * Pure function — testable without Docker.
 * Deny by default: only what the permit granted is reachable.
 */
export function buildHeimdallRunArgs(
  permit: Permit, workspacePath: string, cfg: HeimdallRuntimeConfig, codexArgs: readonly string[],
): string[] {
  if (permit.denied) throw new Error("HEIMDALL: refusing to build args for a denied permit");
  if (permit.requiresHumanApproval) throw new Error("HEIMDALL: refusing to build args for an unapproved permit");
  verifyPermitIntegrity(permit);   // the granted set must still be exactly what was decided

  const engine = cfg.containerEngine.split(/[\\/]/).at(-1)?.toLowerCase();
  const writable = permit.grantedWrites.length > 0;

  return [
    "run", "--rm", "--init",
    "--name", "heimdall-" + permit.runId.slice(0, 20),
    "--label", "io.heimdall.permit=" + permit.permitId,
    "--label", "io.heimdall.run=" + permit.runId,
    ...(engine === "podman" ? ["--userns", "keep-id"] : []),
    // no bridge: the only route out is the proxy, and the proxy obeys the permit
    "--network", cfg.network,
    "--env", "HTTP_PROXY=" + cfg.proxyUrl,
    "--env", "HTTPS_PROXY=" + cfg.proxyUrl,
    "--env", "http_proxy=" + cfg.proxyUrl,
    "--env", "https_proxy=" + cfg.proxyUrl,
    // The proxy's own address must be exempted from being proxied THROUGH
    // itself: base_url (see writeProxiedCodexConfig) already points model
    // traffic straight at it, so a client that also honours HTTP(S)_PROXY for
    // that same host — Codex does — would otherwise wrap it in a second,
    // self-referential proxy hop and send an absolute-URI request line whose
    // "destination" is the proxy's own name. The proxy would then try to
    // permit-check ITS OWN address as if it were the real provider, which no
    // permit ever grants (rule P-07). NO_PROXY makes the client connect to it
    // directly instead — exactly where base_url already sends it.
    "--env", "NO_PROXY=" + new URL(cfg.proxyUrl).hostname,
    "--env", "no_proxy=" + new URL(cfg.proxyUrl).hostname,
    // the REAL Ark key never enters the container; the proxy injects it upstream
    "--env", cfg.providerEnvKey + "=" + cfg.placeholderKey,
    "--env", "HEIMDALL_CAPABILITY=" + permit.capabilityToken,
    // Codex needs a writable home (session state, the rollout recorder); the shared
    // config below is mounted read-only, so the entrypoint copies config.toml out of
    // it into this per-container, non-persisted directory before Codex starts.
    // Not under /tmp: Codex refuses to place its own helper binaries in a
    // well-known shared temp directory.
    "--env", "CODEX_HOME=/codex-home-rw",
    "--env", "HEIMDALL_CODEX_HOME_RO=/codex-home-ro",
    "--env", "HOME=/tmp",
    "--env", "NO_COLOR=1",
    "--security-opt", "no-new-privileges",
    "--cap-drop", "ALL",
    "--cpus", String(cfg.containerCpuLimit),
    "--memory", cfg.containerMemoryLimit,
    "--pids-limit", String(cfg.containerPidsLimit),
    "--user", cfg.containerUser,
    "--mount", `type=bind,src=${workspacePath},dst=${CONTAINER_WORKSPACE_ROOT}${writable ? "" : ",readonly"}`,
    // read-only: closes the shared cross-agent /codex-home hole in the baseline kit
    "--mount", `type=bind,src=${cfg.codexHome},dst=/codex-home-ro,readonly`,
    "--workdir", CONTAINER_WORKSPACE_ROOT,
    cfg.containerRuntimeImage,
    "codex",
    ...codexArgs,
  ];
}

/* ─────────────── the egress proxy's own sidecar container ─────────────── */

/**
 * The port the proxy sidecar listens on inside its own container. Never
 * published to the host — only reachable by container name from the agent
 * container, both being on `network` below.
 */
export const PROXY_SIDECAR_PORT = 8080;

export interface HeimdallProxySidecarConfig {
  containerEngine: string;
  proxyImage: string;
  /** the isolated agent network — the sidecar joins it as a peer of the agent container */
  network: string;
  /** a normal, non-internal network — the sidecar's only route to the real internet */
  egressNetwork: string;
  providerHost: string;
  providerKey: string;
  /** Scheme the sidecar uses to reach providerHost. Defaults to "https" — every real provider is. */
  providerScheme?: "http" | "https";
}

/**
 * Docker Desktop's --internal networks have no route back to the host (verified
 * directly: neither host.docker.internal nor the network's own gateway IP are
 * reachable from an --internal network there), so the proxy can no longer live
 * on the host. It runs as its own container instead, attached to BOTH the
 * isolated agent network (so the agent container can reach it as a peer, by
 * name) and a normal egress network (so it — and only it — can reach the
 * internet). Scoped to exactly one permit: one run, one phase.
 *
 * Pure function — testable without Docker.
 */
export function buildHeimdallProxyRunArgs(
  permit: Permit, cfg: HeimdallProxySidecarConfig, name: string,
): string[] {
  return [
    "run", "-d", "--rm", "--init",
    "--name", name,
    "--label", "io.heimdall.proxy=" + permit.permitId,
    "--label", "io.heimdall.run=" + permit.runId,
    "--network", cfg.network,
    "--network", cfg.egressNetwork,
    "--security-opt", "no-new-privileges",
    "--cap-drop", "ALL",
    "--cpus", "0.5",
    "--memory", "128m",
    "--pids-limit", "64",
    "--env", "HEIMDALL_CAPABILITY=" + permit.capabilityToken,
    "--env", "HEIMDALL_GRANTED_HOSTS=" + permit.grantedHosts.join(","),
    "--env", "HEIMDALL_PERMIT_EXPIRES_AT=" + String(permit.expiresAt),
    "--env", "HEIMDALL_PROVIDER_HOST=" + cfg.providerHost,
    "--env", "HEIMDALL_PROVIDER_SCHEME=" + (cfg.providerScheme ?? "https"),
    // this container's own --name, so ProxyHooks.selfHost (proxy.ts) can
    // unwrap a self-referential absolute-URI request the same as origin-form
    "--env", "HEIMDALL_SELF_HOST=" + name,
    // the REAL key lives only here, in our own trusted sidecar — never in the agent container
    "--env", "HEIMDALL_PROVIDER_KEY=" + cfg.providerKey,
    "--env", "HEIMDALL_RUN_ID=" + permit.runId,
    "--env", "HEIMDALL_AGENT_ID=" + permit.agentId,
    "--env", "HEIMDALL_SIDECAR_PORT=" + String(PROXY_SIDECAR_PORT),
    cfg.proxyImage,
  ];
}