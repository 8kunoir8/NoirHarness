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
