import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { AgentRosterEntry } from "@noir/protocol";
import { LiveSidebar } from "../src/renderer/LiveSidebar.js";

function entry(overrides: Partial<AgentRosterEntry>): AgentRosterEntry {
  return {
    agentId: "a-1",
    name: "Scout",
    role: "owner",
    status: "working",
    activeSessionId: "s-1",
    activeSessionStatus: "running",
    activeToolKind: "shell",
    sessionCount: 1,
    lastActivityAt: 1,
    usage: null,
    pendingApproval: null,
    ...overrides,
  };
}

function doing(overrides: Partial<AgentRosterEntry>, activity?: string): string | null {
  const { container } = render(
    <LiveSidebar
      roster={[entry(overrides)]}
      agentId="a-1"
      activity={activity}
      showOffice={false}
      onOpenAgents={() => undefined}
    />,
  );
  return container.querySelector(".sidebar-doing")?.textContent ?? null;
}

describe("LiveSidebar", () => {
  it("names the tool the open chat's agent is running", () => {
    expect(doing({}, "Run `pnpm test`")).toBe("Run `pnpm test`");
    // No tool yet: the turn is still thinking.
    expect(doing({ status: "working" })).toBe("Thinking");
    expect(doing({ status: "idle", activeToolKind: null })).toBe("Idle");
  });

  it("puts the status ahead of a stale running tool", () => {
    // An approval or a stop can arrive while the tool's own status is still `running`.
    expect(doing({ status: "needs_you" }, "Run `pnpm test`")).toBe("Waiting on your approval");
    expect(doing({ status: "error" }, "Run `pnpm test`")).toBe("Stopped on an error");
  });

  it("says nothing about an agent that is not in the roster", () => {
    render(
      <LiveSidebar roster={[]} agentId="a-9" activity={undefined} showOffice={false} onOpenAgents={() => undefined} />,
    );
    expect(screen.getByText("This chat has no agent in the roster.")).toBeTruthy();
  });
});
