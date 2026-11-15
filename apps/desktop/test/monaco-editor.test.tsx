import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MonacoEditor } from "../src/renderer/MonacoEditor.js";
import { ContextMenuProvider } from "../src/renderer/ContextMenu.js";
import { languageFor, loadMonaco } from "../src/renderer/monaco.js";

vi.mock("../src/renderer/monaco.js", () => ({
  languageFor: vi.fn(() => "typescript"),
  editorThemeFor: vi.fn(() => "noir-paper"),
  loadMonaco: vi.fn(),
}));

function makeMonaco() {
  let listener: (() => void) | undefined;
  const model = {
    getValue: vi.fn(() => "seed"),
    setValue: vi.fn(),
    getValueInRange: vi.fn(() => "const a = 1;"),
    dispose: vi.fn(),
  };
  const editor = {
    onDidChangeModelContent: vi.fn((next: () => void) => {
      listener = next;
      return { dispose: vi.fn() };
    }),
    getValue: vi.fn(() => "typed"),
    getModel: vi.fn(() => model),
    getSelection: vi.fn(() => ({ startLineNumber: 2, endLineNumber: 4 })),
    hasTextFocus: vi.fn(() => false),
    updateOptions: vi.fn(),
    dispose: vi.fn(),
  };
  const monaco = {
    editor: { createModel: vi.fn(() => model), create: vi.fn(() => editor) },
  };
  return {
    monaco,
    model,
    editor,
    fireChange: () => listener?.(),
  };
}

describe("MonacoEditor", () => {
  it("owns one model per path, publishes changes, and disposes model after editor", async () => {
    const fake = makeMonaco();
    vi.mocked(loadMonaco).mockResolvedValue(fake.monaco as never);
    const onChange = vi.fn();
    const { unmount } = render(
      <MonacoEditor path="src/main.ts" value="hello" theme="paper" onChange={onChange} />,
    );

    expect(screen.getByTestId("monaco-host")).toBeTruthy();
    await waitFor(() => expect(fake.editor.onDidChangeModelContent).toHaveBeenCalled());

    expect(languageFor).toHaveBeenCalledWith("src/main.ts");
    expect(fake.monaco.editor.createModel).toHaveBeenCalledWith("hello", "typescript");
    expect(fake.monaco.editor.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ model: fake.model, automaticLayout: true }),
    );

    act(() => fake.fireChange());
    expect(onChange).toHaveBeenCalledWith("typed");

    unmount();
    expect(fake.editor.dispose).toHaveBeenCalledTimes(1);
    expect(fake.model.dispose).toHaveBeenCalledTimes(1);
    expect(fake.editor.dispose.mock.invocationCallOrder[0] ?? 0).toBeLessThan(
      fake.model.dispose.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("shows the load failure instead of throwing", async () => {
    vi.mocked(loadMonaco).mockRejectedValue(new Error("worker unavailable"));
    render(<MonacoEditor path="a.ts" value="" theme="ink" onChange={() => undefined} />);

    expect((await screen.findByRole("alert")).textContent).toBe("worker unavailable");
  });

  it("adds the selection to a chat from the editor menu", async () => {
    const fake = makeMonaco();
    vi.mocked(loadMonaco).mockResolvedValue(fake.monaco as never);
    const onAddSelection = vi.fn();
    render(
      <ContextMenuProvider>
        <MonacoEditor
          path="src/main.ts"
          value="hello"
          theme="paper"
          onChange={() => undefined}
          onAddSelection={onAddSelection}
        />
      </ContextMenuProvider>,
    );
    await waitFor(() => expect(fake.editor.onDidChangeModelContent).toHaveBeenCalled());

    const host = screen.getByTestId("monaco-host").parentElement;
    expect(host).not.toBeNull();
    fireEvent.contextMenu(host as HTMLElement);
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Copy", "Add to chat"]);

    await userEvent.click(screen.getByRole("menuitem", { name: "Add to chat" }));
    expect(onAddSelection).toHaveBeenCalledWith({ path: "src/main.ts", text: "const a = 1;", from: 2, to: 4 });

    // An empty selection still gets a menu, with the reason it can do nothing.
    fake.model.getValueInRange.mockReturnValue("   ");
    fireEvent.contextMenu(host as HTMLElement);
    expect(screen.getByRole("menuitem", { name: "Copy" }).getAttribute("title")).toBe("Select some text first");
  });
});
