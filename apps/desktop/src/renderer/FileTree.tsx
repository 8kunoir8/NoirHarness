import { useEffect, useRef, useState } from "react";
import type { RequestFn } from "./api.js";

interface Entry {
  name: string;
  path: string;
  kind: "file" | "dir";
  size: number;
}

interface Listing {
  entries: Entry[];
  truncated: boolean;
}

export interface FileTreeProps {
  request: RequestFn;
  workspaceId: string;
  activePath?: string | undefined;
  onOpenFile: (path: string) => void;
}

/** Lazily expanded tree over `fs.list`; expansions and listings are cached for the mount. */
export function FileTree({ request, workspaceId, activePath, onOpenFile }: FileTreeProps) {
  const [listings, setListings] = useState<Record<string, Listing>>({});
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | undefined>(undefined);
  // Paths already requested (or in flight) for the current workspace; survives re-renders so a
  // second expand does not hit the kernel twice, and is reset when the workspace changes.
  const requested = useRef(new Set<string>());
  const generation = useRef(0);

  const load = (path: string): void => {
    if (requested.current.has(path)) return;
    requested.current.add(path);
    const current = generation.current;
    void request<Listing>("fs.list", { workspaceId, path }).then(
      (listing) => {
        if (current !== generation.current) return;
        setError(undefined);
        setListings((listings) => ({ ...listings, [path]: listing }));
      },
      (cause: unknown) => {
        if (current !== generation.current) return;
        // Drop the marker so a later expand can retry, and surface the failure inline.
        requested.current.delete(path);
        setError(cause instanceof Error ? cause.message : "Could not read the directory");
      },
    );
  };

  useEffect(() => {
    generation.current += 1;
    requested.current = new Set();
    setListings({});
    setExpanded(new Set());
    setError(undefined);
    load("");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload only when the workspace changes
  }, [workspaceId]);

  const toggle = (path: string): void => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else {
        next.add(path);
        load(path);
      }
      return next;
    });
  };

  const rows: Array<{ entry: Entry; depth: number }> = [];
  const walk = (path: string, depth: number): void => {
    for (const entry of listings[path]?.entries ?? []) {
      rows.push({ entry, depth });
      if (entry.kind === "dir" && expanded.has(entry.path)) walk(entry.path, depth + 1);
    }
  };
  walk("", 0);

  return (
    <section aria-label="Files" className="file-tree">
      <h3>Files</h3>
      {error === undefined ? null : <p role="alert">{error}</p>}
      <ul role="tree" aria-label="Workspace files">
        {rows.map(({ entry, depth }) => (
          <li
            key={entry.path}
            role="treeitem"
            aria-selected={entry.path === activePath}
            aria-expanded={entry.kind === "dir" ? expanded.has(entry.path) : undefined}
            tabIndex={0}
            data-depth={depth}
            onClick={() => (entry.kind === "dir" ? toggle(entry.path) : onOpenFile(entry.path))}
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              if (entry.kind === "dir") toggle(entry.path);
              else onOpenFile(entry.path);
            }}
          >
            <span className="file-kind" aria-hidden="true">
              {entry.kind === "dir" ? (expanded.has(entry.path) ? "▾" : "▸") : "·"}
            </span>
            {entry.name}
          </li>
        ))}
      </ul>
    </section>
  );
}
