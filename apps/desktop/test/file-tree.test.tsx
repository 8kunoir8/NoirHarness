import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { FileTree } from "../src/renderer/FileTree.js";
import { ContextMenuProvider } from "../src/renderer/ContextMenu.js";

const entries: Record<string, unknown> = {
  "": {
    entries: [
      { name: "src", path: "src", kind: "dir", size: 0 },
      { name: "README.md", path: "README.md", kind: "file", size: 12 },
    ],
    truncated: false,
  },
  src: {
    entries: [{ name: "main.ts", path: "src/main.ts", kind: "file", size: 30 }],
    truncated: false,
  },
};

function fakeRequest(method: string, params?: unknown): Promise<unknown> {
  expect(method).toBe("fs.list");
  const path = (params as { path: string }).path;
  return entries[path] === undefined ? Promise.reject(new Error("nope")) : Promise.resolve(entries[path]);
}

describe("FileTree", () => {
  it("expands a directory on demand and opens a file", async () => {
    const onOpenFile = vi.fn();
    render(<FileTree request={fakeRequest as never} workspaceId="w1" onOpenFile={onOpenFile} />);

    const src = await screen.findByRole("treeitem", { name: /src/ });
    expect(screen.queryByRole("treeitem", { name: /main\.ts/ })).toBeNull();

    await userEvent.click(src);
    expect(screen.getByRole("treeitem", { name: /main\.ts/ })).toBeTruthy();

    await userEvent.click(screen.getByRole("treeitem", { name: /main\.ts/ }));
    expect(onOpenFile).toHaveBeenCalledWith("src/main.ts");
  });

  it("routes a pdf row to the preview instead of the editor", async () => {
    const onOpenFile = vi.fn();
    const onPreviewFile = vi.fn();
    const request = (): Promise<unknown> =>
      Promise.resolve({ entries: [{ name: "report.pdf", path: "report.pdf", kind: "file", size: 9 }], truncated: false });
    render(
      <FileTree
        request={request as never}
        workspaceId="w1"
        onOpenFile={onOpenFile}
        onPreviewFile={onPreviewFile}
      />,
    );

    await userEvent.click(await screen.findByText("report.pdf"));
    expect(onPreviewFile).toHaveBeenCalledWith("report.pdf");
    expect(onOpenFile).not.toHaveBeenCalled();
  });

  it("adds an explicit Preview button to previewable rows only", async () => {
    const onOpenFile = vi.fn();
    const onPreviewFile = vi.fn();
    render(
      <FileTree
        request={fakeRequest as never}
        workspaceId="w1"
        onOpenFile={onOpenFile}
        onPreviewFile={onPreviewFile}
      />,
    );

    await screen.findByText("README.md");
    expect(screen.queryByRole("button", { name: "Preview src" })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Preview README.md" }));
    expect(onPreviewFile).toHaveBeenCalledWith("README.md");
    expect(onOpenFile).not.toHaveBeenCalled();

    // The row itself still opens the editor for a markdown file.
    await userEvent.click(screen.getByText("README.md"));
    expect(onOpenFile).toHaveBeenCalledWith("README.md");
  });

  it("marks the open file as selected", async () => {
    render(<FileTree request={fakeRequest as never} workspaceId="w1" activePath="README.md" onOpenFile={() => undefined} />);
    const row = await screen.findByRole("treeitem", { name: /README\.md/ });
    expect(row.getAttribute("aria-selected")).toBe("true");
  });

  it("shows an alert and collapses a directory whose listing fails", async () => {
    const request = (_method: string, params?: unknown): Promise<unknown> => {
      const { path } = paramsOf(params);
      if (path === "src") return Promise.reject(new Error("permission denied"));
      return Promise.resolve(entries[""]);
    };
    render(<FileTree request={request as never} workspaceId="w1" onOpenFile={() => undefined} />);

    const src = await screen.findByRole("treeitem", { name: /src/ });
    expect(src.getAttribute("aria-expanded")).toBe("false");

    await userEvent.click(src);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("src");
    expect(alert.textContent).toContain("permission denied");
    expect(src.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("treeitem", { name: /main\.ts/ })).toBeNull();
  });

  it("keeps an expanded directory cached across a collapse", async () => {
    const calls: string[] = [];
    const request = (_method: string, params?: unknown): Promise<unknown> => {
      const { path } = paramsOf(params);
      calls.push(path);
      return entries[path] === undefined ? Promise.reject(new Error("nope")) : Promise.resolve(entries[path]);
    };
    render(<FileTree request={request as never} workspaceId="w1" onOpenFile={() => undefined} />);

    const src = await screen.findByRole("treeitem", { name: /src/ });
    await userEvent.click(src);
    await screen.findByRole("treeitem", { name: /main\.ts/ });

    await userEvent.click(src);
    await userEvent.click(src);
    await screen.findByRole("treeitem", { name: /main\.ts/ });

    expect(calls.filter((path) => path === "src")).toHaveLength(1);
  });

  it("notes a truncated root listing", async () => {
    const request = (_method: string, _params?: unknown): Promise<unknown> =>
      Promise.resolve({ entries: [{ name: "a.ts", path: "a.ts", kind: "file", size: 1 }], truncated: true });
    render(<FileTree request={request as never} workspaceId="w1" onOpenFile={() => undefined} />);

    await screen.findByRole("treeitem", { name: /a\.ts/ });
    const note = screen.getByText("Showing the first 2,000 entries");
    expect(note.className).toBe("file-tree-note");
  });

  it("drops a listing that resolves after the workspace changes", async () => {
    const deferred = Promise.withResolvers<unknown>();
    const request = (_method: string, params?: unknown): Promise<unknown> => {
      const { workspaceId } = paramsOf(params);
      if (workspaceId === "w1") return deferred.promise;
      return Promise.resolve({
        entries: [{ name: "new.ts", path: "new.ts", kind: "file", size: 3 }],
        truncated: false,
      });
    };
    const { rerender } = render(
      <FileTree request={request as never} workspaceId="w1" onOpenFile={() => undefined} />,
    );
    expect(screen.queryByRole("treeitem", { name: /old\.txt/ })).toBeNull();

    rerender(<FileTree request={request as never} workspaceId="w2" onOpenFile={() => undefined} />);
    const fresh = await screen.findByRole("treeitem", { name: /new\.ts/ });
    expect(fresh.getAttribute("data-depth")).toBe("0");

    await act(async () => {
      deferred.resolve({
        entries: [{ name: "old.txt", path: "old.txt", kind: "file", size: 9 }],
        truncated: false,
      });
    });
    expect(screen.queryByRole("treeitem", { name: /old\.txt/ })).toBeNull();
    expect(screen.getByRole("treeitem", { name: /new\.ts/ })).toBeTruthy();
  });

  it("offers open, diff, copy and reveal on a file row", async () => {
    const onDiffFile = vi.fn();
    const onReveal = vi.fn();
    render(
      <ContextMenuProvider>
        <FileTree
          request={fakeRequest as never}
          workspaceId="w1"
          onOpenFile={() => undefined}
          onDiffFile={onDiffFile}
          onReveal={onReveal}
        />
      </ContextMenuProvider>,
    );

    fireEvent.contextMenu(await screen.findByRole("treeitem", { name: /README\.md/ }));
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Open",
      "Diff",
      "Copy path",
      "Reveal in Explorer",
    ]);
    await userEvent.click(screen.getByRole("menuitem", { name: "Reveal in Explorer" }));
    expect(onReveal).toHaveBeenCalledWith("README.md");

    // A directory has nothing to diff, and its first action says which way it will go.
    fireEvent.contextMenu(screen.getByRole("treeitem", { name: /src/ }));
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Expand",
      "Copy path",
      "Reveal in Explorer",
    ]);
  });
});

function paramsOf(value: unknown): { workspaceId: string; path: string } {
  if (typeof value !== "object" || value === null) return { workspaceId: "", path: "" };
  const workspaceId = "workspaceId" in value && typeof value.workspaceId === "string" ? value.workspaceId : "";
  const path = "path" in value && typeof value.path === "string" ? value.path : "";
  return { workspaceId, path };
}
