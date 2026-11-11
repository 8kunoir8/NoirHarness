import { useEffect, useRef, useState } from "react";
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import type * as PdfJsModule from "pdfjs-dist/legacy/build/pdf.mjs";
import { base64ToBytes } from "./bytes.js";

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;
const ZOOM_STEP = 0.25;
const RESIZE_DEBOUNCE_MS = 150;
/** Horizontal breathing room in the scroll pane; fit width subtracts it from the pane. */
const PANE_PADDING = 32;

type PdfJs = typeof PdfJsModule;
type PdfStatus = "loading" | "ready" | "error";

let loading: Promise<PdfJs> | undefined;

/**
 * Both imports stay dynamic: pdf.js is ~1 MB and must not sit in the entry chunk. The worker
 * is a Vite `?url` asset (hashed into `dist/renderer/assets`), because a runtime
 * `new URL("pdfjs-dist/…", import.meta.url)` cannot resolve a bare package path.
 *
 * The legacy build ships the polyfills pdf.js needs on this Electron's Chromium; the regular
 * build calls `Map.prototype.getOrInsertComputed`, which is missing there and aborts rendering.
 */
function loadPdfJs(): Promise<PdfJs> {
  loading ??= (async () => {
    const [pdfjs, worker] = await Promise.all([
      import("pdfjs-dist/legacy/build/pdf.mjs"),
      import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url"),
    ]);
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
    return pdfjs;
  })().catch((cause: unknown) => {
    // A failed import must not poison later attempts, including Reload.
    loading = undefined;
    throw cause;
  });
  return loading;
}

function errorMessage(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  return message === "" ? "Unknown error" : message;
}

export interface PdfArtifactProps {
  base64: string;
}

export function PdfArtifact({ base64 }: PdfArtifactProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const docRef = useRef<PDFDocumentProxy | null>(null);
  const loadingTaskRef = useRef<PDFDocumentLoadingTask | null>(null);
  const renderTaskRef = useRef<RenderTask | null>(null);

  const [status, setStatus] = useState<PdfStatus>("loading");
  const [message, setMessage] = useState("");
  const [renderError, setRenderError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [pageCount, setPageCount] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [fit, setFit] = useState(false);
  const [paneWidth, setPaneWidth] = useState(0);

  useEffect(() => {
    let live = true;
    setStatus("loading");
    setMessage("");
    setRenderError(null);
    setPage(1);
    setPageCount(0);

    loadPdfJs()
      .then((pdfjs) => {
        if (!live) return null;
        const loadingTask = pdfjs.getDocument({ data: base64ToBytes(base64) });
        loadingTaskRef.current = loadingTask;
        return loadingTask.promise;
      })
      .then((document) => {
        if (!live || document === null) return;
        docRef.current = document;
        setPageCount(document.numPages);
        setStatus("ready");
      })
      .catch((cause: unknown) => {
        if (!live) return;
        setStatus("error");
        setMessage(errorMessage(cause));
      });

    return () => {
      live = false;
      renderTaskRef.current?.cancel();
      renderTaskRef.current = null;
      // v6 exposes teardown on the loading task, which also stops the worker.
      const loadingTask = loadingTaskRef.current;
      loadingTaskRef.current = null;
      docRef.current = null;
      void loadingTask?.destroy().catch(() => {});
    };
  }, [base64]);

  useEffect(() => {
    if (status !== "ready") return;
    const element = scrollRef.current;
    if (element === null) return;
    const measure = (): void => setPaneWidth(element.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(measure, RESIZE_DEBOUNCE_MS);
    });
    observer.observe(element);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [status]);

  useEffect(() => {
    if (status !== "ready") return;
    const document = docRef.current;
    const canvas = canvasRef.current;
    if (document === null || canvas === null) return;
    let live = true;
    let task: RenderTask | undefined;
    // A render failure is per page/zoom, not per document: this run retries it.
    setRenderError(null);

    void (async () => {
      const pdfPage = await document.getPage(page);
      if (!live) return;
      const unscaled = pdfPage.getViewport({ scale: 1 });
      const scale =
        fit && paneWidth > 0
          ? Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, (paneWidth - PANE_PADDING) / unscaled.width))
          : zoom;
      const viewport = pdfPage.getViewport({ scale });
      const ratio = window.devicePixelRatio || 1;
      // The bitmap grows with the device pixel ratio while the CSS box keeps the logical
      // size, so the page stays crisp on HiDPI screens.
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;

      renderTaskRef.current?.cancel();
      task = pdfPage.render({
        canvas,
        viewport,
        transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
      });
      renderTaskRef.current = task;
      await task.promise;
    })().catch((cause: unknown) => {
      // Cancelling the previous page rejects its task; that is expected, not an error.
      if (!live || (cause instanceof Error && cause.name === "RenderingCancelledException")) return;
      setRenderError(errorMessage(cause));
    });

    return () => {
      live = false;
      task?.cancel();
      if (renderTaskRef.current === task) renderTaskRef.current = null;
    };
  }, [status, page, zoom, fit, paneWidth]);

  // Document and render failures share one panel; only the document failure drops the pane.
  const failure = status === "error" ? message : renderError;

  return (
    <section className="artifact-pdf">
      <div className="pdf-toolbar">
        <button
          type="button"
          className="pdf-button"
          aria-label="Previous page"
          disabled={page <= 1}
          onClick={() => setPage((current) => Math.max(1, current - 1))}
        >
          ‹
        </button>
        <span className="pdf-page">{`${page} / ${pageCount === 0 ? "?" : pageCount}`}</span>
        <button
          type="button"
          className="pdf-button"
          aria-label="Next page"
          disabled={pageCount === 0 || page >= pageCount}
          onClick={() => setPage((current) => Math.min(pageCount, current + 1))}
        >
          ›
        </button>
        <span className="pdf-divider" aria-hidden="true" />
        <button
          type="button"
          className="pdf-button"
          aria-label="Zoom out"
          disabled={!fit && zoom <= ZOOM_MIN}
          onClick={() => {
            setFit(false);
            setZoom((current) => Math.max(ZOOM_MIN, current - ZOOM_STEP));
          }}
        >
          −
        </button>
        <button
          type="button"
          className="pdf-button"
          aria-label="Zoom in"
          disabled={!fit && zoom >= ZOOM_MAX}
          onClick={() => {
            setFit(false);
            setZoom((current) => Math.min(ZOOM_MAX, current + ZOOM_STEP));
          }}
        >
          +
        </button>
        <button
          type="button"
          className="pdf-button"
          aria-label="Fit width"
          aria-pressed={fit}
          onClick={() => setFit((current) => !current)}
        >
          Fit width
        </button>
      </div>
      {status === "loading" ? (
        <p className="empty">Loading PDF…</p>
      ) : (
        <>
          {failure !== null ? (
            <div role="alert" className="artifact-error pdf-error">
              <p className="pdf-error-title">Could not read PDF</p>
              {failure.split("\n").map((line, index) => (
                <p key={index} className="pdf-error-detail">
                  {line}
                </p>
              ))}
            </div>
          ) : null}
          {status === "ready" ? (
            <div className="pdf-scroll" ref={scrollRef}>
              <canvas ref={canvasRef} className="pdf-canvas" role="img" aria-label={`PDF page ${page}`} />
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
