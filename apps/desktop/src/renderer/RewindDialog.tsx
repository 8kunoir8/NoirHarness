import { useEffect, useRef } from "react";
import type { CheckpointPlanResult } from "@noir/protocol";

export interface RewindDialogProps {
  phase: "planning" | "ready" | "applying" | "failed";
  plan: CheckpointPlanResult | undefined;
  notCaptured: number;
  error: string | undefined;
  onConfirm: () => void;
  onCancel: () => void;
}

function count(value: number, noun: string): string {
  return `${String(value)} ${noun}${value === 1 ? "" : "s"}`;
}

/** The confirmation step. It never starts work: a rewind is only ever a click on `Rewind`. */
export function RewindDialog({ phase, plan, notCaptured, error, onConfirm, onCancel }: RewindDialogProps) {
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    // Focus lands inside the dialog on open, so Escape reaches the container in every phase, and
    // the destructive button is never the default target of a held Enter.
    cancel.current?.focus();
  }, []);

  return (
    <div
      role="dialog"
      aria-label="Rewind to before this prompt"
      aria-modal="true"
      className="rewind-dialog"
      data-testid="rewind-dialog"
      onKeyDown={(event) => {
        if (event.key === "Escape") onCancel();
      }}
    >
      <h2>Rewind to before this prompt</h2>
      <p className="rewind-hint">The files this turn changed go back; the conversation after it goes away.</p>
      {phase === "planning" ? <p>Checking what would change…</p> : null}
      {phase === "failed" ? <p role="alert">{error ?? "The rewind failed."}</p> : null}
      {plan === undefined ? null : (
        <p className="rewind-counts" data-testid="rewind-counts">
          {count(plan.restored, "file")} restored · {count(plan.deleted, "deleted file")} ·{" "}
          {count(plan.removed, "created file")} removed
        </p>
      )}
      {plan === undefined || plan.failed.length === 0 ? null : (
        <ul className="rewind-failed">
          {plan.failed.map((path) => (
            <li key={path}>
              <code>{path}</code>
            </li>
          ))}
        </ul>
      )}
      {notCaptured === 0 ? null : (
        <p>
          {count(notCaptured, "item")} {notCaptured === 1 ? "was" : "were"} not captured and will not move.
        </p>
      )}
      <div className="rewind-actions">
        <button ref={cancel} type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="primary" disabled={phase !== "ready"} onClick={onConfirm}>
          {phase === "applying" ? "Rewinding…" : "Rewind"}
        </button>
      </div>
    </div>
  );
}
