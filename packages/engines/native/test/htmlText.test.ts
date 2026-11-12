import { describe, expect, it } from "vitest";
import { htmlToText } from "../src/htmlText.js";

const text = (html: string, baseUrl?: string): string =>
  baseUrl === undefined ? htmlToText(html) : htmlToText(html, { baseUrl });

describe("htmlToText structure", () => {
  it("turns headings into Markdown headings", () => {
    expect(text("<h1>Title</h1><h2>Sub</h2><p>Body</p>")).toBe("# Title\n\n## Sub\n\nBody");
  });

  it("separates paragraphs and collapses source whitespace", () => {
    expect(text("<p>one\n\n  two</p><p>three</p>")).toBe("one two\n\nthree");
  });

  it("nests lists by depth and numbers ordered lists", () => {
    expect(text("<ul><li>a</li><li>b<ul><li>c</li></ul></li></ul>")).toBe("- a\n- b\n  - c");
    expect(text("<ol><li>a</li><li>b</li></ol>")).toBe("1. a\n2. b");
  });

  it("keeps table rows and cell boundaries", () => {
    expect(text("<table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table>")).toBe(
      "a | b\n1 | 2",
    );
  });

  it("keeps inline code and fenced code verbatim", () => {
    expect(text("<p>use <code>a  b</code></p>")).toBe("use `a b`");
    expect(text("<pre>line 1\n    indented\n</pre>")).toBe("```\nline 1\n    indented\n```");
  });

  it("wraps links and resolves them against the page URL", () => {
    expect(text('<p>see <a href="/docs">the docs</a></p>', "https://example.com/page")).toBe(
      "see [the docs](https://example.com/docs)",
    );
    expect(text('<a href="https://a.test/x">x</a>')).toBe("[x](https://a.test/x)");
  });

  it("drops a link target that would execute or carry data", () => {
    expect(text('<a href="javascript:alert(1)">click</a>')).toBe("click");
    expect(text('<a href="data:text/html,<b>x</b>">d</a>')).toBe("d");
  });

  it("keeps image alt text", () => {
    expect(text('<p><img src="a.png" alt="a chart"></p>')).toBe("a chart");
  });

  it("puts the title first when the body does not repeat it", () => {
    expect(text("<html><head><title>Doc</title></head><body><p>b</p></body></html>")).toBe("# Doc\n\nb");
    expect(text("<title>Doc</title><h1>Doc</h1><p>b</p>")).toBe("# Doc\n\nb");
  });

  it("decodes named and numeric entities", () => {
    expect(text("<p>a &amp; b &lt;c&gt; &#65;&#x42; &mdash; d</p>")).toBe("a & b <c> AB \u2014 d");
  });

  it("keeps text inside an unclosed element and ignores a stray close tag", () => {
    expect(text("</div><p>kept")).toBe("kept");
  });

  it("treats a bare less-than as text", () => {
    expect(text("<p>1 < 2</p>")).toBe("1 < 2");
  });
});

describe("htmlToText hidden content", () => {
  it("drops script and style bodies even when they contain markup characters", () => {
    expect(text("<p>a</p><script>if (a < b) { document.write('<p>no</p>'); }</script><style>p{}</style>")).toBe("a");
  });

  it("drops a subtree hidden from assistive technology", () => {
    const html = '<p>visible</p><nav aria-hidden="true"><a href="/x">dup</a></nav>';
    expect(text(html)).toBe("visible");
  });

  it("drops a subtree marked hidden or display:none", () => {
    expect(text('<p>a</p><div hidden>b</div><div style="display: none">c</div>')).toBe("a");
  });

  it("keeps only one copy when a mobile menu duplicates real content", () => {
    const html = '<nav aria-hidden="true"><a href="/a">One</a></nav><main><a href="/a">One</a></main>';
    expect(text(html, "https://x.test/")).toBe("[One](https://x.test/a)");
  });
});

describe("htmlToText malformed input", () => {
  it("does not hang or throw on an unterminated tag", () => {
    expect(text("<p>a</p><span class=")).toBe("a");
  });

  it("closes elements implicitly at the end of the document", () => {
    expect(text("<ul><li>a<li>b")).toBe("- a\n- b");
  });

  it("ignores comments and doctype", () => {
    expect(text("<!DOCTYPE html><!-- <p>no</p> --><p>yes</p>")).toBe("yes");
  });
});

describe("htmlToText content landmark", () => {
  const page = (body: string): string =>
    `<html><head><title>Doc</title></head><body><header><nav>site chrome</nav></header>${body}<footer>legal</footer></body></html>`;

  it("keeps only the main landmark when the page marks one", () => {
    expect(text(page("<main><p>article</p></main>"))).toBe("# Doc\n\narticle");
  });

  it("accepts role=main as the same landmark", () => {
    expect(text(page('<div role="main"><p>article</p></div>'))).toBe("# Doc\n\narticle");
  });

  it("keeps the whole document when nothing is marked", () => {
    expect(text(page("<p>article</p>"))).toBe("# Doc\n\nsite chrome\n\narticle\n\nlegal");
  });

  it("handles a nested main landmark without cutting the article short", () => {
    expect(text(page("<main><div><main><p>deep</p></main></div><p>after</p></main>"))).toBe("# Doc\n\ndeep\n\nafter");
  });

  it("ignores a main tag that only appears inside a script", () => {
    expect(text(page('<script>const s = "<main>x</main>";</script><p>real</p>'))).toBe("# Doc\n\nsite chrome\n\nreal\n\nlegal");
  });
});
