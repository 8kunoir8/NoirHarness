import type { OfficePoint } from "./mapper.js";

/**
 * The twelve walkable tiles where the characters stand, one per desk. Each seat is the row after its
 * desk's two-tile footprint, so the desk's art, the monitor standing on it and the agent sort in the
 * order the camera sees them: desk, monitor, agent. It lives in its own module so the roster path
 * never pulls the full map into the startup bundle; the committed map stays a lazy chunk.
 * `office.test.tsx` asserts every point is still walkable there.
 */
export const OFFICE_DESKS: readonly OfficePoint[] = [
  { x: 2, y: 5 },
  { x: 5, y: 5 },
  { x: 8, y: 5 },
  { x: 11, y: 5 },
  { x: 2, y: 9 },
  { x: 5, y: 9 },
  { x: 8, y: 9 },
  { x: 11, y: 9 },
  { x: 2, y: 13 },
  { x: 5, y: 13 },
  { x: 8, y: 13 },
  { x: 11, y: 13 },
];
