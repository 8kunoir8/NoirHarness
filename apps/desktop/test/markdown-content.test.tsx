import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { RequestFn } from "../src/renderer/api.js";
import { MarkdownContent } from "../src/renderer/MarkdownContent.js";

/** The component asks generically; this fake answers `artifact.read` and records the paths. */
function reader(answers: (path: string) => unknown, seen: string[] = []): RequestFn {
  return <T,>(method: string, params?: unknown): Promise<T> => {
    if (method !== "artifact.read") return Promise.reject(new Error(`unexpected ${method}`));
    const path = (params as { path: string }).path;
    seen.push(path);
    try {
      return Promise.resolve(answers(path) as T);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  };
}

describe("MarkdownContent", () => {
  it("renders GFM as blocks: a table with headers, a list and a rule", () => {
    const { container } = render(
      <MarkdownContent
        variant="chat"
        content={"| agent | status |\n| --- | --- |\n| Scout | working |\n\n- one\n- two\n\n---\n"}
      />,
    );

    const table = container.querySelector(".markdown-table table");
    expect(table).not.toBeNull();
    expect([...container.querySelectorAll("th")].map((cell) => cell.textContent)).toEqual(["agent", "status"]);
    expect([...container.querySelectorAll("td")].map((cell) => cell.textContent)).toEqual(["Scout", "working"]);
    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(container.querySelector("hr")).not.toBeNull();
    // The chat wrapper styles the bubble; the artifact wrapper would pad it like a page.
    expect(container.querySelector(".markdown-chat")).not.toBeNull();
  });

  it("shows a workspace image by reading its bytes", async () => {
    const seen: string[] = [];
    const request = reader(() => ({ encoding: "base64", content: "iVBORw0KGgo=", size: 8, mtimeMs: 0, truncated: false }), seen);
    const { container } = render(
      <MarkdownContent
        variant="chat"
        content={"before\n\n![the chart](docs/chart.png)\n"}
        images={{ workspaceId: "w-1", request }}
      />,
    );

    await waitFor(() => expect(container.querySelector("img")).not.toBeNull());
    const image = container.querySelector("img");
    expect(image?.getAttribute("src")).toBe("data:image/png;base64,iVBORw0KGgo=");
    expect(image?.getAttribute("alt")).toBe("the chart");
    expect(seen).toEqual(["docs/chart.png"]);
  });

  it("lets an absolute image load without touching the workspace", () => {
    const seen: string[] = [];
    const { container } = render(
      <MarkdownContent
        variant="chat"
        content={"![remote](https://example.com/p.png)"}
        images={{ workspaceId: "w-1", request: reader(() => undefined, seen) }}
      />,
    );

    expect(container.querySelector("img")?.getAttribute("src")).toBe("https://example.com/p.png");
    expect(seen).toEqual([]);
  });

  it("keeps a text reference when the file is not an image or cannot be read", async () => {
    const request = reader(() => {
      throw new Error("File not found");
    });
    const { container } = render(
      <MarkdownContent variant="chat" content={"![gone](missing.png)\n"} images={{ workspaceId: "w-1", request }} />,
    );

    await waitFor(() => expect(screen.getByText("gone")).toBeTruthy());
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".artifact-image-ref")?.textContent).toBe("gone");
  });

  it("drops raw HTML and refuses a link it cannot open", () => {
    const { container } = render(
      <MarkdownContent content={'<script>alert(1)</script>\n\n[tap](javascript:alert(1))'} />,
    );

    expect(container.querySelector("script")).toBeNull();
    // The text survives, the navigation does not.
    expect(container.textContent).toContain("tap");
    expect(container.querySelector("a")).toBeNull();
  });
});
