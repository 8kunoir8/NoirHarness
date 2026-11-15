import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { GitFileStatus, GitStatusResult } from "@noir/protocol";
import type { RequestFn } from "../src/renderer/api.js";
import { Source } from "../src/renderer/Source.js";

function file(path: string, patch: Partial<GitFileStatus> = {}): GitFileStatus {
  return { path, change: "modified", add: 1, del: 0, index: null, worktree: "modified", ...patch };
}

function status(patch: Partial<GitStatusResult> = {}): GitStatusResult {
  return { isRepo: true, branch: "main", ahead: 0, behind: 0, files: [], ...patch };
}

interface FakeRequest {
  /** The function the page calls. */
  send: RequestFn;
  /** How many times `method` was asked for. */
  calls(method: string): number;
  /** The params of the first call to `method`. */
  params(method: string): unknown;
}

/** A kernel that answers each git method with whatever the test says, and records the calls. */
function fakeRequest(answers: Record<string, unknown>): FakeRequest {
  const fn = vi.fn(async (method: string, _params?: unknown): Promise<unknown> => {
    const answer = answers[method];
    if (answer === undefined) throw new Error(`unexpected ${method}`);
    return typeof answer === "function" ? (answer as () => unknown)() : answer;
  });
  return {
    send: fn as unknown as RequestFn,
    calls: (method) => fn.mock.calls.filter(([name]) => name === method).length,
    params: (method) => fn.mock.calls.find(([name]) => name === method)?.[1],
  };
}

function renderSource(request: FakeRequest, onOpenDiff = vi.fn()) {
  render(<Source request={request.send} workspaceId="w1" workspaceName="C:/ws" onOpenDiff={onOpenDiff} />);
  return { onOpenDiff };
}

describe("Source", () => {
  it("stages a file, commits it, and reports the new commit", async () => {
    const user = userEvent.setup();
    const request = fakeRequest({
      "git.status": status({ files: [file("a.txt")] }),
      "git.stage": status({ files: [file("a.txt", { index: "modified" })] }),
      "git.commit": { sha: "abcdef1234567", summary: "wip", status: status() },
    });
    renderSource(request);

    await user.click(await screen.findByLabelText("Stage a.txt"));
    await waitFor(() => expect(request.calls("git.stage")).toBe(1));
    expect(request.params("git.stage")).toEqual({ workspaceId: "w1", paths: ["a.txt"] });
    // The mutation's own answer is what the page shows: the row moved to the staged group.
    expect(await screen.findByLabelText("Unstage a.txt")).toBeTruthy();

    await user.type(screen.getByLabelText("Commit message"), "wip");
    await user.click(screen.getByRole("button", { name: "Commit" }));
    await waitFor(() => expect(request.calls("git.commit")).toBe(1));
    expect(request.params("git.commit")).toEqual({ workspaceId: "w1", message: "wip" });
    expect((await screen.findByRole("status")).textContent).toBe("Committed abcdef1: wip");
  });

  it("keeps Commit disabled with the reason that is actually missing", async () => {
    const request = fakeRequest({ "git.status": status({ files: [file("a.txt")] }) });
    const user = userEvent.setup();
    renderSource(request);

    await screen.findByLabelText("Stage a.txt");
    const commit = screen.getByRole("button", { name: "Commit" }) as HTMLButtonElement;
    expect(commit.disabled).toBe(true);
    expect(commit.title).toBe("Write a commit message");

    // A message is not enough on its own: what is not staged is not committed.
    await user.type(screen.getByLabelText("Commit message"), "wip");
    expect(commit.disabled).toBe(true);
    expect(commit.title).toBe("Nothing staged to commit");
  });

  it("states that a workspace is not a repository instead of showing an empty page", async () => {
    renderSource(fakeRequest({ "git.status": status({ isRepo: false, branch: null }) }));

    expect((await screen.findByText(/Not a git repository/)).textContent).toContain("C:/ws");
  });

  it("groups a file that is both staged and modified under each state", async () => {
    const request = fakeRequest({
      "git.status": status({ files: [file("a.txt", { index: "modified", worktree: "modified" })] }),
    });
    const { onOpenDiff } = renderSource(request);

    const stagedGroup = await screen.findByRole("region", { name: "Staged" });
    const unstagedGroup = screen.getByRole("region", { name: "Unstaged" });
    expect(within(stagedGroup).getByLabelText("Unstage a.txt")).toBeTruthy();
    expect(within(unstagedGroup).getByLabelText("Stage a.txt")).toBeTruthy();

    // The path is the diff; the checkbox is only about the index.
    await userEvent.click(within(stagedGroup).getByRole("button", { name: "a.txt" }));
    expect(onOpenDiff).toHaveBeenCalledWith("a.txt");
  });

  it("shows the hook's own words when a commit is refused", async () => {
    const request = fakeRequest({
      "git.status": status({ files: [file("a.txt", { index: "modified" })] }),
      "git.commit": () => {
        throw new Error("pre-commit hook: lint failed");
      },
    });
    const user = userEvent.setup();
    renderSource(request);

    await screen.findByLabelText("Unstage a.txt");
    await user.type(screen.getByLabelText("Commit message"), "wip");
    await user.click(screen.getByRole("button", { name: "Commit" }));

    expect((await screen.findByRole("alert")).textContent).toBe("pre-commit hook: lint failed");
  });

  it("re-reads only when asked, and reports divergence from the upstream", async () => {
    const request = fakeRequest({ "git.status": status({ ahead: 2, behind: 1, files: [file("a.txt")] }) });
    const user = userEvent.setup();
    renderSource(request);

    expect((await screen.findByTestId("source-divergence")).textContent).toBe("↑2↓1");
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(request.calls("git.status")).toBe(2));
  });
});
