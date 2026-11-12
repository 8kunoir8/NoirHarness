import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SkillListParams } from "@noir/protocol";
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

  it("names the skill in a failed toggle and refreshes the list", async () => {
    const calls: string[] = [];
    const request = vi.fn(async (method: string): Promise<unknown> => {
      calls.push(method);
      if (method === "skill.list") {
        return {
          skills: [
            { scope: "global", name: "stubborn", description: "won't move", hash: "s".repeat(64), enabled: true },
          ],
          shadowed: [],
          warnings: [],
        };
      }
      if (method === "skill.setEnabled") throw new Error("write failed");
      throw new Error(method);
    }) as unknown as RequestFn;

    render(<Skills workspaceId="ws-1" request={request} />);
    await userEvent.click(await screen.findByRole("button", { name: "Disable stubborn" }));

    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("write failed"));
    expect(screen.getByRole("status").textContent).toContain("stubborn");
    expect(calls.filter((method) => method === "skill.list")).toHaveLength(2);
  });

  it("keeps the new workspace's rows when a toggle settles after a switch", async () => {
    const { promise: pendingToggle, resolve: finishToggle } = Promise.withResolvers<void>();
    const listCalls: string[] = [];
    const request = vi.fn(async (method: string, params: unknown): Promise<unknown> => {
      if (method === "skill.setEnabled") {
        await pendingToggle;
        return { ok: true };
      }
      if (method === "skill.list") {
        const workspaceId = SkillListParams.parse(params).workspaceId ?? "";
        listCalls.push(workspaceId);
        return {
          skills: [
            {
              scope: "global",
              name: workspaceId === "ws-1" ? "alpha" : "beta",
              description: workspaceId,
              hash: "a".repeat(64),
              enabled: true,
            },
          ],
          shadowed: [],
          warnings: [],
        };
      }
      throw new Error(method);
    }) as unknown as RequestFn;

    const { rerender } = render(<Skills workspaceId="ws-1" request={request} />);
    await userEvent.click(await screen.findByRole("button", { name: "Disable alpha" }));

    rerender(<Skills workspaceId="ws-2" request={request} />);
    await waitFor(() => expect(screen.getByRole("region", { name: "Global skills" }).textContent).toContain("beta"));

    finishToggle?.();
    await waitFor(() =>
      expect(screen.getByRole("region", { name: "Global skills" }).textContent).not.toContain("alpha"),
    );
    expect(listCalls).toEqual(["ws-1", "ws-2"]);
  });

  it("installs from a path, shows the source, and gates an update on the checked hash", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    let installed = false;
    const request = vi.fn(async (method: string, params: unknown): Promise<unknown> => {
      calls.push({ method, params });
      if (method === "skill.list") {
        return {
          skills: installed
            ? [{
                scope: "project", name: "new", description: "d", hash: "n".repeat(64), enabled: true,
                source: { kind: "local", url: "/seed/new", ref: null, commit: null, hash: "n".repeat(64), updateAvailable: false },
              }]
            : [],
          shadowed: [],
          warnings: [],
        };
      }
      if (method === "skill.install") {
        installed = true;
        return { ok: true, name: "new", hash: "n".repeat(64) };
      }
      if (method === "skill.checkUpdate") return { commit: null, hash: "m".repeat(64), changed: true };
      if (method === "skill.update") return { commit: null, hash: "m".repeat(64) };
      throw new Error(method);
    }) as unknown as RequestFn;

    render(<Skills workspaceId="ws-1" request={request} />);
    await userEvent.type(screen.getByLabelText("Skill source"), "/seed/new");
    await userEvent.click(screen.getByRole("button", { name: "Install skill" }));

    const project = screen.getByRole("region", { name: "Project skills" });
    await waitFor(() => expect(project.textContent).toContain("new"));
    // The row shows a label; the path it came from is the element's title, so both are observable.
    expect(within(project).getByTitle("/seed/new")).toBeDefined();

    await userEvent.click(within(project).getByRole("button", { name: "Check for updates new" }));
    const update = await within(project).findByRole("button", { name: "Update new" });
    await userEvent.click(update);
    // The confirmation carries the hash the user was shown, so the kernel enforces exactly that pin.
    expect(calls).toContainEqual({
      method: "skill.update",
      params: { workspaceId: "ws-1", scope: "project", name: "new", expectHash: "m".repeat(64) },
    });
  });

  it("keys the badge, the pin, and a hand-placed row on their own scope", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const request = vi.fn(async (method: string, params: unknown): Promise<unknown> => {
      calls.push({ method, params });
      if (method === "skill.list") {
        return {
          skills: [
            {
              scope: "global", name: "dup", description: "g", hash: "g".repeat(64), enabled: true,
              source: { kind: "git", url: "https://host/dup.git", ref: "main", commit: "a".repeat(40), hash: "g".repeat(64), updateAvailable: true },
            },
            {
              scope: "project", name: "dup", description: "p", hash: "p".repeat(64), enabled: true,
              source: { kind: "local", url: "/p/dup", ref: null, commit: null, hash: "p".repeat(64), updateAvailable: true },
            },
            { scope: "project", name: "loose", description: "", hash: "l".repeat(64), enabled: true, source: null },
          ],
          shadowed: [],
          warnings: [],
        };
      }
      if (method === "skill.checkUpdate") return { commit: "b".repeat(40), hash: "m".repeat(64), changed: true };
      if (method === "skill.update") return { commit: "b".repeat(40), hash: "m".repeat(64) };
      throw new Error(method);
    }) as unknown as RequestFn;

    render(<Skills workspaceId="ws-1" request={request} />);
    const global = screen.getByRole("region", { name: "Global skills" });
    const project = screen.getByRole("region", { name: "Project skills" });
    await waitFor(() => expect(project.textContent).toContain("dup"));

    // A list that claims an update proves nothing: only a check can raise the badge.
    expect(within(global).queryByRole("button", { name: "Update dup" })).toBeNull();
    expect(within(project).queryByRole("button", { name: "Update dup" })).toBeNull();
    // A hand-placed row has no provenance, so it shows no source line and no update control.
    const loose = within(project).getByRole("button", { name: "View loose" }).closest("li");
    expect(loose?.querySelector(".skills-source")).toBeNull();
    expect(within(project).queryByRole("button", { name: "Check for updates loose" })).toBeNull();
    // The git row names its short commit; the full url stays behind the title.
    expect(within(global).getByTitle("https://host/dup.git").textContent).toBe(`git ${"a".repeat(7)}`);
    expect(within(project).getByTitle("/p/dup").textContent).toBe("local");

    await userEvent.click(within(global).getByRole("button", { name: "Check for updates dup" }));
    await userEvent.click(await within(global).findByRole("button", { name: "Update dup" }));
    // The project `dup` was never checked, so it has no pin to confirm.
    expect(within(project).queryByRole("button", { name: "Update dup" })).toBeNull();
    expect(calls).toContainEqual({
      method: "skill.update",
      params: { workspaceId: "ws-1", scope: "global", name: "dup", expectHash: "m".repeat(64) },
    });

    // The update reloads the list, which again claims an update; the spent pin stays silent.
    await waitFor(() => expect(calls.filter((call) => call.method === "skill.list")).toHaveLength(2));
    expect(screen.queryByRole("button", { name: "Update dup" })).toBeNull();
  });
});
