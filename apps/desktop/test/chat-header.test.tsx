import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ChatHeader } from "../src/renderer/ChatHeader.js";

function renderHeader(diffStats?: { add: number; del: number }): void {
  render(
    <ChatHeader
      title="Shell"
      status="idle"
      modelId={null}
      models={[]}
      {...(diffStats === undefined ? {} : { diffStats })}
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
});
