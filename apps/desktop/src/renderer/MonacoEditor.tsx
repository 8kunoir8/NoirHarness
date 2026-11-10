import { useEffect, useRef, useState } from "react";
import type * as Monaco from "monaco-editor";
import { editorThemeFor, languageFor, loadMonaco } from "./monaco.js";
import type { Theme } from "./theme.js";

export interface MonacoEditorProps {
  path: string;
  value: string;
  theme: Theme;
  onChange: (value: string) => void;
}

/** Mounts one Monaco model per path; the parent owns the text and the save action. */
export function MonacoEditor({ path, value, theme, onChange }: MonacoEditorProps) {
  const host = useRef<HTMLDivElement | null>(null);
  const editor = useRef<Monaco.editor.IStandaloneCodeEditor | undefined>(undefined);
  const latest = useRef(onChange);
  const latestValue = useRef(value);
  const latestTheme = useRef(theme);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  latest.current = onChange;
  latestValue.current = value;
  latestTheme.current = theme;

  useEffect(() => {
    const element = host.current;
    if (element === null) return;
    let disposed = false;
    let subscription: Monaco.IDisposable | undefined;
    let model: Monaco.editor.ITextModel | undefined;
    void loadMonaco().then(
      (monaco) => {
        if (disposed) return;
        try {
          // The model outlives `editor.create`; it is disposed by hand in the cleanup below.
          model = monaco.editor.createModel(latestValue.current, languageFor(path));
          const instance = monaco.editor.create(element, {
            model,
            theme: editorThemeFor(latestTheme.current),
            automaticLayout: true,
            minimap: { enabled: false },
            fontSize: 13,
            scrollBeyondLastLine: false,
          });
          subscription = instance.onDidChangeModelContent(() => latest.current(instance.getValue()));
          editor.current = instance;
        } catch (error: unknown) {
          model?.dispose();
          model = undefined;
          setFailure(error instanceof Error ? error.message : "Editor failed to start");
        }
      },
      (error: unknown) => {
        if (disposed) return;
        setFailure(error instanceof Error ? error.message : "Editor failed to load");
      },
    );
    return () => {
      disposed = true;
      subscription?.dispose();
      editor.current?.dispose();
      editor.current = undefined;
      model?.dispose();
      model = undefined;
    };
  }, [path]);

  useEffect(() => {
    editor.current?.updateOptions({ theme: editorThemeFor(theme) });
  }, [theme]);

  // Adopt an externally loaded document (a fresh read) without fighting the typist.
  useEffect(() => {
    const instance = editor.current;
    if (instance === undefined) return;
    const model = instance.getModel();
    if (model !== null && model.getValue() !== value && !instance.hasTextFocus()) model.setValue(value);
  }, [value]);

  return (
    <div className="editor-host">
      {failure === undefined ? null : <p role="alert">{failure}</p>}
      <div data-testid="monaco-host" ref={host} className="editor-surface" />
    </div>
  );
}
