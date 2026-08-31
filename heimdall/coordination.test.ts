/**
 * MULTI-AGENT COORDINATION.
 *
 * The brief's bar is "a complete 10-to-1 sequence with no duplicate or missing
 * number", so the tests that matter are the ones where the Agents MISBEHAVE:
 * a real model will happily answer 7 when the sequence is at 4, answer twice,
 * or not answer at all. The invariant has to hold anyway, because it lives in
 * the platform rather than in the prompt.
 */
import { describe, expect, test } from "vitest";
import { Coordinator, parseTurnValue } from "./coordination.js";

const participants = [
  { agentId: "a1", name: "Alpha" },
  { agentId: "a2", name: "Beta" },
  { agentId: "a3", name: "Gamma" },
];

const newSession = (turnTimeoutMs = 120_000) => {
  const c = new Coordinator(turnTimeoutMs);
  const s = c.create({ topic: "countdown", ownerId: "user-a", participants });
  return { c, id: s.id };
};

/** Drive a whole session with a reply function, as the real driver would. */
function drive(c: Coordinator, id: string, reply: (expected: number, agentId: string) => string, maxTurns = 60): void {
  for (let i = 0; i < maxTurns; i++) {
    const turn = c.claim(id);
    if (turn === null) break;
    c.commit(id, turn.agentId, reply(turn.expected, turn.agentId));
  }
}

describe("countdown coordination", () => {
  test("a well-behaved run produces 10..1 exactly once each, across agents", () => {
    const { c, id } = newSession();
    drive(c, id, (expected) => String(expected));

    const session = c.get(id)!;
    expect(session.status).toBe("completed");
    expect(session.messages.map((m) => m.value)).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
    expect(c.verify(session)).toEqual({ complete: true, duplicates: [], missing: [] });
    // and it genuinely involved more than one agent
    expect(new Set(session.messages.map((m) => m.agentId)).size).toBeGreaterThan(1);
  });

  test("the turn order is visible: every message names the agent that produced it", () => {
    const { c, id } = newSession();
    drive(c, id, (expected) => String(expected));
    const session = c.get(id)!;
    expect(session.messages[0]).toMatchObject({ seq: 1, value: 10, agentName: "Alpha" });
    expect(session.messages[1]).toMatchObject({ seq: 2, value: 9, agentName: "Beta" });
    expect(session.messages[2]).toMatchObject({ seq: 3, value: 8, agentName: "Gamma" });
    expect(session.messages[3]).toMatchObject({ seq: 4, value: 7, agentName: "Alpha" });
  });

  /*
   * The sequence advances from COMMITTED state, never from what an agent says.
   * An agent that jumps ahead is rejected and the same number is re-offered.
   */
  test("an agent that skips ahead cannot move the sequence", () => {
    const { c, id } = newSession();
    const first = c.claim(id)!;
    expect(first.expected).toBe(10);
    const bad = c.commit(id, first.agentId, "3");
    expect(bad.accepted).toBe(false);

    const session = c.get(id)!;
    expect(session.messages).toHaveLength(0);
    expect(session.next).toBe(10);                       // unchanged
    expect(session.rejected[0]).toMatchObject({ reason: "said 3, expected 10" });

    // the same number is offered again, and the run still completes cleanly
    drive(c, id, (expected) => String(expected));
    expect(c.verify(c.get(id)!)).toEqual({ complete: true, duplicates: [], missing: [] });
  });

  test("no number is ever duplicated, even when an agent repeats the previous one", () => {
    const { c, id } = newSession();
    let last = 11;
    drive(c, id, (expected) => {
      // every other turn, wrongly repeat the number just used
      const answer = expected % 2 === 0 ? String(last) : String(expected);
      last = expected;
      return answer;
    });
    const session = c.get(id)!;
    const check = c.verify(session);
    expect(check.duplicates).toEqual([]);
    expect(check.missing).toEqual([]);
    expect(session.rejected.length).toBeGreaterThan(0);   // the bad turns were caught
  });

  test("a reply wrapped in prose still yields its number", () => {
    expect(parseTurnValue("7")).toBe(7);
    expect(parseTurnValue("The next number is 7.")).toBe(7);
    expect(parseTurnValue("  7\n")).toBe(7);
    expect(parseTurnValue("seven")).toBeNull();
    expect(parseTurnValue("")).toBeNull();
  });

  test("only one agent holds a turn at a time", () => {
    const { c, id } = newSession();
    const first = c.claim(id);
    const second = c.claim(id);
    expect(first).not.toBeNull();
    expect(second).toBeNull();                            // no second claimant

    // and another agent cannot commit into someone else's turn
    const other = participants.find((p) => p.agentId !== first!.agentId)!;
    expect(c.commit(id, other.agentId, "10")).toMatchObject({ accepted: false, reason: "not this agent's turn" });
    expect(c.get(id)!.messages).toHaveLength(0);
  });

  /** One unresponsive agent must not wedge the session forever. */
  test("a turn that is never answered is reclaimed after its deadline", () => {
    const c = new Coordinator(1_000);
    const id = c.create({ topic: "t", ownerId: "user-a", participants }).id;
    const abandoned = c.claim(id, 0);
    expect(abandoned).not.toBeNull();
    expect(c.claim(id, 500)).toBeNull();                  // still theirs

    const reclaimed = c.claim(id, 2_000);                 // past the deadline
    expect(reclaimed).not.toBeNull();
    expect(reclaimed!.expected).toBe(10);                 // the number was not lost
    expect(c.get(id)!.rejected[0]?.reason).toMatch(/timed out/);
  });

  test("an agent that errors gives the number back rather than consuming it", () => {
    const { c, id } = newSession();
    const turn = c.claim(id)!;
    c.fail(id, turn.agentId, "runtime exited with code 1");
    const session = c.get(id)!;
    expect(session.inFlight).toBeNull();
    expect(session.next).toBe(10);
    drive(c, id, (expected) => String(expected));
    expect(c.verify(c.get(id)!).complete).toBe(true);
  });

  test("a stopped session accepts no further turns", () => {
    const { c, id } = newSession();
    c.claim(id);
    expect(c.stop(id)!.status).toBe("stopped");
    expect(c.claim(id)).toBeNull();
    expect(c.commit(id, "a1", "10")).toMatchObject({ accepted: false });
  });

  test("verify reports exactly what is wrong when a session is incomplete", () => {
    const { c, id } = newSession();
    for (let i = 0; i < 3; i++) {
      const t = c.claim(id)!;
      c.commit(id, t.agentId, String(t.expected));
    }
    expect(c.verify(c.get(id)!)).toMatchObject({ complete: false, duplicates: [], missing: [7, 6, 5, 4, 3, 2, 1] });
  });

  test("sessions are scoped to their owner", () => {
    const c = new Coordinator();
    c.create({ topic: "a", ownerId: "user-a", participants });
    c.create({ topic: "b", ownerId: "user-b", participants });
    expect(c.forOwner("user-a")).toHaveLength(1);
    expect(c.forOwner("user-a")[0]?.topic).toBe("a");
  });
});
