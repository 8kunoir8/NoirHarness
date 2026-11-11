import type { OfficePoint } from "./mapper.js";

/** Four-neighbour A*, no diagonals (spec §9.3). */
const NEIGHBOURS: readonly OfficePoint[] = [
  { x: 0, y: -1 },
  { x: -1, y: 0 },
  { x: 1, y: 0 },
  { x: 0, y: 1 },
];

interface Node {
  x: number;
  y: number;
  g: number;
  f: number;
}

function walkable(grid: readonly (readonly boolean[])[], point: OfficePoint): boolean {
  const row = grid[point.y];
  return row !== undefined && point.x >= 0 && point.x < row.length && row[point.x] === true;
}

/**
 * Returns the tiles to walk through, excluding `from` and including `to`, or `null` when the goal is
 * unreachable. Start equals goal is a zero-length walk, not a failure.
 */
export function findPath(
  grid: readonly (readonly boolean[])[],
  from: OfficePoint,
  to: OfficePoint,
): OfficePoint[] | null {
  if (from.x === to.x && from.y === to.y) return [];
  if (!walkable(grid, from) || !walkable(grid, to)) return null;

  const key = (x: number, y: number): number => y * 4096 + x;
  const heuristic = (x: number, y: number): number => Math.abs(x - to.x) + Math.abs(y - to.y);

  const open: Node[] = [{ x: from.x, y: from.y, g: 0, f: heuristic(from.x, from.y) }];
  const cameFrom = new Map<number, number>();
  const best = new Map<number, number>([[key(from.x, from.y), 0]]);
  const closed = new Set<number>();
  const goal = key(to.x, to.y);

  while (open.length > 0) {
    // The grid is 24×16, so a linear scan of the open set beats the bookkeeping of a heap.
    let currentIndex = 0;
    for (let index = 1; index < open.length; index += 1) {
      if ((open[index]?.f ?? 0) < (open[currentIndex]?.f ?? 0)) currentIndex = index;
    }
    const current = open.splice(currentIndex, 1)[0];
    if (current === undefined) break;
    if (current.x === to.x && current.y === to.y) {
      const path: OfficePoint[] = [];
      let cursor = goal;
      while (cursor !== key(from.x, from.y)) {
        const x = cursor % 4096;
        const y = Math.floor(cursor / 4096);
        path.push({ x, y });
        const previous = cameFrom.get(cursor);
        if (previous === undefined) return null;
        cursor = previous;
      }
      path.reverse();
      return path;
    }

    const currentKey = key(current.x, current.y);
    if (closed.has(currentKey)) continue;
    closed.add(currentKey);

    for (const offset of NEIGHBOURS) {
      const next = { x: current.x + offset.x, y: current.y + offset.y };
      if (!walkable(grid, next)) continue;
      const nextKey = key(next.x, next.y);
      if (closed.has(nextKey)) continue;
      const g = current.g + 1;
      if (g >= (best.get(nextKey) ?? Number.POSITIVE_INFINITY)) continue;
      best.set(nextKey, g);
      cameFrom.set(nextKey, currentKey);
      open.push({ x: next.x, y: next.y, g, f: g + heuristic(next.x, next.y) });
    }
  }

  return null;
}
