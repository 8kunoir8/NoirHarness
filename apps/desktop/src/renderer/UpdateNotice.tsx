import type { UpdateState } from "@noir/protocol";

/** Opens the release page; a browser build opens a tab, since it has no preload bridge. */
function openExternally(href: string): void {
  const bridge = window.noir;
  if (bridge !== undefined) void bridge.openExternal(href);
  else window.open(href, "_blank", "noopener,noreferrer");
}

/** `0` is "never checked", not 1970. */
function checkedLabel(checkedAt: number): string {
  return checkedAt === 0 ? "never" : new Date(checkedAt).toLocaleString();
}

/**
 * One phrase per answer the kernel can give. The toast and the Help row read it, so a version can
 * never be described one way in the corner and another way on the page.
 */
export function updateSummary(state: UpdateState): string {
  if (state.status === "available") return `${state.latest ?? "A newer release"} is available`;
  if (state.status === "failed") return `Could not check: ${state.reason ?? "git did not answer"}`;
  return "Up to date";
}

export interface UpdateNoticeProps {
  state: UpdateState;
  /** True while a check is in flight, so the row can say so instead of looking asleep. */
  checking: boolean;
  onCheck: () => void;
  onDismiss: (version: string) => void;
}

/**
 * The Help page's update row: what this build is, what the remote has, when the kernel last asked,
 * and the one button that asks again now. Warnings are text here; nothing about an update is a
 * dialog or a modal, so a failing check cannot interrupt a turn.
 */
export function UpdateRow({ state, checking, onCheck, onDismiss }: UpdateNoticeProps) {
  const available = state.status === "available" && state.latest !== null;
  return (
    <div className="update-row" data-testid="update-row">
      <p className="update-summary" data-status={state.status}>
        {updateSummary(state)}
      </p>
      <dl className="help-facts">
        <dt>Current version</dt>
        <dd>{state.current}</dd>
        <dt>Latest tag</dt>
        <dd className="help-mono">{state.latest ?? "none found"}</dd>
        <dt>Last checked</dt>
        <dd>{checkedLabel(state.checkedAt)}</dd>
      </dl>
      <div className="update-actions">
        <button type="button" onClick={onCheck} disabled={checking}>
          {checking ? "Checking…" : "Check now"}
        </button>
        {available ? (
          <button type="button" onClick={() => openExternally(state.url)}>
            What&apos;s new
          </button>
        ) : null}
        {available && !state.dismissed ? (
          <button type="button" onClick={() => onDismiss(state.latest ?? "")}>
            Dismiss
          </button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The corner notice: one line, one release page, one way to make it stop. It carries no state of
 * its own — the kernel remembers what was dismissed, so a second window cannot re-ask.
 */
export function UpdateToast({ state, onDismiss }: Pick<UpdateNoticeProps, "state" | "onDismiss">) {
  if (state.status !== "available" || state.dismissed || state.latest === null) return null;
  return (
    <div className="update-toast" role="status" data-testid="update-toast">
      <span className="update-toast-text">{updateSummary(state)}</span>
      <button type="button" className="link" onClick={() => openExternally(state.url)}>
        What&apos;s new
      </button>
      <button type="button" className="link" onClick={() => onDismiss(state.latest ?? "")}>
        Dismiss
      </button>
    </div>
  );
}
