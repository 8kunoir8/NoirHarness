import { render, screen } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CommandPalette } from "../src/renderer/CommandPalette.js";

const appApi = vi.hoisted(() => ({
  connect: vi.fn(async (_listener?: unknown) => undefined),
  // The banner asks the window which build it is talking to; nothing here renders it.
  kernelInfo: vi.fn(async () => ({ port: 1, token: "t", buildMatches: true, daemon: true })),
  reportArmed: vi.fn(),
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

/** Markdown fixture with two anchored links; only `notes.md` has content. */
const NOTES_MARKDOWN = "[see](other.md#usage) and [pdf](doc.pdf#page=3)";

const MODEL = {
  id: "m1",
  providerId: "pr1",
  modelId: "mock-1",
  displayName: "Mock",
  contextWindow: 200_000,
  maxTokens: null,
  enabled: true,
  createdAt: 1,
  engine: "acp",
};

/** The smallest kernel surface `App` needs; anything unlisted rejects so a wrong call is visible. */
const SESSION = {
  id: "s1",
  workspaceId: "w1",
  agentId: "a1",
  engine: "acp",
  title: "Shell",
  status: "idle",
  modelId: null,
  scheduleId: null,
  createdAt: 1,
  lastEventSeq: 1,
  lastEventAt: 1,
  pendingApproval: false,
};

function stubApp({ models = [MODEL], sessions = [] }: { models?: readonly unknown[]; sessions?: readonly unknown[] } = {}): void {
  appApi.request.mockReset();
  // The list a reload sees is the list the kernel would have: a fork has to appear in it.
  const listed = [...sessions];
  appApi.request.mockImplementation(async (method: string, params?: unknown): Promise<unknown> => {
    switch (method) {
      case "system.health":
        return { status: "ok", pid: 1, engineDir: "engine" };
      case "project.list":
        return { projects: [] };
      case "workspace.list":
        return { workspaces: [{ id: "w1", projectId: "p1", path: "C:/ws", branch: null, kind: "git", status: "clean" }] };
      case "model.list":
        return { models };
      case "session.list":
        return { sessions: listed, total: listed.length, nextCursor: null };
      case "session.subscribe":
        return { events: [], lastSeq: 1 };
      case "session.fork": {
        const fork = { ...SESSION, id: "s2", title: "Fork of Shell" };
        listed.push(fork);
        return { session: fork, copiedEvents: 2 };
      }
      case "fs.files":
        return { files: ["notes.md", "other.md", "doc.pdf", "src/main.ts"], truncated: false };
      case "fs.list":
        return {
          entries: [
            { name: "notes.md", path: "notes.md", kind: "file", size: 32 },
            { name: "other.md", path: "other.md", kind: "file", size: 8 },
          ],
          truncated: false,
        };
      case "artifact.read": {
        const path = typeof params === "object" && params !== null && "path" in params ? params.path : "";
        return {
          encoding: "utf8",
          content: path === "notes.md" ? NOTES_MARKDOWN : "",
          size: 32,
          mtimeMs: 1,
          truncated: false,
        };
      }
      default:
        throw new Error(method);
    }
  });
}

/** Runs the palette's "Preview file…" command and waits for the filtered overlay. */
async function openPreviewOverlay(user: UserEvent): Promise<void> {
  await user.click(await screen.findByRole("button", { name: "Commands" }));
  await user.type(await screen.findByLabelText("Command"), "preview");
  await user.click(screen.getByTestId("palette-preview-file"));
  await screen.findByRole("combobox", { name: "Preview file" });
}

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

describe("App fork entry point", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("forks the open chat and lands in the copy", async () => {
    stubApp({ sessions: [SESSION] });
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: /Shell/ }));
    await user.click(await screen.findByRole("button", { name: "Commands" }));
    await user.type(await screen.findByLabelText("Command"), "fork");
    await user.click(screen.getByTestId("palette-fork-session"));

    expect(appApi.request).toHaveBeenCalledWith("session.fork", { sessionId: "s1" });
    expect(await screen.findByRole("tab", { name: "Fork of Shell" })).toBeTruthy();
  });
});

describe("App artifact entry points", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("opens an artifact from the preview command", async () => {
    stubApp();
    const user = userEvent.setup();
    render(<App />);

    await openPreviewOverlay(user);
    expect(await screen.findByRole("option", { name: "notes.md" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "src/main.ts" })).toBeNull();

    await user.click(screen.getByRole("option", { name: "notes.md" }));

    const tab = await screen.findByRole("tab", { name: "notes.md" });
    expect(tab.closest(".tab")?.getAttribute("data-kind")).toBe("preview");
    expect(screen.queryByRole("combobox", { name: "Preview file" })).toBeNull();
  });

  it("opens the overlay on the setup page and lands on a visible artifact", async () => {
    stubApp();
    const user = userEvent.setup();
    render(<App />);

    // The chats view (and its topbar Inspector button) appears once models are loaded.
    await screen.findByRole("button", { name: "Inspector" });
    await user.click(screen.getByRole("button", { name: "Setup" }));
    expect(await screen.findByRole("region", { name: "Providers" })).toBeTruthy();

    await openPreviewOverlay(user);
    await user.click(await screen.findByRole("option", { name: "notes.md" }));

    expect(await screen.findByRole("region", { name: "Preview notes.md" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Providers" })).toBeNull();
  });

  it("keeps the skills view when no model is configured", async () => {
    stubApp({ models: [] });
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Skills" }));
    expect(await screen.findByRole("region", { name: "Skills" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "File list" }));
    await user.click(await screen.findByRole("button", { name: "Preview notes.md" }));

    // The tab exists, but with no model there is no chats view to render it in: stay in Skills.
    expect(screen.getByRole("region", { name: "Skills" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Providers" })).toBeNull();
  });

  it("routes anchored markdown links to the artifact, not the editor", async () => {
    stubApp();
    const user = userEvent.setup();
    render(<App />);

    await openPreviewOverlay(user);
    await user.click(await screen.findByRole("option", { name: "notes.md" }));

    await user.click(await screen.findByText("see"));
    const other = await screen.findByRole("tab", { name: "other.md" });
    expect(other.closest(".tab")?.getAttribute("data-kind")).toBe("preview");
    expect(screen.queryByRole("region", { name: "Editor" })).toBeNull();

    await user.click(screen.getByRole("tab", { name: "notes.md" }));
    await user.click(await screen.findByText("pdf"));
    const pdf = await screen.findByRole("tab", { name: "doc.pdf" });
    expect(pdf.closest(".tab")?.getAttribute("data-kind")).toBe("preview");

    const paths = appApi.request.mock.calls.map(([, params]) =>
      typeof params === "object" && params !== null && "path" in params ? params.path : "",
    );
    expect(paths.filter((path) => typeof path === "string" && path.includes("#"))).toEqual([]);
    expect(appApi.request.mock.calls.some(([method]) => method === "fs.read")).toBe(false);
  });

  it("opens one tab for an artifact reached from the file tree and the palette", async () => {
    stubApp();
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "File list" }));
    await user.click(await screen.findByRole("button", { name: "Preview notes.md" }));
    expect(screen.getAllByRole("tab", { name: "notes.md" })).toHaveLength(1);

    await openPreviewOverlay(user);
    await user.click(await screen.findByRole("option", { name: "notes.md" }));

    expect(screen.getAllByRole("tab", { name: "notes.md" })).toHaveLength(1);
  });
});
