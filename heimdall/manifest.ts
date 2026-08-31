/** HEIMDALL — manifest extraction + validation. Fails closed. */
import { z } from "zod";
import type { Manifest } from "./types.js";

export class ManifestError extends Error {
  constructor(message: string) { super(message); this.name = "ManifestError"; }
}

const capabilitySchema = z
  .object({
    op: z.enum(["FS_READ", "FS_WRITE", "FS_DELETE", "EXEC", "NET_READ", "NET_WRITE", "ENV_READ", "PROC_SPAWN"]),
    paths: z.array(z.string().min(1)).max(200).optional(),
    command: z.string().min(1).max(500).optional(),
    host: z.string().min(1).max(253).optional(),
    dataClass: z.enum(["none", "metadata", "public", "dependency", "source_code", "undeclared"]).optional(),
    payloadPaths: z.array(z.string().min(1)).max(200).optional(),
  })
  .superRefine((c, ctx) => {
    if ((c.op === "NET_READ" || c.op === "NET_WRITE") && !c.host)
      ctx.addIssue({ code: "custom", message: `${c.op} requires "host"` });
    if (c.op === "EXEC" && !c.command)
      ctx.addIssue({ code: "custom", message: `EXEC requires "command"` });
    if (c.op.startsWith("FS_") && (!c.paths || c.paths.length === 0))
      ctx.addIssue({ code: "custom", message: `${c.op} requires a non-empty "paths"` });
  });

const manifestSchema = z.object({
  summary: z.string().trim().min(1).max(400),
  /*
   * MAY BE EMPTY. A question ("explain covariance") needs no filesystem, no
   * commands and no network — the honest manifest for it is zero capabilities.
   * Requiring at least one forced the planner to invent something, and what it
   * invented was a bare NET_READ with no host, which then failed validation and
   * killed the run. A task that needs nothing must be able to say so.
   */
  capabilities: z.array(z.unknown()).max(50),
  maxDurationMs: z.number().int().positive().max(3_600_000).optional(),
});

/**
 * Recon models frequently fill in optional fields they don't need with an explicit
 * `null` instead of omitting the key (especially when the prompt's example JSON shows
 * every field present). Zod's `.optional()` accepts a missing key but rejects `null`,
 * so normalize null-valued keys away before validation — an explicit null should mean
 * the same thing as omission everywhere in the manifest, not just for one field.
 */
function stripNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNulls);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === null) continue;
      out[key] = stripNulls(v);
    }
    return out;
  }
  return value;
}

/**
 * Models describe the same fact under different keys: a host arrives as `url`,
 * `domain` or `endpoint`; `paths` arrives as `path`; `dataClass` as `data_class`.
 * Rejecting the whole manifest over a synonym threw away an otherwise correct
 * plan and failed the run — observed against a real provider, where every
 * attempt emitted NET_READ with the host under another name.
 *
 * Normalising is not the same as trusting: nothing here invents a capability or
 * widens one. It only renames fields and reduces a URL to its host.
 */
const KEY_ALIASES: Record<string, string> = {
  data_class: "dataClass", dataclass: "dataClass",
  payload_paths: "payloadPaths", payloadpaths: "payloadPaths",
  max_duration_ms: "maxDurationMs", maxdurationms: "maxDurationMs",
};

/** Reduce anything URL-shaped to a bare hostname. */
export function toHost(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const raw = value.trim();
  if (raw === "") return undefined;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : "http://" + raw;
  try {
    const host = new URL(withScheme).hostname.toLowerCase();
    return host === "" ? undefined : host;
  } catch { return undefined; }
}

function normaliseCapability(input: unknown): unknown {
  if (input === null || typeof input !== "object") return input;
  const c: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    c[KEY_ALIASES[k.toLowerCase()] ?? k] = v;
  }

  if (typeof c["op"] === "string") c["op"] = c["op"].trim().toUpperCase().replace(/[\s-]+/g, "_");

  // a host may arrive under several names, and often as a full URL
  if (c["host"] === undefined) {
    for (const key of ["url", "domain", "endpoint", "hostname", "uri"]) {
      const host = toHost(c[key]);
      if (host !== undefined) { c["host"] = host; break; }
    }
  } else {
    const host = toHost(c["host"]);
    if (host !== undefined) c["host"] = host;
  }

  // paths may arrive singular, or under `files`
  if (c["paths"] === undefined) {
    const alt = c["path"] ?? c["files"] ?? c["file"];
    if (typeof alt === "string") c["paths"] = [alt];
    else if (Array.isArray(alt)) c["paths"] = alt;
  } else if (typeof c["paths"] === "string") c["paths"] = [c["paths"]];

  // command may arrive as `cmd`, or as an argv array
  if (c["command"] === undefined) {
    const alt = c["cmd"] ?? c["commands"];
    if (typeof alt === "string") c["command"] = alt;
    else if (Array.isArray(alt) && alt.every((x) => typeof x === "string")) c["command"] = alt.join(" ");
  } else if (Array.isArray(c["command"])) {
    c["command"] = (c["command"] as unknown[]).filter((x) => typeof x === "string").join(" ");
  }

  if (typeof c["payloadPaths"] === "string") c["payloadPaths"] = [c["payloadPaths"]];
  if (typeof c["dataClass"] === "string") c["dataClass"] = c["dataClass"].trim().toLowerCase();
  return c;
}

function normaliseManifest(input: unknown): unknown {
  if (input === null || typeof input !== "object") return input;
  const m: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    m[KEY_ALIASES[k.toLowerCase()] ?? k] = v;
  }
  // An omitted key means the same as an empty list: this task needs nothing.
  // Models express "no access required" both ways.
  if (m["capabilities"] === undefined) m["capabilities"] = [];
  if (Array.isArray(m["capabilities"])) m["capabilities"] = m["capabilities"].map(normaliseCapability);
  if (typeof m["maxDurationMs"] === "string") {
    const n = Number(m["maxDurationMs"]);
    if (Number.isFinite(n)) m["maxDurationMs"] = n;
  }
  if (typeof m["summary"] !== "string" || m["summary"].trim() === "") m["summary"] = "recon plan";
  return m;
}

/** Pull the first balanced JSON object out of a model's message. */
export function extractJson(text: string): string {
  const cleaned = text.replace(/```(?:json)?/gi, "");
  const start = cleaned.indexOf("{");
  if (start === -1) throw new ManifestError("no JSON object found in recon output");
  let depth = 0, inString = false, escaped = false;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (escaped) { escaped = false; continue; }
    if (ch === "\\") { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) return cleaned.slice(start, i + 1); }
  }
  throw new ManifestError("unbalanced JSON object in recon output");
}

/** FAIL CLOSED: anything not provably valid throws, and the caller must not execute. */
export function parseManifest(text: string): Manifest {
  let raw: unknown;
  try { raw = normaliseManifest(stripNulls(JSON.parse(extractJson(text)))); }
  catch (error) {
    if (error instanceof ManifestError) throw error;
    throw new ManifestError("unparseable manifest: " + (error as Error).message);
  }

  const asRecord = raw as Record<string, unknown> | null;
  if (asRecord !== null && typeof asRecord === "object" && typeof asRecord["error"] === "string") {
    throw new ManifestError("agent could not determine requirements: " + String(asRecord["error"]));
  }

  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ManifestError("invalid manifest: " + (first ? `${first.path.join(".")} ${first.message}` : "schema mismatch"));
  }

  /*
   * Validate each capability on its own. One malformed entry used to reject the
   * WHOLE plan and refuse the run — observed for real, where the model emitted a
   * NET_READ without a host and an otherwise perfect manifest was thrown away
   * four times over. A capability that does not validate is DROPPED, never
   * granted, and recorded; the run continues on what did validate. If the agent
   * genuinely needed the dropped one, the action is refused at execution with a
   * receipt, which is the same outcome by a clearer route.
   */
  const dropped: string[] = [];
  const valid: Array<z.infer<typeof capabilitySchema>> = [];
  for (const [i, entry] of parsed.data.capabilities.entries()) {
    const one = capabilitySchema.safeParse(entry);
    if (one.success) { valid.push(one.data); continue; }
    const issue = one.error.issues[0];
    const op = (entry as { op?: unknown })?.op;
    dropped.push(`capabilities.${i}${typeof op === "string" ? ` (${op})` : ""}: ${issue?.message ?? "invalid"}`);
  }
  /*
   * Zero valid capabilities is NOT a failure. It yields a permit that grants
   * nothing: read-only workspace, no commands, no egress beyond the model
   * channel. If the task really did need something, that action is refused at
   * execution with a receipt naming it — strictly more informative than
   * refusing the whole run over a malformed line the planner wrote.
   */

  // exactOptionalPropertyTypes: build each capability explicitly, omitting absent keys.
  const capabilities: Manifest["capabilities"] = valid.map((c) => {
    const out: Manifest["capabilities"][number] = { op: c.op };
    if (c.paths !== undefined) out.paths = c.paths;
    if (c.command !== undefined) out.command = c.command;
    if (c.host !== undefined) out.host = c.host;
    if (c.payloadPaths !== undefined) out.payloadPaths = c.payloadPaths;
    // A NET_WRITE with no declared payload class is "undeclared" (max egress points), never "none".
    if (c.dataClass !== undefined) out.dataClass = c.dataClass;
    else if (c.op === "NET_WRITE") out.dataClass = "undeclared";
    return out;
  });

  return {
    version: "1",
    summary: parsed.data.summary,
    capabilities,
    maxDurationMs: parsed.data.maxDurationMs ?? 600_000,
    ...(dropped.length > 0 ? { dropped } : {}),
  };
}

/** The recon form. Asks for FACTS only — there is deliberately no risk field. */
export function reconPrompt(userPrompt: string, journal: string): string {
  return [
    "## HEIMDALL RECONNAISSANCE MODE",
    "",
    "You are running READ-ONLY. You cannot modify anything, and any attempt will fail.",
    "Your only job this turn is to determine what the task below will require.",
    "",
    "### Task",
    userPrompt,
    "",
    journal.trim() ? "### Notes from previous runs (advisory)\n" + journal.trim() + "\n" : "",
    "### Reply format",
    "Reply with ONLY a JSON object matching this schema. No prose, no markdown fence.",
    "",
    "{",
    '  "summary": "<one sentence, plain English>",',
    '  "capabilities": [',
    "    {",
    '      "op": "FS_READ"|"FS_WRITE"|"FS_DELETE"|"EXEC"|"NET_READ"|"NET_WRITE"|"ENV_READ"|"PROC_SPAWN",',
    '      "paths": ["<path or glob>"],',
    '      "command": "<exact command>",',
    '      "host": "<hostname>",',
    '      "dataClass": "none"|"metadata"|"public"|"dependency"|"source_code",',
    '      "payloadPaths": ["<files whose CONTENTS leave the workspace>"]',
    "    }",
    "  ],",
    '  "maxDurationMs": 600000',
    "}",
    "",
    "### Rules",
    "- Declare every path, command and host you will need. Anything you do not declare will be blocked at execution time.",
    "- Declare only what this task needs. Padding the list will delay the run.",
    '- Every capability field except "op" is optional. OMIT a field entirely when it does not apply to that capability — never include it set to null.',
    "- State FACTS. Do not assess risk, severity or safety — that is not your role and it is decided elsewhere.",
    '- If you cannot determine the requirements, reply exactly: {"error":"<short reason>"}',
  ].filter(Boolean).join("\n");
}
