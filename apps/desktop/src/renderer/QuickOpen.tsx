import type { FsFilesResult } from "@noir/protocol";
import { useEffect, useId, useMemo, useState } from "react";
import type { RequestFn } from "./api.js";
import { errorMessage } from "./events.js";

export interface QuickOpenProps {
  request: RequestFn;
  workspaceId: string;
  onPick: (path: string) => void;
  onClose: () => void;
  /** Restricts the list, e.g. to previewable extensions; identity changes are harmless. */
  filter?: ((path: string) => boolean) | undefined;
  /** Dialog and input name; also names the placeholder ("Open file" → "Open a file…"). */
  label?: string | undefined;
}

const MAX_ROWS = 20;
const DEFAULT_LABEL = "Open file";

/** "Open file" → "Open a file…"; an unusual label just gains an ellipsis. */
function placeholderFor(label: string): string {
  return `${label.replace(/ file$/u, " a file")}…`;
}

/** `smt` matches `src/main.ts`: every query character appears in order. */
export function subsequence(path: string, query: string): boolean {
  const needle = [...query.toLowerCase()];
  const haystack = path.toLowerCase();
  let index = 0;
  for (const char of haystack) {
    if (char === needle[index]) index += 1;
    if (index === needle.length) return true;
  }
  return needle.length === 0;
}

/** ⌘P overlay: subsequence-filtered file list, ↑/↓ to move, Enter to pick, Esc to close. */
export function QuickOpen({ request, workspaceId, onPick, onClose, filter, label = DEFAULT_LABEL }: QuickOpenProps) {
  const listId = useId();
  const [files, setFiles] = useState<string[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  useEffect(() => {
    let live = true;
    // A different workspace is a fresh search: nothing from the old listing may survive.
    setFiles([]);
    setTruncated(false);
    setError(undefined);
    setQuery("");
    setActive(0);
    void (async () => {
      try {
        const result = await request<FsFilesResult>("fs.files", { workspaceId });
        if (!live) return;
        setFiles(result.files);
        setTruncated(result.truncated);
      } catch (reason: unknown) {
        if (!live) return;
        setError(errorMessage(reason));
      }
    })();
    return () => {
      live = false;
    };
  }, [request, workspaceId]);

  const visible = useMemo(
    () => (filter === undefined ? files : files.filter((path) => filter(path))),
    [files, filter],
  );
  const matches = useMemo(
    () => visible.filter((path) => subsequence(path, query)).slice(0, MAX_ROWS),
    [visible, query],
  );
  const activeIndex = Math.min(active, Math.max(matches.length - 1, 0));
  const selected = matches[activeIndex];

  return (
    <div
      className="quick-open-backdrop"
      onMouseDown={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div
        className="quick-open"
        role="dialog"
        aria-modal="true"
        aria-label={label}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
            return;
          }
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setActive(Math.min(activeIndex + 1, Math.max(matches.length - 1, 0)));
            return;
          }
          if (event.key === "ArrowUp") {
            event.preventDefault();
            setActive(Math.max(activeIndex - 1, 0));
            return;
          }
          if (event.key === "Enter") {
            event.preventDefault();
            if (selected !== undefined) onPick(selected);
          }
        }}
      >
        <input
          role="combobox"
          aria-label={label}
          aria-expanded="true"
          aria-controls={`${listId}-results`}
          aria-autocomplete="list"
          aria-activedescendant={selected === undefined ? undefined : `${listId}-option-${activeIndex}`}
          autoFocus
          value={query}
          placeholder={placeholderFor(label)}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
        />
        {error === undefined ? null : (
          <p className="quick-open-error" role="alert">
            {error}
          </p>
        )}
        <ul id={`${listId}-results`} role="listbox" aria-label="Matching files" className="quick-open-list">
          {matches.map((path, index) => (
            <li
              key={path}
              id={`${listId}-option-${index}`}
              role="option"
              aria-selected={index === activeIndex}
              onMouseEnter={() => setActive(index)}
              onMouseDown={(event) => {
                event.preventDefault();
                onPick(path);
              }}
            >
              {path}
            </li>
          ))}
        </ul>
        {error !== undefined ? null : matches.length === 0 ? (
          <p className="quick-open-empty" role="status">
            No matching files.
          </p>
        ) : null}
        {truncated ? <p className="quick-open-truncated">Showing the first 5,000 files.</p> : null}
      </div>
    </div>
  );
}
