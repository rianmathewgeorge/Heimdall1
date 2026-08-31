import { describe, expect, it } from "vitest";
import { findLogsInChain, findRuntimeMetaInChain, RuntimeExitError, serializeError } from "./errors.js";

describe("serializeError", () => {
  it("walks the full causal chain, not just the outer message", () => {
    // Mirrors the example in the brief: an outer "recon failed" wrapping the
    // real runtime failure underneath it.
    const rootCause = new RuntimeExitError(
      "Codex runtime exited with code 1: Failed to shutdown rollout recorder",
      { exitCode: 1, containerName: "heimdall-recon-abc", stdout: "step one\n", stderr: "Failed to shutdown rollout recorder\n" },
    );
    const outer = new Error(
      "HEIMDALL: recon did not produce a valid manifest — execution refused (fail closed).",
      { cause: rootCause },
    );

    const serialized = serializeError(outer);
    expect(serialized.message).toContain("recon did not produce a valid manifest");
    expect(serialized.cause).toBeDefined();
    expect(serialized.cause?.message).toBe("Codex runtime exited with code 1: Failed to shutdown rollout recorder");
    expect(serialized.cause?.exitCode).toBe(1);
    expect(serialized.cause?.containerName).toBe("heimdall-recon-abc");
    expect(serialized.cause?.stderr).toContain("Failed to shutdown rollout recorder");
  });

  it("handles a non-Error thrown value", () => {
    expect(serializeError("just a string")).toEqual({ message: "just a string", name: "Error" });
  });

  it("handles an error with no cause", () => {
    const serialized = serializeError(new Error("plain failure"));
    expect(serialized.cause).toBeUndefined();
    expect(serialized.message).toBe("plain failure");
  });

  it("does not walk more than a bounded number of cause levels", () => {
    let error = new Error("root");
    for (let i = 0; i < 20; i++) {
      error = new Error(`level ${i}`, { cause: error });
    }
    const serialized = serializeError(error);
    let depth = 0;
    let node = serialized;
    while (node.cause) {
      depth += 1;
      node = node.cause;
    }
    expect(depth).toBeLessThanOrEqual(8);
  });
});

describe("findLogsInChain / findRuntimeMetaInChain", () => {
  it("finds stdout/stderr and exit metadata anywhere in the chain", () => {
    const inner = new RuntimeExitError("inner failure", {
      exitCode: 137, containerName: "heimdall-exec-xyz", stdout: "out", stderr: "err",
    });
    const outer = serializeError(new Error("outer wrapper", { cause: inner }));
    expect(findLogsInChain(outer)).toEqual({ stdout: "out", stderr: "err" });
    expect(findRuntimeMetaInChain(outer)).toEqual({ exitCode: 137, containerName: "heimdall-exec-xyz" });
  });

  it("returns null when nothing in the chain carries that information", () => {
    const outer = serializeError(new Error("outer", { cause: new Error("inner") }));
    expect(findLogsInChain(outer)).toBeNull();
    expect(findRuntimeMetaInChain(outer)).toBeNull();
  });
});
