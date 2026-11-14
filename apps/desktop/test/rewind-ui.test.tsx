import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ChatRewind } from "../src/renderer/events.js";
import { RewindDialog } from "../src/renderer/RewindDialog.js";
import { RewindMarker } from "../src/renderer/RewindMarker.js";

const plan = { restored: 2, deleted: 1, removed: 3, failed: [] };

function rewind(overrides: Partial<ChatRewind> = {}): ChatRewind {
  return {
    seq: 9,
    cutSeq: 1,
    promptSeq: 1,
    restored: 2,
    deleted: 1,
    removed: 3,
    failed: 0,
    notCaptured: 0,
    engineNotRewound: false,
    ...overrides,
  };
}

describe("RewindDialog", () => {
  it("shows what would change and confirms", async () => {
    const onConfirm = vi.fn();
    render(
      <RewindDialog phase="ready" plan={plan} notCaptured={0} error={undefined} onConfirm={onConfirm} onCancel={vi.fn()} />,
    );
    expect(screen.getByTestId("rewind-counts").textContent).toContain(
      "2 files restored · 1 deleted file · 3 created files removed",
    );
    await userEvent.click(screen.getByRole("button", { name: "Rewind" }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("refuses to confirm while the plan is still being computed", () => {
    render(
      <RewindDialog phase="planning" plan={undefined} notCaptured={0} error={undefined} onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Rewind" }).disabled).toBe(true);
    expect(screen.getByText("Checking what would change…")).not.toBeNull();
    // Focus is inside the dialog before a plan exists, and it is not on the destructive button.
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
  });

  it("states what it could not capture", () => {
    render(<RewindDialog phase="ready" plan={plan} notCaptured={4} error={undefined} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText(/4 items were not captured/)).not.toBeNull();
  });

  it("closes on Escape before the plan resolves", async () => {
    const onCancel = vi.fn();
    render(
      <RewindDialog phase="planning" plan={undefined} notCaptured={0} error={undefined} onConfirm={vi.fn()} onCancel={onCancel} />,
    );
    await userEvent.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("shows the failure and keeps the dialog open", () => {
    render(
      <RewindDialog
        phase="failed"
        plan={undefined}
        notCaptured={0}
        error="A turn is running in this workspace"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain("A turn is running in this workspace");
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Rewind" }).disabled).toBe(true);
  });
});

describe("RewindMarker", () => {
  it("reports the counts and offers the prompt back", async () => {
    const onLoadPrompt = vi.fn();
    render(<RewindMarker rewind={rewind()} onLoadPrompt={onLoadPrompt} />);
    expect(screen.getByTestId("rewind-marker").textContent).toContain("2 restored · 1 deleted · 3 removed");
    await userEvent.click(screen.getByRole("button", { name: "Load the prompt again" }));
    expect(onLoadPrompt).toHaveBeenCalledWith(1);
  });

  it("says when the engine keeps its own memory", () => {
    render(<RewindMarker rewind={rewind({ engineNotRewound: true })} />);
    expect(screen.getByText(/keeps its own memory/)).not.toBeNull();
  });

  it("speaks of one uncaptured item in the singular", () => {
    render(<RewindMarker rewind={rewind({ notCaptured: 1 })} />);
    expect(screen.getByText(/1 item was not captured/)).not.toBeNull();
  });

  it("has no prompt button when the prompt is gone", () => {
    render(<RewindMarker rewind={rewind({ promptSeq: null })} onLoadPrompt={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Load the prompt again" })).toBeNull();
  });

  it("has no prompt button without a handler", () => {
    render(<RewindMarker rewind={rewind()} />);
    expect(screen.queryByRole("button", { name: "Load the prompt again" })).toBeNull();
  });
});
