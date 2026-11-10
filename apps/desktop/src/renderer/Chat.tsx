import { useEffect, useRef, useState } from "react";
import type { ModelView, PermissionOption, SessionPromptResult, SessionView } from "@noir/protocol";
import type { RequestFn } from "./Settings.js";
import { errorMessage, useSessionEvents } from "./events.js";

function newId(): string {
  const source = globalThis.crypto;
  if (source !== undefined && typeof source.randomUUID === "function") return source.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`;
}

export function Chat({ session, models, request }: { session: SessionView; models: ModelView[]; request: RequestFn }) {
  const { state, appendUser } = useSessionEvents(session.id, request);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [queued, setQueued] = useState(false);
  const [actionError, setActionError] = useState<string | undefined>(undefined);
  const queuedAtTurn = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!queued) return;
    if (state.activeTurnId !== queuedAtTurn.current || (state.activeTurnId === undefined && state.status === "idle")) {
      setQueued(false);
    }
  }, [queued, state.activeTurnId, state.status]);

  const busy = sending || queued;
  const error = actionError ?? state.error;
  const canInterrupt = state.status === "running" || state.status === "waiting";
  const knownModel = models.some((model) => model.id === session.modelId);

  async function send(): Promise<void> {
    const text = draft.trim();
    if (text === "" || busy) return;
    setSending(true);
    queuedAtTurn.current = state.activeTurnId;
    const requestId = newId();
    try {
      const result = await request<SessionPromptResult>("session.prompt", {
        sessionId: session.id,
        requestId,
        content: [{ type: "text", text }],
      });
      appendUser(text, requestId);
      setDraft("");
      setActionError(undefined);
      if (result.queued) setQueued(true);
    } catch (sendError) {
      setActionError(errorMessage(sendError));
    } finally {
      setSending(false);
    }
  }

  async function interrupt(): Promise<void> {
    try {
      await request("session.interrupt", { sessionId: session.id });
      setActionError(undefined);
    } catch (interruptError) {
      setActionError(errorMessage(interruptError));
    }
  }

  async function respond(option: PermissionOption): Promise<void> {
    if (state.approval === undefined) return;
    try {
      await request("approval.respond", { approvalId: state.approval.approvalId, decision: option.kind });
      setActionError(undefined);
    } catch (respondError) {
      setActionError(errorMessage(respondError));
    }
  }

  const title = state.title ?? session.title;
  return (
    <section className="chat" aria-label="Chat">
      <header className="chat-header">
        <h2>{title === "" ? "Untitled session" : title}</h2>
        <span data-testid="session-status">{state.status}</span>
        <label>
          Model
          <select aria-label="Model" value={session.modelId ?? ""} disabled>
            <option value="">Default</option>
            {session.modelId !== null && !knownModel ? <option value={session.modelId}>{session.modelId}</option> : null}
            {models.map((model) => <option key={model.id} value={model.id}>{model.displayName}</option>)}
          </select>
        </label>
        {canInterrupt ? <button type="button" onClick={() => void interrupt()}>Interrupt</button> : null}
      </header>

      {error === undefined ? null : <p role="alert">{error}</p>}

      <ol className="messages">
        {state.messages.map((message) => (
          <li key={message.id} className={`message message-${message.role}`} data-testid={message.role === "assistant" ? "message-assistant" : undefined}>
            <strong>{message.role === "user" ? "You" : "Assistant"}</strong>
            {message.blocks.map((block, index) => (
              <div key={`${message.id}-${index}`} className={block.kind === "reasoning" ? "reasoning" : "text"}>
                {block.kind === "reasoning" ? <span className="label">Reasoning</span> : null}
                <p>{block.text}</p>
              </div>
            ))}
          </li>
        ))}
      </ol>

      {state.tools.length === 0 ? null : (
        <section aria-label="Tools">
          <h3>Tools</h3>
          <ul className="tools">
            {state.tools.map((tool) => (
              <li key={tool.id} className="tool" data-testid="tool-card">
                <strong>{tool.title === "" ? tool.id : tool.title}</strong>
                <span className="status">{tool.status}</span>
                {tool.output === "" ? null : <pre>{tool.output}</pre>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {state.approval === undefined ? null : (
        <div role="dialog" aria-label="Permission required" className="approval" data-testid="permission-card">
          <p>{state.approval.title}</p>
          <div className="approval-options">
            {state.approval.options.map((option) => (
              <button key={option.optionId} type="button" onClick={() => void respond(option)}>{option.name}</button>
            ))}
          </div>
        </div>
      )}

      {state.usage === undefined ? null : (
        <p className="usage">Context {state.usage.used}/{state.usage.size} · ${state.usage.costUsd.toFixed(4)}</p>
      )}

      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <textarea
          aria-label="Prompt"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <button type="submit" disabled={busy || draft.trim() === ""}>Send</button>
      </form>
    </section>
  );
}
