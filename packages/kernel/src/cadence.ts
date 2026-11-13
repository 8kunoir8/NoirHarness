/**
 * Occurrences one catch-up walk will step through before re-aligning. A one-minute schedule left
 * closed for a year is half a million `Date` constructions for a number nobody reads.
 */
export const MAX_ADVANCE_STEPS = 5_000;

const DAY_MINUTES = 1_440;

/**
 * Adds `intervalMinutes` to the local wall-clock fields of `at`, carrying whole days in the date
 * field. Reconstructing the instant from local fields is what keeps "daily at 09:00" at 09:00
 * across a DST boundary; adding `86_400_000` would land it at 08:00 or 10:00.
 */
export function advance(at: number, intervalMinutes: number): number {
  const from = new Date(at);
  const total = from.getHours() * 60 + from.getMinutes() + intervalMinutes;
  const days = Math.floor(total / DAY_MINUTES);
  const minuteOfDay = total % DAY_MINUTES;
  return new Date(
    from.getFullYear(),
    from.getMonth(),
    from.getDate() + days,
    Math.floor(minuteOfDay / 60),
    minuteOfDay % 60,
  ).getTime();
}

/** `anchorMinutes` past local midnight on the local day of `day`. */
export function anchoredOn(day: number, anchorMinutes: number): number {
  const from = new Date(day);
  return new Date(
    from.getFullYear(),
    from.getMonth(),
    from.getDate(),
    Math.floor(anchorMinutes / 60),
    anchorMinutes % 60,
  ).getTime();
}

/**
 * Walks from `from` until strictly past `after`, counting the occurrences it passed. `count` is the
 * number of runs that came due and did not happen; `next` is the first one still in the future.
 *
 * Past the step budget the walk stops, and `anchorMinutes` decides where it lands: the answer is the
 * first anchored occurrence after `after`, so a 15-minute schedule left closed for a year comes back
 * on the quarter hour instead of one interval after whenever the app was opened.
 */
export function occurrencesBetween(
  from: number,
  intervalMinutes: number,
  after: number,
  anchorMinutes = 0,
): { next: number; count: number } {
  if (from > after) return { next: from, count: 0 };
  let cursor = from;
  for (let count = 0; count < MAX_ADVANCE_STEPS; count += 1) {
    cursor = advance(cursor, intervalMinutes);
    if (cursor > after) return { next: cursor, count: count + 1 };
  }
  return { next: realignAfter(after, intervalMinutes, anchorMinutes), count: MAX_ADVANCE_STEPS };
}

/**
 * The first anchored occurrence after `after`. `anchorAt` is on the same local day, so the walk
 * needs at most one day's worth of intervals — a bound independent of the interval, unlike the one
 * that was just exhausted.
 */
function realignAfter(after: number, intervalMinutes: number, anchorMinutes: number): number {
  let cursor = anchoredOn(after, anchorMinutes);
  for (let steps = 0; cursor <= after && steps <= DAY_MINUTES + 1; steps += 1) {
    cursor = advance(cursor, intervalMinutes);
  }
  return cursor;
}

/** The first occurrence strictly after `after`. */
export function nextAfter(from: number, intervalMinutes: number, after: number, anchorMinutes = 0): number {
  return occurrencesBetween(from, intervalMinutes, after, anchorMinutes).next;
}
