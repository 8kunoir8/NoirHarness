/**
 * CSV/TSV parser for the artifact preview.
 *
 * Handles RFC 4180 quoting (embedded delimiters, newlines and `""` escapes),
 * CRLF row separators, a leading UTF-8 BOM and delimiter inference. Output is
 * bounded: at most `MAX_ROWS` data rows, `MAX_COLUMNS` columns and
 * `MAX_CELL_CHARS` characters per cell; everything past a bound is dropped and
 * reported through `truncated`.
 *
 * Rows are ragged: they are neither padded to the header width nor trimmed to
 * it, so a row may carry fewer or more cells than `headers`. Renderers must
 * tolerate both shapes.
 */

export const MAX_ROWS = 5_000;
export const MAX_COLUMNS = 100;
export const MAX_CELL_CHARS = 500;

const DELIMITERS = [",", ";", "\t", "|"] as const;
const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/** Raw rows are held until the header decision, which needs one extra row. */
const MAX_RAW_ROWS = MAX_ROWS + 2;

export interface ParseCsvOptions {
  /** Overrides inference, e.g. to parse a `.tsv` whose text contains commas. */
  delimiter?: string;
}

export interface CsvTable {
  headers: string[];
  rows: string[][];
  truncated: boolean;
  delimiter: string;
}

export function parseCsv(text: string, opts: ParseCsvOptions = {}): CsvTable {
  const source = text.startsWith("\uFEFF") ? text.slice(1) : text;
  const delimiter = opts.delimiter ?? inferDelimiter(source);
  const { rawRows, truncated } = scanRows(source, delimiter);
  return finalize(rawRows, truncated, delimiter);
}

/** Picks the delimiter with the highest count on the first physical line, ignoring quotes; ties (and no match) go to `,`. */
function inferDelimiter(source: string): string {
  const counts = DELIMITERS.map(() => 0);
  let inQuotes = false;
  let fieldStart = true;

  for (let index = 0; index < source.length; index += 1) {
    const char = source.charAt(index);
    // A quoted cell may span a newline, but inference never looks past the first
    // physical line; otherwise delimiters in later lines would skew the count.
    if (char === "\n" || char === "\r") break;
    if (inQuotes) {
      if (char === '"') {
        if (source.charAt(index + 1) === '"') index += 1;
        else inQuotes = false;
      }
      continue;
    }
    if (char === '"' && fieldStart) {
      inQuotes = true;
      fieldStart = false;
      continue;
    }
    const delimiterIndex = (DELIMITERS as readonly string[]).indexOf(char);
    if (delimiterIndex >= 0) {
      counts[delimiterIndex] = (counts[delimiterIndex] ?? 0) + 1;
      fieldStart = true;
    } else {
      fieldStart = false;
    }
  }

  const max = Math.max(...counts);
  if (max === 0) return ",";
  const top = counts.filter((count) => count === max);
  return top.length === 1 ? (DELIMITERS[counts.indexOf(max)] ?? ",") : ",";
}

function scanRows(source: string, delimiter: string): { rawRows: string[][]; truncated: boolean } {
  const rawRows: string[][] = [];
  let cells: string[] = [];
  let field = "";
  let inQuotes = false;
  let quoted = false;
  let rowStarted = false;
  let truncated = false;
  let stopped = false;

  const append = (char: string): void => {
    if (field.length < MAX_CELL_CHARS) field += char;
    else truncated = true;
  };

  const endField = (): void => {
    if (cells.length < MAX_COLUMNS) cells.push(field);
    else truncated = true;
    field = "";
    quoted = false;
  };

  const endRow = (): void => {
    endField();
    if (rawRows.length >= MAX_RAW_ROWS) {
      truncated = true;
      stopped = true;
    } else {
      rawRows.push(cells);
    }
    cells = [];
    rowStarted = false;
  };

  for (let index = 0; index < source.length && !stopped; index += 1) {
    const char = source.charAt(index);

    if (inQuotes) {
      if (char === '"') {
        if (source.charAt(index + 1) === '"') {
          append('"');
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        append(char);
      }
      continue;
    }

    if (char === '"' && field.length === 0 && !quoted) {
      inQuotes = true;
      quoted = true;
      rowStarted = true;
      continue;
    }

    if (char === delimiter) {
      rowStarted = true;
      endField();
      continue;
    }

    if (char === "\n") {
      if (rowStarted) endRow();
      continue;
    }

    if (char === "\r") {
      if (source.charAt(index + 1) === "\n") index += 1;
      if (rowStarted) endRow();
      continue;
    }

    append(char);
    rowStarted = true;
  }

  if (!stopped && rowStarted) endRow();

  return { rawRows, truncated };
}

function finalize(rawRows: string[][], truncated: boolean, delimiter: string): CsvTable {
  const firstRow = rawRows[0];
  let headers: string[];
  let rows: string[][];

  if (
    firstRow !== undefined &&
    firstRow.length > 0 &&
    firstRow.every((cell) => cell !== "") &&
    firstRow.some((cell) => !NUMBER.test(cell.trim()))
  ) {
    headers = firstRow;
    rows = rawRows.slice(1);
  } else {
    headers = Array.from({ length: firstRow?.length ?? 0 }, (_, index) => `Column ${index + 1}`);
    rows = rawRows;
  }

  if (rows.length > MAX_ROWS) {
    rows = rows.slice(0, MAX_ROWS);
    truncated = true;
  }

  return { headers, rows, truncated, delimiter };
}
