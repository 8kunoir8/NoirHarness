import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Minimal but structurally valid one-page PDF. pdf.js reads the cross-reference table
 * eagerly, so the offsets are computed from the bytes actually written instead of being
 * hard-coded; the page draws a red square so a real render has visible pixels.
 */
function buildSmallPdf() {
  const content = "1 0 0 RG 10 10 180 180 re S\n";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << >> >>",
    `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}endstream`,
  ];

  let pdf = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf, "latin1");
  // Every entry is exactly 20 bytes: 10-digit offset, 5-digit generation, type, two bytes.
  pdf += "xref\n0 5\n0000000000 65535 f \n";
  for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

/** Markdown that must render its GFM table while every hostile construct stays inert. */
const NOTES = [
  "# Artifact notes",
  "",
  "| File | Kind |",
  "| --- | --- |",
  "| data.csv | table |",
  "",
  '<script>alert("script")</script>',
  "",
  '<img src="x" onerror="alert(\'onerror\')">',
  "",
  "[hostile link](javascript:alert(1))",
  "",
].join("\n");

/** BOM, a quoted comma, and an embedded newline: the three CSV paths the parser must survive. */
const DATA_CSV = '\uFEFFname,note\r\n"x,1","line one\nline two"\r\n';

/**
 * Writes the artifact fixtures into `dir`. They are generated per run so the repository holds
 * no binary blobs; `huge.pdf` is 32 MiB + 1, above the kernel's cap, and never stored.
 */
export function writeArtifactFixtures(dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "notes.md"), NOTES, "utf8");
  writeFileSync(join(dir, "data.csv"), DATA_CSV, "utf8");
  writeFileSync(join(dir, "small.pdf"), buildSmallPdf());
  writeFileSync(
    join(dir, "huge.pdf"),
    Buffer.concat([Buffer.from("%PDF-1.4\n", "latin1"), Buffer.alloc(32 * 1024 * 1024 + 1)]),
  );
}
