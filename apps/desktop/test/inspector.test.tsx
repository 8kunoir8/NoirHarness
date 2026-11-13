import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { SessionView } from "@noir/protocol";
import { Inspector } from "../src/renderer/Inspector.js";

const session: SessionView = {
  id: "s1",
  workspaceId: "w1",
  agentId: "a1",
  engine: "acp",
  title: "Shell",
  status: "running",
  modelId: null,
  createdAt: 1,
  lastEventSeq: 0,
  lastEventAt: 1,
  pendingApproval: false,
  scheduleId: null,
};

describe("Inspector", () => {
  it("shows usage, changed files, plan and approvals", () => {
    render(
      <Inspector
        session={session}
        status="running"
        usage={{ used: 12_000, size: 200_000, inputTokens: 1_200, outputTokens: 340, costUsd: 0.0123 }}
        turnStartedAt={Date.now() - 4_000}
        files={[
          { path: "src/a.ts", change: "modified", add: 9, del: 2 },
          { path: "src/b.ts", change: "created", add: 3, del: 0 },
        ]}
        plan={[
          { text: "Wire the shell", status: "active" },
          { text: "Read the kernel", status: "done" },
        ]}
        approvalTitles={["Run tests?"]}
        onShowDiff={() => undefined}
        onClose={() => undefined}
      />,
    );

    expect(screen.getByTestId("inspector-status").textContent).toBe("running");
    expect(screen.getByTestId("inspector-turn").textContent).toBe("running");
    expect(screen.getByRole("region", { name: "Usage" }).textContent).toContain("$0.0123");
    expect(screen.getByRole("region", { name: "Usage" }).textContent).toContain("12k / 200k");
    expect(screen.getByRole("region", { name: "Changed files" }).textContent).toContain("2 files");
    expect(screen.getByRole("region", { name: "Changed files" }).textContent).toContain("+12");
    const planItems = screen.getByRole("region", { name: "Plan" }).querySelectorAll("li");
    expect([...planItems].map((item) => item.getAttribute("data-status"))).toEqual(["active", "done"]);
    expect(screen.getByRole("region", { name: "Approvals" }).textContent).toContain("Run tests?");
  });

  it("reports the finished turn and the empty state without a session", () => {
    const { rerender } = render(
      <Inspector
        session={session}
        status="idle"
        lastTurn={{ status: "interrupted", ms: 5_500 }}
        files={[]}
        plan={[]}
        approvalTitles={[]}
        onShowDiff={() => undefined}
        onClose={() => undefined}
      />,
    );
    expect(screen.getByTestId("inspector-turn").textContent).toBe("interrupted in 5.5s");
    expect(screen.getByRole("region", { name: "Usage" }).textContent).toContain("No usage reported yet.");
    expect(screen.getByRole("region", { name: "Changed files" }).textContent).toContain("No files changed.");

    rerender(
      <Inspector
        session={undefined}
        status="idle"
        files={[]}
        plan={[]}
        approvalTitles={[]}
        onShowDiff={() => undefined}
        onClose={() => undefined}
      />,
    );
    expect(screen.getByText(/Open a chat to inspect/)).toBeTruthy();
  });

  it("offers Preview only for previewable changed files", async () => {
    const onPreview = vi.fn();
    render(
      <Inspector
        session={session}
        status="idle"
        files={[
          { path: "notes.md", change: "modified", add: 2, del: 1 },
          { path: "src/b.ts", change: "created", add: 5, del: 0 },
        ]}
        plan={[]}
        approvalTitles={[]}
        onShowDiff={() => undefined}
        onPreview={onPreview}
        onClose={() => undefined}
      />,
    );

    expect(screen.queryByRole("button", { name: "Preview src/b.ts" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Preview notes.md" }));
    expect(onPreview).toHaveBeenCalledWith("notes.md");
  });

  it("opens the diff for a changed file", async () => {
    const onShowDiff = vi.fn();
    render(
      <Inspector
        session={session}
        status="idle"
        files={[
          { path: "src/a.ts", change: "modified", add: 2, del: 1 },
          { path: "src/b.ts", change: "created", add: 5, del: 0 },
        ]}
        plan={[]}
        approvalTitles={[]}
        onShowDiff={onShowDiff}
        onClose={() => undefined}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Show diff for src/b.ts" }));
    expect(onShowDiff).toHaveBeenCalledTimes(1);
    expect(onShowDiff).toHaveBeenCalledWith("src/b.ts");
  });
});
