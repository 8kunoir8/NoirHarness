import type { OfficePoint } from "./mapper.js";

/**
 * The twelve walkable tiles where the characters stand, one per desk. The desk art is drawn over the
 * lower half of a seat, so a seat stays walkable while its agent reads as sitting behind the desk. It
 * lives in its own module so the roster path never pulls the full map into the startup bundle; the
 * committed map stays a lazy chunk. `office.test.tsx` asserts every point is still walkable there.
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
