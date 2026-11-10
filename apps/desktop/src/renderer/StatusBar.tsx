export interface StatusBarProps {
  status: string;
  running: number;
  pendingApprovals: number;
  engineDir?: string | undefined;
}

export function StatusBar({ status, running, pendingApprovals, engineDir }: StatusBarProps) {
  return (
    <div className="statusbar">
      <span data-testid="kernel-status">{status}</span>
      <span aria-hidden="true">·</span>
      <span>{running === 0 ? "no turns running" : `${running} turn${running === 1 ? "" : "s"} running`}</span>
      <span aria-hidden="true">·</span>
      <span className={pendingApprovals > 0 ? "statusbar-warn" : undefined}>
        {pendingApprovals === 0 ? "no approvals waiting" : `${pendingApprovals} approval${pendingApprovals === 1 ? "" : "s"} waiting`}
      </span>
      {engineDir === undefined ? null : (
        <>
          <span className="statusbar-spacer" />
          <span className="statusbar-path" title={engineDir}>
            engine profile: {engineDir}
          </span>
        </>
      )}
    </div>
  );
}
