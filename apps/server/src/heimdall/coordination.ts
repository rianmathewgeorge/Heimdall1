/**
 * HEIMDALL — multi-Agent coordination.
 *
 * A shared topic that several Agents take turns writing to. The brief's demo is
 * a countdown from 10 to 1 across multiple Agents, with "no duplicate or missing
 * number" as the acceptance bar — so the interesting part is not the messaging,
 * it is the INVARIANT. Two Agents must never claim the same number, and none may
 * be skipped, even though each turn is a separate Runtime doing real work.
 *
 * How that is guaranteed:
 *   - the next value is derived from committed state, never from what an Agent
 *     says. An Agent that replies "7" when the sequence is at 4 does not move
 *     the sequence to 7; its turn is rejected and re-offered.
 *   - exactly one turn is in flight at a time (`claim` is a compare-and-set on
 *     the session), so two Agents cannot both be "next".
 *   - a turn that neither commits nor fails within its deadline is reclaimed,
 *     so one unresponsive Agent cannot wedge the session forever.
 *
 * Single-process and in-memory, matching the rest of this kit's persistence
 * model. The invariant is enforced here, not in the participating Agents —
 * which is the point: coordination is a platform capability, not an instruction
 * you hope the model follows.
 */
import { randomUUID } from "node:crypto";

export type SessionStatus = "running" | "completed" | "failed" | "stopped";

export interface TopicMessage {
  seq: number;
  at: string;
  agentId: string;
  agentName: string;
  /** the value this turn contributed, once validated */
  value: number;
  /** what the Agent actually said, kept for the audit even when it was wrong */
  raw: string;
}

export interface RejectedTurn {
  at: string;
  agentId: string;
  reason: string;
  raw: string;
}

export interface CoordinationSession {
  id: string;
  topic: string;
  ownerId: string;
  participants: Array<{ agentId: string; name: string }>;
  from: number;
  to: number;
  /** the next value the sequence expects. Derived state — never Agent-supplied. */
  next: number;
  status: SessionStatus;
  messages: TopicMessage[];
  rejected: RejectedTurn[];
  /** the turn currently in flight, if any */
  inFlight: { agentId: string; expected: number; deadline: number } | null;
  createdAt: string;
  completedAt: string | null;
  error: string | null;
}

export interface ClaimedTurn {
  sessionId: string;
  agentId: string;
  agentName: string;
  expected: number;
  /** what to ask the Agent this turn */
  prompt: string;
}

const DEFAULT_TURN_TIMEOUT_MS = 120_000;

/** Pull the first integer out of whatever the Agent replied. */
export function parseTurnValue(raw: string): number | null {
  const match = /-?\d+/.exec(raw.replace(/[,_]/g, ""));
  if (match === null) return null;
  const value = Number(match[0]);
  return Number.isSafeInteger(value) ? value : null;
}

export class Coordinator {
  private readonly sessions = new Map<string, CoordinationSession>();

  constructor(private readonly turnTimeoutMs: number = DEFAULT_TURN_TIMEOUT_MS) {}

  create(input: {
    topic: string; ownerId: string;
    participants: Array<{ agentId: string; name: string }>;
    from?: number; to?: number;
  }): CoordinationSession {
    if (input.participants.length === 0) throw new Error("a session needs at least one participant");
    const from = input.from ?? 10;
    const to = input.to ?? 1;
    if (from < to) throw new Error("countdown must start at or above its target");
    const session: CoordinationSession = {
      id: "cs_" + randomUUID().replace(/-/g, "").slice(0, 12),
      topic: input.topic,
      ownerId: input.ownerId,
      participants: input.participants,
      from, to, next: from,
      status: "running",
      messages: [], rejected: [],
      inFlight: null,
      createdAt: new Date().toISOString(),
      completedAt: null,
      error: null,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  get(id: string): CoordinationSession | undefined { return this.sessions.get(id); }
  all(): CoordinationSession[] { return [...this.sessions.values()]; }
  forOwner(ownerId: string): CoordinationSession[] {
    return this.all().filter((s) => s.ownerId === ownerId);
  }

  /**
   * Whose turn it is. Round-robin over participants by how many turns have been
   * committed, so ordering is visible and reproducible rather than incidental.
   */
  private nextParticipant(session: CoordinationSession): { agentId: string; name: string } {
    const index = session.messages.length % session.participants.length;
    // participants is non-empty (enforced in create), so this is always defined
    return session.participants[index] as { agentId: string; name: string };
  }

  /**
   * Claim the next turn. Returns null when the session is finished or a turn is
   * already in flight — this compare-and-set is what stops two Agents both
   * believing they are next.
   */
  claim(sessionId: string, now = Date.now()): ClaimedTurn | null {
    const session = this.sessions.get(sessionId);
    if (session === undefined || session.status !== "running") return null;

    if (session.inFlight !== null) {
      if (now < session.inFlight.deadline) return null;      // still someone else's turn
      // the holder never answered: reclaim rather than wedge the session
      session.rejected.push({
        at: new Date().toISOString(), agentId: session.inFlight.agentId,
        reason: "turn timed out and was reclaimed", raw: "",
      });
      session.inFlight = null;
    }

    const who = this.nextParticipant(session);
    session.inFlight = { agentId: who.agentId, expected: session.next, deadline: now + this.turnTimeoutMs };
    return {
      sessionId, agentId: who.agentId, agentName: who.name, expected: session.next,
      prompt:
        `You are participating in a shared countdown with other agents on topic "${session.topic}".\n` +
        `The countdown so far: ${session.messages.map((m) => m.value).join(", ") || "(nothing yet)"}.\n` +
        `Reply with ONLY the next number in the countdown, which is ${session.next}. No words, no punctuation.`,
    };
  }

  /**
   * Commit a turn. The Agent's reply is VALIDATED against the expected value —
   * the sequence advances from committed state, so a wrong answer cannot skip,
   * repeat or reorder it.
   */
  commit(sessionId: string, agentId: string, raw: string): { accepted: boolean; reason?: string } {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return { accepted: false, reason: "unknown session" };
    if (session.status !== "running") return { accepted: false, reason: "session is not running" };
    if (session.inFlight === null || session.inFlight.agentId !== agentId) {
      return { accepted: false, reason: "not this agent's turn" };
    }

    const expected = session.inFlight.expected;
    const value = parseTurnValue(raw);
    const name = session.participants.find((p) => p.agentId === agentId)?.name ?? agentId;

    if (value !== expected) {
      session.rejected.push({
        at: new Date().toISOString(), agentId,
        reason: value === null ? "no number in reply" : `said ${value}, expected ${expected}`,
        raw: raw.slice(0, 200),
      });
      session.inFlight = null;                 // re-offer the same number
      return { accepted: false, reason: `expected ${expected}` };
    }

    session.messages.push({
      seq: session.messages.length + 1,
      at: new Date().toISOString(),
      agentId, agentName: name, value, raw: raw.slice(0, 200),
    });
    session.inFlight = null;
    session.next = expected - 1;
    if (session.next < session.to) {
      session.status = "completed";
      session.completedAt = new Date().toISOString();
    }
    return { accepted: true };
  }

  /** A turn that errored. The number is re-offered to the next participant. */
  fail(sessionId: string, agentId: string, reason: string): void {
    const session = this.sessions.get(sessionId);
    if (session === undefined || session.inFlight?.agentId !== agentId) return;
    session.rejected.push({
      at: new Date().toISOString(), agentId, reason: reason.slice(0, 200), raw: "",
    });
    session.inFlight = null;
  }

  stop(sessionId: string, reason = "stopped by operator"): CoordinationSession | null {
    const session = this.sessions.get(sessionId);
    if (session === undefined || session.status !== "running") return null;
    session.status = "stopped";
    session.error = reason;
    session.completedAt = new Date().toISOString();
    session.inFlight = null;
    return session;
  }

  /** The invariant, checkable at any moment — this is what the demo has to show. */
  verify(session: CoordinationSession): { complete: boolean; duplicates: number[]; missing: number[] } {
    const values = session.messages.map((m) => m.value);
    const seen = new Set<number>();
    const duplicates: number[] = [];
    for (const v of values) {
      if (seen.has(v)) duplicates.push(v);
      seen.add(v);
    }
    const missing: number[] = [];
    for (let v = session.from; v >= session.to; v--) if (!seen.has(v)) missing.push(v);
    return { complete: missing.length === 0 && duplicates.length === 0, duplicates, missing };
  }
}
