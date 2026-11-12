/**
 * HTML to readable text for `web.fetch`.
 *
 * This is a tokenizer with an element stack, not a chain of regexes, because the things that made a
 * regex version lossy are exactly the things a regex cannot see: nesting (a `</table>` that closes
 * the table opened three levels up), element identity (only `<code>` is code, not `<kbd>`), and
 * attributes that hide a subtree (`aria-hidden="true"`, `hidden`, `display:none`) — the last is what
 * duplicates a nav or a mobile menu into the middle of the text.
 *
 * The output is Markdown-ish: headings, lists, tables, fenced code, and inline code survive. It is
 * not a document renderer: no styling, no layout, no images beyond their alt text.
 */

/** Content that is never document text. Each one is skipped wholesale, to its own closing tag. */
const SKIPPED: Record<string, true> = {
  script: true,
  style: true,
  noscript: true,
  template: true,
  svg: true,
  math: true,
  iframe: true,
  object: true,
  embed: true,
  canvas: true,
  video: true,
  audio: true,
  map: true,
  select: true,
  datalist: true,
  textarea: true,
};

const VOID: Record<string, true> = {
  area: true,
  base: true,
  br: true,
  col: true,
  embed: true,
  hr: true,
  img: true,
  input: true,
  link: true,
  meta: true,
  param: true,
  source: true,
  track: true,
  wbr: true,
};

/** Elements whose presence means "a paragraph ended here": a blank line on both sides. */
const PARAGRAPHS: Record<string, true> = {
  p: true,
  blockquote: true,
  table: true,
  dl: true,
  figure: true,
  figcaption: true,
  details: true,
  address: true,
  h1: true,
  h2: true,
  h3: true,
  h4: true,
  h5: true,
  h6: true,
};

/** Elements that separate content without claiming a whole paragraph. */
const LINES: Record<string, true> = {
  div: true,
  section: true,
  article: true,
  header: true,
  footer: true,
  main: true,
  nav: true,
  aside: true,
  form: true,
  fieldset: true,
  summary: true,
  tr: true,
  dt: true,
  dd: true,
  thead: true,
  tbody: true,
  tfoot: true,
};

const HEADINGS: Record<string, number> = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 };

/**
 * End tags HTML lets the document omit. Opening the key closes the listed elements, so
 * `<li>a<li>b` is two items rather than one run-together line.
 */
const IMPLIED_CLOSE: Record<string, Record<string, true>> = {
  li: { li: true },
  p: { p: true },
  dt: { dt: true, dd: true },
  dd: { dt: true, dd: true },
  td: { td: true, th: true },
  th: { td: true, th: true },
  tr: { tr: true, td: true, th: true },
  option: { option: true },
};

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "\u2014",
  ndash: "\u2013",
  hellip: "\u2026",
  copy: "\u00a9",
  reg: "\u00ae",
  trade: "\u2122",
  laquo: "\u00ab",
  raquo: "\u00bb",
  ldquo: "\u201c",
  rdquo: "\u201d",
  lsquo: "\u2018",
  rsquo: "\u2019",
  middot: "\u00b7",
  bull: "\u2022",
  deg: "\u00b0",
  plusmn: "\u00b1",
  times: "\u00d7",
  divide: "\u00f7",
  frac12: "\u00bd",
  frac14: "\u00bc",
  frac34: "\u00be",
  sup2: "\u00b2",
  sup3: "\u00b3",
  micro: "\u00b5",
  para: "\u00b6",
  sect: "\u00a7",
  euro: "\u20ac",
  pound: "\u00a3",
  yen: "\u00a5",
  cent: "\u00a2",
  larr: "\u2190",
  rarr: "\u2192",
  uarr: "\u2191",
  darr: "\u2193",
  harr: "\u2194",
  rArr: "\u21d2",
  lArr: "\u21d0",
  hArr: "\u21d4",
  infin: "\u221e",
  ne: "\u2260",
  le: "\u2264",
  ge: "\u2265",
  asymp: "\u2248",
  equiv: "\u2261",
  minus: "\u2212",
  sum: "\u2211",
  prod: "\u220f",
  radic: "\u221a",
  ensp: " ",
  emsp: " ",
  thinsp: " ",
  zwnj: "",
  zwj: "",
  shy: "",
};

const ENTITY = /&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([A-Za-z][A-Za-z0-9]*));/g;

function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(ENTITY, (whole, decimal: string | undefined, hex: string | undefined, named: string | undefined) => {
    if (named !== undefined) return NAMED_ENTITIES[named] ?? whole;
    const code = decimal !== undefined ? Number.parseInt(decimal, 10) : Number.parseInt(hex ?? "", 16);
    if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
    if (code >= 0xd800 && code <= 0xdfff) return whole;
    return String.fromCodePoint(code);
  });
}

const TAG_NAME = /[A-Za-z][A-Za-z0-9:-]*/;

function isHiddenElement(attrs: Map<string, string>): boolean {
  if (attrs.has("hidden")) return true;
  if ((attrs.get("aria-hidden") ?? "").toLowerCase() === "true") return true;
  const style = attrs.get("style") ?? "";
  return /display\s*:\s*none|visibility\s*:\s*hidden/i.test(style);
}

/** Parses attributes from just after the tag name to just after the closing `>`. */
function parseAttributes(html: string, from: number): { attrs: Map<string, string>; end: number; selfClosing: boolean } {
  const attrs = new Map<string, string>();
  let selfClosing = false;
  let i = from;
  while (i < html.length) {
    const char = html.charAt(i);
    if (char === ">") return { attrs, end: i + 1, selfClosing };
    if (char === "/" && html.charAt(i + 1) === ">") return { attrs, end: i + 2, selfClosing: true };
    if (/\s/.test(char)) {
      i++;
      continue;
    }
    const nameStart = i;
    while (i < html.length) {
      const c = html.charAt(i);
      if (c === "=" || c === ">" || c === "/" || /\s/.test(c)) break;
      i++;
    }
    const name = html.slice(nameStart, i).toLowerCase();
    if (name === "") {
      i++;
      continue;
    }
    let j = i;
    while (j < html.length && /\s/.test(html.charAt(j))) j++;
    if (html.charAt(j) !== "=") {
      if (!attrs.has(name)) attrs.set(name, "");
      continue;
    }
    j++;
    while (j < html.length && /\s/.test(html.charAt(j))) j++;
    const quote = html.charAt(j);
    if (quote === '"' || quote === "'") {
      const end = html.indexOf(quote, j + 1);
      const value = html.slice(j + 1, end === -1 ? html.length : end);
      if (!attrs.has(name)) attrs.set(name, value);
      i = end === -1 ? html.length : end + 1;
    } else {
      const valueStart = j;
      while (j < html.length && !/[\s>]/.test(html.charAt(j))) j++;
      if (!attrs.has(name)) attrs.set(name, html.slice(valueStart, j));
      i = j;
    }
  }
  return { attrs, end: html.length, selfClosing };
}

/** Index range of `</name ...>`, or the end of the document when it never closes. */
function findEndTag(html: string, from: number, name: string): { start: number; end: number } {
  const pattern = new RegExp(`</${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b[^>]*>`, "gi");
  pattern.lastIndex = from;
  const match = pattern.exec(html);
  return match === null ? { start: html.length, end: html.length } : { start: match.index, end: match.index + match[0].length };
}

/** Inline markup gone, text and entities kept: for `title`, `pre`, and other text-only contexts. */
function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ""));
}

/**
 * Accumulates the output. Collapsing happens here rather than in a pass at the end, so indentation
 * a list writes on purpose survives while incidental whitespace in the source does not.
 */
class TextWriter {
  readonly #chunks: string[] = [];
  #size = 0;
  #breaks = 0;
  #space = false;
  #last = "";

  /**
   * Where a captured span starts. The pending space is written first, so the space *between* "see"
   * and a link is not inside the link's captured text.
   */
  mark(): number {
    this.#flushSpace();
    return this.#chunks.length;
  }

  text(raw: string): void {
    if (raw === "") return;
    const collapsed = raw.replace(/[\s\u00a0]+/g, " ");
    const body = collapsed.trim();
    if (collapsed.startsWith(" ")) this.#space = true;
    if (body !== "") {
      this.#flush();
      this.#flushSpace();
      this.#push(body);
    }
    if (collapsed.endsWith(" ")) this.#space = true;
  }

  /** A line starts here, with `prefix` written as-is: list markers and their indentation. */
  startLine(prefix: string): void {
    this.#flush();
    this.#space = false;
    this.#push(prefix);
  }

  /** A placeholder for content that must not be collapsed, indented, or trimmed: code blocks. */
  token(index: number): void {
    this.#flush();
    this.#flushSpace();
    this.#push(`\u0000${index}\u0000`);
  }

  breakLine(): void {
    this.#breaks = Math.max(this.#breaks, 1);
    this.#space = false;
  }

  breakBlock(): void {
    this.#breaks = Math.max(this.#breaks, 2);
    this.#space = false;
  }

  /** Everything written since `mark`, removed from the output: a link's or code span's inner text. */
  take(mark: number): string {
    if (mark >= this.#chunks.length) {
      this.#breaks = 0;
      this.#space = false;
      return "";
    }
    const removed = this.#chunks.splice(mark);
    for (const chunk of removed) this.#size -= chunk.length;
    const last = this.#chunks.at(-1);
    this.#last = last === undefined ? "" : last.slice(-1);
    this.#breaks = 0;
    this.#space = false;
    return removed.join("");
  }

  finish(): string {
    return this.#chunks.join("");
  }

  #flush(): void {
    if (this.#breaks === 0) return;
    if (this.#size > 0) this.#push("\n".repeat(this.#breaks));
    this.#breaks = 0;
  }

  #flushSpace(): void {
    if (this.#space && this.#last !== "" && !/\s/.test(this.#last)) this.#push(" ");
    this.#space = false;
  }

  #push(value: string): void {
    if (value === "") return;
    this.#chunks.push(value);
    this.#size += value.length;
    this.#last = value.slice(-1);
  }
}

export interface HtmlTextOptions {
  /** Resolves relative `href`s; without it a relative link keeps its text and no target. */
  baseUrl?: string;
}

interface OpenElement {
  name: string;
  hidden: boolean;
  /** Per-element state a close handler needs: a link's start mark, its href. */
  mark?: number;
  href?: string | undefined;
}

/**
 * The range of the element that holds the document's own content, or `undefined` when the page
 * does not mark one. Landmarks are the only signal available without a page-specific heuristic, and
 * they are worth honouring: on a docs site the site chrome can outweigh the article three to one,
 * which pushes the article past the tool's cap.
 *
 * This tokenizes rather than regex-matching, so a `<main>` inside a `<script>` string or an HTML
 * comment cannot be mistaken for the page's.
 */
function findContentRange(html: string): { start: number; end: number } | undefined {
  let i = 0;
  let target: { name: string; depth: number; start: number } | undefined;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) break;
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      i = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith("<!", lt) || html.startsWith("<?", lt)) {
      const end = html.indexOf(">", lt + 2);
      i = end === -1 ? html.length : end + 1;
      continue;
    }
    const closing = html.charAt(lt + 1) === "/";
    const nameMatch = TAG_NAME.exec(html.slice(lt + (closing ? 2 : 1), lt + 66));
    const name = nameMatch === null ? "" : nameMatch[0].toLowerCase();
    const parsed = parseAttributes(html, lt + (closing ? 2 : 1) + name.length);
    if (name === "") {
      i = lt + 1;
      continue;
    }

    if (closing) {
      i = parsed.end;
      if (target !== undefined && name === target.name) {
        target.depth--;
        if (target.depth === 0) return { start: target.start, end: lt };
      }
      continue;
    }
    if (SKIPPED[name] === true && VOID[name] !== true) {
      i = findEndTag(html, parsed.end, name).end;
      continue;
    }
    i = parsed.end;
    if (target !== undefined) {
      if (name === target.name && parsed.selfClosing === false) target.depth++;
      continue;
    }
    const role = (parsed.attrs.get("role") ?? "").toLowerCase();
    if ((name === "main" || role === "main") && !parsed.selfClosing) {
      target = { name, depth: 1, start: i };
    }
  }
  return undefined;
}

export function htmlToText(html: string, options: HtmlTextOptions = {}): string {
  const writer = new TextWriter();
  const blocks: string[] = [];
  const stack: OpenElement[] = [];
  const lists: Array<{ ordered: boolean; index: number }> = [];
  let hiddenDepth = 0;
  let rowCells = 0;
  // The title sits in the head, so it is read from the whole document even when the body is
  // restricted to the content landmark.
  const titleTag = /<title\b/i.exec(html);
  const title =
    titleTag === null
      ? ""
      : stripTags(html.slice(titleTag.index, findEndTag(html, titleTag.index, "title").start))
          .replace(/\s+/g, " ")
          .trim();
  const content = findContentRange(html);
  const limit = content?.end ?? html.length;
  let i = content?.start ?? 0;

  const emitText = (raw: string): void => {
    if (hiddenDepth > 0 || raw === "") return;
    writer.text(decodeEntities(raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")));
  };

  const block = (content: string): number => {
    blocks.push(content);
    return blocks.length - 1;
  };

  const resolveHref = (href: string): string | undefined => {
    const value = decodeEntities(href).trim();
    if (value === "" || /^(javascript|data|vbscript|file):/i.test(value)) return undefined;
    // A same-page anchor is navigation inside the document, not a target to fetch later.
    if (value.startsWith("#")) return undefined;
    if (options.baseUrl === undefined) return value;
    try {
      return new URL(value, options.baseUrl).toString();
    } catch {
      return undefined;
    }
  };

  const closeElement = (open: OpenElement): void => {
    const name = open.name;
    if (name === "a") {
      const inner = writer.take(open.mark ?? 0).trim();
      if (inner !== "") writer.text(open.href === undefined ? inner : `[${inner}](${open.href})`);
      return;
    }
    if (name === "code") {
      const inner = writer.take(open.mark ?? 0).trim().replace(/\s+/g, " ");
      if (inner !== "") writer.token(block(`\`${inner}\``));
      return;
    }
    if (name === "li") {
      writer.breakLine();
      return;
    }
    if (name === "ul" || name === "ol") {
      lists.pop();
      if (lists.length > 0) writer.breakLine();
      else writer.breakBlock();
      return;
    }
    if (HEADINGS[name] !== undefined) {
      writer.breakBlock();
      return;
    }
    if (PARAGRAPHS[name] === true) {
      writer.breakBlock();
      return;
    }
    if (LINES[name] === true) writer.breakLine();
  };

  const openElement = (open: OpenElement, attrs: Map<string, string>): void => {
    const name = open.name;
    switch (name) {
      case "br":
        writer.breakLine();
        return;
      case "hr":
        writer.breakBlock();
        return;
      case "img": {
        const alt = decodeEntities(attrs.get("alt") ?? "").trim();
        if (alt !== "") writer.text(alt);
        return;
      }
      case "a": {
        open.mark = writer.mark();
        const href = attrs.get("href");
        open.href = href === undefined ? undefined : resolveHref(href);
        return;
      }
      case "code":
        open.mark = writer.mark();
        return;
      case "li": {
        const list = lists.at(-1);
        if (list === undefined) return;
        if (list.ordered) list.index++;
        const indent = "  ".repeat(Math.max(0, lists.length - 1));
        writer.startLine(`${indent}${list.ordered ? `${list.index}. ` : "- "}`);
        return;
      }
      case "ul":
      case "ol":
        // A nested list belongs to the item it sits in: a paragraph break would detach it.
        if (lists.length > 0) writer.breakLine();
        else writer.breakBlock();
        lists.push({ ordered: name === "ol", index: 0 });
        return;
      case "td":
      case "th":
        if (rowCells > 0) writer.text(" | ");
        rowCells++;
        return;
      case "tr":
        writer.breakLine();
        rowCells = 0;
        return;
    }
    const level = HEADINGS[name];
    if (level !== undefined) {
      writer.breakBlock();
      writer.text(`${"#".repeat(level)} `);
      return;
    }
    if (PARAGRAPHS[name] === true) writer.breakBlock();
    else if (LINES[name] === true) writer.breakLine();
  };

  while (i < limit) {
    const lt = html.indexOf("<", i);
    if (lt === -1 || lt >= limit) {
      emitText(html.slice(i, limit));
      break;
    }
    if (lt > i) emitText(html.slice(i, lt));
    i = lt;

    if (html.startsWith("<!--", i)) {
      const end = html.indexOf("-->", i + 4);
      i = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith("<![CDATA[", i)) {
      const end = html.indexOf("]]>", i + 9);
      emitText(html.slice(i + 9, end === -1 ? html.length : end));
      i = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith("<!", i) || html.startsWith("<?", i)) {
      const end = html.indexOf(">", i + 2);
      i = end === -1 ? html.length : end + 1;
      continue;
    }

    const next = html.charAt(i + 1);
    if (next === "/") {
      const start = i + 2;
      const match = TAG_NAME.exec(html.slice(start, start + 64));
      const name = match === null ? "" : match[0].toLowerCase();
      const end = html.indexOf(">", start);
      i = end === -1 ? html.length : end + 1;
      if (name === "") continue;
      let index = -1;
      for (let k = stack.length - 1; k >= 0; k--) {
        if (stack[k]?.name === name) {
          index = k;
          break;
        }
      }
      while (index !== -1 && stack.length > index) {
        const open = stack.pop();
        if (open === undefined) break;
        if (open.hidden) hiddenDepth--;
        else closeElement(open);
      }
      continue;
    }
    if (!/[A-Za-z]/.test(next)) {
      emitText("<");
      i++;
      continue;
    }

    const match = TAG_NAME.exec(html.slice(i + 1, i + 65));
    const name = match === null ? "" : match[0].toLowerCase();
    const parsed = parseAttributes(html, i + 1 + name.length);
    i = parsed.end;
    if (name === "") continue;
    const attrs = parsed.attrs;

    if (SKIPPED[name] === true) {
      if (VOID[name] !== true) i = findEndTag(html, i, name).end;
      continue;
    }
    if (name === "title") {
      i = findEndTag(html, i, name).end;
      continue;
    }
    if (name === "pre") {
      const end = findEndTag(html, i, name);
      const inner = stripTags(html.slice(i, end.start)).replace(/\r\n?/g, "\n").trim();
      i = end.end;
      if (inner === "") continue;
      writer.breakBlock();
      writer.token(block(`\`\`\`\n${inner}\n\`\`\``));
      writer.breakBlock();
      continue;
    }

    if (hiddenDepth > 0 || isHiddenElement(attrs)) {
      if (VOID[name] !== true && !parsed.selfClosing) {
        stack.push({ name, hidden: true });
        hiddenDepth++;
      }
      continue;
    }
    if (VOID[name] === true) {
      openElement({ name, hidden: false }, attrs);
      continue;
    }

    const implied = IMPLIED_CLOSE[name];
    while (implied !== undefined && stack.length > 0) {
      const top = stack.at(-1);
      if (top === undefined || top.hidden || implied[top.name] !== true) break;
      stack.pop();
      closeElement(top);
    }
    const open: OpenElement = { name, hidden: false };
    stack.push(open);
    openElement(open, attrs);
    if (parsed.selfClosing) {
      stack.pop();
      closeElement(open);
    }
  }

  while (stack.length > 0) {
    const open = stack.pop();
    if (open !== undefined && !open.hidden) closeElement(open);
  }

  let text = writer.finish();
  // Paragraphs were separated by deliberate blank lines; only the stray ones are dropped here.
  text = text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  // Code was stored as placeholders so this pass could not touch it.
  text = text.replace(/\u0000(\d+)\u0000/g, (_whole, index: string) => blocks[Number(index)] ?? "");

  if (title !== "" && !text.startsWith(title) && !text.startsWith(`# ${title}`)) {
    text = text === "" ? `# ${title}` : `# ${title}\n\n${text}`;
  }
  return text;
}
