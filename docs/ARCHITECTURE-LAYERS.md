# Heimdall — layered architecture

How responsibilities are split, and where each one is enforced. The column that
matters is the last: a control that lives only in the UI is not a control.

| Layer | Responsibility | Where it lives | Enforced at |
|---|---|---|---|
| Experience | Agent CRUD, Playground, trace views, permit decisions | `apps/web` | nothing — the UI holds no key and makes no decision |
| Control plane | Agent spec, run orchestration, reconciliation | `apps/server/src/app.ts`, `agent-service.ts` | Fastify routes, ownership-scoped |
| Identity & policy | Human and Agent principals, delegation, approval, revocation, attribution | `heimdall/identity.ts`, `engine.ts`, `runner.ts` | the API boundary and the permit |
| Agent runtime | Codex execution, retries, cancellation, limits | `heimdall/runner.ts`, `container-codex-runner.ts` | the container the permit builds |
| Execution & data | Workspaces, JSON state, protected records | `workspace.ts`, `store.ts` | bind mounts + ownership checks |
| Observability | Events, spans, hash-chained ledger, redaction | `events.ts`, `heimdall/trace.ts`, `heimdall/store.ts` | derived from the run's own stream |
| Cloud resources | Containers, networks, the egress sidecar | `heimdall/broker.ts`, `Dockerfile.proxy` | Docker: `--cap-drop`, `--user`, dual network |

## The contracts between layers

Three seams carry everything, and each is a place another implementation could
be substituted:

**`AgentRunner`** (`types.ts`) — `run`, `cancel`, `isAvailable`. Heimdall is a
wrapper around this interface, which is why `HEIMDALL=off` restores the
untouched baseline: the wrapper leaves the chain. Swapping in another runtime
means implementing three methods.

**The permit** (`heimdall/types.ts`) — the only thing that decides what a run
may do. `buildHeimdallRunArgs` derives the container purely from it, so there is
no path where the container is more capable than the permit says. A different
policy engine would produce the same struct.

**The event stream** (`events.ts`) — every stage transition, decision and
lifecycle point. Traces are *derived* from it (`heimdall/trace.ts`), so an
external trace backend consumes the same stream rather than a parallel one.

## How it would evolve

- **Another runtime**: implement `AgentRunner`. The permit, ledger and identity
  plane are unchanged.
- **A real IdP**: replace `IdentityDirectory.resolveHuman`. Everything downstream
  authorizes against `request.principal`, not against a token.
- **A real trace backend**: `GET /api/traces/:id/export` already emits the whole
  trace as JSON; point a collector at it.
- **Another model provider**: `activeProvider()` in `config.ts` plus the proxy's
  provider channel. Nothing else knows the provider exists.
