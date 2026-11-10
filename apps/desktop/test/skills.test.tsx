import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { RequestFn } from "../src/renderer/api.js";
import { Skills } from "../src/renderer/Skills.js";

describe("Skills", () => {
  it("lists global and project skills, toggles one, and shows its body", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const request = vi.fn(async (method: string, params: unknown): Promise<unknown> => {
      calls.push({ method, params });
      if (method === "skill.list") {
        return {
          skills: [
            { scope: "project", name: "shared", description: "project copy", hash: "p".repeat(64), enabled: true },
          ],
          shadowed: ["shared"],
          warnings: ["global:broken: SKILL.md has no name"],
        };
      }
      if (method === "skill.setEnabled") return { ok: true };
      if (method === "skill.read") {
        return { content: "---\nname: shared\n---\nBODY", hash: "p".repeat(64), truncated: false };
      }
      throw new Error(method);
    }) as unknown as RequestFn;

    render(<Skills workspaceId="ws-1" request={request} />);
    const project = screen.getByRole("region", { name: "Project skills" });
    await waitFor(() => expect(project.textContent).toContain("project copy"));
    expect(project.textContent).toContain("p".repeat(12));
    expect(screen.getByRole("region", { name: "Global skills" }).textContent).toContain(
      "shadowed by a project skill",
    );
    expect(screen.getByRole("status").textContent).toContain("global:broken");

    await userEvent.click(within(project).getByRole("button", { name: "Disable shared" }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: "skill.setEnabled",
        params: { workspaceId: "ws-1", scope: "project", name: "shared", enabled: false },
      }),
    );
    await waitFor(() => expect(calls.filter((call) => call.method === "skill.list")).toHaveLength(2));

    await userEvent.click(within(project).getByRole("button", { name: "View shared" }));
    await waitFor(() =>
      expect(screen.getByRole("region", { name: "Skill body" }).textContent).toContain("BODY"),
    );
  });

  it("enables a disabled global skill", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const request = vi.fn(async (method: string, params: unknown): Promise<unknown> => {
      calls.push({ method, params });
      if (method === "skill.list") {
        return {
          skills: [{ scope: "global", name: "quiet", description: "global copy", hash: "g".repeat(64), enabled: false }],
          shadowed: [],
          warnings: [],
        };
      }
      if (method === "skill.setEnabled") return { ok: true };
      throw new Error(method);
    }) as unknown as RequestFn;

    render(<Skills workspaceId="ws-1" request={request} />);
    const global = screen.getByRole("region", { name: "Global skills" });
    await userEvent.click(await within(global).findByRole("button", { name: "Enable quiet" }));

    await waitFor(() =>
      expect(calls).toContainEqual({
        method: "skill.setEnabled",
        params: { workspaceId: "ws-1", scope: "global", name: "quiet", enabled: true },
      }),
    );
    expect(screen.getByRole("region", { name: "Project skills" }).textContent).toContain("No project skills");
  });

  it("shows a hint without listing when no workspace is selected", () => {
    const request = vi.fn(async (): Promise<unknown> => {
      throw new Error("skill.list must not be called without a workspace");
    }) as unknown as RequestFn;

    render(<Skills workspaceId="" request={request} />);
    expect(screen.getByText(/Select a workspace/)).toBeTruthy();
    expect(request).not.toHaveBeenCalled();
  });

  it("renders request errors as a status row", async () => {
    const request = vi.fn(async (): Promise<unknown> => {
      throw new Error("skills directory unreadable");
    }) as unknown as RequestFn;

    render(<Skills workspaceId="ws-1" request={request} />);
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain("skills directory unreadable"),
    );
  });
});
