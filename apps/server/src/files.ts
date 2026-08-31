/**
 * Workspace visibility: a searchable tree, syntax-highlight-ready file
 * previews, and a run-scoped "what changed" diff — all snapshot-based rather
 * than a filesystem watcher (see WORKSPACE_SNAPSHOT_LIMITATION in this file's
 * doc comments), which keeps it dependency-free and correct across both the
 * local-process and container runtimes without needing a shared git repo.
 */
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import * as Diff from "diff";
import type { DiffHunk, FileChange } from "./types.js";

export class WorkspacePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspacePathError";
  }
}

const EXCLUDED_DIRS = new Set(["node_modules", ".git", "dist", "build", ".cache", "coverage", ".deleted"]);
const MAX_WALK_ENTRIES = 5000;
const MAX_SNAPSHOT_CONTENT_BYTES = 256 * 1024;
const MAX_PREVIEW_BYTES = 1024 * 1024;
const MAX_SEARCH_RESULTS = 200;
const MAX_WALK_DEPTH = 12;

/** Resolves a relative path inside `root`, refusing anything that would escape it. */
export function resolveWorkspacePath(root: string, relPath: string): string {
  const normalized = path.normalize(relPath || ".").replace(/^([/\\])+/, "");
  const rootResolved = path.resolve(root);
  const resolved = path.resolve(rootResolved, normalized);
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
    throw new WorkspacePathError("Path escapes the agent workspace");
  }
  return resolved;
}

export interface TreeEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  size: number | null;
  mtimeMs: number | null;
}

export async function listDirectory(root: string, relPath: string): Promise<TreeEntry[]> {
  const dir = resolveWorkspacePath(root, relPath);
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
  if (entries === null) return [];
  const out: TreeEntry[] = [];
  for (const entry of entries) {
    if (EXCLUDED_DIRS.has(entry.name)) continue;
    const rel = relPath ? path.posix.join(relPath, entry.name) : entry.name;
    if (entry.isDirectory()) {
      out.push({ name: entry.name, path: rel, type: "directory", size: null, mtimeMs: null });
      continue;
    }
    if (!entry.isFile()) continue;
    try {
      const info = await stat(path.join(dir, entry.name));
      out.push({ name: entry.name, path: rel, type: "file", size: info.size, mtimeMs: info.mtimeMs });
    } catch {
      /* raced with the agent writing/removing the file; skip it this listing */
    }
  }
  out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "directory" ? -1 : 1));
  return out;
}

export async function searchFiles(root: string, query: string, limit = MAX_SEARCH_RESULTS): Promise<string[]> {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const out: string[] = [];
  const walk = async (rel: string, depth: number): Promise<void> => {
    if (out.length >= limit || depth > MAX_WALK_DEPTH) return;
    const dir = resolveWorkspacePath(root, rel);
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
    if (entries === null) return;
    for (const entry of entries) {
      if (out.length >= limit) return;
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      const childRel = rel ? path.posix.join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) {
        await walk(childRel, depth + 1);
        continue;
      }
      if (entry.name.toLowerCase().includes(needle)) out.push(childRel);
    }
  };
  await walk("", 0);
  return out;
}

function looksBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 8000).includes(0);
}

const LANGUAGE_BY_EXT: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".json": "json",
  ".md": "markdown",
  ".css": "css",
  ".html": "xml",
  ".py": "python",
  ".sh": "bash",
  ".yml": "yaml",
  ".yaml": "yaml",
  ".toml": "ini",
  ".txt": "plaintext",
};

export function languageForPath(p: string): string {
  return LANGUAGE_BY_EXT[path.extname(p).toLowerCase()] ?? "plaintext";
}

export interface FilePreview {
  path: string;
  size: number;
  content: string;
  truncated: boolean;
  binary: boolean;
  language: string;
}

export async function readFilePreview(root: string, relPath: string): Promise<FilePreview> {
  const abs = resolveWorkspacePath(root, relPath);
  const info = await stat(abs);
  if (!info.isFile()) throw new WorkspacePathError("Not a file");
  const buffer = await readFile(abs);
  const binary = looksBinary(buffer);
  const truncated = buffer.byteLength > MAX_PREVIEW_BYTES;
  const content = binary ? "" : buffer.subarray(0, MAX_PREVIEW_BYTES).toString("utf8");
  return { path: relPath, size: info.size, content, truncated, binary, language: languageForPath(relPath) };
}

/* ─────────────────────── run-scoped change tracking ───────────────────────
 *
 * WORKSPACE_SNAPSHOT_LIMITATION: there is no filesystem watcher here — a
 * before/after content snapshot is taken around each run instead. That is
 * exact for the "what did this run change" question (which is what the
 * Files tab needs) but cannot show changes made *outside* a run, and a
 * concurrent external edit during the run window can be misattributed.
 * Workspaces are not required to be git repositories, so this intentionally
 * does not depend on git.
 */

export interface SnapshotEntry {
  size: number;
  mtimeMs: number;
  /** Captured only for files under MAX_SNAPSHOT_CONTENT_BYTES that are not binary. */
  content: string | null;
}

export type WorkspaceSnapshot = Map<string, SnapshotEntry>;

export async function snapshotWorkspace(root: string): Promise<WorkspaceSnapshot> {
  const snapshot: WorkspaceSnapshot = new Map();
  const walk = async (rel: string, depth: number): Promise<void> => {
    if (depth > MAX_WALK_DEPTH || snapshot.size > MAX_WALK_ENTRIES) return;
    const dir = resolveWorkspacePath(root, rel);
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
    if (entries === null) return;
    for (const entry of entries) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      const childRel = rel ? path.posix.join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) {
        await walk(childRel, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const abs = path.join(dir, entry.name);
        const info = await stat(abs);
        let content: string | null = null;
        if (info.size <= MAX_SNAPSHOT_CONTENT_BYTES) {
          const buffer = await readFile(abs);
          if (!looksBinary(buffer)) content = buffer.toString("utf8");
        }
        snapshot.set(childRel, { size: info.size, mtimeMs: info.mtimeMs, content });
      } catch {
        /* file vanished mid-walk */
      }
    }
  };
  await walk("", 0);
  return snapshot;
}

export function buildFileDiff(before: SnapshotEntry | undefined, after: SnapshotEntry | undefined): DiffHunk[] {
  const beforeText = before?.content ?? "";
  const afterText = after?.content ?? "";
  return Diff.diffLines(beforeText, afterText).map((part) => ({
    value: part.value,
    ...(part.added ? { added: true } : {}),
    ...(part.removed ? { removed: true } : {}),
  }));
}

export function diffSnapshots(before: WorkspaceSnapshot, after: WorkspaceSnapshot): FileChange[] {
  const changes: FileChange[] = [];

  for (const [filePath, beforeEntry] of before) {
    const afterEntry = after.get(filePath);
    if (!afterEntry) {
      const diffAvailable = beforeEntry.content !== null;
      changes.push({
        path: filePath,
        kind: "deleted",
        sizeBefore: beforeEntry.size,
        sizeAfter: null,
        diffAvailable,
        ...(diffAvailable ? { diff: buildFileDiff(beforeEntry, undefined) } : {}),
      });
      continue;
    }
    if (afterEntry.size !== beforeEntry.size || afterEntry.mtimeMs !== beforeEntry.mtimeMs) {
      const diffAvailable = afterEntry.content !== null && beforeEntry.content !== null;
      changes.push({
        path: filePath,
        kind: "modified",
        sizeBefore: beforeEntry.size,
        sizeAfter: afterEntry.size,
        diffAvailable,
        ...(diffAvailable ? { diff: buildFileDiff(beforeEntry, afterEntry) } : {}),
      });
    }
  }

  for (const [filePath, afterEntry] of after) {
    if (before.has(filePath)) continue;
    const diffAvailable = afterEntry.content !== null;
    changes.push({
      path: filePath,
      kind: "added",
      sizeBefore: null,
      sizeAfter: afterEntry.size,
      diffAvailable,
      ...(diffAvailable ? { diff: buildFileDiff(undefined, afterEntry) } : {}),
    });
  }

  changes.sort((a, b) => a.path.localeCompare(b.path));
  return changes;
}
