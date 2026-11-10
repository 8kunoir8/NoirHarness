import type * as Monaco from "monaco-editor";

const EXTENSIONS: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  md: "markdown",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  c: "c",
  h: "c",
  cpp: "cpp",
  cs: "csharp",
  yml: "yaml",
  yaml: "yaml",
  sh: "shell",
  bash: "shell",
  ps1: "powershell",
  css: "css",
  scss: "scss",
  html: "html",
  xml: "xml",
  sql: "sql",
  toml: "ini",
};

export function languageFor(path: string): string {
  const name = path.split("/").at(-1) ?? path;
  const extension = name.includes(".") ? name.split(".").at(-1) ?? "" : "";
  return EXTENSIONS[extension.toLowerCase()] ?? "plaintext";
}

export function editorThemeFor(theme: "paper" | "ink"): string {
  return theme === "ink" ? "noir-ink" : "noir-paper";
}

type WorkerModule = { default: new () => Worker };
type WorkerLoader = () => Promise<WorkerModule>;

// Each language service runs in its own worker; a single editor worker makes the language
// features (completions, diagnostics, formatting) fail with unknown-method errors.
// These imports stay dynamic: Vite must emit one lazy chunk per worker instead of pulling every
// language service into the startup bundle, and the specifier is fixed at build time.
const editorWorker: WorkerLoader = () => import("monaco-editor/esm/vs/editor/editor.worker.js?worker");
const tsWorker: WorkerLoader = () => import("monaco-editor/esm/vs/language/typescript/ts.worker.js?worker");
const cssWorker: WorkerLoader = () => import("monaco-editor/esm/vs/language/css/css.worker.js?worker");
const htmlWorker: WorkerLoader = () => import("monaco-editor/esm/vs/language/html/html.worker.js?worker");
const jsonWorker: WorkerLoader = () => import("monaco-editor/esm/vs/language/json/json.worker.js?worker");

/** The worker bundle that owns a Monaco language service label. */
export type WorkerKind = "ts" | "css" | "html" | "json" | "editor";

const WORKER_KIND_BY_LABEL: Readonly<Partial<Record<string, WorkerKind>>> = {
  typescript: "ts",
  javascript: "ts",
  css: "css",
  scss: "css",
  less: "css",
  html: "html",
  handlebars: "html",
  razor: "html",
  json: "json",
};

export function workerKindFor(label: string): WorkerKind {
  return WORKER_KIND_BY_LABEL[label] ?? "editor";
}

const WORKER_LOADERS: Record<WorkerKind, WorkerLoader> = {
  ts: tsWorker,
  css: cssWorker,
  html: htmlWorker,
  json: jsonWorker,
  editor: editorWorker,
};

let loading: Promise<typeof Monaco> | undefined;

/** Loads Monaco once, installs the worker, and defines both token themes. */
export function loadMonaco(): Promise<typeof Monaco> {
  loading ??= (async () => {
    // The package has no `main`, so its bare specifier is unresolvable outside the browser
    // resolver; the ESM entry is the same public editor API.
    const monaco = await import("monaco-editor/esm/vs/editor/editor.main.js");
    self.MonacoEnvironment = {
      // Loaded on the first request per language, so opening a plain markdown file never downloads
      // the TypeScript service.
      getWorker: async (_workerId: string, label: string) => {
        const { default: WorkerClass } = await WORKER_LOADERS[workerKindFor(label)]();
        return new WorkerClass();
      },
    };
    monaco.editor.defineTheme("noir-paper", {
      base: "vs",
      inherit: true,
      rules: [],
      colors: { "editor.background": "#fbf9f5", "editor.lineHighlightBackground": "#f0ece4" },
    });
    monaco.editor.defineTheme("noir-ink", {
      base: "vs-dark",
      inherit: true,
      rules: [],
      colors: { "editor.background": "#16161a", "editor.lineHighlightBackground": "#1f1f25" },
    });
    return monaco;
  })().catch((error: unknown) => {
    // A transient load failure must not brick the editor for the rest of the session.
    loading = undefined;
    throw error;
  });
  return loading;
}
