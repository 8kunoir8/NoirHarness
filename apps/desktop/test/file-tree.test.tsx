import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { FileTree } from "../src/renderer/FileTree.js";

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

  it("marks the open file as selected", async () => {
    render(<FileTree request={fakeRequest as never} workspaceId="w1" activePath="README.md" onOpenFile={() => undefined} />);
    const row = await screen.findByRole("treeitem", { name: /README\.md/ });
    expect(row.getAttribute("aria-selected")).toBe("true");
  });
});
