import { useEffect, useRef, useState } from "react";
import type * as Monaco from "monaco-editor";
import { menuForShortcut, useContextMenu, type MenuItem } from "./ContextMenu.js";
import { editorThemeFor, languageFor, loadMonaco } from "./monaco.js";
import type { Theme } from "./theme.js";

export interface EditorSelection {
  path: string;
  text: string;
  /** 1-based, as Monaco reports them. */
  from: number;
  to: number;
}

export interface MonacoEditorProps {
  path: string;
  value: string;
  theme: Theme;
  onChange: (value: string) => void;
  /** Quotes the selection into a chat; omitted where there is no chat to quote into. */
  onAddSelection?: ((selection: EditorSelection) => void) | undefined;
}

/** Mounts one Monaco model per path; the parent owns the text and the save action. */
export function MonacoEditor({ path, value, theme, onChange, onAddSelection }: MonacoEditorProps) {
  const menu = useContextMenu();
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
    // A failure belongs to the path that caused it; a new mount starts clean.
    setFailure(undefined);
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
            // The renderer draws its own menu, so Monaco's would be a second, unstyled one.
            contextmenu: false,
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

  /** The current selection, read when the menu opens rather than on every keystroke. */
  const readSelection = (): EditorSelection => {
    const instance = editor.current;
    const model = instance?.getModel() ?? null;
    const selection = instance?.getSelection() ?? null;
    if (model === null || selection === null) return { path, text: "", from: 1, to: 1 };
    return {
      path,
      text: model.getValueInRange(selection),
      from: selection.startLineNumber,
      to: selection.endLineNumber,
    };
  };

  const selectionItems = (selection: EditorSelection): MenuItem[] => {
    const empty = selection.text.trim() === "";
    return [
      {
        kind: "item",
        id: "copy-selection",
        label: "Copy",
        ...(empty ? { disabled: "Select some text first" } : {}),
        run: () => void navigator.clipboard?.writeText(selection.text).catch(() => undefined),
      },
      ...(onAddSelection === undefined
        ? []
        : [
            {
              kind: "item" as const,
              id: "add-to-chat",
              label: "Add to chat",
              ...(empty ? { disabled: "Select some text first" } : {}),
              run: () => onAddSelection(selection),
            },
          ]),
    ];
  };

  return (
    <div
      className="editor-host"
      onContextMenu={(event) => {
        event.preventDefault();
        menu.open(selectionItems(readSelection()), { x: event.clientX, y: event.clientY }, { element: event.currentTarget });
      }}
      onKeyDown={(event) => {
        if (menuForShortcut(event) === undefined) return;
        event.preventDefault();
        menu.openFor(selectionItems(readSelection()), { element: event.currentTarget });
      }}
    >
      {failure === undefined ? null : <p role="alert">{failure}</p>}
      <div data-testid="monaco-host" ref={host} className="editor-surface" />
    </div>
  );
}
