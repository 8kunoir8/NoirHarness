import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CommandPalette } from "../src/renderer/CommandPalette.js";

const appApi = vi.hoisted(() => ({
  connect: vi.fn(async (_listener?: unknown) => undefined),
  offEvent: vi.fn((_listener?: unknown) => undefined),
  request: vi.fn<(method: string, params?: unknown) => Promise<unknown>>(async () => {
    throw new Error("unmocked request");
  }),
}));
vi.mock("../src/renderer/api.js", () => appApi);

import { App } from "../src/renderer/App.js";
import {
  commandForEvent,
  filterCommands,
  isTypingTarget,
  matchesShortcut,
  shortcutLabel,
  type Command,
} from "../src/renderer/commands.js";

function command(patch: Partial<Command> & Pick<Command, "id" | "label">): Command {
  return { enabled: true, run: () => undefined, ...patch };
}

const commands: Command[] = [
  command({ id: "new-chat", label: "New chat", shortcut: { key: "n", mod: true }, keywords: "create" }),
  command({ id: "interrupt", label: "Interrupt the running turn", shortcut: { key: ".", mod: true }, allowInInput: true }),
  command({ id: "close", label: "Close chat tab", shortcut: { key: "w", mod: true }, enabled: false }),
  command({ id: "copy", label: "Copy session id", keywords: "clipboard" }),
];

function keydown(init: KeyboardEventInit, target?: EventTarget): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { cancelable: true, ...init });
  if (target !== undefined) Object.defineProperty(event, "target", { value: target });
  return event;
}

describe("shortcuts", () => {
  it("matches modifiers exactly", () => {
    const shortcut = { key: "b", mod: true } as const;
    expect(matchesShortcut(keydown({ key: "b", metaKey: true }), shortcut)).toBe(true);
    expect(matchesShortcut(keydown({ key: "b", ctrlKey: true }), shortcut)).toBe(true);
    expect(matchesShortcut(keydown({ key: "B", metaKey: true }), shortcut)).toBe(true);
    expect(matchesShortcut(keydown({ key: "b" }), shortcut)).toBe(false);
    expect(matchesShortcut(keydown({ key: "b", metaKey: true, shiftKey: true }), { key: "b", mod: true, shift: true })).toBe(true);
    expect(shortcutLabel({ key: "k", mod: true, shift: true })).toBe("⌘⇧K");
  });

  it("dispatches the first enabled match and skips typing targets unless allowed", () => {
    const input = document.createElement("input");
    expect(commandForEvent(commands, keydown({ key: "w", metaKey: true }), document.body)).toBeUndefined();
    expect(commandForEvent(commands, keydown({ key: "n", metaKey: true }), document.body)?.id).toBe("new-chat");

    expect(isTypingTarget(input)).toBe(true);
    expect(commandForEvent(commands, keydown({ key: "n", metaKey: true }), input)).toBeUndefined();
    expect(commandForEvent(commands, keydown({ key: ".", metaKey: true }), input)?.id).toBe("interrupt");
  });

  it("filters on label and keywords with every token required", () => {
    expect(filterCommands(commands, "").map((entry) => entry.id)).toEqual(["new-chat", "interrupt", "close", "copy"]);
    expect(filterCommands(commands, "close tab").map((entry) => entry.id)).toEqual(["close"]);
    expect(filterCommands(commands, "clipboard").map((entry) => entry.id)).toEqual(["copy"]);
    expect(filterCommands(commands, "interrupt clipboard")).toEqual([]);
  });
});

describe("CommandPalette", () => {
  it("navigates with arrows, runs with Enter, and closes on Esc", async () => {
    const user = userEvent.setup();
    const onRun = vi.fn();
    const onClose = vi.fn();
    render(<CommandPalette commands={commands} onRun={onRun} onClose={onClose} />);

    await user.type(screen.getByLabelText("Command"), "turn");
    expect(screen.queryByTestId("palette-new-chat")).toBeNull();
    await user.keyboard("{Enter}");
    expect(onRun).toHaveBeenCalledWith(expect.objectContaining({ id: "interrupt" }));

    onRun.mockClear();
    await user.clear(screen.getByLabelText("Command"));
    await user.keyboard("{ArrowDown}{Enter}");
    expect(onRun).toHaveBeenCalledWith(expect.objectContaining({ id: "interrupt" }));

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("opens an artifact preview from the preview command", async () => {
    const user = userEvent.setup();
    appApi.request.mockImplementation(async (method: string): Promise<unknown> => {
      switch (method) {
        case "system.health":
          return { status: "ok", pid: 1, engineDir: "engine" };
        case "project.list":
          return { projects: [] };
        case "workspace.list":
          return { workspaces: [{ id: "w1", projectId: "p1", path: "C:/ws", branch: null, kind: "git", status: "clean" }] };
        case "model.list":
          return {
            models: [
              {
                id: "m1",
                providerId: "pr1",
                modelId: "mock-1",
                displayName: "Mock",
                contextWindow: 200_000,
                maxTokens: null,
                enabled: true,
                createdAt: 1,
                engine: "acp",
              },
            ],
          };
        case "session.list":
          return { sessions: [] };
        case "fs.files":
          return { files: ["notes.md", "src/main.ts"], truncated: false };
        default:
          throw new Error(method);
      }
    });

    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Commands" }));
    await user.type(await screen.findByLabelText("Command"), "preview");
    await user.click(screen.getByTestId("palette-preview-file"));

    expect(await screen.findByRole("combobox", { name: "Preview file" })).toBeTruthy();
    expect(await screen.findByText("notes.md")).toBeTruthy();
    expect(screen.queryByText("src/main.ts")).toBeNull();

    await user.click(screen.getByText("notes.md"));

    const tab = await screen.findByRole("tab", { name: "notes.md" });
    expect(tab.closest(".tab")?.getAttribute("data-kind")).toBe("preview");
    expect(screen.queryByRole("combobox", { name: "Preview file" })).toBeNull();
  });

  it("refuses disabled commands", async () => {
    const user = userEvent.setup();
    const onRun = vi.fn();
    render(<CommandPalette commands={commands} onRun={onRun} onClose={() => undefined} />);

    await user.type(screen.getByLabelText("Command"), "close");
    expect(screen.getByTestId("palette-close").getAttribute("aria-disabled")).toBe("true");
    await user.keyboard("{Enter}");
    expect(onRun).not.toHaveBeenCalled();
  });
});
