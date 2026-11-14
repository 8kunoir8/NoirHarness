import { useCallback, useEffect, useState } from "react";
import type { CheckpointListResult, CheckpointPlanResult } from "@noir/protocol";
import type { RequestFn } from "./api.js";
import { errorMessage } from "./events.js";

export interface CheckpointEntry {
  id: string;
  notCaptured: number;
  error: string | null;
}

export interface CheckpointsApi {
  byTurn: ReadonlyMap<string, CheckpointEntry>;
  available: boolean;
  reason: string | undefined;
  plan: (checkpointId: string) => Promise<CheckpointPlanResult>;
  restore: (checkpointId: string) => Promise<void>;
}

/**
 * The checkpoints of one session, keyed by turn. Refetched when `refreshKey` changes: a turn
 * starting is what adds a row, and only the kernel knows when that happened.
 */
export function useCheckpoints(sessionId: string, request: RequestFn, refreshKey: string): CheckpointsApi {
  const [list, setList] = useState<CheckpointListResult | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (sessionId === "") return;
    let active = true;
    void (async () => {
      try {
        const result = await request<CheckpointListResult>("checkpoint.list", { sessionId });
        if (active) {
          setList(result);
          setError(undefined);
        }
      } catch (failure) {
        if (active) setError(errorMessage(failure));
      }
    })();
    return () => {
      active = false;
    };
  }, [sessionId, request, refreshKey]);

  const plan = useCallback(
    async (checkpointId: string): Promise<CheckpointPlanResult> =>
      request<CheckpointPlanResult>("checkpoint.plan", { sessionId, checkpointId }),
    [request, sessionId],
  );

  const restore = useCallback(
    async (checkpointId: string): Promise<void> => {
      await request("checkpoint.restore", { sessionId, checkpointId });
    },
    [request, sessionId],
  );

  const byTurn = new Map<string, CheckpointEntry>();
  for (const entry of list?.checkpoints ?? []) {
    if (entry.turnId !== null && entry.error === null) {
      byTurn.set(entry.turnId, { id: entry.id, notCaptured: entry.notCaptured, error: entry.error });
    }
  }

  return {
    byTurn,
    available: list?.available === true && error === undefined,
    reason: list?.reason ?? error,
    plan,
    restore,
  };
}
