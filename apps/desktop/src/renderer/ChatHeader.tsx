import { useEffect, useState } from "react";
import type { ModelView, SessionStatus } from "@noir/protocol";
import type { ChatTurn, ChatUsage } from "./events.js";
import { formatDuration } from "./format.js";
import { UsageMeter } from "./UsageMeter.js";

/** Added and deleted line counts for the changed-file set. */
export interface DiffStats {
  add: number;
  del: number;
}

export interface ChatHeaderProps {
  title: string;
  status: SessionStatus;
  modelId: string | null;
  models: readonly ModelView[];
  usage?: ChatUsage | undefined;
  diffStats?: DiffStats | undefined;
  turnStartedAt?: number | undefined;
  lastTurn?: ChatTurn | undefined;
  canInterrupt: boolean;
  onInterrupt: () => void;
  onModelChange: (modelId: string) => void;
  /** Omitted where the chat cannot be renamed; the title then renders as plain text. */
  onRename?: ((title: string) => void) | undefined;
}

/** Live elapsed time for the running turn; freezes when `turnStartedAt` disappears. */
function useElapsed(startedAt: number | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === undefined) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  return startedAt === undefined ? 0 : now - startedAt;
}

export function ChatHeader({
  title,
  status,
  modelId,
  models,
  usage,
  diffStats,
  turnStartedAt,
  lastTurn,
  canInterrupt,
  onInterrupt,
  onModelChange,
  onRename,
}: ChatHeaderProps) {
  const elapsed = useElapsed(turnStartedAt);
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const modelOptions = models.map((model) => ({ id: model.id, label: model.displayName }));
  if (modelId !== null && !models.some((model) => model.id === modelId)) {
    modelOptions.push({ id: modelId, label: `${modelId} (missing)` });
  }
  // What the title reads as, and what an edit starts from: a session with no title yet starts its
  // draft empty, so the first keystroke does not begin with "Untitled session".
  const label = title === "" ? "Untitled session" : title;

  /** Enter is the only commit; a blank or unchanged draft just closes the field, as in the list. */
  function commitRename(): void {
    if (draft === undefined) return;
    setDraft(undefined);
    const next = draft.trim();
    if (next === "" || next === title) return;
    onRename?.(next);
  }

  return (
    <header className="chat-header">
      <div className="chat-title">
        {onRename === undefined ? (
          <h2>{label}</h2>
        ) : draft === undefined ? (
          // The title is the rename control: one click puts it in edit, so there is no separate
          // "rename" mode to discover.
          <h2>
            <button
              type="button"
              className="chat-title-button"
              aria-label="Rename chat"
              title="Rename chat"
              onClick={() => setDraft(title)}
            >
              {label}
            </button>
          </h2>
        ) : (
          <form
            className="chat-title-form"
            onSubmit={(event) => {
              event.preventDefault();
              commitRename();
            }}
          >
            <input
              aria-label="Chat title"
              value={draft}
              // `session.rename` rejects more than 200 characters; stop the typist, do not fail them.
              maxLength={200}
              autoFocus
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setDraft(undefined);
              }}
            />
          </form>
        )}
        <span className="chat-status" data-testid="session-status" data-status={status}>
          {status}
        </span>
      </div>
      <label className="model-picker">
        Model
        <select aria-label="Model" value={modelId ?? ""} onChange={(event) => onModelChange(event.target.value)}>
          <option value="">Default</option>
          {modelOptions.map((model) => (
            <option key={model.id} value={model.id}>
              {model.label}
            </option>
          ))}
        </select>
      </label>
      <span className="turn-timer" aria-live="off">
        {turnStartedAt === undefined
          ? lastTurn === undefined
            ? ""
            : `last turn ${formatDuration(lastTurn.ms)}`
          : `${formatDuration(elapsed)}`}
      </span>
      <UsageMeter usage={usage} />
      {diffStats === undefined ? null : (
        <span className="chat-diff" role="group" aria-label="Diff stats">
          <span className="diff-add">+{diffStats.add}</span> <span className="diff-del">−{diffStats.del}</span>
        </span>
      )}
      {canInterrupt ? (
        <button type="button" onClick={onInterrupt}>
          Interrupt
        </button>
      ) : null}
    </header>
  );
}
