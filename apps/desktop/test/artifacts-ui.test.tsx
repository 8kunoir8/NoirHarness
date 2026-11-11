import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestFn } from "../src/renderer/api.js";
import { ArtifactPreview } from "../src/renderer/preview/ArtifactPreview.js";
import { previewKind } from "../src/renderer/preview/kind.js";

// pdf.js is a browser bundle; the component only needs its document API, so the tests
// replace the whole module and assert the shapes handed to it.
const pdfMock = vi.hoisted(() => ({ getDocument: vi.fn() }));

vi.mock("pdfjs-dist", () => ({
  getDocument: pdfMock.getDocument,
  GlobalWorkerOptions: { workerSrc: "" },
  RenderingCancelledException: class RenderingCancelledException extends Error {},
}));

vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({ default: "/assets/pdf.worker.min.test.mjs" }));

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

const csvText = "name,qty\nwidget,3\nbolt,5";

const pdfBytes = Uint8Array.from("%PDF-1.4\n", (char) => char.charCodeAt(0));
const pdfBase64 = btoa(String.fromCharCode(...pdfBytes));

const pdfResult = {
  encoding: "base64" as const,
  content: pdfBase64,
  size: pdfBytes.length,
  mtimeMs: 1,
  truncated: false,
};

function mockPdfDocument(pageCount = 3) {
  const render = vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() }));
  const page = {
    getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }),
    render,
  };
  const destroy = vi.fn(async () => {});
  pdfMock.getDocument.mockReturnValue({
    promise: Promise.resolve({ numPages: pageCount, getPage: async () => page, destroy }),
    destroy,
  });
  return { page, render, destroy };
}

beforeEach(() => {
  pdfMock.getDocument.mockReset();
});

describe("CsvArtifact", () => {
  it("renders CSV rows in a table and counts them", async () => {
    const request = vi.fn(async () => ({ ...readResult, content: csvText }));
    render(harness(request as unknown as RequestFn, "data.csv"));

    const table = await screen.findByRole("table");
    expect(within(table).getByRole("columnheader", { name: "name" })).toBeTruthy();
    expect(within(table).getByRole("cell", { name: "widget" })).toBeTruthy();
    expect(within(table).getByRole("cell", { name: "5" })).toBeTruthy();
    expect(screen.getByText("2 rows")).toBeTruthy();
  });

  it("shows the empty state instead of a table for an empty file", async () => {
    const request = vi.fn(async () => ({ ...readResult, content: "" }));
    render(harness(request as unknown as RequestFn, "empty.csv"));

    expect(await screen.findByText("Empty file")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("caps the rendered table and reports truncation at 5,000 rows", async () => {
    const rows = Array.from({ length: 5_100 }, (_, index) => `row${index},${index}`);
    const request = vi.fn(async () => ({ ...readResult, content: ["id,value", ...rows].join("\n") }));
    render(harness(request as unknown as RequestFn, "big.csv"));

    expect(await screen.findByText("5,000 rows shown (truncated)")).toBeTruthy();
    const table = screen.getByRole("table");
    expect(within(table).getByRole("cell", { name: "row0" })).toBeTruthy();
    // Windowing keeps the DOM small: the tail of the file is not rendered up front.
    expect(within(table).queryByRole("cell", { name: "row5099" })).toBeNull();
  });

  it("marks a cell cut at the 500-character cap without claiming a row cap", async () => {
    const request = vi.fn(async () => ({ ...readResult, content: `text\n${"x".repeat(600)}` }));
    const { container } = render(harness(request as unknown as RequestFn, "wide.csv"));

    expect(await screen.findByText("1 row")).toBeTruthy();
    expect(screen.queryByText(/5,000 rows/)).toBeNull();
    const cell = await waitFor(() => {
      const found = container.querySelector("tbody td");
      if (found === null) throw new Error("no cell yet");
      return found;
    });
    expect(cell.textContent?.endsWith("…")).toBe(true);
    expect(cell.textContent?.length).toBe(500);
  });

  it("keeps the row count when only the column cap is hit", async () => {
    const row = (prefix: string) => Array.from({ length: 121 }, (_, index) => `${prefix}${index}`).join(",");
    const request = vi.fn(async () => ({ ...readResult, content: `${row("c")}\n${row("v")}` }));
    render(harness(request as unknown as RequestFn, "columns.csv"));

    const table = await screen.findByRole("table");
    expect(within(table).getAllByRole("columnheader")).toHaveLength(100);
    expect(screen.getByText("1 row")).toBeTruthy();
    expect(screen.queryByText(/5,000 rows/)).toBeNull();
  });

  it("generates Column N headers when the first row has no header", async () => {
    const request = vi.fn(async () => ({ ...readResult, content: "1,2\n3,4" }));
    render(harness(request as unknown as RequestFn, "numbers.csv"));

    const table = await screen.findByRole("table");
    expect(within(table).getByRole("columnheader", { name: "Column 1" })).toBeTruthy();
    expect(within(table).getByRole("columnheader", { name: "Column 2" })).toBeTruthy();
    expect(within(table).getByRole("cell", { name: "3" })).toBeTruthy();
    expect(screen.getByText("2 rows")).toBeTruthy();
  });

  it("windows the body to the scroll position", async () => {
    const rows = Array.from({ length: 1_000 }, (_, index) => `row${index}`);
    const request = vi.fn(async () => ({ ...readResult, content: ["id", ...rows].join("\n") }));
    const { container } = render(harness(request as unknown as RequestFn, "tall.csv"));

    const table = await screen.findByRole("table");
    expect(within(table).getByRole("cell", { name: "row0" })).toBeTruthy();

    const scroller = container.querySelector(".artifact-csv-scroll");
    if (scroller === null) throw new Error("no scroller");
    fireEvent.scroll(scroller, { target: { scrollTop: 24 * 500 } });

    await waitFor(() => expect(within(table).queryByRole("cell", { name: "row0" })).toBeNull());
    expect(within(table).getByRole("cell", { name: "row500" })).toBeTruthy();
  });
});

describe("PdfArtifact", () => {
  it("hands pdf.js the decoded bytes and shows the page count", async () => {
    const { render: renderPage } = mockPdfDocument(3);
    const request = vi.fn(async () => pdfResult);
    render(harness(request as unknown as RequestFn, "manual.pdf"));

    expect(await screen.findByText("1 / 3")).toBeTruthy();
    const options = pdfMock.getDocument.mock.calls[0]?.[0] as { data: Uint8Array } | undefined;
    expect(options?.data).toBeInstanceOf(Uint8Array);
    expect(Array.from(options?.data.subarray(0, 4) ?? [])).toEqual([0x25, 0x50, 0x44, 0x46]);
    await waitFor(() => expect(renderPage).toHaveBeenCalled());
  });

  it("reports a document pdf.js refuses to open", async () => {
    const rejection = Promise.reject(new Error("Invalid PDF structure"));
    // The component attaches its handler on mount; mark the rejection handled up front so a
    // slow renderer tick does not surface it as an unhandled rejection in the runner.
    rejection.catch(() => {});
    pdfMock.getDocument.mockReturnValue({
      promise: rejection,
      destroy: vi.fn(async () => {}),
    });
    const request = vi.fn(async () => pdfResult);
    render(harness(request as unknown as RequestFn, "broken.pdf"));

    expect(await screen.findByText("Could not read PDF")).toBeTruthy();
    expect(screen.getByText("Invalid PDF structure")).toBeTruthy();
  });
});
