import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { RequestFn } from "../src/renderer/api.js";
import { ArtifactPreview } from "../src/renderer/preview/ArtifactPreview.js";
import { previewKind } from "../src/renderer/preview/kind.js";

const markdown = "# Title\n\n| a |\n| - |\n| 1 |";

const readResult = {
  encoding: "utf8" as const,
  content: markdown,
  size: 20,
  mtimeMs: 1,
  truncated: false,
};

function harness(request: RequestFn, path = "notes.md") {
  return <ArtifactPreview workspaceId="w1" path={path} request={request} />;
}

describe("previewKind", () => {
  it("classifies supported extensions case-insensitively", () => {
    expect(previewKind("notes.md")).toBe("markdown");
    expect(previewKind("docs/README.MARKDOWN")).toBe("markdown");
    expect(previewKind("data.csv")).toBe("csv");
    expect(previewKind("dir/data.TSV")).toBe("csv");
    expect(previewKind("manual.pdf")).toBe("pdf");
  });

  it("returns undefined for anything not previewable", () => {
    expect(previewKind("src/main.ts")).toBeUndefined();
    expect(previewKind("archive.tar")).toBeUndefined();
    expect(previewKind("LICENSE")).toBeUndefined();
  });
});

describe("ArtifactPreview", () => {
  it("renders a Markdown heading and a GFM table", async () => {
    const request = vi.fn(async (method: string) => {
      expect(method).toBe("artifact.read");
      return readResult;
    });
    render(harness(request as unknown as RequestFn));

    expect(await screen.findByRole("heading", { name: "Title" })).toBeTruthy();
    const table = screen.getByRole("table");
    expect(within(table).getByRole("columnheader", { name: "a" })).toBeTruthy();
    expect(within(table).getByRole("cell", { name: "1" })).toBeTruthy();
    expect(request).toHaveBeenCalledWith("artifact.read", { workspaceId: "w1", path: "notes.md" });
  });

  it("shows a truncation notice for capped text", async () => {
    const request = vi.fn(async () => ({ ...readResult, truncated: true }));
    render(harness(request as unknown as RequestFn));

    expect(await screen.findByText("Showing the first 2 MB")).toBeTruthy();
  });

  it("drops script, event handlers, and hostile link or image targets", async () => {
    const hostile = [
      "# Safe",
      "",
      "<script>window.pwned = 1</script>",
      "",
      '<img src="x" onerror="window.pwned = 2" />',
      "",
      "[bad](javascript:alert(1))",
      "",
      "[worse](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)",
      "",
      "![pixel](data:image/png;base64,AAAA)",
      "",
      "[good](https://example.com)",
    ].join("\n");
    const request = vi.fn(async () => ({ ...readResult, content: hostile }));
    const { container } = render(harness(request as unknown as RequestFn));

    expect(await screen.findByRole("heading", { name: "Safe" })).toBeTruthy();
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.querySelector("a[href^='javascript:']")).toBeNull();
    expect(container.querySelector("a[href^='data:']")).toBeNull();
    // Unsafe targets stay visible as plain text instead of becoming links.
    expect(screen.queryByRole("link", { name: "bad" })).toBeNull();
    expect(screen.queryByRole("link", { name: "worse" })).toBeNull();
    expect(screen.getByText("bad")).toBeTruthy();
    expect(screen.getByText("worse")).toBeTruthy();
    expect(screen.getByText("pixel")).toBeTruthy();
    // The safe link survives.
    expect(screen.getByRole("link", { name: "good" }).getAttribute("href")).toBe("https://example.com");
    expect("pwned" in window).toBe(false);
  });

  it("reports a missing file and reads it again on Reload", async () => {
    let calls = 0;
    const request = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error("File not found: notes.md");
      return readResult;
    });
    render(harness(request as unknown as RequestFn));

    expect(await screen.findByText("File not found: notes.md")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Reload" }));

    expect(await screen.findByRole("heading", { name: "Title" })).toBeTruthy();
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("File not found: notes.md")).toBeNull();
  });
});
