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

let loading: Promise<typeof Monaco> | undefined;

/** Loads Monaco once, installs the worker, and defines both token themes. */
export function loadMonaco(): Promise<typeof Monaco> {
  loading ??= (async () => {
    const [{ default: EditorWorker }, monacoModule] = await Promise.all([
      import("monaco-editor/esm/vs/editor/editor.worker?worker"),
      // The package has no `main`, so its bare specifier is unresolvable outside the
      // browser resolver; the ESM entry is the same public editor API.
      import("monaco-editor/esm/vs/editor/editor.main.js"),
    ]);
    const monaco = monacoModule;
    self.MonacoEnvironment = {
      getWorker: () => new EditorWorker(),
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
  })();
  return loading;
}
