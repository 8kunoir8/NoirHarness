import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ChatHeader } from "../src/renderer/ChatHeader.js";

function renderHeader(diffStats?: { add: number; del: number }, onRename?: (title: string) => void): void {
  render(
    <ChatHeader
      title="Shell"
      status="idle"
      modelId={null}
      models={[]}
      {...(diffStats === undefined ? {} : { diffStats })}
      {...(onRename === undefined ? {} : { onRename })}
      canInterrupt={false}
      onInterrupt={() => undefined}
      onModelChange={() => undefined}
    />,
  );
}

describe("ChatHeader", () => {
  it("shows the changed-line totals beside the usage meter", () => {
    renderHeader({ add: 12, del: 3 });
    const stats = screen.getByRole("group", { name: "Diff stats" });
    expect(stats.textContent).toBe("+12 −3");
  });

  it("renders no diff stats when there is nothing to report", () => {
    renderHeader();
    expect(screen.queryByRole("group", { name: "Diff stats" })).toBeNull();
    expect(screen.queryByLabelText("Diff stats")).toBeNull();
  });

  it("commits a title typed into the heading and abandons one on Esc", async () => {
    const user = userEvent.setup();
    const onRename = vi.fn();
    renderHeader(undefined, onRename);

    await user.click(screen.getByRole("button", { name: "Rename chat" }));
    const field = screen.getByLabelText("Chat title");
    await user.clear(field);
    await user.type(field, "  Kernel audit {Enter}");
    expect(onRename).toHaveBeenCalledTimes(1);
    expect(onRename).toHaveBeenCalledWith("Kernel audit");

    await user.click(screen.getByRole("button", { name: "Rename chat" }));
    await user.type(screen.getByLabelText("Chat title"), "discarded{Escape}");
    expect(onRename).toHaveBeenCalledTimes(1);
    // Esc returns the heading, and the unchanged title is what it shows.
    expect(screen.getByRole("button", { name: "Rename chat" }).textContent).toBe("Shell");
  });
});
