import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { UpdateState } from "@noir/protocol";
import { UpdateRow, UpdateToast, updateSummary } from "../src/renderer/UpdateNotice.js";

function state(patch: Partial<UpdateState> = {}): UpdateState {
  return {
    current: "0.1.0",
    latest: "v0.2.0",
    status: "available",
    checkedAt: 1_700_000_000_000,
    dismissed: false,
    url: "https://github.com/8kunoir8/NoirHarness",
    ...patch,
  };
}

const noop = (): void => undefined;

describe("updateSummary", () => {
  it("says the newest fact in one phrase, including why a check failed", () => {
    expect(updateSummary(state())).toBe("v0.2.0 is available");
    expect(updateSummary(state({ status: "current", latest: "v0.1.0" }))).toBe("Up to date");
    expect(updateSummary(state({ status: "failed", reason: "git not found" }))).toBe("Could not check: git not found");
    // A failure with no reason still has to explain itself rather than show a bare label.
    expect(updateSummary(state({ status: "failed" }))).toBe("Could not check: git did not answer");
  });
});

describe("UpdateRow", () => {
  it("shows the version, the tag and when the kernel last asked", () => {
    const { rerender } = render(<UpdateRow state={state()} checking={false} onCheck={noop} onDismiss={noop} />);

    const row = screen.getByTestId("update-row");
    expect(within(row).getByText("v0.2.0 is available")).toBeTruthy();
    expect(within(row).getByText("v0.2.0")).toBeTruthy();
    expect(within(row).getByText("0.1.0")).toBeTruthy();
    expect(within(row).getByText(new Date(1_700_000_000_000).toLocaleString())).toBeTruthy();

    // Never checked is its own answer, not the epoch printed as a date.
    rerender(<UpdateRow state={state({ checkedAt: 0 })} checking={false} onCheck={noop} onDismiss={noop} />);
    expect(within(row).getByText("never")).toBeTruthy();
  });

  it("reports a failed check with the reason and hides the release links", () => {
    render(
      <UpdateRow
        state={state({ status: "failed", reason: "git not found" })}
        checking={false}
        onCheck={noop}
        onDismiss={noop}
      />,
    );

    expect(screen.getByText("Could not check: git not found")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /What's new/ })).toBeNull();
  });

  it("distinguishes checking from idle, and offers a forced check", async () => {
    const onCheck = vi.fn();
    render(<UpdateRow state={state()} checking onCheck={onCheck} onDismiss={noop} />);

    const check = screen.getByRole("button", { name: "Checking…" }) as HTMLButtonElement;
    expect(check.disabled).toBe(true);
    await userEvent.click(check);
    expect(onCheck).not.toHaveBeenCalled();
  });

  it("offers Dismiss only while the release is undismissed, and names its version", async () => {
    const onDismiss = vi.fn();
    const { rerender } = render(<UpdateRow state={state()} checking={false} onCheck={noop} onDismiss={onDismiss} />);

    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onDismiss).toHaveBeenCalledWith("v0.2.0");

    rerender(<UpdateRow state={state({ dismissed: true })} checking={false} onCheck={noop} onDismiss={onDismiss} />);
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
  });
});

describe("UpdateToast", () => {
  it("announces an undismissed release once, with both ways out", async () => {
    const openExternal = vi.fn(async () => undefined);
    window.noir = { openExternal } as unknown as Window["noir"];
    const onDismiss = vi.fn();
    try {
      render(<UpdateToast state={state()} onDismiss={onDismiss} />);

      const toast = screen.getByTestId("update-toast");
      expect(toast.getAttribute("role")).toBe("status");
      await userEvent.click(within(toast).getByRole("button", { name: /What's new/ }));
      expect(openExternal).toHaveBeenCalledWith("https://github.com/8kunoir8/NoirHarness");
      await userEvent.click(within(toast).getByRole("button", { name: "Dismiss" }));
      expect(onDismiss).toHaveBeenCalledWith("v0.2.0");
    } finally {
      delete window.noir;
    }
  });

  it("renders nothing when there is no release to announce", () => {
    const { container, rerender } = render(<UpdateToast state={state({ status: "current" })} onDismiss={noop} />);
    expect(container.firstChild).toBeNull();

    rerender(<UpdateToast state={state({ dismissed: true })} onDismiss={noop} />);
    expect(container.firstChild).toBeNull();
  });
});
