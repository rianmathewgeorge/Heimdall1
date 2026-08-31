import { useEffect, useMemo, useState } from "react";
import { api } from "../../api";
import { formatBytes } from "../../lib/format";
import type { AgentRun, DiffHunk, FilePreview, TreeEntry } from "../../types";
import { IconChevronRight, IconFile, IconFolder, IconSearch } from "../../HeimdallIcons";

function DiffView({ hunks }: { hunks: DiffHunk[] }) {
  return (
    <pre className="diff-view mono">
      {hunks.map((hunk, i) => (
        <span key={i} className={hunk.added ? "diff-added" : hunk.removed ? "diff-removed" : "diff-context"}>
          {hunk.value
            .split("\n")
            .filter((_, index, all) => index < all.length - 1 || all[index] !== "")
            .map((line, lineIndex) => (
              <span className="diff-line" key={lineIndex}>
                <span className="diff-marker">{hunk.added ? "+" : hunk.removed ? "-" : " "}</span>
                {line}
                {"\n"}
              </span>
            ))}
        </span>
      ))}
    </pre>
  );
}

function FilePreviewView({ file }: { file: FilePreview }) {
  const [highlighted, setHighlighted] = useState<string | null>(null);

  useEffect(() => {
    setHighlighted(null);
    if (file.binary) return;
    let cancelled = false;
    import("highlight.js").then(({ default: hljs }) => {
      if (cancelled) return;
      try {
        const result =
          file.language !== "plaintext"
            ? hljs.highlight(file.content, { language: file.language }).value
            : hljs.highlightAuto(file.content).value;
        setHighlighted(result);
      } catch {
        setHighlighted(null);
      }
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [file]);

  if (file.binary) return <p className="wr-empty">Binary file — preview unavailable.</p>;
  return (
    <>
      {file.truncated && <p className="perm-note">Showing the first portion of a larger file.</p>}
      {highlighted ? (
        <pre className="code-preview mono"><code dangerouslySetInnerHTML={{ __html: highlighted }} /></pre>
      ) : (
        <pre className="code-preview mono">{file.content}</pre>
      )}
    </>
  );
}

export interface FilesTabProps {
  agentId: string;
  run: AgentRun | null;
}

type Mode = "browse" | "changes";

export function FilesTab({ agentId, run }: FilesTabProps) {
  const [mode, setMode] = useState<Mode>("browse");
  const [currentPath, setCurrentPath] = useState("");
  const [entries, setEntries] = useState<TreeEntry[]>([]);
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<string[] | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshedAt, setRefreshedAt] = useState<number>(Date.now());

  const changedPaths = useMemo(() => new Set((run?.fileChanges ?? []).map((c) => c.path)), [run?.fileChanges]);

  useEffect(() => {
    let cancelled = false;
    api.filesTree(agentId, currentPath).then(({ entries: next }) => {
      if (!cancelled) { setEntries(next); setRefreshedAt(Date.now()); }
    }).catch(() => { if (!cancelled) setError("Could not list this directory."); });
    return () => { cancelled = true; };
  }, [agentId, currentPath]);

  useEffect(() => {
    if (!query.trim()) { setSearchResults(null); return; }
    let cancelled = false;
    const handle = window.setTimeout(() => {
      api.filesSearch(agentId, query).then(({ paths }) => { if (!cancelled) setSearchResults(paths); }).catch(() => undefined);
    }, 200);
    return () => { cancelled = true; window.clearTimeout(handle); };
  }, [agentId, query]);

  const openFile = (path: string) => {
    setSelectedPath(path);
    setPreview(null);
    setError(null);
    api.fileContent(agentId, path).then(({ file }) => setPreview(file)).catch(() => setError("Could not read this file."));
  };

  const breadcrumbs = currentPath ? currentPath.split("/") : [];
  const change = selectedPath ? (run?.fileChanges ?? []).find((c) => c.path === selectedPath) : undefined;

  return (
    <div className="tab-panel files-tab">
      <div className="files-toolbar">
        <div className="files-mode-toggle">
          <button className={mode === "browse" ? "active" : ""} onClick={() => setMode("browse")}>Browse</button>
          <button className={mode === "changes" ? "active" : ""} onClick={() => setMode("changes")}>
            Changes {run?.fileChanges ? "(" + run.fileChanges.length + ")" : ""}
          </button>
        </div>
        {mode === "browse" && (
          <div className="files-search">
            <IconSearch />
            <input placeholder="Search files…" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
        )}
      </div>

      <div className="files-body">
        <div className="files-list">
          {mode === "browse" ? (
            <>
              <div className="files-freshness">Snapshot refreshed {new Date(refreshedAt).toLocaleTimeString()}</div>
              {searchResults !== null ? (
                <>
                  {searchResults.length === 0 && <p className="wr-empty">No files match "{query}".</p>}
                  {searchResults.map((path) => (
                    <button key={path} className={"file-row " + (path === selectedPath ? "selected" : "")} onClick={() => openFile(path)}>
                      <IconFile />
                      <span className="mono truncate">{path}</span>
                      {changedPaths.has(path) && <span className="change-dot" />}
                    </button>
                  ))}
                </>
              ) : (
                <>
                  <div className="breadcrumbs">
                    <button onClick={() => setCurrentPath("")}>workspace</button>
                    {breadcrumbs.map((segment, i) => (
                      <span key={i}>
                        <IconChevronRight />
                        <button onClick={() => setCurrentPath(breadcrumbs.slice(0, i + 1).join("/"))}>{segment}</button>
                      </span>
                    ))}
                  </div>
                  {entries.map((entry) => (
                    <button
                      key={entry.path}
                      className={"file-row " + (entry.path === selectedPath ? "selected" : "")}
                      onClick={() => (entry.type === "directory" ? setCurrentPath(entry.path) : openFile(entry.path))}
                    >
                      {entry.type === "directory" ? <IconFolder /> : <IconFile />}
                      <span className="truncate">{entry.name}</span>
                      {entry.type === "file" && entry.size !== null && <span className="mono file-size">{formatBytes(entry.size)}</span>}
                      {changedPaths.has(entry.path) && <span className="change-dot" />}
                    </button>
                  ))}
                  {entries.length === 0 && <p className="wr-empty">Empty directory.</p>}
                </>
              )}
            </>
          ) : (
            <>
              <div className="files-freshness">
                {run ? "Changes made by this run — based on the completed-run snapshot." : "No run selected."}
              </div>
              {(run?.fileChanges ?? []).length === 0 && <p className="wr-empty">No file changes recorded for this run.</p>}
              {(run?.fileChanges ?? []).map((c) => (
                <button key={c.path} className={"file-row change-" + c.kind + " " + (c.path === selectedPath ? "selected" : "")}
                  onClick={() => { setSelectedPath(c.path); setPreview(null); }}>
                  <span className={"change-badge change-" + c.kind}>{c.kind[0]?.toUpperCase()}</span>
                  <span className="mono truncate">{c.path}</span>
                </button>
              ))}
            </>
          )}
        </div>

        <div className="files-preview">
          {error && <p className="wr-empty">{error}</p>}
          {mode === "changes" && change ? (
            change.diffAvailable && change.diff ? (
              <DiffView hunks={change.diff} />
            ) : (
              <p className="wr-empty">Diff unavailable for this file (too large, or binary).</p>
            )
          ) : selectedPath && preview ? (
            <>
              <div className="files-preview-head mono">{selectedPath}</div>
              <FilePreviewView file={preview} />
            </>
          ) : (
            <p className="wr-empty">Select a file to preview it here without leaving the agent screen.</p>
          )}
        </div>
      </div>
    </div>
  );
}
