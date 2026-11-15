import type { KeyboardEvent, Ref } from "react";

export type ComposerStatus = "idle" | "sending" | "queued" | "streaming" | "interrupted" | "error";

export interface ComposerProps {
  draft: string;
  onDraftChange: (draft: string) => void;
  status: ComposerStatus;
  error?: string | undefined;
  queued: boolean;
  /** An approval card owns Esc while it is open. */
  hasApproval: boolean;
  sendDisabled: boolean;
  onSend: () => void;
  onQueue: () => void;
  onInterrupt: () => void;
  onCancelQueued: () => void;
  /** The prompt element, so a surface that fills the draft can also put the caret in it. */
  inputRef?: Ref<HTMLTextAreaElement> | undefined;
}

const STATUS_HINT: Record<ComposerStatus, string> = {
  idle: "Enter sends · ⇧Enter newline",
  sending: "Sending…",
  queued: "Queued for after this turn · ⌘Enter queues another",
  streaming: "Streaming · ⌘Enter queues · Esc interrupts",
  interrupted: "Interrupted · Enter sends the next turn",
  error: "Failed · the draft is kept",
};

/**
 * Composer shell. Enter sends, ⌘Enter queues while a turn runs, and Esc interrupts.
 * While a turn is streaming, plain Enter inserts a newline so a draft can span turns.
 */
export function Composer({
  draft,
  onDraftChange,
  status,
  error,
  queued,
  hasApproval,
  sendDisabled,
  onSend,
  onQueue,
  onInterrupt,
  onCancelQueued,
  inputRef,
}: ComposerProps) {
  const streaming = status === "streaming";

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.nativeEvent.isComposing) return;
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      onQueue();
      return;
    }
    if (event.key === "Escape") {
      if (streaming && !hasApproval) {
        event.preventDefault();
        onInterrupt();
      }
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && !streaming) {
      event.preventDefault();
      onSend();
    }
  }

  return (
    <form
      className="composer"
      data-state={status}
      onSubmit={(event) => {
        event.preventDefault();
        onSend();
      }}
    >
      <textarea
        aria-label="Prompt"
        value={draft}
        ref={inputRef}
        placeholder={streaming ? "Draft the next message…" : "Message the agent…"}
        onChange={(event) => onDraftChange(event.target.value)}
        onKeyDown={onKeyDown}
      />
      {error === undefined ? null : <p role="alert">{error}</p>}
      <div className="composer-actions">
        <button type="submit" className="primary" disabled={sendDisabled}>
          Send
        </button>
        {queued ? (
          <button type="button" className="composer-queue" onClick={onCancelQueued}>
            Queued — runs after this turn · Cancel
          </button>
        ) : null}
        <span className="composer-hint" data-testid="composer-state">
          {queued ? STATUS_HINT.queued : STATUS_HINT[status]}
        </span>
      </div>
    </form>
  );
}
