import { describe, expect, it } from "vitest";
import { RunEventBus } from "./events.js";

describe("RunEventBus", () => {
  it("assigns increasing sequence numbers and replays events after a given seq", () => {
    const bus = new RunEventBus();
    bus.emit({ appRunId: "run-1", agentId: "agent-1", stage: "queued", message: "queued" });
    bus.emit({ appRunId: "run-1", agentId: "agent-1", stage: "recon", message: "recon starting" });
    bus.emit({ appRunId: "run-1", agentId: "agent-1", stage: "manifest", message: "manifest parsed" });

    const all = bus.events("run-1");
    expect(all.map((e) => e.stage)).toEqual(["queued", "recon", "manifest"]);
    expect(all.map((e) => e.seq)).toEqual([0, 1, 2]);

    const resumed = bus.events("run-1", all[0]!.seq);
    expect(resumed.map((e) => e.stage)).toEqual(["recon", "manifest"]);
  });

  it("keeps separate event streams per run", () => {
    const bus = new RunEventBus();
    bus.emit({ appRunId: "run-1", agentId: "agent-1", stage: "queued", message: "a" });
    bus.emit({ appRunId: "run-2", agentId: "agent-2", stage: "queued", message: "b" });
    expect(bus.events("run-1")).toHaveLength(1);
    expect(bus.events("run-2")).toHaveLength(1);
    expect(bus.events("run-3")).toHaveLength(0);
  });

  it("notifies live subscribers and stops after unsubscribe", () => {
    const bus = new RunEventBus();
    const seen: string[] = [];
    const unsubscribe = bus.subscribe("run-1", (event) => seen.push(event.message));
    bus.emit({ appRunId: "run-1", agentId: "agent-1", stage: "recon", message: "first" });
    unsubscribe();
    bus.emit({ appRunId: "run-1", agentId: "agent-1", stage: "recon", message: "second" });
    expect(seen).toEqual(["first"]);
  });

  it("remembers the heimdall run id once tagged, and applies it to later events", () => {
    const bus = new RunEventBus();
    bus.emit({ appRunId: "run-1", agentId: "agent-1", stage: "queued", message: "queued" });
    bus.emit({ appRunId: "run-1", agentId: "agent-1", stage: "recon", message: "recon", heimdallRunId: "wr-123" });
    bus.emit({ appRunId: "run-1", agentId: "agent-1", stage: "manifest", message: "manifest" });

    const events = bus.events("run-1");
    expect(events[0]?.heimdallRunId).toBeNull();
    expect(events[1]?.heimdallRunId).toBe("wr-123");
    expect(events[2]?.heimdallRunId).toBe("wr-123");
    expect(bus.heimdallRunIdFor("run-1")).toBe("wr-123");
  });

  it("defaults unset severity to info and preserves structured data", () => {
    const bus = new RunEventBus();
    const event = bus.emit({
      appRunId: "run-1", agentId: "agent-1", stage: "container",
      message: "spawned", data: { containerName: "heimdall-abc" },
    });
    expect(event.severity).toBe("info");
    expect(event.data).toEqual({ containerName: "heimdall-abc" });
  });
});
