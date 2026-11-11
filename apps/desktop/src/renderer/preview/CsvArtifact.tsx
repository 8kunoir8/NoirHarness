import { useEffect, useMemo, useRef, useState } from "react";
import { MAX_CELL_CHARS, MAX_ROWS, parseCsv } from "./csv.js";

/** Fixed row height in CSS pixels: the window maths only works against a known stride. */
const ROW_HEIGHT = 24;
/** Rows rendered past either edge of the viewport, so a wheel scroll does not show a gap. */
const OVERSCAN = 50;
/** jsdom reports a zero-height pane; the first paint still needs a sensible window. */
const FALLBACK_VIEWPORT_ROWS = 30;

export interface CsvArtifactProps {
  text: string;
}

function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

/** The parser drops everything past the cap, so an at-cap cell is the only evidence it was cut. */
function displayCell(value: string): string {
  return value.length >= MAX_CELL_CHARS ? `${value.slice(0, MAX_CELL_CHARS - 1)}…` : value;
}

export function CsvArtifact({ text }: CsvArtifactProps) {
  const table = useMemo(() => parseCsv(text), [text]);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportRows, setViewportRows] = useState(FALLBACK_VIEWPORT_ROWS);

  // The scrollbar must describe the whole table, so the body is windowed with spacer rows
  // above and below instead of shrinking the scroll range.
  useEffect(() => {
    const element = scrollRef.current;
    if (element === null) return;
    const measure = (): void => {
      const rows = Math.ceil(element.clientHeight / ROW_HEIGHT);
      setViewportRows(rows > 0 ? rows : FALLBACK_VIEWPORT_ROWS);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(measure, 150);
    });
    observer.observe(element);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, []);

  const first = Math.floor(scrollTop / ROW_HEIGHT);
  const start = Math.max(0, first - OVERSCAN);
  const end = Math.min(table.rows.length, first + OVERSCAN + Math.max(viewportRows, OVERSCAN));
  const visible = table.rows.slice(start, end);
  const spacerAbove = start * ROW_HEIGHT;
  const spacerBelow = Math.max(0, (table.rows.length - end) * ROW_HEIGHT);

  if (table.rows.length === 0 && table.headers.length === 0) {
    return (
      <section className="artifact-csv">
        <p className="empty">Empty file</p>
      </section>
    );
  }

  return (
    <section className="artifact-csv">
      <p className="artifact-csv-summary" role="status">
        {table.truncated
          ? `${formatCount(MAX_ROWS)} rows shown (truncated)`
          : `${formatCount(table.rows.length)} ${table.rows.length === 1 ? "row" : "rows"}`}
      </p>
      <div
        className="artifact-csv-scroll"
        ref={scrollRef}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      >
        <table className="artifact-csv-table">
          <thead>
            <tr>
              {table.headers.map((header, index) => (
                <th key={index} scope="col">
                  {displayCell(header)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {spacerAbove > 0 ? <tr aria-hidden="true" style={{ height: spacerAbove }} /> : null}
            {visible.map((row, rowIndex) => {
              const width = Math.max(table.headers.length, row.length);
              return (
                <tr key={start + rowIndex}>
                  {Array.from({ length: width }, (_, cellIndex) => (
                    <td key={cellIndex}>{displayCell(row[cellIndex] ?? "")}</td>
                  ))}
                </tr>
              );
            })}
            {spacerBelow > 0 ? <tr aria-hidden="true" style={{ height: spacerBelow }} /> : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}
