import { useEffect, useMemo, useState } from "react";
import type { RequestFn } from "./api.js";

export interface QuickOpenProps {
  request: RequestFn;
  workspaceId: string;
  onPick: (path: string) => void;
  onClose: () => void;
}

interface FileList {
  files: string[];
  truncated: boolean;
}

const MAX_ROWS = 20;

/** `smt` matches `src/main.ts`: every query character appears in order. */
export function subsequence(path: string, query: string): boolean {
  const needle = query.toLowerCase();
  const haystack = path.toLowerCase();
  let index = 0;
  for (const char of haystack) {
    if (char === needle[index]) index += 1;
    if (index === needle.length) return true;
  }
  return needle.length === 0;
}

/** ⌘P overlay: subsequence-filtered file list, ↑/↓ to move, Enter to pick, Esc to close. */
export function QuickOpen({ request, workspaceId, onPick, onClose }: QuickOpenProps) {
  const [files, setFiles] = useState<string[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  useEffect(() => {
    let live = true;
    setError(undefined);
    void (async () => {
      try {
        const result = await request<FileList>("fs.files", { workspaceId });
        if (!live) return;
        setFiles(Array.isArray(result?.files) ? result.files : []);
        setTruncated(result?.truncated === true);
      } catch (reason: unknown) {
        if (!live) return;
        setFiles([]);
        setTruncated(false);
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    })();
    return () => {
      live = false;
    };
  }, [request, workspaceId]);

  const matches = useMemo(
    () => files.filter((path) => subsequence(path, query)).slice(0, MAX_ROWS),
    [files, query],
  );
  const activeIndex = Math.min(active, Math.max(matches.length - 1, 0));
  const selected = matches[activeIndex];

  return (
    <div
      className="quick-open"
      role="dialog"
      aria-modal="true"
      aria-label="Open file"
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
        aria-label="Open file"
        aria-expanded="true"
        aria-controls="quick-open-results"
        aria-autocomplete="list"
        aria-activedescendant={selected === undefined ? undefined : `quick-open-option-${activeIndex}`}
        autoFocus
        value={query}
        placeholder="Open a file…"
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
      <ul id="quick-open-results" role="listbox" aria-label="Matching files" className="quick-open-list">
        {matches.map((path, index) => (
          <li
            key={path}
            id={`quick-open-option-${index}`}
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
        <p className="quick-open-empty">No matching files.</p>
      ) : null}
      {truncated ? <p className="quick-open-truncated">Showing the first 5,000 files.</p> : null}
    </div>
  );
}
