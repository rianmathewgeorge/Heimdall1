# Heimdall — threat model

Protected assets: the provider credential, the operator's other agents and data,
the host, and the integrity of the audit record.

Trust boundaries: browser → API (no key in the browser); API → agent container
(the container is untrusted); container → internet (only via the sidecar).

| Threat | Control | Where it is proven |
|---|---|---|
| Credential theft | The container holds `heimdall.proxy.injected`, never the real key. The sidecar terminates the model channel and attaches the credential upstream. | `proxy.test.ts` "swaps the placeholder for the real key"; `codex-capability.integration.test.ts` |
| Secret leaking into logs/traces | Every event, receipt and ledger entry passes `redact()` before storage. The self-audit scans the repo with the product's own detector. | `npm run audit`; "the ledger redacts before hashing or storing" |
| Confused deputy / privilege escalation | An agent has its OWN principal, never the human's. Authority is a scoped, time-bound, revocable permit; approval re-bases the window. | `identity.test.ts` revocation and rotation tests |
| Cross-user access | Ownership checks at the API for every agent, run, trace and session. A non-owner gets 404, not 403. | `identity.test.ts` "User A cannot read User B's protected resource" |
| Prompt injection | Injection-shaped workspace content is *observed* as taint (never declared), which escalates the tier. The manifest is data: a declared risk field cannot influence scoring. | scenario corpus I1–I4; probe "a declared risk field cannot influence scoring" |
| Tool misuse / undeclared actions | Deny-by-default: only permit-granted commands and paths run. Compound commands are decomposed per segment; redirects are checked against write grants. | `heimdall.test.ts` compound-command tests (4 allow / 9 deny) |
| Data exfiltration | The sidecar enforces a host allowlist and inspects payloads on the terminated channel. Denials produce a counterfactual receipt. | scenario A4; `proxy.test.ts` "credential-shaped payload does not reach the model" |
| Sandbox escape | Non-root `--user`, `--cap-drop ALL`, `no-new-privileges`, cpu/memory/pid limits, workspace-only mounts, per-run codex home. | `buildHeimdallRunArgs` tests |
| Runaway execution / cost | Container budget is the lesser of `CODEX_TIMEOUT_MS` and the permit's remaining window; output cap; approval timeout fails closed; orphan reaping at boot. | container-loop timeout test; live crash-restart check |
| Audit tampering | Hash-chained ledger; `GET /api/heimdall/ledger/verify` walks the chain and reports the first broken index. | "tampering breaks the chain at exactly the right index" |
| Coordination abuse | The countdown sequence advances from committed state, not from what an agent says; one turn in flight at a time; unanswered turns are reclaimed. | `coordination.test.ts` skip/duplicate/timeout tests |

## Residual risks — stated, not hidden

1. **A raw socket can still leave the box.** The default network keeps agents off
   the shared bridge and the proxy is the only credentialled path, but host-level
   filtering needs the `--internal` topology (Linux; Docker Desktop cannot reach a
   host-side proxy that way).
2. **TLS bodies to other granted hosts are opaque.** Payload inspection covers the
   model channel and plain HTTP, not `CONNECT` tunnels.
3. **Bare all-lowercase secrets** with no key name in front are not caught by the
   entropy path — the deliberate trade that removed 30 false positives.
4. **Single-process, in-memory** event history and coordination state. The
   persisted run record and ledger survive a restart; live event history does not.
5. **The identity directory is a mock.** It demonstrates the authorization
   boundary, not an IdP. `resolveHuman` is the seam to replace.
6. **`HEIMDALL=off` has no protection at all** — by design, so the comparison is
   honest.
