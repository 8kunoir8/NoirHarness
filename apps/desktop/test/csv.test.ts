import { describe, expect, it } from "vitest";
import { parseCsv } from "../src/renderer/preview/csv.js";

describe("parseCsv", () => {
  it("parses quoted commas and embedded newlines", () => {
    const table = parseCsv('a,b\n"x,1","y\n2"\n');
    expect(table.headers).toEqual(["a", "b"]);
    expect(table.rows).toEqual([["x,1", "y\n2"]]);
    expect(table.truncated).toBe(false);
  });

  it("strips a UTF-8 BOM before inferring a semicolon delimiter", () => {
    const table = parseCsv("\uFEFFa;b\n1;2\n");
    expect(table.delimiter).toBe(";");
    expect(table.headers).toEqual(["a", "b"]);
    expect(table.rows).toEqual([["1", "2"]]);
  });

  it("infers tab and pipe delimiters and defaults to a comma", () => {
    expect(parseCsv("a\tb\n1\t2\n").delimiter).toBe("\t");
    expect(parseCsv("a|b\n1|2\n").delimiter).toBe("|");
    expect(parseCsv("single\n").delimiter).toBe(",");
    expect(parseCsv("a;b\tc\n1;2\t3\n").delimiter).toBe(",");
  });

  it("infers the delimiter from the first physical line when a quoted cell spans a newline", () => {
    const table = parseCsv('name,"multi\nline",tail\nann,"y\nz",end\n');
    expect(table.delimiter).toBe(",");
    expect(table.headers).toEqual(["name", "multi\nline", "tail"]);
    expect(table.rows).toEqual([["ann", "y\nz", "end"]]);
  });

  it("uses the first row as headers when every cell is non-empty and some is not numeric", () => {
    const table = parseCsv("name,age\nann,3\n");
    expect(table.headers).toEqual(["name", "age"]);
    expect(table.rows).toEqual([["ann", "3"]]);
  });

  it("generates Column 1..N headers for a numeric first row and keeps it as data", () => {
    const table = parseCsv("1,2\n3,4\n");
    expect(table.headers).toEqual(["Column 1", "Column 2"]);
    expect(table.rows).toEqual([
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  it("rejects a header row with an empty cell", () => {
    const table = parseCsv("name,\nann,3\n");
    expect(table.headers).toEqual(["Column 1", "Column 2"]);
    expect(table.rows).toEqual([
      ["name", ""],
      ["ann", "3"],
    ]);
  });

  it("unescapes doubled quotes inside quoted fields", () => {
    expect(parseCsv('a,b\n"say ""hi""",2\n').rows).toEqual([['say "hi"', "2"]]);
  });

  it("ends a quoted section at a quote followed by a non-quote", () => {
    expect(parseCsv('a,b\n"x"y,2\n').rows).toEqual([["xy", "2"]]);
  });

  it("handles CRLF as a row separator and inside quotes as content", () => {
    expect(parseCsv("a,b\r\n1,2\r\n").rows).toEqual([["1", "2"]]);
    expect(parseCsv('a,b\n"x\r\ny",2\n').rows).toEqual([["x\r\ny", "2"]]);
  });

  it("does not add rows for trailing newlines or blank lines", () => {
    expect(parseCsv("a,b\n1,2\n\n").rows).toEqual([["1", "2"]]);
  });

  it("consumes an unterminated quote to the end of the input", () => {
    expect(parseCsv('a,b\n"x,1').rows).toEqual([["x,1"]]);
  });

  it("returns an empty table for an empty file", () => {
    expect(parseCsv("")).toEqual({ headers: [], rows: [], truncated: false, delimiter: "," });
  });

  it("caps the table at 5,000 data rows", () => {
    const csv = ["a,b", ...Array.from({ length: 5_001 }, (_, index) => `${index},x`)].join("\n") + "\n";
    const table = parseCsv(csv);
    expect(table.rows).toHaveLength(5_000);
    expect(table.rows[4_999]).toEqual(["4999", "x"]);
    expect(table.truncated).toBe(true);
  });

  it("does not flag truncation at exactly 5,000 data rows", () => {
    const csv = ["a,b", ...Array.from({ length: 5_000 }, (_, index) => `${index},x`)].join("\n") + "\n";
    const table = parseCsv(csv);
    expect(table.rows).toHaveLength(5_000);
    expect(table.truncated).toBe(false);
  });

  it("caps the table at 100 columns", () => {
    const header = Array.from({ length: 101 }, (_, index) => `c${index}`).join(",");
    const row = Array.from({ length: 101 }, (_, index) => String(index)).join(",");
    const table = parseCsv(`${header}\n${row}\n`);
    expect(table.headers).toHaveLength(100);
    expect(table.headers[99]).toBe("c99");
    expect(table.rows[0]).toHaveLength(100);
    expect(table.truncated).toBe(true);
  });

  it("caps each cell at 500 characters", () => {
    const table = parseCsv(`a\n${"x".repeat(501)}\n`);
    expect(table.rows[0]?.[0]).toBe("x".repeat(500));
    expect(table.truncated).toBe(true);
  });

  it("honours an explicit delimiter override", () => {
    const table = parseCsv("a,b\tc\n1,2\t3\n", { delimiter: "\t" });
    expect(table.delimiter).toBe("\t");
    expect(table.headers).toEqual(["a,b", "c"]);
  });
});
