import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { reduceTimeline } from "../lib/timeline";
import { streamRunEvents } from "../lib/runEventStream";
import type { AgentRun, RunEvent } from "../types";

export type ConnectionMode = "connecting" | "live" | "polling" | "closed";

export interface RunEventsState {
  run: AgentRun | null;
  events: RunEvent[];
  connection: ConnectionMode;
}

const POLL_INTERVAL_MS = 2500;
const isTerminalStatus = (status: AgentRun["status"]): boolean =>
  status === "completed" || status === "failed" || status === "cancelled";

/**
 * Live progress for one run: SSE stream is the primary source (replayed from
 * the start, then live), REST polling of /api/runs/:id is only the fallback
 * used when the stream itself fails to connect or drops mid-run.
 */
export function useRunEvents(runId: string | null): RunEventsState {
  const [state, setState] = useState<RunEventsState>({ run: null, events: [], connection: "connecting" });

  useEffect(() => {
    if (!runId) {
      setState({ run: null, events: [], connection: "closed" });
      return;
    }
    let cancelled = false;
    let pollTimer: number | null = null;
    const controller = new AbortController();
    setState({ run: null, events: [], connection: "connecting" });

    const stopPolling = () => {
      if (pollTimer !== null) window.clearInterval(pollTimer);
      pollTimer = null;
    };

    const startPolling = () => {
      if (cancelled || pollTimer !== null) return;
      setState((current) => ({ ...current, connection: "polling" }));
      const tick = async () => {
        try {
          const { run } = await api.run(runId);
          if (cancelled) return;
          setState((current) => ({ ...current, run }));
          if (isTerminalStatus(run.status)) stopPolling();
        } catch {
          // transient — keep the last good state and retry on the next tick
        }
      };
      pollTimer = window.setInterval(() => void tick(), POLL_INTERVAL_MS);
      void tick();
    };

    (async () => {
      try {
        const { run: baseline } = await api.run(runId);
        if (cancelled) return;
        setState({ run: baseline, events: [], connection: "connecting" });
      } catch {
        // the initial fetch failing is not fatal — the stream replay may still work
      }

      try {
        await streamRunEvents(runId, {
          onEvent: (event) => {
            if (cancelled) return;
            setState((current) => {
              const events = [...current.events, event];
              const run = current.run
                ? {
                    ...current.run,
                    lastEventAt: event.ts,
                    heimdallRunId: event.heimdallRunId ?? current.run.heimdallRunId,
                    containerName:
                      typeof event.data?.["containerName"] === "string"
                        ? (event.data["containerName"] as string)
                        : current.run.containerName,
                    exitCode:
                      typeof event.data?.["exitCode"] === "number"
                        ? (event.data["exitCode"] as number)
                        : current.run.exitCode,
                    stage: event.stage,
                    timeline: reduceTimeline(current.run.timeline, event),
                  }
                : current.run;
              return { run, events, connection: "live" };
            });
          },
        }, controller.signal);
        // The stream closed normally (server ends it once the run is terminal).
        // Fetch once more for fields the event stream itself does not carry —
        // output, usage, logs, fileChanges, errorDetail.
        if (!cancelled) {
          const { run } = await api.run(runId);
          if (!cancelled) setState((current) => ({ ...current, run, connection: "closed" }));
        }
      } catch (error) {
        if (cancelled || controller.signal.aborted) return;
        void error;
        startPolling();
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
      stopPolling();
    };
  }, [runId]);

  return state;
}
