import { describe, expect, it } from "vitest";
import {
  activateTab,
  chatTab,
  closeTab,
  diffTab,
  editorTab,
  loadTabs,
  openTab,
  previewTab,
  pruneChatTabs,
  scopeTabs,
  TABS_KEY,
  type TabsState,
} from "../src/renderer/tabs.js";

const empty: TabsState = { tabs: [], active: undefined, workspaceId: "" };

describe("tabs", () => {
  it("opens, dedupes by id, and activates", () => {
    const first = openTab(empty, chatTab("s1"));
    expect(first.tabs).toHaveLength(1);
    expect(first.active).toBe("chat:s1");
    expect(openTab(first, chatTab("s1"))).toBe(first);

    const again = openTab(openTab(first, editorTab("src/a.ts")), chatTab("s1"));
    expect(again.tabs.map((tab) => tab.id)).toEqual(["chat:s1", "editor:src/a.ts"]);
    expect(again.active).toBe("chat:s1");
  });

  it("closes the active tab onto its neighbour, then the previous one", () => {
    const state = openTab(openTab(openTab(empty, chatTab("a")), editorTab("x.ts")), diffTab("x.ts"));
    const middle = closeTab(state, "editor:x.ts");
    expect(middle.active).toBe("diff:x.ts");
    const last = closeTab(middle, "diff:x.ts");
    expect(last.active).toBe("chat:a");
    expect(closeTab(last, "chat:a")).toEqual({ tabs: [], active: undefined, workspaceId: "" });
  });

  it("closes an active middle tab onto its following tab", () => {
    const state = activateTab(
      openTab(openTab(openTab(empty, chatTab("a")), editorTab("x.ts")), diffTab("x.ts")),
      "editor:x.ts",
    );
    expect(closeTab(state, "editor:x.ts").active).toBe("diff:x.ts");
  });

  it("ignores unknown ids", () => {
    const state = openTab(empty, chatTab("a"));
    expect(activateTab(state, "editor:nope")).toBe(state);
    expect(closeTab(state, "editor:nope")).toBe(state);
  });

  it("migrates the v1 chat-only shape and drops malformed entries", () => {
    const migrated = loadTabs({ open: ["s1", "s2"], active: "s2" });
    expect(migrated.tabs.map((tab) => tab.kind)).toEqual(["chat", "chat"]);
    expect(migrated.active).toBe("chat:s2");
    expect(loadTabs({ open: [42, "s1"], active: "missing" })).toEqual({
      tabs: [chatTab("s1")],
      active: "chat:s1",
      workspaceId: "",
    });
    expect(loadTabs(null)).toEqual(empty);
  });

  it("loads the v2 shape in order and drops malformed entries", () => {
    const loaded = loadTabs({
      tabs: [chatTab("s1"), editorTab("a.ts"), diffTab("a.ts"), { kind: "nope", id: "x" }],
      active: "editor:a.ts",
    });
    expect(loaded.tabs.map((tab) => tab.id)).toEqual(["chat:s1", "editor:a.ts", "diff:a.ts"]);
    expect(loaded.active).toBe("editor:a.ts");
    expect(loadTabs({ tabs: [chatTab("s1"), editorTab("a.ts")], active: "chat:missing" }).active).toBe("chat:s1");
    expect(loadTabs({ tabs: [{ kind: "nope" }], open: ["s1"] })).toEqual(empty);
  });

  it("round-trips a preview tab and rejects an empty path", () => {
    const opened = openTab(empty, previewTab("notes/readme.md"));
    expect(opened.active).toBe("preview:notes/readme.md");
    expect(opened.tabs).toEqual([{ id: "preview:notes/readme.md", kind: "preview", path: "notes/readme.md" }]);
    // Opening the same artifact again only focuses the tab that already exists.
    expect(openTab(opened, previewTab("notes/readme.md"))).toBe(opened);
    expect(loadTabs(JSON.parse(JSON.stringify(opened)))).toEqual(opened);
    // A blob without the derived id is normalized back to the canonical tab.
    expect(loadTabs({ tabs: [{ kind: "preview", path: "notes/readme.md" }] }).tabs).toEqual([
      previewTab("notes/readme.md"),
    ]);
    expect(loadTabs({ tabs: [{ kind: "preview", path: "" }] }).tabs).toEqual([]);
  });

  it("treats a dotted or doubled path as the same preview artifact", () => {
    expect(previewTab("./notes.md")).toEqual(previewTab("notes.md"));
    expect(previewTab("docs//./notes.md")).toEqual(previewTab("docs/notes.md"));

    const opened = openTab(openTab(empty, previewTab("./notes.md")), previewTab("notes.md"));
    expect(opened.tabs).toEqual([{ id: "preview:notes.md", kind: "preview", path: "notes.md" }]);
    expect(opened.active).toBe("preview:notes.md");
    // A stored tab keeps the same canonical id and path.
    expect(loadTabs({ tabs: [{ kind: "preview", path: "./notes.md" }] }).tabs).toEqual([previewTab("notes.md")]);
  });

  it("dedupes duplicated stored ids, first wins", () => {
    const loaded = loadTabs({ tabs: [editorTab("a.ts"), editorTab("a.ts"), chatTab("s1")] });
    expect(loaded.tabs.map((tab) => tab.id)).toEqual(["editor:a.ts", "chat:s1"]);
  });

  it("persists and restores the workspace alongside the tabs", () => {
    const restored = loadTabs({
      tabs: [chatTab("s1"), editorTab("src/a.ts")],
      active: "editor:src/a.ts",
      workspaceId: "w1",
    });
    expect(restored.workspaceId).toBe("w1");
    expect(restored.tabs.map((tab) => tab.id)).toEqual(["chat:s1", "editor:src/a.ts"]);
    // Every transition carries the workspace the paths belong to.
    expect(openTab(restored, diffTab("src/a.ts")).workspaceId).toBe("w1");
    expect(closeTab(restored, "editor:src/a.ts").workspaceId).toBe("w1");
    expect(activateTab(restored, "chat:s1").workspaceId).toBe("w1");
  });

  it("defaults a legacy blob to no workspace", () => {
    expect(loadTabs({ open: ["s1"], active: "s1", workspaceId: 42 }).workspaceId).toBe("");
    expect(loadTabs({ tabs: [editorTab("a.ts")] }).workspaceId).toBe("");
  });

  it("scopeTabs treats an unset workspace as unowned and keeps only chats", () => {
    const v2: TabsState = {
      tabs: [chatTab("s1"), editorTab("a.ts"), diffTab("a.ts"), previewTab("a.md")],
      active: "preview:a.md",
      workspaceId: "",
    };
    expect(scopeTabs(v2, "w1")).toEqual({ tabs: [chatTab("s1")], active: "chat:s1", workspaceId: "w1" });

    // v1 blobs are chat-only, so the stricter rule loses nothing legitimate.
    expect(scopeTabs({ tabs: [chatTab("s1")], active: "chat:s1", workspaceId: "" }, "w1")).toEqual({
      tabs: [chatTab("s1")],
      active: "chat:s1",
      workspaceId: "w1",
    });
    expect(scopeTabs({ ...v2, workspaceId: "w1" }, "w1")).toEqual({ ...v2, workspaceId: "w1" });
  });

  it("scopeTabs drops editor, diff, and preview tabs saved in another workspace", () => {
    const state: TabsState = {
      tabs: [chatTab("s1"), editorTab("a.ts"), diffTab("a.ts"), previewTab("a.md")],
      active: "preview:a.md",
      workspaceId: "w1",
    };
    expect(scopeTabs(state, "w2")).toEqual({
      tabs: [chatTab("s1")],
      active: "chat:s1",
      workspaceId: "w2",
    });
  });

  it("pruneChatTabs drops chats whose session is gone and keeps file tabs", () => {
    const state: TabsState = {
      tabs: [chatTab("live"), chatTab("dead"), editorTab("a.ts"), diffTab("a.ts"), previewTab("a.md")],
      active: "chat:dead",
      workspaceId: "w1",
    };
    expect(pruneChatTabs(state, new Set(["live"]))).toEqual({
      tabs: [chatTab("live"), editorTab("a.ts"), diffTab("a.ts"), previewTab("a.md")],
      active: "chat:live",
      workspaceId: "w1",
    });
    expect(pruneChatTabs(state, new Set(["live", "dead"]))).toBe(state);
  });

  it("pins the storage key", () => {
    expect(TABS_KEY).toBe("noir.tabs.v3");
  });
});
