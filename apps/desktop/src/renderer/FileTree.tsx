import { useEffect, useRef, useState } from "react";
import type { FsEntry as Entry, FsListResult as Listing } from "@noir/protocol";
import type { RequestFn } from "./api.js";
import { menuForShortcut, useContextMenu, type MenuItem } from "./ContextMenu.js";
import { previewKind } from "./preview/kind.js";

interface Failure {
  path: string;
  message: string;
}

export interface FileTreeProps {
  request: RequestFn;
  workspaceId: string;
  activePath?: string | undefined;
  onOpenFile: (path: string) => void;
  /** Opens a previewable file in the artifact tab; the row's default action is unchanged. */
  onPreviewFile?: ((path: string) => void) | undefined;
  /** Opens the file's diff tab. */
  onDiffFile?: ((path: string) => void) | undefined;
  /** Reveals the entry in the OS file manager; omitted in a browser build. */
  onReveal?: ((path: string) => void) | undefined;
}

/** Names the failing directory in the alert so a nested failure is identifiable. */
function describeFailure(path: string, cause: unknown): string {
  const detail = cause instanceof Error ? cause.message : "Could not read the directory";
  if (path === "") return detail;
  return `${path.slice(path.lastIndexOf("/") + 1)}: ${detail}`;
}

/** Lazily expanded tree over `fs.list`; expansions and listings are cached for the mount. */
export function FileTree({ request, workspaceId, activePath, onOpenFile, onPreviewFile, onDiffFile, onReveal }: FileTreeProps) {
  const menu = useContextMenu();
  const [listings, setListings] = useState<Record<string, Listing>>({});
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<Failure | undefined>(undefined);
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
        setListings((listings) => ({ ...listings, [path]: listing }));
        // Only clear the alert raised by this path; a sibling's success says nothing about it.
        setError((failure) => (failure?.path === path ? undefined : failure));
      },
      (cause: unknown) => {
        if (current !== generation.current) return;
        // Drop the marker so a later expand retries, and roll the directory back to collapsed.
        requested.current.delete(path);
        setExpanded((expanded) => {
          if (!expanded.has(path)) return expanded;
          const next = new Set(expanded);
          next.delete(path);
          return next;
        });
        setError({ path, message: describeFailure(path, cause) });
      },
    );
  };

  const retryRoot = (): void => {
    requested.current.delete("");
    load("");
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
    const next = new Set(expanded);
    const shouldLoad = !next.has(path);
    if (shouldLoad) next.add(path);
    else next.delete(path);
    setExpanded(next);
    if (shouldLoad) load(path);
  };

  const rows: Array<{ entry: Entry; depth: number }> = [];
  const walk = (path: string, depth: number): void => {
    for (const entry of listings[path]?.entries ?? []) {
      rows.push({ entry, depth });
      if (entry.kind === "dir" && expanded.has(entry.path)) walk(entry.path, depth + 1);
    }
  };
  walk("", 0);

  const open = (entry: Entry): void => {
    if (entry.kind === "dir") {
      toggle(entry.path);
      return;
    }
    // Monaco cannot render a PDF, so a PDF row's default action is its preview.
    if (previewKind(entry.path) === "pdf" && onPreviewFile !== undefined) {
      onPreviewFile(entry.path);
      return;
    }
    onOpenFile(entry.path);
  };

  const itemsFor = (entry: Entry): MenuItem[] => [
    {
      kind: "item",
      id: "open",
      label: entry.kind === "dir" ? (expanded.has(entry.path) ? "Collapse" : "Expand") : "Open",
      run: () => open(entry),
    },
    ...(entry.kind === "file" && onDiffFile !== undefined
      ? [{ kind: "item" as const, id: "diff", label: "Diff", run: () => onDiffFile(entry.path) }]
      : []),
    {
      kind: "item",
      id: "copy-path",
      label: "Copy path",
      run: () => void navigator.clipboard?.writeText(entry.path).catch(() => undefined),
    },
    ...(onReveal === undefined
      ? []
      : [{ kind: "item" as const, id: "reveal", label: "Reveal in Explorer", run: () => onReveal(entry.path) }]),
  ];

  return (
    <section aria-label="Files" className="file-tree">
      <h3>Files</h3>
      {error === undefined ? null : (
        <p role="alert" className="file-tree-alert">
          <span>{error.message}</span>
          {error.path === "" ? (
            <button type="button" onClick={retryRoot}>
              Retry
            </button>
          ) : null}
        </p>
      )}
      <ul role="tree" aria-label="Workspace files">
        {rows.map(({ entry, depth }) => (
          <li
            key={entry.path}
            role="treeitem"
            aria-selected={entry.path === activePath}
            aria-expanded={entry.kind === "dir" ? expanded.has(entry.path) : undefined}
            aria-level={depth + 1}
            tabIndex={0}
            data-depth={Math.min(depth, 6)}
            onClick={() => open(entry)}
            onContextMenu={(event) => {
              event.preventDefault();
              menu.open(itemsFor(entry), { x: event.clientX, y: event.clientY }, { element: event.currentTarget });
            }}
            onKeyDown={(event) => {
              // A menu chord works from the row or from the Preview button inside it.
              if (menuForShortcut(event) !== undefined) {
                event.preventDefault();
                menu.openFor(itemsFor(entry), { element: event.currentTarget });
                return;
              }
              // The Preview button is a descendant; its own Enter must not also open the row.
              if (event.target !== event.currentTarget) return;
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              open(entry);
            }}
          >
            <span className="file-kind" aria-hidden="true">
              {entry.kind === "dir" ? (expanded.has(entry.path) ? "▾" : "▸") : "·"}
            </span>
            <span className="file-name">{entry.name}</span>
            {onPreviewFile !== undefined && entry.kind === "file" && previewKind(entry.path) !== undefined ? (
              <button
                type="button"
                className="link"
                aria-label={`Preview ${entry.path}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onPreviewFile(entry.path);
                }}
              >
                Preview
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {listings[""]?.truncated === true ? (
        <p className="file-tree-note">Showing the first 2,000 entries</p>
      ) : null}
    </section>
  );
}
