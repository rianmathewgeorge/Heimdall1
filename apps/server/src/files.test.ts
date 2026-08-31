import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  diffSnapshots, listDirectory, readFilePreview, resolveWorkspacePath, searchFiles,
  snapshotWorkspace, WorkspacePathError,
} from "./files.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-files-test-"));
  temporaryDirectories.push(root);
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "app.ts"), "export const x = 1;\n", "utf8");
  await writeFile(path.join(root, "README.md"), "# demo\n", "utf8");
  return root;
}

describe("resolveWorkspacePath", () => {
  it("refuses a path that escapes the workspace", () => {
    expect(() => resolveWorkspacePath("/tmp/workspace", "../outside")).toThrow(WorkspacePathError);
    expect(() => resolveWorkspacePath("/tmp/workspace", "../../etc/passwd")).toThrow(WorkspacePathError);
  });

  it("treats a leading slash as workspace-relative rather than an absolute escape", () => {
    // Safe either way (it never leaves the workspace) — this documents the choice.
    expect(resolveWorkspacePath("/tmp/workspace", "/etc/passwd")).toBe(path.join("/tmp/workspace", "etc/passwd"));
  });

  it("allows an ordinary relative path", () => {
    expect(resolveWorkspacePath("/tmp/workspace", "src/app.ts")).toBe(path.join("/tmp/workspace", "src/app.ts"));
  });
});

describe("listDirectory / searchFiles / readFilePreview", () => {
  it("lists a directory with directories first, then files alphabetically", async () => {
    const root = await makeWorkspace();
    const entries = await listDirectory(root, "");
    expect(entries.map((e) => e.name)).toEqual(["src", "README.md"]);
    expect(entries[0]).toMatchObject({ type: "directory" });
  });

  it("finds files by name across the tree", async () => {
    const root = await makeWorkspace();
    expect(await searchFiles(root, "app")).toEqual(["src/app.ts"]);
    expect(await searchFiles(root, "nothing-like-this")).toEqual([]);
  });

  it("reads a file's content with a language hint", async () => {
    const root = await makeWorkspace();
    const preview = await readFilePreview(root, "src/app.ts");
    expect(preview.content).toContain("export const x = 1;");
    expect(preview.language).toBe("typescript");
    expect(preview.binary).toBe(false);
  });
});

describe("run-scoped file change tracking", () => {
  it("detects an added file with a usable diff", async () => {
    const root = await makeWorkspace();
    const before = await snapshotWorkspace(root);
    await writeFile(path.join(root, "new-file.txt"), "hello\nworld\n", "utf8");
    const after = await snapshotWorkspace(root);

    const changes = diffSnapshots(before, after);
    const added = changes.find((c) => c.path === "new-file.txt");
    expect(added).toMatchObject({ kind: "added", diffAvailable: true });
    expect(added?.diff?.some((hunk) => hunk.added && hunk.value.includes("hello"))).toBe(true);
  });

  it("detects a modified file and a deleted file", async () => {
    const root = await makeWorkspace();
    const before = await snapshotWorkspace(root);
    await writeFile(path.join(root, "src", "app.ts"), "export const x = 2;\n", "utf8");
    await rm(path.join(root, "README.md"));
    const after = await snapshotWorkspace(root);

    const changes = diffSnapshots(before, after);
    expect(changes.find((c) => c.path === "src/app.ts")).toMatchObject({ kind: "modified", diffAvailable: true });
    expect(changes.find((c) => c.path === "README.md")).toMatchObject({
      kind: "deleted", diffAvailable: true, sizeAfter: null,
    });
  });

  it("reports no changes when nothing in the workspace moved", async () => {
    const root = await makeWorkspace();
    const before = await snapshotWorkspace(root);
    const after = await snapshotWorkspace(root);
    expect(diffSnapshots(before, after)).toEqual([]);
  });
});
