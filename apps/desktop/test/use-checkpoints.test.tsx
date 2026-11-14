import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { RequestFn } from "../src/renderer/api.js";
import { useCheckpoints } from "../src/renderer/useCheckpoints.js";

function answering(reply: (method: string, params: unknown) => unknown): RequestFn {
  return <T,>(method: string, params?: unknown): Promise<T> => {
    try {
      return Promise.resolve(reply(method, params) as T);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  };
}

describe("useCheckpoints", () => {
  it("maps checkpoints to their turns and drops the unusable ones", async () => {
    const request = answering((method) => {
      if (method !== "checkpoint.list") throw new Error(`unexpected ${method}`);
      return {
        available: true,
        checkpoints: [
          { id: "c-1", turnId: "t-1", seq: 1, createdAt: 1, notCaptured: 0, label: "turn", error: null },
          { id: "c-2", turnId: "t-2", seq: 9, createdAt: 2, notCaptured: 0, label: "turn", error: "git is not available" },
          { id: "c-3", turnId: null, seq: 3, createdAt: 3, notCaptured: 0, label: "pre-restore", error: null },
        ],
      };
    });
    const { result } = renderHook(() => useCheckpoints("s-1", request, "0"));

    await waitFor(() => expect(result.current.byTurn.size).toBe(1));
    expect(result.current.byTurn.get("t-1")?.id).toBe("c-1");
    // The safety row has no turn, so it is keyed by the seq its rewind marker took.
    expect(result.current.preRestore.size).toBe(1);
    expect(result.current.preRestore.get(3)?.id).toBe("c-3");
    expect(result.current.available).toBe(true);
  });

  it("keeps an unusable pre-restore row out of both maps", async () => {
    const request = answering(() => ({
      available: true,
      checkpoints: [
        { id: "c-1", turnId: "t-1", seq: 1, createdAt: 1, notCaptured: 0, label: "turn", error: null },
        { id: "c-3", turnId: null, seq: 3, createdAt: 3, notCaptured: 2, label: "pre-restore", error: "no tree" },
      ],
    }));
    const { result } = renderHook(() => useCheckpoints("s-1", request, "0"));

    await waitFor(() => expect(result.current.byTurn.size).toBe(1));
    expect(result.current.preRestore.size).toBe(0);
    expect(result.current.preRestore.get(3)).toBeUndefined();
  });

  it("keeps the kernel's reason when checkpoints are unavailable", async () => {
    const request = answering(() => ({ available: false, reason: "LFS worktrees are not supported", checkpoints: [] }));
    const { result } = renderHook(() => useCheckpoints("s-1", request, "0"));
    // `available` is false before the list lands too, so wait on the kernel's answer itself.
    await waitFor(() => expect(result.current.reason).toBe("LFS worktrees are not supported"));
    expect(result.current.available).toBe(false);
  });

  it("asks for a plan and applies a restore", async () => {
    const seen: string[] = [];
    const request = answering((method) => {
      seen.push(method);
      if (method === "checkpoint.list") return { available: true, checkpoints: [] };
      if (method === "checkpoint.plan") return { restored: 2, deleted: 0, removed: 1, failed: [] };
      if (method === "checkpoint.restore") return { ok: true, restored: 2, deleted: 0, removed: 1, failed: [], eventSeq: 9 };
      throw new Error(`unexpected ${method}`);
    });
    const { result } = renderHook(() => useCheckpoints("s-1", request, "0"));
    await waitFor(() => expect(result.current.available).toBe(true));

    await expect(result.current.plan("c-1")).resolves.toMatchObject({ restored: 2 });
    await result.current.restore("c-1");
    expect(seen).toEqual(["checkpoint.list", "checkpoint.plan", "checkpoint.restore"]);
  });
});
