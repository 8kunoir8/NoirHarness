import { useEffect, useState } from "react";
import type { ArtifactReadResult } from "@noir/protocol";
import type { RequestFn } from "../api.js";
import { CsvArtifact } from "./CsvArtifact.js";
import { MarkdownArtifact } from "./MarkdownArtifact.js";
import { PdfArtifact } from "./PdfArtifact.js";
import { previewKind } from "./kind.js";
import "./preview.css";

type PreviewState =
  | { status: "loading" }
  | { status: "ready"; result: ArtifactReadResult }
  | { status: "error"; message: string };

export interface ArtifactPreviewProps {
  workspaceId: string;
  path: string;
  request: RequestFn;
  onOpenPath?: ((path: string) => void) | undefined;
}

export function ArtifactPreview({ workspaceId, path, request, onOpenPath }: ArtifactPreviewProps) {
  const [state, setState] = useState<PreviewState>({ status: "loading" });
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let live = true;
    setState({ status: "loading" });
    request<ArtifactReadResult>("artifact.read", { workspaceId, path })
      .then((result) => {
        if (live) setState({ status: "ready", result });
      })
      .catch((error: unknown) => {
        if (live) {
          setState({ status: "error", message: error instanceof Error ? error.message : "Could not read the file" });
        }
      });
    // JSON-RPC has no cancellation: ignore a reply whose tab unmounted or reloaded.
    return () => {
      live = false;
    };
  }, [request, workspaceId, path, reloadKey]);

  const kind = previewKind(path);

  return (
    <section aria-label={`Preview ${path}`} className="artifact-preview">
      <header className="artifact-header">
        <span className="artifact-path" title={path}>
          {path}
        </span>
        <button type="button" className="artifact-reload" onClick={() => setReloadKey((key) => key + 1)}>
          Reload
        </button>
      </header>
      {state.status === "loading" ? (
        <p className="empty">Loading {path}…</p>
      ) : state.status === "error" ? (
        <p role="alert" className="artifact-error">
          {state.message}
        </p>
      ) : (
        <>
          {state.result.truncated ? <p className="artifact-note">Showing the first 2 MB</p> : null}
          {kind === "markdown" ? (
            <MarkdownArtifact content={state.result.content} onOpenPath={onOpenPath} />
          ) : kind === "csv" ? (
            <CsvArtifact text={state.result.content} />
          ) : kind === "pdf" ? (
            <PdfArtifact base64={state.result.content} />
          ) : (
            <p className="empty">This file type cannot be previewed.</p>
          )}
        </>
      )}
    </section>
  );
}
