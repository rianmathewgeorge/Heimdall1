/**
 * Pre-submission self-audit.
 * The acceptance checklist requires that no secret appears in source, logs, traces,
 * screenshots, browser storage or demo output. This scans the repo with Heimdall's
 * OWN detector, so the thing that protects the agent also protects the submission.
 *
 *   npm run audit
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { containsSecret, looksLikeInjection } from "../apps/server/src/heimdall/engine.js";

const ROOT = path.resolve(import.meta.dirname, "..");
/**
 * The audit is about what is COMMITTED, not what a run leaves behind. Runtime
 * state (ledger, workspaces, codex homes) legitimately contains generated
 * tokens, so scanning it made `npm run check` fail for anyone who had actually
 * run the POC once — the check passed only on a pristine clone.
 */
const SKIP = new Set([
  "node_modules", ".git", "dist", "build", "coverage", "package-lock.json",
  "workspaces", "codex-home",
]);

/** Local state and tooling always live in a dot-directory; source never does. */
const isLocalStateDir = (name: string): boolean => name.startsWith(".");
/** Files that legitimately contain placeholder credentials. */
const ALLOWED = [
  /\.env\.example$/, /terraform\.tfvars\.example$/, /^docs\//, /^README\.md$/,
  /^scenarios\//, /^deploy\//, /\.test\.ts$/,
];
/** A file may opt out with this marker when it deliberately contains fixture values. */
const OPT_OUT = "heimdall-audit-ignore";

const secrets: string[] = [];
const injections: string[] = [];
let scanned = 0;

function walk(dir: string): void {
  for (const name of readdirSync(dir).sort()) {
    if (SKIP.has(name)) continue;
    const abs = path.join(dir, name);
    const info = statSync(abs);
    if (info.isDirectory()) {
      if (!isLocalStateDir(name)) walk(abs);
      continue;
    }
    if (info.size > 400_000) continue;
    if (!/\.(ts|tsx|js|jsx|json|md|ya?ml|sh|toml|tf|xml|html|css|txt|example)$/.test(name)) continue;
    const rel = path.relative(ROOT, abs);
    if (ALLOWED.some((r) => r.test(rel))) continue;
    const text = readFileSync(abs, "utf8");
    if (text.includes(OPT_OUT)) continue;
    scanned++;
    if (containsSecret(text)) secrets.push(rel);
    if (looksLikeInjection(text)) injections.push(rel);
  }
}
walk(ROOT);

console.log(`\nHEIMDALL SELF-AUDIT — ${scanned} files scanned with our own detector\n`);
console.log(`  secret-shaped content    : ${secrets.length === 0 ? "NONE ✓" : secrets.join(", ")}`);
console.log(`  injection-shaped content : ${injections.length === 0 ? "NONE ✓" : injections.join(", ")}\n`);
if (secrets.length > 0) { console.error("FAIL — a credential-shaped value is in the repo.\n"); process.exit(1); }
console.log("RESULT: PASS\n");
