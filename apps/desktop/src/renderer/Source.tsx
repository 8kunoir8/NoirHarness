import { useCallback, useEffect, useState } from "react";
import type { GitCommitResult, GitFileStatus, GitStatusResult } from "@noir/protocol";
import type { RequestFn } from "./api.js";
import { errorMessage } from "./events.js";

export interface SourceProps {
  request: RequestFn;
  workspaceId: string;
  /** Shown when more than one workspace exists, since a chat can open this page for another one. */
  workspaceName: string;
  onOpenDiff: (path: string) => void;
}

/** Which mutation is in flight; a second one waits, because the index is a single resource. */
type Busy = "status" | "stage" | "unstage" | "commit";

interface CommitSummary {
  sha: string;
  summary: string;
}

function counts(files: readonly GitFileStatus[]): { add: number; del: number } {
  return files.reduce((total, file) => ({ add: total.add + file.add, del: total.del + file.del }), {
    add: 0,
    del: 0,
  });
}

/**
 * Local source control: the same `git.status` the inspector reads, plus the three mutations the
 * kernel serializes per workspace. Every mutation answers with the fresh status, so what is on
 * screen is what the index holds, never a guess.
 */
export function Source({ request, workspaceId, workspaceName, onOpenDiff }: SourceProps) {
  const [status, setStatus] = useState<GitStatusResult | undefined>(undefined);
  const [busy, setBusy] = useState<Busy | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [message, setMessage] = useState("");
  const [committed, setCommitted] = useState<CommitSummary | undefined>(undefined);

  const refresh = useCallback(async (): Promise<void> => {
    setBusy("status");
    try {
      setStatus(await request<GitStatusResult>("git.status", { workspaceId }));
      setError(undefined);
    } catch (statusError) {
      setError(errorMessage(statusError));
    } finally {
      setBusy(undefined);
    }
  }, [request, workspaceId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const mutate = async (kind: Exclude<Busy, "status">, action: () => Promise<GitStatusResult>): Promise<void> => {
    setBusy(kind);
    try {
      setStatus(await action());
      setError(undefined);
      if (kind === "commit") setMessage("");
    } catch (mutationError) {
      // Git's own words: a hook rejection is the reason the user needs to read.
      setError(errorMessage(mutationError));
    } finally {
      setBusy(undefined);
    }
  };

  const stage = (paths: string[]): Promise<void> =>
    mutate("stage", () => request<GitStatusResult>("git.stage", { workspaceId, paths }));
  const unstage = (paths: string[]): Promise<void> =>
    mutate("unstage", () => request<GitStatusResult>("git.unstage", { workspaceId, paths }));

  const commit = (): Promise<void> =>
    mutate("commit", async () => {
      const result = await request<GitCommitResult>("git.commit", { workspaceId, message });
      setCommitted({ sha: result.sha, summary: result.summary });
      return result.status;
    });

  if (status === undefined) {
    return (
      <section aria-label="Source" className="source">
        <p className="empty">{error ?? "Reading the working tree…"}</p>
      </section>
    );
  }

  if (!status.isRepo) {
    return (
      <section aria-label="Source" className="source">
        <p className="empty">Not a git repository: {workspaceName}</p>
      </section>
    );
  }

  const staged = status.files.filter((file) => file.index !== null);
  const unstaged = status.files.filter((file) => file.worktree !== null);
  const totals = counts(status.files);
  const commitReason =
    message.trim() === ""
      ? "Write a commit message"
      : staged.length === 0
        ? "Nothing staged to commit"
        : undefined;

  /** One row per group: the checkbox is the toggle, the path opens the diff. */
  const rows = (files: readonly GitFileStatus[], group: "staged" | "unstaged") =>
    files.length === 0 ? (
      <p className="empty">{group === "staged" ? "Nothing staged" : "Working tree clean"}</p>
    ) : (
      <ul className="source-list">
        {files.map((file) => {
          const checked = group === "staged";
          return (
            <li key={`${group}:${file.path}`} className="source-row">
              <input
                type="checkbox"
                aria-label={`${group === "staged" ? "Unstage" : "Stage"} ${file.path}`}
                checked={checked}
                disabled={busy !== undefined}
                onChange={() => void (checked ? unstage([file.path]) : stage([file.path]))}
              />
              <button
                type="button"
                className="source-path"
                title={`${file.path} (+${String(file.add)} −${String(file.del)})`}
                onClick={() => onOpenDiff(file.path)}
              >
                {file.path}
              </button>
              <span className="source-counts">
                <span className="diff-add">+{file.add}</span> <span className="diff-del">−{file.del}</span>
              </span>
            </li>
          );
        })}
      </ul>
    );

  return (
    <section aria-label="Source" className="source">
      <header className="source-header">
        <h2>{workspaceName}</h2>
        <span className="source-branch">{status.branch ?? "detached"}</span>
        {status.ahead === 0 && status.behind === 0 ? null : (
          <span className="source-divergence" data-testid="source-divergence">
            {status.ahead === 0 ? "" : `↑${String(status.ahead)}`}
            {status.behind === 0 ? "" : `↓${String(status.behind)}`}
          </span>
        )}
        <span className="source-counts">
          <span className="diff-add">+{totals.add}</span> <span className="diff-del">−{totals.del}</span>
        </span>
        <button type="button" onClick={() => void refresh()} disabled={busy !== undefined}>
          Refresh
        </button>
      </header>
      {busy === undefined ? null : (
        <p className="source-busy" role="status">
          {busy === "status" ? "Reading…" : busy === "stage" ? "Staging…" : busy === "unstage" ? "Unstaging…" : "Committing…"}
        </p>
      )}
      {error === undefined ? null : (
        <p role="alert" className="source-error">
          {error}
        </p>
      )}
      {status.files.length === 0 ? <p className="empty">No changes</p> : null}

      <section className="source-group" aria-label="Staged">
        <div className="source-group-header">
          <h3>Staged ({staged.length})</h3>
          <button
            type="button"
            disabled={staged.length === 0 || busy !== undefined}
            onClick={() => void unstage(staged.map((file) => file.path))}
          >
            Unstage all
          </button>
        </div>
        {rows(staged, "staged")}
      </section>

      <section className="source-group" aria-label="Unstaged">
        <div className="source-group-header">
          <h3>Unstaged ({unstaged.length})</h3>
          <button
            type="button"
            disabled={unstaged.length === 0 || busy !== undefined}
            onClick={() => void stage(unstaged.map((file) => file.path))}
          >
            Stage all
          </button>
        </div>
        {rows(unstaged, "unstaged")}
      </section>

      <form
        className="source-commit"
        onSubmit={(event) => {
          event.preventDefault();
          if (commitReason === undefined && busy === undefined) void commit();
        }}
      >
        <label>
          Commit message
          <textarea
            aria-label="Commit message"
            value={message}
            rows={2}
            onChange={(event) => setMessage(event.target.value)}
          />
        </label>
        <button
          type="submit"
          className="primary"
          disabled={commitReason !== undefined || busy !== undefined}
          title={commitReason}
        >
          Commit
        </button>
      </form>
      {committed === undefined ? null : (
        <p className="source-committed" role="status">
          Committed {committed.sha.slice(0, 7)}: {committed.summary}
        </p>
      )}
      <p className="source-note">
        Diffs compare against HEAD; a fully staged file shows the same content either way.
      </p>
    </section>
  );
}
