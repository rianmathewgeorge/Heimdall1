# Heimdall

Heimdall is a policy-enforcement layer for AI coding agents. Heimdall controls what an agent can do during a run. Heimdall does not let the browser make security decisions. Heimdall does not let the model grant itself authority. Heimdall does not give the agent container the real provider credential.

Heimdall runs on top of the **Volc Agent Launchpad**, a starter kit for a browser-based agent platform. The starter kit alone has no identity control, no audit trail, and no sandbox enforcement. Heimdall adds all three.

**Design rule:** Nothing crosses the trust boundary that the permit does not authorize.

---

## Warning

This project is a proof of concept. Do not run it with production data. Do not run it with production credentials. Read [SECURITY.md](./SECURITY.md) before you deploy it.

---

## Contents

- [The problem Heimdall solves](#the-problem-heimdall-solves)
- [How Heimdall works](#how-heimdall-works)
- [Trust boundary](#trust-boundary)
- [What Heimdall changes in the starter kit](#what-heimdall-changes-in-the-starter-kit)
- [Enforcement points](#enforcement-points)
- [Egress control](#egress-control)
- [Capability tokens](#capability-tokens)
- [Permit integrity](#permit-integrity)
- [Recovery and failure handling](#recovery-and-failure-handling)
- [Measured results](#measured-results)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Docker Compose](#docker-compose)
- [Development](#development)
- [Configuration](#configuration)
- [Deployment](#deployment)
- [Validation](#validation)
- [API reference](#api-reference)
- [Known limitations](#known-limitations)
- [Planned work](#planned-work)
- [Renamed from Warrant](#renamed-from-warrant)
- [Documentation](#documentation)
- [Terms used in this document](#terms-used-in-this-document)
- [License](#license)

---

## The problem Heimdall solves

An AI coding agent reads files during a task. A file can contain hidden text that gives the agent new instructions. Security teams call this attack **indirect prompt injection**.

The starter kit's only defense against this attack is a paragraph of English text in `AGENTS.md`. The text asks the agent not to misbehave. An attacker can write a file that talks the agent out of this instruction. The instruction is a request. It is not a control.

Heimdall does not try to detect bad instructions inside a file. Detection of this kind is not reliable, because the attacker writes the file. Heimdall enforces a boundary instead. Heimdall refuses to widen the agent's permissions during a run, no matter what the agent reads or says.

---

## How Heimdall works

Heimdall grants authority through one object: the **permit**. Heimdall builds the permit before the agent runs any command. The agent container receives only the capabilities named in the permit.

Each run passes through six stages.

1. **Recon.** The agent reads the workspace in read-only mode. The agent cannot write a file at this stage.
2. **Manifest.** The agent states the facts it needs: file paths, commands, hosts, and data types. The agent does not assign itself a risk score.
3. **Score.** Heimdall's own code scores the manifest against a fixed policy file. The policy uses six axes and a fixed set of rules. The model's opinion of its own risk has no effect on the score.
4. **Resolve.** Heimdall assigns a risk tier, from `T0` to `T4`. A fixed rule set makes this decision. A language model never makes this decision.
5. **Execute.** Heimdall builds the agent container from the permit, not from the prompt. A trusted broker checks every action the agent reports.
6. **Reconcile and record.** Heimdall compares what the agent declared against what the agent did. Heimdall writes a denial to the precedent store. Heimdall writes a failure to `error.txt`.

The risk tier sets the level of review for an action.

| Tier | Effect |
|---|---|
| `T0` | Heimdall allows the action. |
| `T1` | Heimdall allows the action and sends a notice. |
| `T2` | Heimdall's own code resolves the decision. |
| `T3` | A human must approve the action before Heimdall starts a container. |
| `T4` | Heimdall denies the action. |

---

## Trust boundary

Heimdall divides the system into two sides.

**Trusted side.** This side decides authority.
- Browser (Playground, approvals, trace views)
- Control plane (Fastify API, ownership checks)
- Identity and policy service (principal, delegation, revocation)
- Recon (read-only workspace scan)
- Manifest (declared capabilities)
- Term sheet (the static six-axis policy)
- Permit (the scoped, time-bound, revocable grant)
- Approval gate (the `T3` human decision point)

**Untrusted side.** Heimdall assumes this side is hostile.
- Agent runtime container (non-root, dropped capabilities, resource limits)
- Action broker (the broker itself runs on the trusted side, but it watches the untrusted container)

```text
                    TRUSTED SIDE
┌───────────────────────────────────────────────────────────────┐
│ Browser → Control Plane → Recon → Manifest → Term Sheet → Permit │
│                                                                 │
│                  Authority is decided here.                     │
└─────────────────────────────┬───────────────────────────────────┘
                               │
              ═════════════════╪═════════════════
                THE PERMIT IS THE ONLY GRANT
              ═════════════════╪═════════════════
                               │
┌─────────────────────────────▼───────────────────────────────────┐
│                     UNTRUSTED RUNTIME                            │
│ Agent container → Action Broker → Egress Sidecar → Provider      │
│                                                                   │
│ No direct route to the provider. No real key. Deny by default.   │
└───────────────────────────────────────────────────────────────────┘
```

The permit is the only object that crosses the boundary. The prompt does not grant authority. The model does not grant authority. The container does not grant authority. Only the permit grants authority.

### Layer map

| Layer | Responsibility | Enforced at |
|---|---|---|
| Experience | Agent creation, Playground, trace views | UI only. Holds no key. Makes no decision. |
| Control Plane | Agent specs, run orchestration | Fastify routes and ownership checks. |
| Identity and Policy | Principals, delegation, approval, revocation | API boundary and the permit. |
| Agent Runtime | Codex execution, limits, cancellation | The permit-derived container. |
| Execution and Data | Workspaces, run state, protected records | Mounts and ownership checks. |
| Observability | Events, spans, ledger, redaction | Derived from the run's own event stream. |
| Cloud Resources | Containers, networks, egress | Docker flags and network isolation. |

---

## What Heimdall changes in the starter kit

| Starter kit behavior | Heimdall behavior |
|---|---|
| The container runs on `--network bridge` and reaches the whole internet. | The container runs on an isolated network. Its only route out is Heimdall's proxy, which enforces the permit. |
| The container holds the real `ARK_API_KEY`. | The container holds a placeholder value only. The proxy attaches the real key upstream. The container never sees it. |
| `AGENTS.md` asks the agent not to print credentials. | Heimdall enforces this rule at the network boundary, not in a prompt. |
| `CODEX_SANDBOX_MODE` is one global setting. | Each agent has its own policy file, under `policy/<agentId>.json`. |
| One shared bearer token serves every user. | A permit is a scoped grant. It is time-bound and revocable. |
| The event parser discards command and file-change data. | The broker reads the same event stream and records every event. |
| `/codex-home` is mounted read-write and shared by every agent. | `/codex-home` is mounted read-only. This closes a cross-agent tampering path. |
| A failed run produces one error string. | A failed run produces a full record: manifest, permit, denials, divergences, and timings. |

---

## Enforcement points

| # | Boundary | Control | Effect |
|---:|---|---|---|
| 01 | API | Ownership check | A non-owner receives `404`, not `403`. This hides whether the resource exists. |
| 02 | Identity | Agent principal and revocation | Each agent has its own identity. Heimdall can rotate or revoke it independently. |
| 03 | Policy | Tier scoring | A fixed six-axis policy sets the tier, from `T0` to `T4`. Hard rules cannot be discounted. |
| 04 | Approval | `T3` human gate | Heimdall starts no container before a human decides. Approval resets the permit window. |
| 05 | Runtime | Capability derivation | The container runs non-root, with dropped capabilities and workspace limits. |
| 06 | Execution | Action broker | The broker denies by default. It re-checks compound commands and redirects. |
| 07 | Egress | Sidecar proxy | The proxy enforces a host allowlist and inspects payloads. The real credential stays outside the runtime. |
| 08 | Audit | Hash-chained ledger | The ledger is redacted, attributable, and verifiable. |
| 09 | Recovery | Fail-closed defaults | Invalid recon, zero capability, a stale image, or an orphaned container cannot grant authority. |

---

## Egress control

The agent container cannot reach the model provider directly. Its only route is the **egress sidecar**. The sidecar runs as its own container, separate from the platform's server process.

The sidecar attaches to two networks:
- `HEIMDALL_NETWORK`, so the agent container can reach it by name.
- `HEIMDALL_EGRESS_NETWORK`, its only route to the internet.

The sidecar checks the permit's host allowlist. It inspects the payload. It terminates the model channel and attaches the real credential upstream. The agent container's own network membership does not change: it stays on `HEIMDALL_NETWORK` only, with no other route out.

---

## Capability tokens

The agent container presents a 64-character token in the `x-heimdall-capability` header. The proxy uses this token to look up the permit. The lookup uses a constant-time comparison.

A run ID is an identifier. It is not a credential. Run IDs appear in container names and labels, so an operator can find a run with `docker ps`. A container that guesses another run's ID gains nothing.

---

## Permit integrity

Every permit carries a `requestHash`. This hash covers the granted writes, reads, hosts, and commands. When a human approves a permit, Heimdall stores the hash as `approvedHash`.

Heimdall recomputes the hash immediately before it builds the container. If the granted set has changed since the decision, the run fails closed. An approval for "write `src/app.ts`" cannot silently become an approval for something else.

---

## Recovery and failure handling

Heimdall treats a failure as a security decision, not only as an operational error.

- Heimdall cannot read the recon output: the run fails closed.
- The agent declares no capability: Heimdall assigns tier `T0` and grants nothing.
- A capability fails validation: Heimdall drops it and logs it.
- A `T3` decision is pending: Heimdall starts no container.
- The runtime budget is the smaller of the run's timeout and the permit's window.
- An orphaned container is reaped at boot.
- A stale runtime image is caught at boot.
- A cancelled run is not the same as a contained attack. Heimdall records it as `cancelled`.

---

## Measured results

These figures come from the architecture source and from `npm run report`.

| Measure | Baseline (`HEIMDALL=off`) | Heimdall |
|---|---:|---:|
| Attack scenarios contained | 0 of 8 | 8 of 8 |
| Benign tasks that complete | — | 4 of 4 |
| Adversarial probes passed | — | 37 of 37 |
| Tokens per recon attempt | 7,632 | 469 (a 94% drop) |
| Tests passing | — | 228 (208 server, 20 web) |

The benign-task result matters. Heimdall does not contain attacks by refusing every task.

---

## Requirements

- Node.js, version 22 or later.
- npm, version 10 or later.
- One container engine: Docker, Colima, or Podman.
- An API key for a supported model provider: Volcengine Ark or OpenRouter.

Codex CLI is already inside the Runtime image. You do not need to install it on your host.

---

## Quick start

Follow these steps to run Heimdall on your local machine.

1. Install Node.js 22 or later and one container engine. Check each tool:

   ```bash
   node --version
   npm --version
   docker --version        # Docker Desktop, Docker Engine, or Colima
   podman --version        # use this command instead for Podman
   ```

2. Clone the repository:

   ```bash
   git clone https://github.com/rianmathewgeorge/Heimdall1 heimdall
   cd heimdall
   ```

3. Start the proof of concept. Supply your provider key and model:

   ```bash
   ARK_API_KEY=your-ark-api-key \
   ARK_MODEL=ep-your-endpoint-id \
   npm run poc
   ```

   The first run installs the Node.js dependencies. The first run also builds the Runtime image. The script selects Docker, Colima, or Podman for you.

4. Open the Web UI at <http://localhost:3000>.

5. In the Web UI, select **Create Agent**. Enter a name, a description, and workspace instructions. Select **Create Agent** again.

6. Enter a task in the Playground, for example:

   ```text
   Create a TypeScript hello-world CLI, add a test, and run it.
   ```

7. To stop the run, press `Ctrl+C` in the startup terminal. This step removes the temporary Runtime containers. This step keeps your agent workspaces and conversations.

Heimdall stores local state at one of these locations:

- macOS: `~/.volc-agent-launchpad/`
- Linux: `.local/`
- A custom path: set `LOCAL_POC_DATA_ROOT`.

Run `npm run poc` again to continue a stopped session.

### Select a specific container engine

Use this command to force Podman when your host has more than one engine installed:

```bash
CONTAINER_ENGINE=podman \
ARK_API_KEY=your-ark-api-key \
ARK_MODEL=ep-your-endpoint-id \
npm run poc
```

Colima uses `CONTAINER_ENGINE=docker`, because Colima exposes the Docker CLI. For a clean Linux host, follow the [rootless Podman setup](./docs/LOCAL_POC.md#rootless-podman-on-linux).

---

## Docker Compose

1. Create the configuration file:

   ```bash
   ./scripts/bootstrap-local.sh
   ```

2. Set these required values in `.env`:

   ```bash
   ARK_API_KEY=your-ark-api-key
   ARK_MODEL=ep-your-endpoint-id
   APP_AUTH_TOKEN=replace-with-at-least-24-random-characters
   ```

3. Start the application:

   ```bash
   docker compose up --build
   ```

4. Open <http://localhost:3000>.

5. To stop the application without deleting agent data, run:

   ```bash
   docker compose down
   ```

---

## Development

1. Install the dependencies and copy the environment file:

   ```bash
   npm install
   cp .env.example .env
   npm install --global @openai/codex@0.111.0
   ```

2. Start the development servers:

   ```bash
   npm run dev
   ```

3. Open the Web UI at <http://localhost:5173>. The API runs at <http://localhost:3000>.

When you run the platform outside Docker, set local paths in `.env`:

```bash
APP_DATA_DIR=.data
AGENT_WORKSPACE_ROOT=workspaces
CODEX_HOME=codex-home
```

---

## Configuration

### Platform variables

| Variable | Default | Purpose |
|---|---|---|
| `ARK_API_KEY` | required | The Ark model API key. |
| `ARK_MODEL` | required | The Responses-capable endpoint or model ID. |
| `ARK_BASE_URL` | Beijing v3 endpoint | The Ark OpenAI-compatible API URL. |
| `APP_AUTH_TOKEN` | empty on loopback | The shared demo token. Use 24 or more random characters for a remote deployment. |
| `RUNTIME_PROVIDER` | `local-process` | Set to `container` to use disposable local Runtime containers. |
| `CODEX_SANDBOX_MODE` | `workspace-write` | The Codex inner sandbox mode. |
| `CODEX_TIMEOUT_MS` | `600000` | The maximum duration of one turn, in milliseconds. |
| `LOCAL_POC_DATA_ROOT` | platform-specific | The directory for local metadata, workspaces, and sessions. |

### Heimdall variables

| Variable | Default | Purpose |
|---|---|---|
| `HEIMDALL` | `on` | Set to `off` to restore the unmodified baseline runner. |
| `HEIMDALL_NETWORK` | `heimdall-internal` | The isolated Docker network for the agent container. It has no route out except through the sidecar. |
| `HEIMDALL_EGRESS_NETWORK` | `heimdall-egress` | The Docker network that is the sidecar's only route to the internet. |
| `HEIMDALL_APPROVAL_TIMEOUT_MS` | `300000` | An unanswered `T3` approval fails closed after this time. |
| `HEIMDALL_DEGRADED` | `off` | Set to `on` to fall back to standing policy when recon fails. |
| `HEIMDALL_POLICY_DIR` | `./policy` | The directory for per-agent standing policy files. |

`npm run poc` creates the `heimdall-internal` and `heimdall-egress` networks on the first run. To create them by hand, run:

```bash
docker network create --internal heimdall-internal
docker network create heimdall-egress
```

### Model provider

Either provider works. Heimdall injects whichever key is active. The agent container sees only a placeholder value.

```bash
# Volcengine Ark (default)
ARK_API_KEY=... ARK_MODEL=ep-... npm run poc

# OpenRouter
MODEL_PROVIDER=openrouter OPENROUTER_API_KEY=sk-or-... \
  OPENROUTER_MODEL=deepseek/deepseek-chat-v3-0324:free npm run poc
```

See [.env.example](./.env.example) for the full list of Runtime and resource-limit options.

---

## Deployment

- [Existing Linux ECS host with Docker](./docs/DEPLOYMENT.md#existing-linux-ecs)
- [Full Volcengine environment with Terraform](./docs/DEPLOYMENT.md#terraform-deployment)
- [Local Docker, Colima, and Podman detail](./docs/LOCAL_POC.md)

To deploy from the current source tree to an existing ECS host, run:

```bash
cp .env.example .env.production
./scripts/deploy-existing-ecs.sh .env.production
```

To provision a VPC, subnet, security group, ECS instance, and EIP with Terraform, run:

```bash
cp deploy/volcengine/terraform.tfvars.example \
  deploy/volcengine/terraform.tfvars
./scripts/deploy-volcengine.sh
```

---

## Validation

Run these commands to check the build:

```bash
npm run check        # type check, 228 tests, the scenario corpus, 37 probes, a self-audit, and the build
npm run scenarios     # the 12-scenario corpus, with metrics generated from the real engine
npm run probe          # 37 adversarial probes against the enforcement surfaces
npm run audit          # a scan of the repository for leaked secrets
terraform fmt -check -recursive deploy/volcengine
docker compose config
```

`HEIMDALL=off npm run poc` restores the unmodified baseline runner. `HEIMDALL=on`, the default, engages every control. This on/off switch is the proof that Heimdall enters through one seam: the three-method `AgentRunner` interface, wired in `runner-factory`. Heimdall does not edit `app.ts` or `agent-service.ts`.

---

## API reference

All Heimdall routes sit under `/api/heimdall/`.

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/status` | The current Heimdall on/off state. |
| `GET` | `/termsheet` | The static six-axis policy. |
| `GET` | `/metrics` | Live containment and completion metrics. |
| `GET` | `/pending` | Runs that are waiting for a `T3` approval. |
| `GET` | `/runs` | The list of runs. |
| `GET` | `/runs/:id` | One run's full record. |
| `GET` | `/ledger` | The hash-chained ledger. |
| `GET` | `/ledger/verify` | A check that names the first broken link, if one exists. |
| `GET` | `/precedents/:id` | The precedent record for an agent. |
| `GET` | `/policy/:id` | An agent's standing policy. |
| `POST` | `/runs/:id/decide` | Approve or deny a `T3` run. |
| `PUT` | `/policy/:id` | Update an agent's standing policy. |

Identity routes sit under `/api/identity/`: `GET /me`, `GET /agents/:id`, `POST /agents/:id/revoke`, `POST /agents/:id/rotate`.

Trace routes sit under `/api/traces/`: `GET /`, `GET /:id`, `GET /:id/export`.

---

## Known limitations

Heimdall states these limits so a reviewer does not need to find them.

1. **Codex sessions do not carry over between runs.** `CODEX_HOME` is a fresh, writable, per-container directory. This closes a cross-agent read path, but it also means `codex resume <threadId>` has no prior state between runs.
2. **The proxy cannot inspect TLS payloads.** For `CONNECT` tunnels, the proxy enforces the host but not the payload. Payload inspection covers plain HTTP and the terminated Ark path only.
3. **Codex event names change between versions.** `observeEvent` matches known shapes only. Heimdall logs an unknown shape as `unmapped-events` and denies the action rather than guessing.
4. **A bare, all-lowercase secret with no `KEY=` prefix can pass the entropy check.** The prefix list and the assignment check still catch it.
5. **Recon costs one extra model call for each new capability set.** A repeated capability set uses the precedent store instead.
6. **Heimdall runs as a single process.** State storage follows the starter kit's own JSON model.
7. **Heimdall does not provide hardened multi-tenant isolation.** The boundary is the container plus the broker, not a microVM.

---

## Planned work

- A break-glass override with automatic expiry.
- A blast-radius preview on the approval card.
- An advisory note from a language model beside the fixed tier. This note would explain risk. It would never decide risk.
- Path resolution through `fs.realpathSync`.
- Export of the ledger through OpenTelemetry.

---

## Renamed from Warrant

Heimdall was renamed from an earlier project called Warrant. Every reference moved together. There is no compatibility layer, so update any link or script that names the old project.

| Old name | New name |
|---|---|
| `WARRANT=off`, `WARRANT_NETWORK`, `WARRANT_*` | `HEIMDALL=off`, `HEIMDALL_NETWORK`, `HEIMDALL_*` |
| `/api/warrant/*` | `/api/heimdall/*` |
| `warrant-proxy:local` | `heimdall-proxy:local` |
| networks `warrant-internal` / `warrant-egress` | `heimdall-internal` / `heimdall-egress` |
| labels `io.warrant.*` | `io.heimdall.*` |
| header `x-warrant-capability` | `x-heimdall-capability` |
| `apps/server/src/warrant/` | `apps/server/src/heimdall/` |

Two exceptions were kept on purpose. The `LICENSE` file was not changed, because it uses the English words "WARRANTY" and "WARRANTIES" in the MIT text. Orphan cleanup still looks for the old `io.warrant.*` label too, so a container from a pre-rename build is still reaped.

If you pull this change, rebuild the proxy image. The image name changed, and the sidecar's entry point moved to `dist/heimdall/proxy-standalone.js`. `npm run poc` rebuilds it for you.

---

## Documentation

| Document | Content |
|---|---|
| [HEIMDALL.md](./HEIMDALL.md) | The full technical account of Heimdall, with verified runtime findings. |
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | Component and extension boundaries. |
| [docs/ARCHITECTURE-LAYERS.md](./docs/ARCHITECTURE-LAYERS.md) | The layers, the contracts between them, and how to swap each one. |
| [docs/THREAT-MODEL.md](./docs/THREAT-MODEL.md) | Threats, controls, and stated residual risk. |
| [docs/LOCAL_POC.md](./docs/LOCAL_POC.md) | Local Docker, Colima, and Podman detail. |
| [docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md) | ECS and Terraform deployment steps. |
| [docs/HACKATHON_EXTENSION_GUIDE.md](./docs/HACKATHON_EXTENSION_GUIDE.md) | How to extend the platform. |
| [docs/RESULTS.md](./docs/RESULTS.md) | Generated results, regenerated by `npm run report`. |
| [SECURITY.md](./SECURITY.md) | The security policy for this proof of concept. |
| [CONTRIBUTING.md](./CONTRIBUTING.md) | How to contribute to this repository. |

---

## Terms used in this document

- **Agent.** The AI process that reads a task and calls tools to complete it.
- **Broker.** The trusted-side service that checks each action the agent reports, against the permit.
- **Ledger.** The append-only, hash-chained record of decisions and events.
- **Manifest.** The list of capabilities the agent declares it needs, before it runs.
- **Permit.** The single, scoped, time-bound, revocable object that grants authority to a run.
- **Precedent.** A stored record of a past denial, used to speed up a repeated decision.
- **Recon.** The read-only stage in which the agent scans the workspace before Heimdall grants any capability.
- **Run.** One execution of an agent task, from prompt to reconciliation.
- **Sidecar.** The separate proxy container that holds the real provider credential and enforces the egress allowlist.
- **Term sheet.** The static, platform-owned policy file that sets the six scoring axes.
- **Tier.** The risk level Heimdall assigns to a manifest, from `T0` (lowest) to `T4` (denied).

---

## License

Heimdall is available under the [MIT License](./LICENSE).
