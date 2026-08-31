import type { SerializedError } from "./types.js";

export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export class RunCancelledError extends Error {
  constructor() {
    super("Run cancelled");
    this.name = "RunCancelledError";
  }
}

/**
 * Thrown by a runner when the underlying process/container exited abnormally.
 * Carries the raw exit code and full stdout/stderr so the diagnostic surface
 * never has to fall back to a generic "runtime failed" message. Chain a lower
 * level cause via the standard `cause` option — errors.ts walks it in
 * serializeError so the UI sees the full chain, not just this outer message.
 */
export class RuntimeExitError extends Error {
  public readonly exitCode: number | null;
  public readonly containerName: string | null;
  public readonly stdout: string;
  public readonly stderr: string;

  constructor(
    message: string,
    details: {
      exitCode: number | null;
      containerName?: string | null;
      stdout?: string;
      stderr?: string;
      cause?: unknown;
    },
  ) {
    super(message, details.cause !== undefined ? { cause: details.cause } : undefined);
    this.name = "RuntimeExitError";
    this.exitCode = details.exitCode;
    this.containerName = details.containerName ?? null;
    this.stdout = details.stdout ?? "";
    this.stderr = details.stderr ?? "";
  }
}

interface ErrorLike {
  message?: unknown;
  name?: unknown;
  exitCode?: unknown;
  containerName?: unknown;
  stdout?: unknown;
  stderr?: unknown;
  cause?: unknown;
}

const MAX_CAUSE_DEPTH = 8;

/**
 * Walks `.cause` to produce the full causal chain as a plain, JSON-safe object.
 * Native Error objects are not JSON-serialisable and drop custom properties
 * (exitCode, stdout, stderr) and `.cause` on `JSON.stringify` — this is the one
 * place that flattens an error graph before it is persisted or sent to the UI.
 */
export function serializeError(error: unknown, depth = 0): SerializedError {
  if (!(error instanceof Error)) {
    return { message: String(error), name: "Error" };
  }
  const withMeta = error as Error & ErrorLike;
  const out: SerializedError = {
    message: error.message,
    name: error.name || "Error",
  };
  if (typeof withMeta.exitCode === "number" || withMeta.exitCode === null) {
    out.exitCode = withMeta.exitCode as number | null;
  }
  if (typeof withMeta.containerName === "string" || withMeta.containerName === null) {
    out.containerName = withMeta.containerName as string | null;
  }
  if (typeof withMeta.stdout === "string" && withMeta.stdout.length > 0) {
    out.stdout = withMeta.stdout;
  }
  if (typeof withMeta.stderr === "string" && withMeta.stderr.length > 0) {
    out.stderr = withMeta.stderr;
  }
  if (withMeta.cause !== undefined && withMeta.cause !== null && depth < MAX_CAUSE_DEPTH) {
    out.cause = serializeError(withMeta.cause, depth + 1);
  }
  return out;
}

/** First stdout/stderr found anywhere in the causal chain, if any node carries it. */
export function findLogsInChain(error: SerializedError): { stdout: string; stderr: string } | null {
  let node: SerializedError | undefined = error;
  while (node) {
    if (node.stdout !== undefined || node.stderr !== undefined) {
      return { stdout: node.stdout ?? "", stderr: node.stderr ?? "" };
    }
    node = node.cause;
  }
  return null;
}

/** First exit code / container name found anywhere in the causal chain, if any. */
export function findRuntimeMetaInChain(
  error: SerializedError,
): { exitCode: number | null; containerName: string | null } | null {
  let node: SerializedError | undefined = error;
  while (node) {
    if (node.exitCode !== undefined || node.containerName !== undefined) {
      return { exitCode: node.exitCode ?? null, containerName: node.containerName ?? null };
    }
    node = node.cause;
  }
  return null;
}
