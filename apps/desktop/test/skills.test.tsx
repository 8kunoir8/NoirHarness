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
    let body = "OLD_BODY";
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
      if (method === "skill.update") {
        body = "NEW_BODY";
        return { commit: null, hash: "m".repeat(64) };
      }
      if (method === "skill.read") return { content: body, hash: "n".repeat(64), truncated: false };
      throw new Error(method);
    }) as unknown as RequestFn;

    render(<Skills workspaceId="ws-1" request={request} />);
    await userEvent.type(screen.getByLabelText("Skill source"), "/seed/new");
    await userEvent.click(screen.getByRole("button", { name: "Install skill" }));

    const project = screen.getByRole("region", { name: "Project skills" });
    await waitFor(() => expect(project.textContent).toContain("new"));
    // The row shows a label; the path it came from is the element's title, so both are observable.
    expect(within(project).getByTitle("/seed/new")).toBeDefined();
    // The install is asserted exactly: a hardcoded kind, a dropped source, or the default scope fails.
    expect(calls).toContainEqual({
      method: "skill.install",
      params: { workspaceId: "ws-1", scope: "project", kind: "local", source: "/seed/new" },
    });
    // Have the pane open, so the update has something stale to replace.
    await userEvent.click(within(project).getByRole("button", { name: "View new" }));
    const bodyPane = screen.getByRole("region", { name: "Skill body" });
    await waitFor(() => expect(bodyPane.textContent).toContain("OLD_BODY"));

    await userEvent.click(within(project).getByRole("button", { name: "Check for updates new" }));
    // Opening the update only shows what would change; nothing is written yet.
    await userEvent.click(await within(project).findByRole("button", { name: "Update new" }));
    // Installed hash → fetched hash, both shortened, so the user sees what they are replacing.
    expect(within(project).getByText(`new: ${"n".repeat(7)} → ${"m".repeat(7)}`)).toBeDefined();
    await userEvent.click(within(project).getByRole("button", { name: "Cancel update new" }));
    expect(calls.some((call) => call.method === "skill.update")).toBe(false);

    await userEvent.click(within(project).getByRole("button", { name: "Update new" }));
    await userEvent.click(within(project).getByRole("button", { name: "Confirm update new" }));
    // The confirmation carries the hash the user was shown, so the kernel enforces exactly that pin.
    expect(calls).toContainEqual({
      method: "skill.update",
      params: { workspaceId: "ws-1", scope: "project", name: "new", expectHash: "m".repeat(64) },
    });
    expect(calls.filter((call) => call.method === "skill.update")).toHaveLength(1);
    // The update replaced the files, so the open pane must show what is now on disk.
    await waitFor(() => expect(bodyPane.textContent).toContain("NEW_BODY"));
    expect(bodyPane.textContent).not.toContain("OLD_BODY");
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
    await userEvent.click(within(global).getByRole("button", { name: "Confirm update dup" }));
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

  it("installs into the scope the user selected and refuses an empty source", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const request = vi.fn(async (method: string, params: unknown): Promise<unknown> => {
      calls.push({ method, params });
      if (method === "skill.list") return { skills: [], shadowed: [], warnings: [] };
      if (method === "skill.install") return { ok: true, name: "g", hash: "g".repeat(64) };
      throw new Error(method);
    }) as unknown as RequestFn;

    render(<Skills workspaceId="ws-1" request={request} />);
    const install = screen.getByRole("button", { name: "Install skill" });
    // An empty source cannot install, and whitespace is not a source either.
    await userEvent.click(install);
    await userEvent.type(screen.getByLabelText("Skill source"), "   ");
    await userEvent.click(install);
    expect(calls.some((call) => call.method === "skill.install")).toBe(false);
    await userEvent.clear(screen.getByLabelText("Skill source"));

    await userEvent.selectOptions(screen.getByLabelText("Scope"), "global");
    await userEvent.type(screen.getByLabelText("Skill source"), "https://host/g.git");
    await userEvent.click(screen.getByRole("button", { name: "Install skill" }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: "skill.install",
        params: { workspaceId: "ws-1", scope: "global", kind: "git", source: "https://host/g.git" },
      }),
    );
  });

  it("drops a refused update's pin so the row cannot resend the same failing hash", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const request = vi.fn(async (method: string, params: unknown): Promise<unknown> => {
      calls.push({ method, params });
      if (method === "skill.list") {
        return {
          skills: [{
            scope: "project", name: "stale", description: "d", hash: "s".repeat(64), enabled: true,
            source: { kind: "local", url: "/seed/stale", ref: null, commit: null, hash: "s".repeat(64), updateAvailable: false },
          }],
          shadowed: [],
          warnings: [],
        };
      }
      if (method === "skill.checkUpdate") return { commit: null, hash: "t".repeat(64), changed: true };
      if (method === "skill.update") throw new Error("conflict: the installed hash moved");
      throw new Error(method);
    }) as unknown as RequestFn;

    render(<Skills workspaceId="ws-1" request={request} />);
    const project = screen.getByRole("region", { name: "Project skills" });
    await userEvent.click(
      await within(project).findByRole("button", { name: "Check for updates stale" }),
    );
    await userEvent.click(await within(project).findByRole("button", { name: "Update stale" }));
    await userEvent.click(within(project).getByRole("button", { name: "Confirm update stale" }));

    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("conflict"));
    // The refused pin is gone, so neither the badge nor a second confirmation survives it.
    expect(within(project).queryByRole("button", { name: "Update stale" })).toBeNull();
    expect(within(project).queryByRole("button", { name: "Confirm update stale" })).toBeNull();
    expect(calls.filter((call) => call.method === "skill.update")).toHaveLength(1);
  });

  it("keeps a stale-list error after a successful update instead of re-reading the body", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    let lists = 0;
    const request = vi.fn(async (method: string, params: unknown): Promise<unknown> => {
      calls.push({ method, params });
      if (method === "skill.list") {
        lists += 1;
        if (lists > 1) throw new Error("skills directory unreadable");
        return {
          skills: [{
            scope: "project", name: "moved", description: "d", hash: "s".repeat(64), enabled: true,
            source: { kind: "local", url: "/seed/moved", ref: null, commit: null, hash: "s".repeat(64), updateAvailable: false },
          }],
          shadowed: [],
          warnings: [],
        };
      }
      if (method === "skill.read") return { content: "OLD_BODY", hash: "s".repeat(64), truncated: false };
      if (method === "skill.checkUpdate") return { commit: null, hash: "t".repeat(64), changed: true };
      if (method === "skill.update") return { commit: null, hash: "t".repeat(64) };
      throw new Error(method);
    }) as unknown as RequestFn;

    render(<Skills workspaceId="ws-1" request={request} />);
    const project = screen.getByRole("region", { name: "Project skills" });
    await userEvent.click(await within(project).findByRole("button", { name: "View moved" }));
    const bodyPane = screen.getByRole("region", { name: "Skill body" });
    await waitFor(() => expect(bodyPane.textContent).toContain("OLD_BODY"));

    await userEvent.click(within(project).getByRole("button", { name: "Check for updates moved" }));
    await userEvent.click(await within(project).findByRole("button", { name: "Update moved" }));
    await userEvent.click(within(project).getByRole("button", { name: "Confirm update moved" }));

    // The update landed but the list did not: the error stands, and the pane is not re-read over it.
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain("skills directory unreadable"),
    );
    expect(calls.filter((call) => call.method === "skill.read")).toHaveLength(1);
    expect(bodyPane.textContent).toContain("OLD_BODY");
    expect(calls.filter((call) => call.method === "skill.update")).toHaveLength(1);
  });
});
