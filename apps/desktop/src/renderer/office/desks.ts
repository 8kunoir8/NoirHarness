import type { OfficePoint } from "./mapper.js";

/**
 * The twelve walkable tiles in front of the map's desks, where each character stands. It lives in its
 * own module so the roster path never pulls the full map into the startup bundle; the committed map
 * stays a lazy chunk. `office.test.tsx` asserts every point is still walkable on that map.
 */
export const OFFICE_DESKS: readonly OfficePoint[] = [
  { x: 2, y: 4 },
  { x: 5, y: 4 },
  { x: 8, y: 4 },
  { x: 11, y: 4 },
  { x: 2, y: 8 },
  { x: 5, y: 8 },
  { x: 8, y: 8 },
  { x: 11, y: 8 },
  { x: 2, y: 12 },
  { x: 5, y: 12 },
  { x: 8, y: 12 },
  { x: 11, y: 12 },
];
