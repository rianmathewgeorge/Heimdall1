/**
 * The live progress signal for a run. Replaces blind status polling as the
 * primary source of truth: every stage transition, recon attempt, permit
 * decision, container lifecycle point and reconciliation result is a
 * structured RunEvent here, correlated by appRunId. The HTTP status-poll
 * endpoints remain — they read the same underlying AgentRun record — but the
 * UI's live view should prefer this stream.
 *
 * Single-process, in-memory by design (matches the rest of this kit's JSON
 * persistence model — see HEIMDALL.md "KNOWN LIMITATIONS"). Event history does
 * not survive a server restart; the AgentRun's persisted `timeline` and
 * terminal fields do, and are what a reconnecting client falls back to.
 */
import type { EventSeverity, RunEvent, RunStage } from "./types.js";

export interface EmitInput {
  appRunId: string;
  agentId: string;
  heimdallRunId?: string | null;
  stage: RunStage;
  severity?: EventSeverity;
  message: string;
  data?: Record<string, unknown>;
}

type Listener = (event: RunEvent) => void;

const MAX_EVENTS_PER_RUN = 2000;
const MAX_TRACKED_RUNS = 50;

export class RunEventBus {
  private seq = 0;
  private readonly buffers = new Map<string, RunEvent[]>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly heimdallRunIds = new Map<string, string>();

  emit(input: EmitInput): RunEvent {
    if (!this.buffers.has(input.appRunId)) {
      this.evictIfNeeded();
      this.buffers.set(input.appRunId, []);
    }
    if (input.heimdallRunId) {
      this.heimdallRunIds.set(input.appRunId, input.heimdallRunId);
    }
    const event: RunEvent = {
      seq: this.seq++,
      ts: new Date().toISOString(),
      appRunId: input.appRunId,
      heimdallRunId: input.heimdallRunId ?? this.heimdallRunIds.get(input.appRunId) ?? null,
      agentId: input.agentId,
      stage: input.stage,
      severity: input.severity ?? "info",
      message: input.message,
      ...(input.data ? { data: input.data } : {}),
    };
    const buffer = this.buffers.get(input.appRunId);
    if (buffer) {
      buffer.push(event);
      if (buffer.length > MAX_EVENTS_PER_RUN) buffer.splice(0, buffer.length - MAX_EVENTS_PER_RUN);
    }
    for (const listener of this.listeners.get(input.appRunId) ?? []) listener(event);
    return event;
  }

  /** Buffered events for a run, in order. Pass the last seen `seq` to resume a stream. */
  events(appRunId: string, afterSeq = -1): RunEvent[] {
    return (this.buffers.get(appRunId) ?? []).filter((event) => event.seq > afterSeq);
  }

  subscribe(appRunId: string, listener: Listener): () => void {
    const set = this.listeners.get(appRunId) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(appRunId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(appRunId);
    };
  }

  heimdallRunIdFor(appRunId: string): string | null {
    return this.heimdallRunIds.get(appRunId) ?? null;
  }

  /** Evict the oldest un-listened-to run's buffer once the tracked-run cap is hit. */
  private evictIfNeeded(): void {
    if (this.buffers.size < MAX_TRACKED_RUNS) return;
    for (const key of this.buffers.keys()) {
      if (!this.listeners.has(key)) {
        this.buffers.delete(key);
        this.heimdallRunIds.delete(key);
        return;
      }
    }
  }
}
