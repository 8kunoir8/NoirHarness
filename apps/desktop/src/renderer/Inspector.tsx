import type { SessionStatus, SessionView } from "@noir/protocol";
import type { ChatFile, ChatPlanItem, ChatTurn, ChatUsage } from "./events.js";
import { formatDuration, formatTokens } from "./format.js";

export interface InspectorProps {
  session: SessionView | undefined;
  status: SessionStatus;
  usage?: ChatUsage | undefined;
  turnStartedAt?: number | undefined;
  lastTurn?: ChatTurn | undefined;
  files: readonly ChatFile[];
  plan: readonly ChatPlanItem[];
  approvalTitles: readonly string[];
  onClose: () => void;
}

/** Read-only view of everything the kernel reported for the active session. */
export function Inspector({
  session,
  status,
  usage,
  turnStartedAt,
  lastTurn,
  files,
  plan,
  approvalTitles,
  onClose,
}: InspectorProps) {
  if (session === undefined) {
    return (
      <div className="inspector">
        <header className="inspector-head">
          <h2>Inspector</h2>
          <button type="button" aria-label="Close inspector" onClick={onClose}>
            ×
          </button>
        </header>
        <p className="empty">Open a chat to inspect its turn, usage, and changed files.</p>
      </div>
    );
  }

  const turnLabel =
    turnStartedAt === undefined
      ? lastTurn === undefined
        ? "no turns yet"
        : `${lastTurn.status} in ${formatDuration(lastTurn.ms)}`
      : "running";
  const additions = files.reduce((sum, file) => sum + file.add, 0);
  const deletions = files.reduce((sum, file) => sum + file.del, 0);

  return (
    <div className="inspector">
      <header className="inspector-head">
        <h2>Inspector</h2>
        <button type="button" aria-label="Close inspector" onClick={onClose}>
          ×
        </button>
      </header>

      <section aria-label="Turn" className="inspector-section">
        <h3>Turn</h3>
        <dl>
          <dt>Status</dt>
          <dd data-testid="inspector-status">{status}</dd>
          <dt>Turn</dt>
          <dd data-testid="inspector-turn">{turnLabel}</dd>
          <dt>Session</dt>
          <dd>
            <code>{session.id}</code>
          </dd>
        </dl>
      </section>

      <section aria-label="Usage" className="inspector-section">
        <h3>Usage</h3>
        {usage === undefined ? (
          <p className="empty">No usage reported yet.</p>
        ) : (
          <dl>
            <dt>Input</dt>
            <dd>{formatTokens(usage.inputTokens)} tokens</dd>
            <dt>Output</dt>
            <dd>{formatTokens(usage.outputTokens)} tokens</dd>
            <dt>Context</dt>
            <dd>
              {formatTokens(usage.used)} / {formatTokens(usage.size)}
            </dd>
            <dt>Cost</dt>
            <dd>${usage.costUsd.toFixed(4)}</dd>
          </dl>
        )}
      </section>

      <section aria-label="Approvals" className="inspector-section">
        <h3>Approvals</h3>
        {approvalTitles.length === 0 ? (
          <p className="empty">Nothing waiting.</p>
        ) : (
          <ul className="inspector-list">
            {approvalTitles.map((title) => (
              <li key={title} className="inspector-approval">
                {title}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Changed files" className="inspector-section">
        <h3>Changed files</h3>
        {files.length === 0 ? (
          <p className="empty">No files changed.</p>
        ) : (
          <>
            <p className="inspector-summary">
              {files.length} file{files.length === 1 ? "" : "s"} · <span className="diff-add">+{additions}</span>{" "}
              <span className="diff-del">−{deletions}</span>
            </p>
            <ul className="inspector-list">
              {files.map((file) => (
                <li key={file.path} className="inspector-file">
                  <span className={`diff-tag diff-${file.change}`}>{file.change}</span>
                  <code title={file.path}>{file.path}</code>
                  <span className="diff-add">+{file.add}</span>
                  <span className="diff-del">−{file.del}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section aria-label="Plan" className="inspector-section">
        <h3>Plan</h3>
        {plan.length === 0 ? (
          <p className="empty">No plan for this session.</p>
        ) : (
          <ol className="inspector-plan">
            {plan.map((item) => (
              <li key={item.text} data-status={item.status}>
                {item.text}
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
