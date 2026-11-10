import { describe, expect, it } from "vitest";
import { activateTab, chatTab, closeTab, diffTab, editorTab, loadTabs, openTab, type TabsState } from "../src/renderer/tabs.js";

const empty: TabsState = { tabs: [], active: undefined };

describe("tabs", () => {
  it("opens, dedupes by id, and activates", () => {
    const first = openTab(empty, chatTab("s1"));
    expect(first.tabs).toHaveLength(1);
    expect(first.active).toBe("chat:s1");

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
});
