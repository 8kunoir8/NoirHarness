import { useEffect, useRef, useState } from "react";
import type { RequestFn } from "./api.js";

export interface DiffLine {
  kind: "meta" | "hunk" | "add" | "del" | "context";
  text: string;
  oldLine?: number;
  newLine?: number;
}

interface Annotation {
  id: string;
  line: number;
  note: string;
  createdAt: number;
  stale: boolean;
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const NO_NEWLINE = "\\ No newline at end of file";

export function parseDiff(text: string): DiffLine[] {
  const raw = text.split("\n");
  if (raw[raw.length - 1] === "") raw.pop();
  const parsed: DiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const rawLine of raw) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.startsWith("diff ")) {
      inHunk = false;
      oldLine = 0;
      newLine = 0;
      parsed.push({ kind: "meta", text: line });
      continue;
    }
    const hunk = HUNK.exec(line);
    if (hunk !== null) {
      inHunk = true;
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      parsed.push({ kind: "hunk", text: line });
      continue;
    }
    if (!inHunk) {
      // File headers (---/+++, index, mode/rename/binary markers) carry no hunks yet.
      parsed.push({ kind: "meta", text: line });
      continue;
    }
    if (line.startsWith(NO_NEWLINE)) {
      parsed.push({ kind: "meta", text: line });
      continue;
    }
    if (line.startsWith("+")) {
      parsed.push({ kind: "add", text: line, newLine });
      newLine += 1;
      continue;
    }
    if (line.startsWith("-")) {
      parsed.push({ kind: "del", text: line, oldLine });
      oldLine += 1;
      continue;
    }
    parsed.push({ kind: "context", text: line, oldLine, newLine });
    oldLine += 1;
    newLine += 1;
  }
  return parsed;
}

export interface DiffViewProps {
  request: RequestFn;
  workspaceId: string;
  path: string;
}

function messageOf(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}

export function DiffView({ request, workspaceId, path }: DiffViewProps) {
  const [lines, setLines] = useState<DiffLine[]>([]);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [draft, setDraft] = useState<{ line: number; note: string } | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loaded, setLoaded] = useState(false);
  const generation = useRef(0);

  useEffect(() => {
    generation.current += 1;
    const run = generation.current;
    setLines([]);
    setAnnotations([]);
    setDraft(undefined);
    setError(undefined);
    setLoaded(false);
    void (async () => {
      try {
        const [diff, notes] = await Promise.all([
          request<{ diff: string }>("git.diff", { workspaceId, path }),
          request<{ diffHash: string; annotations: Annotation[] }>("annotation.list", { workspaceId, path }),
        ]);
        if (generation.current !== run) return;
        setLines(parseDiff(diff.diff));
        setAnnotations(notes.annotations);
        setLoaded(true);
      } catch (cause) {
        if (generation.current !== run) return;
        setError(messageOf(cause, "Could not load the diff"));
        setLoaded(true);
      }
    })();
    return () => {
      if (generation.current === run) generation.current = run + 1;
    };
  }, [request, workspaceId, path]);

  const addNote = async (line: number, note: string): Promise<void> => {
    const trimmed = note.trim();
    if (trimmed === "") return;
    try {
      const added = await request<Annotation>("annotation.add", { workspaceId, path, line, note: trimmed });
      setAnnotations((current) =>
        current.some((annotation) => annotation.id === added.id) ? current : [...current, added],
      );
      setDraft(undefined);
      setError(undefined);
    } catch (cause) {
      setError(messageOf(cause, "Could not save the note"));
    }
  };

  const removeNote = async (id: string): Promise<void> => {
    try {
      await request<{ ok: true }>("annotation.delete", { id });
      setAnnotations((current) => current.filter((annotation) => annotation.id !== id));
      setError(undefined);
    } catch (cause) {
      setError(messageOf(cause, "Could not delete the note"));
    }
  };

  const current = annotations.filter((annotation) => !annotation.stale);
  const stale = annotations.filter((annotation) => annotation.stale);

  return (
    <section aria-label="Diff" className="diff-view">
      {error === undefined ? null : <p role="alert">{error}</p>}
      {loaded && lines.length === 0 && error === undefined ? (
        <p className="empty">No changes in this file.</p>
      ) : null}
      <ol className="diff-lines">
        {lines.map((line, index) => {
          const newLine = line.newLine;
          const notes = newLine === undefined ? [] : current.filter((annotation) => annotation.line === newLine);
          return (
            <li key={`${index}:${line.text}`} className={`diff-line diff-${line.kind}`}>
              {newLine === undefined ? (
                <span className="diff-gutter" />
              ) : (
                <button
                  type="button"
                  className="diff-gutter"
                  aria-label={`Annotate line ${newLine}`}
                  onClick={() => setDraft({ line: newLine, note: "" })}
                >
                  {newLine}
                </button>
              )}
              <code>{line.text === "" ? " " : line.text}</code>
              {newLine !== undefined && draft?.line === newLine ? (
                <input
                  className="diff-note-input"
                  aria-label="Note"
                  autoFocus
                  value={draft.note}
                  onChange={(event) => setDraft({ line: newLine, note: event.target.value })}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && event.nativeEvent.isComposing !== true) {
                      void addNote(newLine, draft.note);
                    }
                    if (event.key === "Escape") setDraft(undefined);
                  }}
                />
              ) : null}
              {notes.map((annotation) => (
                <p key={annotation.id} className="diff-note">
                  <span className="diff-note-text">{annotation.note}</span>
                  <button
                    type="button"
                    className="diff-note-delete"
                    aria-label={`Delete note on line ${annotation.line}`}
                    onClick={() => void removeNote(annotation.id)}
                  >
                    ×
                  </button>
                </p>
              ))}
            </li>
          );
        })}
      </ol>
      {stale.length === 0 ? null : (
        <section aria-label="Stale notes" className="diff-stale">
          <h3>Notes from an earlier version</h3>
          <ul>
            {stale.map((annotation) => (
              <li key={annotation.id}>
                line {annotation.line}: <span className="diff-note-text">{annotation.note}</span>
                <button
                  type="button"
                  className="diff-note-delete"
                  aria-label={`Delete stale note on line ${annotation.line}`}
                  onClick={() => void removeNote(annotation.id)}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </section>
  );
}
