import type { SessionView } from "@noir/protocol";
import { sessionStatusLabel } from "./SessionList.js";

export interface TabsProps {
  sessions: readonly SessionView[];
  activeId?: string | undefined;
  onSelect: (sessionId: string) => void;
  onClose: (sessionId: string) => void;
}

export function Tabs({ sessions, activeId, onSelect, onClose }: TabsProps) {
  if (sessions.length === 0) return null;
  return (
    <div className="tabs" role="tablist" aria-label="Open chats">
      {sessions.map((session) => {
        const label = session.title === "" ? "Untitled chat" : session.title;
        const active = session.id === activeId;
        return (
          <div key={session.id} className="tab" data-active={active}>
            <button
              type="button"
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              onClick={() => onSelect(session.id)}
              title={`${label} — ${sessionStatusLabel(session)}`}
            >
              {label}
            </button>
            <button
              type="button"
              className="tab-close"
              aria-label={`Close ${label}`}
              onClick={() => onClose(session.id)}
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}
