/**
 * HEIMDALL — the identity plane.
 *
 * Two kinds of principal, deliberately separate:
 *
 *   HUMAN  — owns agents, approves permits, revokes. Authenticates with a token.
 *   AGENT  — the thing that actually executes. It has its OWN principal, minted
 *            per agent, rotatable and revocable WITHOUT touching the human's
 *            credential, and it never reuses the human's session.
 *
 * That separation is the point. The baseline kit had one shared platform token:
 * every agent ran as "whoever holds the token", so nothing could be attributed
 * to a person, scoped to an owner, or revoked short of rotating the one secret
 * everybody uses.
 *
 * A run's authority is a DELEGATION from the human to the agent principal:
 * scoped (the permit's granted set), time-bound (the permit's expiry) and
 * revocable (revoke the agent principal and the next run refuses to start).
 * The mock user directory is deliberately small — the middleware being
 * demonstrated is the authorization boundary, not the login screen.
 */
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

/** The operator a legacy shared-token (or no-auth) request maps to. */
export const DEFAULT_PRINCIPAL_ID = "user-operator";

export interface HumanPrincipal {
  kind: "human";
  id: string;
  displayName: string;
  /** sha256 of the bearer token. The token itself is never stored. */
  tokenHash: string;
}

export interface AgentPrincipal {
  kind: "agent";
  id: string;
  agentId: string;
  /** the human this agent acts on behalf of — attribution always resolves to a person */
  ownerId: string;
  createdAt: string;
  revokedAt: string | null;
  /** bumped on rotation, so an old delegation is distinguishable from a new one */
  version: number;
}

export type Principal = HumanPrincipal | AgentPrincipal;

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Constant-time compare of two hex digests. */
function digestMatches(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

/**
 * A mock user directory. Real deployments would swap this for an IdP; the
 * boundary the rest of the system depends on is `resolveHuman`, not the store.
 */
export class IdentityDirectory {
  private readonly humans = new Map<string, HumanPrincipal>();
  private readonly agents = new Map<string, AgentPrincipal>();

  /** Registers a human. Returns the principal; the caller keeps the token. */
  addHuman(id: string, displayName: string, token: string): HumanPrincipal {
    const principal: HumanPrincipal = { kind: "human", id, displayName, tokenHash: hashToken(token) };
    this.humans.set(id, principal);
    return principal;
  }

  /** Resolve a bearer token to a human. Constant-time, and never leaks which user matched. */
  resolveHuman(token: string): HumanPrincipal | null {
    if (token === "") return null;
    const presented = hashToken(token);
    for (const human of this.humans.values()) {
      if (digestMatches(presented, human.tokenHash)) return human;
    }
    return null;
  }

  human(id: string): HumanPrincipal | undefined { return this.humans.get(id); }
  humans_(): HumanPrincipal[] { return [...this.humans.values()]; }

  /** Mint a fresh principal for an agent, owned by a human. */
  mintAgentPrincipal(agentId: string, ownerId: string): AgentPrincipal {
    const principal: AgentPrincipal = {
      kind: "agent",
      id: "ap_" + randomUUID().replace(/-/g, "").slice(0, 16),
      agentId, ownerId,
      createdAt: new Date().toISOString(),
      revokedAt: null,
      version: 1,
    };
    this.agents.set(principal.id, principal);
    return principal;
  }

  agentPrincipal(id: string): AgentPrincipal | undefined { return this.agents.get(id); }

  /** The agent's current, non-revoked principal, if it has one. */
  activeFor(agentId: string): AgentPrincipal | null {
    for (const p of this.agents.values()) {
      if (p.agentId === agentId && p.revokedAt === null) return p;
    }
    return null;
  }

  /**
   * Revoke. Execution authority ends immediately: the next run refuses to
   * start, and an in-flight run's permit is no longer honoured.
   */
  revoke(principalId: string): AgentPrincipal | null {
    const p = this.agents.get(principalId);
    if (p === undefined || p.revokedAt !== null) return null;
    const revoked: AgentPrincipal = { ...p, revokedAt: new Date().toISOString() };
    this.agents.set(principalId, revoked);
    return revoked;
  }

  /**
   * Rotate: revoke the old principal and mint a new one for the same agent and
   * owner, with the version bumped. The human's own credential is untouched.
   */
  rotate(agentId: string): AgentPrincipal | null {
    const current = this.activeFor(agentId);
    if (current === null) return null;
    this.revoke(current.id);
    const next = this.mintAgentPrincipal(agentId, current.ownerId);
    const bumped: AgentPrincipal = { ...next, version: current.version + 1 };
    this.agents.set(next.id, bumped);
    return bumped;
  }

  forAgent(agentId: string): AgentPrincipal[] {
    return [...this.agents.values()].filter((p) => p.agentId === agentId);
  }

  snapshot(): { humans: HumanPrincipal[]; agents: AgentPrincipal[] } {
    return { humans: this.humans_(), agents: [...this.agents.values()] };
  }

  restore(agents: AgentPrincipal[]): void {
    for (const a of agents) this.agents.set(a.id, a);
  }
}

/**
 * Who did what, resolved to a PERSON. Every consequential decision carries this,
 * so an audit answers "which human is accountable for this action", not merely
 * "which process ran it".
 */
export interface Attribution {
  /** the human who initiated (or owns) the work */
  humanId: string;
  humanName: string;
  /** the agent principal that executed it */
  agentPrincipalId: string | null;
  agentPrincipalVersion: number | null;
  agentId: string;
}

export function attributionFor(
  owner: HumanPrincipal, agentId: string, principal: AgentPrincipal | null,
): Attribution {
  return {
    humanId: owner.id,
    humanName: owner.displayName,
    agentPrincipalId: principal?.id ?? null,
    agentPrincipalVersion: principal?.version ?? null,
    agentId,
  };
}
