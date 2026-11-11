export type PreviewKind = "markdown" | "csv" | "pdf";

const KINDS: Record<string, PreviewKind> = {
  ".md": "markdown",
  ".markdown": "markdown",
  ".csv": "csv",
  ".tsv": "csv",
  ".pdf": "pdf",
};

/** Lowercase extension lookup; `undefined` means "not previewable", not "unknown file". */
export function previewKind(path: string): PreviewKind | undefined {
  const dot = path.lastIndexOf(".");
  return dot === -1 ? undefined : KINDS[path.slice(dot).toLowerCase()];
}
