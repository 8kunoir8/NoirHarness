import type { ChatUsage } from "./events.js";
import { formatTokens } from "./format.js";

export interface UsageMeterProps {
  usage?: ChatUsage | undefined;
}

/** Context meter plus token and cost readout; absent until the engine reports usage. */
export function UsageMeter({ usage }: UsageMeterProps) {
  if (usage === undefined) return null;
  const percent = usage.size > 0 ? Math.min(100, Math.round((usage.used / usage.size) * 100)) : 0;
  return (
    <div className="usage-meter" data-testid="usage-meter" role="group" aria-label="Context usage">
      <div
        className="usage-bar"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-label="Context used"
      >
        <span style={{ width: `${percent}%` }} data-tone={percent >= 85 ? "warn" : "ok"} />
      </div>
      <span>
        {percent}% of {formatTokens(usage.size)} · in {formatTokens(usage.inputTokens)} / out{" "}
        {formatTokens(usage.outputTokens)} · ${usage.costUsd.toFixed(4)}
      </span>
    </div>
  );
}
