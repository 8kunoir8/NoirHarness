import { describe, expect, it } from "vitest";
import { activateTab, chatTab, closeTab, diffTab, editorTab, loadTabs, openTab, TABS_KEY, type TabsState } from "../src/renderer/tabs.js";

const empty: TabsState = { tabs: [], active: undefined };

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
    expect(closeTab(last, "chat:a")).toEqual({ tabs: [], active: undefined });
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

  it("dedupes duplicated stored ids, first wins", () => {
    const loaded = loadTabs({ tabs: [editorTab("a.ts"), editorTab("a.ts"), chatTab("s1")] });
    expect(loaded.tabs.map((tab) => tab.id)).toEqual(["editor:a.ts", "chat:s1"]);
  });

  it("pins the storage key", () => {
    expect(TABS_KEY).toBe("noir.tabs.v2");
  });
});
