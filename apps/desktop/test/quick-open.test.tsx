import { act, fireEvent, render, screen } from "@testing-library/react";
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

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  const { promise, resolve } = Promise.withResolvers<T>();
  return { promise, resolve };
}

function workspaceOf(params: unknown): string {
  if (typeof params !== "object" || params === null) return "";
  if (!("workspaceId" in params)) return "";
  return typeof params.workspaceId === "string" ? params.workspaceId : "";
}

describe("subsequence", () => {
  it("matches case-insensitively while preserving character order", () => {
    expect(subsequence("src/Main.ts", "SMAIN")).toBe(true);
    expect(subsequence("src/main.ts", "ni")).toBe(false);
    expect(subsequence("README.md", "")).toBe(true);
  });

  it("matches on code points rather than UTF-16 units", () => {
    expect(subsequence("docs/🎉/notes.md", "🎉N")).toBe(true);
    expect(subsequence("docs/🎉/notes.md", "🎊")).toBe(false);
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

  it("announces the empty state", async () => {
    renderQuickOpen();
    await screen.findByText("src/main.ts");
    await userEvent.type(screen.getByRole("combobox", { name: "Open file" }), "zzz");

    expect((await screen.findByRole("status")).textContent).toBe("No matching files.");
  });

  it("requests fs.files for the mounted workspace", async () => {
    const requestSpy = vi.fn(async () => ({ files: ["a.ts"], truncated: false }));
    renderQuickOpen({ request: requestSpy });
    await screen.findByText("a.ts");

    expect(requestSpy).toHaveBeenCalledWith("fs.files", { workspaceId: "w1" });
  });

  it("picks the clicked row with the pointer", async () => {
    const onPick = vi.fn();
    const onClose = vi.fn();
    renderQuickOpen({ onPick, onClose });
    await screen.findByText("src/app.tsx");

    await userEvent.click(screen.getByText("src/app.tsx"));

    expect(onPick).toHaveBeenCalledWith("src/app.tsx");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes when the backdrop is clicked", async () => {
    const onClose = vi.fn();
    const view = renderQuickOpen({ onClose });
    await screen.findByText("src/main.ts");

    const backdrop = view.container.querySelector<HTMLElement>(".quick-open-backdrop");
    expect(backdrop).not.toBeNull();
    if (backdrop === null) throw new Error("backdrop missing");
    await userEvent.click(backdrop);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("drops the old listing while a new workspace is still loading", async () => {
    const pending = deferred<{ files: string[]; truncated: boolean }>();
    const requestFn = vi.fn((_method: string, params?: unknown) => {
      return workspaceOf(params) === "w1"
        ? Promise.resolve({ files: ["old.txt"], truncated: false })
        : pending.promise;
    });
    const view = render(
      <QuickOpen
        request={requestFn as never}
        workspaceId="w1"
        onPick={() => undefined}
        onClose={() => undefined}
      />,
    );
    expect(await screen.findByText("old.txt")).toBeTruthy();

    view.rerender(
      <QuickOpen
        request={requestFn as never}
        workspaceId="w2"
        onPick={() => undefined}
        onClose={() => undefined}
      />,
    );
    expect(screen.queryByText("old.txt")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("No matching files.");

    await act(async () => {
      pending.resolve({ files: ["new.txt"], truncated: false });
      await pending.promise;
    });
    expect(await screen.findByText("new.txt")).toBeTruthy();
  });

  it("writes nothing when unmounted before fs.files resolves", async () => {
    const pending = deferred<{ files: string[]; truncated: boolean }>();
    const requestFn = vi.fn(() => pending.promise);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const view = renderQuickOpen({ request: requestFn });

    view.unmount();
    await act(async () => {
      pending.resolve({ files: ["late.ts"], truncated: false });
      await pending.promise;
    });

    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("shows the alert when request throws synchronously", async () => {
    const sync = vi.fn(() => {
      throw new Error("sync boom");
    });
    renderQuickOpen({ request: sync });

    expect((await screen.findByRole("alert")).textContent).toContain("sync boom");
  });
});
