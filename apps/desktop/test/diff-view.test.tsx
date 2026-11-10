import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DiffView, parseDiff } from "../src/renderer/DiffView.js";

const diff = ["--- a/a.txt", "+++ b/a.txt", "@@ -1,2 +1,3 @@", " one", "+two", " three", ""].join("\n");

describe("parseDiff", () => {
  it("classifies meta, hunk, context, add and delete lines with line numbers", () => {
    const lines = parseDiff(diff);
    expect(lines[0]).toMatchObject({ kind: "meta", text: "--- a/a.txt" });
    expect(lines[2]).toMatchObject({ kind: "hunk", text: "@@ -1,2 +1,3 @@" });
    expect(lines[3]).toMatchObject({ kind: "context", oldLine: 1, newLine: 1 });
    expect(lines[4]).toMatchObject({ kind: "add", newLine: 2, text: "+two" });
    const removed = parseDiff("--- a/x\n+++ b/x\n@@ -1 +1 @@\n-gone\n+new\n");
    expect(removed[3]).toMatchObject({ kind: "del", oldLine: 1 });
    expect(removed[3]?.newLine).toBeUndefined();
    expect(removed[4]).toMatchObject({ kind: "add", newLine: 1 });
  });

  it("numbers each hunk from its own header and drops the trailing newline", () => {
    const patch = [
      "--- a/x",
      "+++ b/x",
      "@@ -1,1 +1,2 @@",
      " one",
      "+two",
      "@@ -10,1 +11,1 @@",
      " ten",
    ].join("\n");
    const lines = parseDiff(`${patch}\n`);
    expect(lines).toHaveLength(7);
    expect(lines[2]).toMatchObject({ kind: "hunk", text: "@@ -1,1 +1,2 @@" });
    expect(lines[3]).toMatchObject({ kind: "context", oldLine: 1, newLine: 1 });
    expect(lines[4]).toMatchObject({ kind: "add", newLine: 2 });
    expect(lines[5]).toMatchObject({ kind: "hunk", text: "@@ -10,1 +11,1 @@" });
    expect(lines[6]).toMatchObject({ kind: "context", oldLine: 10, newLine: 11 });
  });

  it("renders the no-newline marker as meta and an empty patch as nothing", () => {
    const lines = parseDiff("--- a/x\n+++ b/x\n@@ -1 +1 @@\n-gone\n\\ No newline at end of file\n+new\n");
    expect(lines[4]).toMatchObject({ kind: "meta", text: "\\ No newline at end of file" });
    expect(lines[4]?.oldLine).toBeUndefined();
    expect(lines[4]?.newLine).toBeUndefined();
    expect(lines[5]).toMatchObject({ kind: "add", newLine: 1 });
    expect(parseDiff("")).toEqual([]);
  });

  it("keeps pre-hunk headers meta without numbers and reads ---/+++ content inside a hunk", () => {
    const lines = parseDiff(
      [
        "diff --git a/x b/x",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/x",
        "@@ -1,2 +1,2 @@",
        "--- keep",
        "++ hello",
      ].join("\n"),
    );
    expect(lines[0]).toMatchObject({ kind: "meta", text: "diff --git a/x b/x" });
    expect(lines[1]).toMatchObject({ kind: "meta", text: "new file mode 100644" });
    expect(lines[1]?.oldLine).toBeUndefined();
    expect(lines[1]?.newLine).toBeUndefined();
    expect(lines[5]).toMatchObject({ kind: "del", text: "--- keep", oldLine: 1 });
    expect(lines[5]?.newLine).toBeUndefined();
    expect(lines[6]).toMatchObject({ kind: "add", text: "++ hello", newLine: 1 });
  });

  it("strips carriage returns from CRLF patches", () => {
    const lines = parseDiff("--- a/x\r\n+++ b/x\r\n@@ -1 +1 @@\r\n one\r\n");
    expect(lines.map((line) => line.text)).toEqual(["--- a/x", "+++ b/x", "@@ -1 +1 @@", " one"]);
  });
});

describe("DiffView", () => {
  it("renders the patch and posts a note for a clicked line", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "git.diff") return { diff };
      if (method === "annotation.list") return { diffHash: "h1", annotations: [] };
      if (method === "annotation.add") return { id: "a1", line: 2, note: "why?", createdAt: 1, stale: false };
      throw new Error(`unexpected ${method}`);
    });
    render(<DiffView request={request as never} workspaceId="w1" path="a.txt" />);

    await screen.findByText("+two");
    const gutter = screen.getByRole("button", { name: "Annotate line 2" });
    await userEvent.click(gutter);
    await userEvent.type(screen.getByLabelText("Note"), "why?{Enter}");

    await waitFor(() => expect(request).toHaveBeenCalledWith("annotation.add", { workspaceId: "w1", path: "a.txt", line: 2, note: "why?" }));
    expect((await screen.findByText("why?")).textContent).toBe("why?");
  });

  it("deletes a note through the kernel", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "git.diff") return { diff };
      if (method === "annotation.list")
        return { diffHash: "h1", annotations: [{ id: "a1", line: 2, note: "why?", createdAt: 1, stale: false }] };
      if (method === "annotation.delete") return { ok: true };
      throw new Error(`unexpected ${method}`);
    });
    render(<DiffView request={request as never} workspaceId="w1" path="a.txt" />);

    await screen.findByText("why?");
    await userEvent.click(screen.getByRole("button", { name: "Delete note on line 2" }));
    await waitFor(() => expect(request).toHaveBeenCalledWith("annotation.delete", { id: "a1" }));
    expect(screen.queryByText("why?")).toBeNull();
  });

  it("shows the empty state for an empty patch", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "git.diff") return { diff: "" };
      if (method === "annotation.list") return { diffHash: "", annotations: [] };
      throw new Error(`unexpected ${method}`);
    });
    render(<DiffView request={request as never} workspaceId="w1" path="a.txt" />);

    expect((await screen.findByText("No changes in this file.")).textContent).toBe("No changes in this file.");
  });

  it("renders notes from an earlier version only in the stale list", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "git.diff") return { diff };
      if (method === "annotation.list")
        return { diffHash: "h2", annotations: [{ id: "a1", line: 2, note: "why?", createdAt: 1, stale: true }] };
      throw new Error(`unexpected ${method}`);
    });
    render(<DiffView request={request as never} workspaceId="w1" path="a.txt" />);

    const stale = await screen.findByRole("region", { name: "Stale notes" });
    expect(within(stale).getByText("Notes from an earlier version")).toBeDefined();
    expect(within(stale).getByText("why?")).toBeDefined();
    expect(within(stale).getByRole("button", { name: "Delete stale note on line 2" })).toBeDefined();
    expect(screen.getAllByText("why?")).toHaveLength(1);
    const row = screen.getByRole("button", { name: "Annotate line 2" }).closest("li");
    expect(row).not.toBeNull();
    if (row !== null) expect(within(row).queryByText("why?")).toBeNull();
  });

  it("surfaces a rejected diff as an alert without escaping", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "git.diff") throw new Error("git exploded");
      if (method === "annotation.list") return { diffHash: "h1", annotations: [] };
      throw new Error(`unexpected ${method}`);
    });
    render(<DiffView request={request as never} workspaceId="w1" path="a.txt" />);

    expect((await screen.findByRole("alert")).textContent).toBe("git exploded");
    expect(screen.queryByText("No changes in this file.")).toBeNull();
  });

  it("attaches a second-hunk note to its own line", async () => {
    const multi = [
      "--- a/x.txt",
      "+++ b/x.txt",
      "@@ -1,2 +1,3 @@",
      " one",
      " two",
      "+three",
      "@@ -10,2 +10,2 @@",
      " ten",
      "+eleven",
      "",
    ].join("\n");
    const request = vi.fn(async (method: string) => {
      if (method === "git.diff") return { diff: multi };
      if (method === "annotation.list")
        return { diffHash: "h1", annotations: [{ id: "a1", line: 11, note: "why?", createdAt: 1, stale: false }] };
      throw new Error(`unexpected ${method}`);
    });
    render(<DiffView request={request as never} workspaceId="w1" path="a.txt" />);

    await screen.findByText("+eleven");
    expect(screen.getAllByText("why?")).toHaveLength(1);
    const secondHunk = screen.getByText("+eleven").closest("li");
    expect(secondHunk).not.toBeNull();
    if (secondHunk !== null) expect(within(secondHunk).getByText("why?")).toBeDefined();
    const firstHunk = screen.getByText("+three").closest("li");
    expect(firstHunk).not.toBeNull();
    if (firstHunk !== null) expect(within(firstHunk).queryByText("why?")).toBeNull();
  });

  it("numbers a synthetic new-file patch from line 1 and never exposes line 0", async () => {
    const created = [
      "diff --git a/c.txt b/c.txt",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/c.txt",
      "@@ -0,0 +1,2 @@",
      "+alpha",
      "+beta",
      "",
    ].join("\n");
    const request = vi.fn(async (method: string) => {
      if (method === "git.diff") return { diff: created };
      if (method === "annotation.list") return { diffHash: "h1", annotations: [] };
      throw new Error(`unexpected ${method}`);
    });
    render(<DiffView request={request as never} workspaceId="w1" path="a.txt" />);

    await screen.findByText("+beta");
    expect(screen.getByRole("button", { name: "Annotate line 1" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Annotate line 2" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Annotate line 0" })).toBeNull();
  });

  it("drops the previous file's notes when the path changes", async () => {
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "git.diff") return { diff };
      if (method === "annotation.list") {
        const target = params !== null && typeof params === "object" && "path" in params ? params.path : undefined;
        return target === "a.txt"
          ? { diffHash: "h1", annotations: [{ id: "a1", line: 2, note: "old", createdAt: 1, stale: false }] }
          : { diffHash: "h2", annotations: [] };
      }
      throw new Error(`unexpected ${method}`);
    });
    const { rerender } = render(<DiffView request={request as never} workspaceId="w1" path="a.txt" />);

    await screen.findByText("old");
    rerender(<DiffView request={request as never} workspaceId="w1" path="b.txt" />);

    await waitFor(() => expect(screen.queryByText("old")).toBeNull());
    expect(screen.getByRole("button", { name: "Annotate line 2" })).toBeDefined();
  });
});
