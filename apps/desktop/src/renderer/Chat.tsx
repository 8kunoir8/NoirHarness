import { useEffect, useRef, useState } from "react";
import type { ModelView, PermissionOption, SessionPromptResult, SessionView } from "@noir/protocol";
import type { RequestFn } from "./api.js";
import { ChatHeader, type DiffStats } from "./ChatHeader.js";
import { Composer, type ComposerStatus } from "./Composer.js";
import { errorMessage, type SessionEvents } from "./events.js";
import { MarkdownContent } from "./MarkdownContent.js";
import { previewKind } from "./preview/kind.js";
import { ToolCard } from "./ToolCard.js";

function newId(): string {
  const source = globalThis.crypto;
  if (source !== undefined && typeof source.randomUUID === "function") return source.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`;
}

export function Chat({
  session,
  models,
  request,
  events,
  diffStats,
  onSessionChange,
  onPreview,
}: {
  session: SessionView;
  models: ModelView[];
  request: RequestFn;
  events: SessionEvents;
  diffStats?: DiffStats | undefined;
  onSessionChange?: (() => void) | undefined;
  /** Opens a referenced previewable file in the artifact tab. */
  onPreview?: ((path: string) => void) | undefined;
}) {
  const { state, appendUser } = events;
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [queuedTurnId, setQueuedTurnId] = useState<string | undefined>(undefined);
  const [actionError, setActionError] = useState<string | undefined>(undefined);
  const queuedAtTurn = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (queuedTurnId === undefined) return;
    if (state.activeTurnId !== queuedAtTurn.current || (state.activeTurnId === undefined && state.status === "idle")) {
      setQueuedTurnId(undefined);
    }
  }, [queuedTurnId, state.activeTurnId, state.status]);

  const error = actionError ?? state.error;
  const canInterrupt = state.status === "running" || state.status === "waiting";
  const streaming = state.status === "starting" || canInterrupt;
  const queued = queuedTurnId !== undefined;

  async function submit(): Promise<void> {
    const text = draft.trim();
    if (text === "" || sending) return;
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
      setQueuedTurnId(result.queued ? result.turnId : undefined);
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

  async function cancelQueued(): Promise<void> {
    if (queuedTurnId === undefined) return;
    try {
      const result = await request<{ cancelled: boolean }>("session.cancelQueued", {
        sessionId: session.id,
        turnId: queuedTurnId,
      });
      if (result.cancelled) setQueuedTurnId(undefined);
      setActionError(undefined);
    } catch (cancelError) {
      setActionError(errorMessage(cancelError));
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

  async function changeModel(modelId: string): Promise<void> {
    if (modelId === "" || modelId === session.modelId) return;
    try {
      await request("session.setModel", { sessionId: session.id, modelId });
      setActionError(undefined);
      onSessionChange?.();
    } catch (modelError) {
      setActionError(errorMessage(modelError));
    }
  }

  // Approval keys: Esc rejects when a reject option exists, digits pick options by position.
  useEffect(() => {
    const approval = state.approval;
    if (approval === undefined) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        const reject = approval.options.find((option) => option.kind === "reject" || option.kind === "reject_always");
        if (reject !== undefined) {
          event.preventDefault();
          void request("approval.respond", { approvalId: approval.approvalId, decision: reject.kind }).catch(
            (respondError: unknown) => setActionError(errorMessage(respondError)),
          );
        }
        return;
      }
      const target = event.target;
      const typing =
        target instanceof HTMLElement &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT");
      if (typing || !/^[1-9]$/.test(event.key)) return;
      const option = approval.options[Number(event.key) - 1];
      if (option === undefined) return;
      event.preventDefault();
      void request("approval.respond", { approvalId: approval.approvalId, decision: option.kind }).catch(
        (respondError: unknown) => setActionError(errorMessage(respondError)),
      );
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [request, state.approval]);

  const composerStatus: ComposerStatus =
    error !== undefined
      ? "error"
      : queued
        ? "queued"
        : streaming
          ? "streaming"
          : sending
            ? "sending"
            : state.lastTurn?.status === "interrupted"
              ? "interrupted"
              : "idle";

  const title = state.title ?? session.title;
  return (
    <section className="chat" aria-label="Chat">
      <ChatHeader
        title={title}
        status={state.status}
        modelId={session.modelId}
        models={models}
        usage={state.usage}
        diffStats={diffStats}
        turnStartedAt={state.turnStartedAt}
        lastTurn={state.lastTurn}
        canInterrupt={canInterrupt}
        onInterrupt={() => void interrupt()}
        onModelChange={(modelId) => void changeModel(modelId)}
      />

      {state.skillsLoaded.length === 0 ? null : (
        <div className="chat-skills" role="group" aria-label="Skills loaded">
          {state.skillsLoaded.map((skill) => (
            <span key={skill.name} className="chat-skill" title={skill.hash.slice(0, 12)}>
              {skill.name}
            </span>
          ))}
        </div>
      )}

      {state.notices.length === 0 ? null : (
        <ul className="chat-notices" role="status" aria-label="Setup notices">
          {state.notices.map((notice) => (
            <li key={notice}>{notice}</li>
          ))}
        </ul>
      )}


      {state.status === "error" ? (
        <p role="status" className="session-stopped">
          Session stopped. Send a prompt to resume.
        </p>
      ) : null}

      <ol className="messages">
        {state.messages.map((message) => (
          <li key={message.id} className={`message message-${message.role}`} data-testid={message.role === "assistant" ? "message-assistant" : undefined}>
            <strong>{message.role === "user" ? "You" : "Assistant"}</strong>
            {message.blocks.map((block, index) =>
              block.kind === "reasoning" ? (
                <details key={`${message.id}-${index}`} className="reasoning">
                  <summary>Reasoning</summary>
                  <p>{block.text}</p>
                </details>
              ) : block.kind === "file" ? (
                <div key={`${message.id}-${index}`} className="file-ref">
                  <code>{block.path}</code>
                  {onPreview !== undefined && previewKind(block.path) !== undefined ? (
                    <button
                      type="button"
                      className="link"
                      aria-label={`Preview ${block.path}`}
                      onClick={() => onPreview(block.path)}
                    >
                      Preview
                    </button>
                  ) : null}
                </div>
              ) : (
                <div key={`${message.id}-${index}`} className="text">
                  <MarkdownContent
                    content={block.text}
                    variant="chat"
                    images={{ workspaceId: session.workspaceId, request }}
                    {...(onPreview === undefined ? {} : { onOpenPath: onPreview })}
                  />
                </div>
              ),
            )}
          </li>
        ))}
      </ol>

      {state.tools.length === 0 ? null : (
        <section aria-label="Tools">
          <h3>Tools</h3>
          <ul className="tools">
            {state.tools.map((tool) => (
              <ToolCard key={tool.id} tool={tool} />
            ))}
          </ul>
        </section>
      )}

      {state.approval === undefined ? null : (
        <div role="dialog" aria-label="Permission required" className="approval" data-testid="permission-card">
          <p>{state.approval.title}</p>
          <div className="approval-options">
            {state.approval.options.map((option, index) => (
              <button key={option.optionId} type="button" onClick={() => void respond(option)}>
                <kbd aria-hidden="true">{index + 1}</kbd> {option.name}
              </button>
            ))}
          </div>
          <p className="approval-hint">Press 1–9 to answer · Esc rejects</p>
        </div>
      )}

      <Composer
        draft={draft}
        onDraftChange={setDraft}
        status={composerStatus}
        error={error}
        queued={queued}
        hasApproval={state.approval !== undefined}
        sendDisabled={draft.trim() === "" || sending}
        onSend={() => void submit()}
        onQueue={() => void submit()}
        onInterrupt={() => void interrupt()}
        onCancelQueued={() => void cancelQueued()}
      />
    </section>
  );
}
