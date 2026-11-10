import { useEffect, useState } from "react";
import type { ModelView, SessionStatus } from "@noir/protocol";
import type { ChatTurn, ChatUsage } from "./events.js";
import { formatDuration } from "./format.js";
import { UsageMeter } from "./UsageMeter.js";

export interface ChatHeaderProps {
  title: string;
  status: SessionStatus;
  modelId: string | null;
  models: readonly ModelView[];
  usage?: ChatUsage | undefined;
  turnStartedAt?: number | undefined;
  lastTurn?: ChatTurn | undefined;
  canInterrupt: boolean;
  onInterrupt: () => void;
  onModelChange: (modelId: string) => void;
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
  turnStartedAt,
  lastTurn,
  canInterrupt,
  onInterrupt,
  onModelChange,
}: ChatHeaderProps) {
  const elapsed = useElapsed(turnStartedAt);
  const modelOptions = models.map((model) => ({ id: model.id, label: model.displayName }));
  if (modelId !== null && !models.some((model) => model.id === modelId)) {
    modelOptions.push({ id: modelId, label: `${modelId} (missing)` });
  }
  return (
    <header className="chat-header">
      <div className="chat-title">
        <h2>{title === "" ? "Untitled session" : title}</h2>
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
      {canInterrupt ? (
        <button type="button" onClick={onInterrupt}>
          Interrupt
        </button>
      ) : null}
    </header>
  );
}
