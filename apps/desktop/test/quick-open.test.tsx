import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QuickOpen, subsequence } from "../src/renderer/QuickOpen.js";

const request = vi.fn(async () => ({ files: ["src/main.ts", "src/app.tsx", "README.md"], truncated: false }));

beforeEach(() => {
  request.mockClear();
});

function renderQuickOpen(options: {
  request?: unknown;
  onPick?: (path: string) => void;
  onClose?: () => void;
} = {}) {
  return render(
    <QuickOpen
      request={(options.request ?? request) as never}
      workspaceId="w1"
      onPick={options.onPick ?? (() => undefined)}
      onClose={options.onClose ?? (() => undefined)}
    />,
  );
}

describe("subsequence", () => {
  it("matches case-insensitively while preserving character order", () => {
    expect(subsequence("src/Main.ts", "SMAIN")).toBe(true);
    expect(subsequence("src/main.ts", "ni")).toBe(false);
    expect(subsequence("README.md", "")).toBe(true);
  });
});

describe("QuickOpen", () => {
  it("filters on a subsequence and picks with Enter", async () => {
    const onPick = vi.fn();
    render(<QuickOpen request={request as never} workspaceId="w1" onPick={onPick} onClose={() => undefined} />);
    const input = screen.getByRole("combobox", { name: "Open file" });

    await userEvent.type(input, "smain");
    await screen.findByText("src/main.ts");
    expect(screen.queryByText("README.md")).toBeNull();

    await userEvent.keyboard("{Enter}");
    expect(onPick).toHaveBeenCalledWith("src/main.ts");
  });

  it("closes on Escape", async () => {
    const onClose = vi.fn();
    render(<QuickOpen request={request as never} workspaceId="w1" onPick={() => undefined} onClose={onClose} />);
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  it("closes on Escape from the dialog itself", async () => {
    const onClose = vi.fn();
    renderQuickOpen({ onClose });
    await screen.findByText("src/main.ts");

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows an alert and an empty list when fs.files fails", async () => {
    const failing = vi.fn(async () => {
      throw new Error("kernel offline");
    });
    renderQuickOpen({ request: failing });

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("kernel offline");
    expect(screen.queryAllByRole("option")).toHaveLength(0);
  });

  it("clamps the active row at both ends instead of wrapping", async () => {
    const onPick = vi.fn();
    renderQuickOpen({ onPick });
    await screen.findByText("README.md");

    await userEvent.keyboard("{ArrowUp}");
    await userEvent.keyboard("{Enter}");
    expect(onPick).toHaveBeenLastCalledWith("src/main.ts");

    await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}");
    await userEvent.keyboard("{Enter}");
    expect(onPick).toHaveBeenLastCalledWith("README.md");
  });

  it("does not pick when the query has no matches", async () => {
    const onPick = vi.fn();
    renderQuickOpen({ onPick });
    await screen.findByText("src/main.ts");

    await userEvent.type(screen.getByRole("combobox", { name: "Open file" }), "zzz");
    await screen.findByText("No matching files.");
    await userEvent.keyboard("{Enter}");

    expect(onPick).not.toHaveBeenCalled();
  });

  it("keeps the active row inside the list after the query changes", async () => {
    const onPick = vi.fn();
    renderQuickOpen({ onPick });
    await screen.findByText("README.md");

    await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}");
    await userEvent.type(screen.getByRole("combobox", { name: "Open file" }), "main");
    await screen.findByText("src/main.ts");
    await userEvent.keyboard("{Enter}");

    expect(onPick).toHaveBeenCalledWith("src/main.ts");
  });

  it("notes a truncated listing", async () => {
    const truncated = vi.fn(async () => ({ files: ["a.ts"], truncated: true }));
    renderQuickOpen({ request: truncated });
    expect(await screen.findByText("Showing the first 5,000 files.")).toBeTruthy();
  });

  it("lists at most twenty rows", async () => {
    const many = vi.fn(async () => ({
      files: Array.from({ length: 25 }, (_, index) => `file-${String(index).padStart(2, "0")}.ts`),
      truncated: false,
    }));
    renderQuickOpen({ request: many });

    await screen.findByText("file-00.ts");
    expect(screen.getAllByRole("option")).toHaveLength(20);
  });

  it("keeps activedescendant and option ids aligned and unique", async () => {
    renderQuickOpen();
    const input = screen.getByRole("combobox", { name: "Open file" });
    await userEvent.type(input, "s");

    const options = screen.getAllByRole("option");
    const ids = options.map((option) => option.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(input.getAttribute("aria-activedescendant"));
    expect(options.filter((option) => option.getAttribute("aria-selected") === "true")).toHaveLength(1);
  });
});
