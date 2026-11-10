import { render, screen, waitFor } from "@testing-library/react";
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
});
