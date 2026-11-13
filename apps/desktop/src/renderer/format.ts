/** Compacts token counts for meters: 999 -> "999", 12100 -> "12.1k". */
export function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

/** Turn timer: 420 ms -> "0.4s", 12.3 s -> "12.3s", 125 s -> "2m 05s". */
export function formatDuration(ms: number): string {
  const seconds = Math.max(ms, 0) / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(Math.floor(seconds % 60)).padStart(2, "0")}s`;
}

/** Minutes past midnight -> "09:00". */
export function formatClock(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/** The cadence as a person says it: "every 15 min", "daily at 09:00", "weekly at 09:00". */
export function formatCadence(intervalMinutes: number, anchorMinutes: number): string {
  if (intervalMinutes % 1_440 !== 0) return `every ${intervalMinutes} min`;
  const days = intervalMinutes / 1_440;
  const clock = formatClock(anchorMinutes);
  if (days === 1) return `daily at ${clock}`;
  if (days === 7) return `weekly at ${clock}`;
  return `every ${days} days at ${clock}`;
}
