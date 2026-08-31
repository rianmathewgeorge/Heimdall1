# HEIMDALL — intent-bound execution for agent platforms

**Selected middleware capability:** an invented one — *a permit, and the provenance of its use.*
It spans identity/delegation, human-in-the-loop approval, sandboxing and audit, because those
turn out to be one mechanism seen from four angles.

> **Thesis:** intent before execution, verification after execution.
> A manifest is a promise the agent cannot be talked out of.

---

## The problem

The starter kit's own README says it: *"It intentionally has no identity, tracing, audit, or
hardened sandbox middleware."* Today the platform's entire safety policy is a paragraph of English
in `AGENTS.md` asking the agent not to misbehave — and an agent takes instructions from **any file
it reads**. A poisoned README talks it out of the paragraph. That is indirect prompt injection.

Most defences try to *detect* the bad instruction. That is unwinnable: the attacker writes the
input. Heimdall detects nothing. It refuses to widen permissions mid-run.

## The loop

```
user prompt
  → ① RECON      codex --sandbox read-only, cannot write a byte
  → MANIFEST     the agent declares FACTS: paths, commands, hosts, data class. No scores.
  → ② SCORE      our code + policy/termsheet — six axes, hard rules, discounts
  → ③ RESOLVE    T2 band settled by deterministic rules R1–R8, never by a model
  → PERMIT       tier, itemised receipt, granted capability
  → ④ EXECUTE    container built FROM the permit; broker checks every action
  → ⑤ RECONCILE  declared vs actual → contract violations
  → ⑥ WRITE BACK denial → precedent store (enforced) · failure → error.txt (advisory)
```

**Scrutiny rises monotonically with risk:** `T0` allow · `T1` allow+notify ·
`T2` code resolves · `T3` human approves · `T4` denied.

## What we changed in the baseline, and why

| Baseline weakness (found by reading the kit) | Heimdall |
|---|---|
| `--network bridge` — the container has the whole internet | internal network; the only route out is our proxy, which obeys the permit |
| `--env ARK_API_KEY` — the agent holds the platform credential | container gets `heimdall.proxy.injected`; the **real key never enters it** — the proxy injects it upstream |
| `AGENTS.md` asks it not to print credentials | a request, not a control. Replaced by enforcement at the boundary |
| `CODEX_SANDBOX_MODE` is one global setting | per-agent policy in `policy/<agentId>.json` |
| one shared bearer token, no users | a permit is scoped, time-bound and revocable delegation |
| `parseCodexEventLine` discards every command and file change | the broker taps the same stream and records everything |
| `/codex-home` bind-mounted **read-write and shared by every agent** | mounted **read-only** — closes a cross-agent tampering path |
| a failed run yields one error string | run record: manifest, permit, denials, divergences, timings |

## Running it

```bash
npm run poc          # baseline flow, unchanged
npm run check        # typecheck + 85 tests + corpus + 37 probes + self-audit + build
npm run scenarios    # the 12-scenario corpus, metrics generated from the real engine
npm run probe        # 37 adversarial probes against the enforcement surfaces
npm run audit        # scans the repo with our own detector for leaked secrets
```

**The off switch is the proof of integration.** `HEIMDALL=off npm run poc` restores the untouched
baseline; `HEIMDALL=on` (default) engages everything. We never edited `app.ts` or `agent-service.ts` —
Heimdall enters at the three-method `AgentRunner` seam via `runner-factory`.

| Variable | Default | Meaning |
|---|---|---|
| `HEIMDALL` | `on` | `off` restores the baseline runner |
| `HEIMDALL_NETWORK` | `heimdall-internal` | isolated docker network the agent container runs on — no route out except the proxy sidecar |
| `HEIMDALL_EGRESS_NETWORK` | `heimdall-egress` | normal docker network — the proxy sidecar's only route to the internet |
| `HEIMDALL_APPROVAL_TIMEOUT_MS` | `300000` | unanswered approvals **fail closed** |
| `HEIMDALL_DEGRADED` | `off` | `on` = fall back to standing policy when recon fails |
| `HEIMDALL_POLICY_DIR` | `./policy` | per-agent standing policy |

### Model provider

Either provider works; Heimdall injects whichever key is active and the agent container
only ever sees a placeholder.

```bash
# Volcengine Ark (default)
ARK_API_KEY=... ARK_MODEL=ep-... npm run poc

# OpenRouter
MODEL_PROVIDER=openrouter OPENROUTER_API_KEY=sk-or-... \
  OPENROUTER_MODEL=deepseek/deepseek-chat-v3-0324:free npm run poc
```

`npm run poc` creates both `heimdall-internal` and `heimdall-egress` automatically on first
run; no manual setup needed. (Manually: `docker network create --internal heimdall-internal`
and `docker network create heimdall-egress`.)

## API

`GET /api/heimdall/status` · `/termsheet` · `/metrics` · `/pending` · `/runs` · `/runs/:id`
`/ledger` · `/ledger/verify` · `/precedents/:id` · `/policy/:id`
`POST /api/heimdall/runs/:id/decide` · `PUT /api/heimdall/policy/:id`

## Capability tokens — a run id is an identifier, never a credential

The container presents an unguessable 64-hex per-run token in `x-heimdall-capability`;
the proxy resolves the permit from it with a constant-time compare. Run ids appear in
container names and labels so operators can find a run in `docker ps`, but they are not
usable as credentials — a container that guesses another run's id gains nothing.

## The egress proxy runs as its own sidecar container, not in-process

The obvious design has the proxy run inside the platform's own server process, listening on
the host, with the agent container reaching it via `host.docker.internal`. That breaks on
Docker Desktop: verified directly (a container on an `--internal` network cannot reach the
host at all there — not by that hostname, not by the network's own gateway IP; native Linux
dockerd is documented to still permit the gateway IP even on `--internal` networks, since
host and bridge share one kernel there, but Docker Desktop's host is a genuinely separate VM
boundary). A host-bound proxy is therefore unreachable from the one network the agent
container is allowed on, for every real run.

The proxy runs as its own container instead — one per run-phase (recon and execution each
get a fresh one, scoped to exactly that phase's permit), attached to **both**
`HEIMDALL_NETWORK` (so the agent container reaches it as a peer, by container name) and
`HEIMDALL_EGRESS_NETWORK` (its only route to the internet). The agent container's own network
membership is unchanged: `heimdall-internal` only, still with no route out except through
that peer. See `apps/server/src/heimdall/proxy-standalone.ts` and `Dockerfile.proxy`.

## Reconnaissance cannot write, and does not rely on the sandbox flag

Codex's `--sandbox read-only` depends on Landlock, which is unavailable on some hosts —
Docker Desktop on macOS reports exactly this and falls back to `danger-full-access`. So the
recon phase runs under a permit that grants no writes at all, which means
`buildHeimdallRunArgs` mounts the workspace **read-only**. Recon provably cannot persist a
byte whatever the sandbox reports, because the control is the mount, not the flag.

## Permit integrity — a decision is bound to the exact capability set

Every permit carries `requestHash`, a hash of the granted writes, reads, hosts and commands.
When an operator approves, that hash is stored as `approvedHash`. It is recomputed and compared
immediately before the container is built, so a granted set that drifts between decision and
execution **fails closed**. Approving "write `src/app.ts`" cannot silently become anything else.

## Verification

95 tests in `apps/server/src/heimdall/*.test.ts`, wired into `npm run check` so the build fails if
containment drops. The nine acceptance tests: fail-closed manifest · permit cannot widen policy ·
deny by default · canary and credential paths · redaction everywhere · precedent asymmetry ·
policy change invalidates approvals · ledger tamper detection · **benign runs still complete**.

`scenarios/probe.ts` runs 37 adversarial probes — host suffix and subdomain attacks, command
injection through a granted prefix, path traversal, permit tampering, precedent abuse, redaction
leakage. Five live weaknesses were found and fixed this way (see the regression tests).

`loop.test.ts` drives the real runner end to end on a temp workspace: recon → taint observation →
permit → denial/approval → `error.txt` → precedent → ledger.

Two files run against a real Docker daemon rather than stubs (skip cleanly when Docker isn't
reachable, so the rest of the suite stays Docker-free): `recon-container.integration.test.ts`
builds the actual runtime entrypoint and proves the writable `CODEX_HOME` / read-only shared-mount
split; `proxy-sidecar.integration.test.ts` builds the actual proxy image and proves an agent-like
container on the isolated network has no direct route to a target host, but reaches it through the
sidecar — which still enforces the granted-host permit.

## KNOWN LIMITATIONS

Stated deliberately rather than left for a reviewer to find.

1. **Codex sessions do not persist across runs.** `CODEX_HOME` is now a fresh, writable,
   per-container directory seeded only with `config.toml` (copied in by the container
   entrypoint from a read-only shared mount) — Codex needs it writable for its own session
   state, including the rollout recorder, which a read-only mount silently broke. That closes
   the earlier cross-agent read exposure entirely (nothing persists to read), but also means
   `codex resume <threadId>` has no prior state to resume from between runs. A per-agent
   persistent-but-isolated session directory would restore continuity without reopening the
   cross-agent hole.
2. **TLS bodies are opaque.** For `CONNECT` tunnels the proxy enforces the host but cannot inspect
   the payload. Payload inspection covers plain HTTP and the Ark path, which we terminate.
3. **Codex event names are version-dependent.** `observeEvent` matches defensively and logs any
   shape it does not recognise as `unmapped-events` rather than guessing. Unrecognised actions are
   **denied**, not allowed.
4. **Bare all-lowercase secrets** with no `KEY=` in front are not caught by the entropy path
   (this is the deliberate trade that removed 30 false positives across the starter kit). They are
   still caught by the prefix list and the assignment path.
5. **Recon costs one extra model call** per novel capability set. Precedent removes it on repeats.
6. **Single process.** The store mirrors the kit's own JSON persistence model.
7. **Not hardened multi-tenant isolation.** The boundary is the container plus the broker. A
   microVM runtime is out of scope per the brief.

## What we would build next

Break-glass override with automatic expiry · blast-radius preview on the approval card ·
an advisory LLM annotation beside the deterministic tier (explaining risk, never deciding it) ·
`fs.realpathSync` path resolution · OpenTelemetry export of the ledger.

## Verified against a real Codex container

Everything below was confirmed by running codex-cli 0.111 in the real runtime
image, through the real proxy sidecar, against a scripted provider — not by
reading the code. Reproduce with `npx vitest run apps/server/src/heimdall/*.integration.test.ts`.

**`usage.total_tokens` is mandatory.** Codex's Responses client refuses a
`response.completed` whose `usage` lacks `total_tokens` and reports it as
`stream disconnected before completion: failed to parse ResponseCompleted:
missing field 'total_tokens'`, retries five times, then fails the run. That is
the error seen against OpenRouter, whose `/responses` endpoint is beta. Because
the proxy terminates the model channel it repairs the event in flight
(`normaliseUsage` in `proxy.ts`), mapping the chat-completions spellings when
those arrive instead. `HEIMDALL=off` has no proxy and so cannot be protected this
way — the middleware makes the system strictly more robust than the baseline.

**`wire_api` must be `"responses"`.** Codex ≥0.111 refuses to start with
`wire_api = "chat"`: *"`wire_api = "chat"` is no longer supported"*.

**The item kind lives in `item.type`, not `item_type`.** Verified from a real
stream: `{"type":"item.completed","item":{"id":"item_1","type":"command_execution",...}}`.
`observeEvents` accepts either, so it works across both layouts.

**Codex 0.111 has no patch tool.** Its tools are `exec_command`, `write_stdin`,
`update_plan`, `request_user_input`, `web_search`, `view_image`. Files are written
by running shell commands, so a write emits an EXEC event and no FS event at all.
Two consequences: `EXEC` is the real enforcement point, and reconciliation diffs
the workspace before and after the run — otherwise every declared write was
reported "unused" even when the file was plainly created.

**Commands arrive wrapped and chained.** Every command is `/usr/bin/bash -lc
'<script>'`, and real work chains with `&&`. Treating any metacharacter as
"exact match only" killed a real run on its first action. The broker now unwraps
the login shell and checks each top-level segment against the permit
independently — stricter than prefix matching, and it still refuses anything it
cannot read: command substitution, backticks, redirection, and backgrounding.

**Two images must exist and be current.** A missing `heimdall-proxy:local`, or a
`volc-agent-runtime:local` built before the writable-`CODEX_HOME` change, both
fail *before* a container is created — so nothing appears in `docker ps -a` and
the run error says nothing about the image. Both are checked at boot now, with
the rebuild command in the message.

### Operational notes found by running it

**Rebuild the sidecar after editing `proxy.ts`.** The sidecar runs a copy of the
proxy baked into its image, so editing the source and restarting the server
changes nothing — the old code keeps enforcing. This cost real debugging time
twice, so boot now compares the image against the newest source file and says so.

**Cancellation is not containment.** Cancelling a run tears down its containers
the same way a denial does, and reporting it as "a blocked action was attempted"
counted operator actions as security containments in the metrics. A cancel now
reports as `cancelled`.

**The runtime phones home.** Codex contacts `ab.chatgpt.com` on its own; the
proxy blocks it, correctly. Those denials are marked `platform: true` and
excluded from `contained`/`denials` — otherwise every clean run reported as
contained and the security metric measured the runtime, not the agent.

**`npm run check` must survive a real run.** The audit scans the repo with the
product's own detector; runtime state (`.data`, `codex-home`, agent workspaces)
legitimately holds generated tokens, so it is skipped. Before that, `check`
passed only on a pristine clone and failed for anyone who had actually used it.

**The canary is never shown to the planner.** `.config/credentials` is a honeypot
whose read is an automatic T4 denial. Listing it in the recon prompt invited the
planner to declare a read of it, so a benign task could be refused over a file
the platform planted itself. Dot-directories are excluded from the digest.

### From a real OpenRouter run

The planner emitted `{"op":"NET_READ"}` with no host. Validation rejected the
WHOLE manifest, so an otherwise correct plan was thrown away — twice by the
direct planner and twice more by container recon — and the run failed closed
after ~52 seconds and two container boots.

Three changes, in order of how early they act:

1. **The prompt names the required field per op**, and says to omit a NET_*
   capability entirely rather than emit one without a host.
2. **Fields are normalised before validation.** A host is recovered from `url`,
   `domain`, `endpoint`, `hostname` or `uri`, and reduced from a full URL to a
   bare hostname; `path`/`files` become `paths`; `cmd` and argv arrays become
   `command`; snake_case keys become camelCase; ops are upper-cased. This renames
   what the model said — it never invents or widens a capability.
3. **A capability that still fails validation is DROPPED, not fatal.** It is
   never granted (so it is fail-safe: attempting it is refused at execution with
   a receipt) and it is recorded in `manifest.dropped`, logged, and shown on the
   timeline. The run fails closed only when NOTHING validates.

The same run now completes in ~1s with the bad capability dropped and recorded.

Separately, `response_format: {"type":"json_object"}` is requested first because
it improves reply quality, but a provider that rejects it (400/404/422) gets one
retry without it rather than failing the run over a formatting preference.

### Rendering model answers

Answers are markdown with LaTeX. The Playground printed `message.content` as raw
text, so a correct explanation arrived as literal `###`, `**bold**` and
`\[\operatorname{Cov}(X,Y)=\frac{1}{n}\sum…\]` — the reader was shown the source,
not the answer. `MessageBody` now renders markdown (GFM tables, lists, code) and
typesets maths with KaTeX.

Two details that matter:

- **`\(…\)` and `\[…\]` are converted to `$…$` / `$$…$$` first.** `remark-math`
  only understands the dollar forms, and models overwhelmingly emit the LaTeX
  ones. Fenced and inline code are skipped, so a code sample containing `\[` is
  left as code. Block maths is dedented, or an indented `\[` inside a list item
  continues the list and typesets inline instead of as a display block.
- **This renders UNTRUSTED model output.** `rehype-raw` is deliberately NOT
  installed, so embedded HTML is escaped rather than executed, and KaTeX runs
  with `trust: false`. Links are forced to `target="_blank" rel="noreferrer"`.
  A test asserts that `<img onerror>` and `<script>` reach the DOM as text.

### The permit window starts at approval

A permit's expiry ran from when it was drafted, so time spent waiting for a human
came out of the run's own budget: an operator who took a few minutes to approve
handed over a permit that was nearly expired, and the container was killed almost
immediately. The window is now re-based on the approval — never lengthened beyond
what the manifest and the standing policy already allow.

## Renamed from Warrant

The project was renamed wholesale. Everything moved together — there is no
compatibility shim, so anything that referred to the old name must be updated:

| Was | Now |
|---|---|
| `WARRANT=off`, `WARRANT_NETWORK`, `WARRANT_*` | `HEIMDALL=off`, `HEIMDALL_NETWORK`, `HEIMDALL_*` |
| `/api/warrant/*` | `/api/heimdall/*` |
| `warrant-proxy:local` | `heimdall-proxy:local` |
| networks `warrant-internal` / `warrant-egress` | `heimdall-internal` / `heimdall-egress` |
| labels `io.warrant.*` | `io.heimdall.*` |
| header `x-warrant-capability` | `x-heimdall-capability` |
| `WARRANT_PROXY_READY` / `WARRANT_DENIAL_JSON` | `HEIMDALL_PROXY_READY` / `HEIMDALL_DENIAL_JSON` |
| audit opt-out `warrant-audit-ignore` | `heimdall-audit-ignore` |
| `apps/server/src/warrant/` | `apps/server/src/heimdall/` |

Two deliberate exceptions:

- **`LICENSE` was not touched.** It contains "WARRANTY" and "WARRANTIES" in the
  MIT text, which are the English words, not the product.
- **Orphan reaping still looks for `io.warrant.*` as well.** A container left
  behind by a pre-rename build would otherwise never be cleaned up, and a stale
  sidecar still holds a provider key.

**Rebuild the proxy image after pulling this**: the image name changed and the
sidecar's entrypoint moved to `dist/heimdall/proxy-standalone.js`. `npm run poc`
does it; otherwise the boot preflight will tell you the image is missing.

## Middleware capabilities

Mapped to the challenge's recommended directions. Each row names where it is
*enforced* and where it is *proven* — a control that exists only in the UI is
not a control.

### Identity and authorization
- **Human vs Agent principals.** A human authenticates; an agent gets its OWN
  principal (`ap_…`), minted at creation, never the human's credential.
- **Ownership isolation.** Every agent, run, trace and session route resolves
  through `requireOwnedAgent`. A non-owner gets **404, not 403** — confirming an
  id exists but belongs to someone else is itself a disclosure.
- **Delegated authority.** The permit is the delegation: scoped to a granted set,
  time-bound, and re-based on approval so waiting for a human does not eat the
  run's budget.
- **Revocation bites at execution.** `POST /api/identity/agents/:id/revoke` and
  the next run is refused 403 — while the owner's own credential keeps working.
- **Attribution.** Written to the ledger *first*, before anything can fail, so
  "who tried this" survives a run that never got a permit.

`GET /api/identity/me`, `/api/identity/agents/:id`, `POST …/revoke`, `…/rotate`.
Users A and B are seeded (`HEIMDALL_USER_A_TOKEN`, `HEIMDALL_USER_B_TOKEN`) with
one protected record each, so the isolation claim is testable in one curl.

### Trace, audit and observability
A run is one trace. Spans are **derived** from the run's own event stream, so
there is no second source of truth to drift: stable `traceId`/`spanId`, span
categories (`model_call`, `policy_decision`, `human_approval`,
`sandbox_execution`, `cloud_operation`, `orchestration`), durations, status,
first-failure and critical-path helpers, token usage when reported.
`GET /api/traces`, `/api/traces/:id`, `/api/traces/:id/export` (machine-readable).
Payloads are redacted before storage, so the trace cannot leak what the ledger won't.

### Multi-agent coordination
`POST /api/coordination/sessions` with several agents runs a shared countdown.
The invariant lives in the **platform, not the prompt**: the next value comes
from committed state, one turn is in flight at a time, and an unanswered turn is
reclaimed. An agent that answers 7 when the sequence is at 4 is rejected and the
number re-offered — verified live, and in tests that deliberately misbehave.
`GET /api/coordination/sessions/:id` returns the history plus a `verification`
block reporting duplicates and gaps.

### Layered architecture and threat model
See `docs/ARCHITECTURE-LAYERS.md` (layers, the three contracts between them, and
how each could be swapped) and `docs/THREAT-MODEL.md` (threats, controls, where
each is proven, and six residual risks stated rather than hidden).

### Measured results
`npm run report` regenerates `docs/RESULTS.md` from actual execution — the
corpus, the probes, the test suite and the real planner prompt. No figure in it
is hand-entered.
