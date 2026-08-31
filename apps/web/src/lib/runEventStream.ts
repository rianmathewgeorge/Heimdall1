/**
 * Consumes the SSE run-event stream via `fetch` + a ReadableStream reader
 * rather than the native `EventSource` API. EventSource cannot set the
 * `Authorization` header this app's shared-token auth requires, so this is
 * the only way to get a live stream that also respects auth.
 */
import { getAuthToken, runEventsStreamUrl } from "../api";
import type { RunEvent } from "../types";

export interface RunEventStreamHandlers {
  onEvent(event: RunEvent): void;
}

/** Resolves once the stream ends (server closed it, e.g. the run went terminal). */
export async function streamRunEvents(
  runId: string,
  handlers: RunEventStreamHandlers,
  signal: AbortSignal,
  afterSeq?: number,
): Promise<void> {
  const token = getAuthToken();
  const response = await fetch(runEventsStreamUrl(runId, afterSeq), {
    headers: token ? { Authorization: "Bearer " + token } : {},
    signal,
  });
  if (!response.ok) {
    throw new Error("Event stream request failed: " + response.status);
  }
  if (!response.body) {
    throw new Error("Event stream response has no body");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let separatorIndex = buffer.indexOf("\n\n");
    while (separatorIndex !== -1) {
      const block = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + 2);
      const dataLine = block.split("\n").find((line) => line.startsWith("data: "));
      if (dataLine) {
        try {
          handlers.onEvent(JSON.parse(dataLine.slice("data: ".length)) as RunEvent);
        } catch {
          // malformed frame — skip it, the stream continues
        }
      }
      separatorIndex = buffer.indexOf("\n\n");
    }
  }
}
