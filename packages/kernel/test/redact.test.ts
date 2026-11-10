import { describe, expect, it } from "vitest";
import { REDACTED, Redactor, environmentSecrets, parseRedactionPatterns } from "../src/redact.js";

describe("Redactor", () => {
  it("replaces exact secrets, including inside nested payloads", () => {
    const redactor = new Redactor({ secrets: ["sk-live-1234567890"] });
    expect(redactor.redact({ text: "use sk-live-1234567890 now", list: ["sk-live-1234567890"] }))
      .toEqual({ text: `use ${REDACTED} now`, list: [REDACTED] });
  });

  it("ignores short or blank secrets", () => {
    const redactor = new Redactor({ secrets: ["", "short"] });
    expect(redactor.redactText("short stays")).toBe("short stays");
  });

  it("replaces built-in token shapes", () => {
    const redactor = new Redactor();
    expect(redactor.redactText("key=sk-abcdefghijklmnopqrstuvwx")).toBe(`key=${REDACTED}`);
    expect(redactor.redactText("Authorization: Bearer abcdefghijklmnop")).toBe(`Authorization: Bearer ${REDACTED}`);
  });

  it("applies configured patterns and rejects an invalid entry", () => {
    const redactor = new Redactor({ patterns: parseRedactionPatterns('[":secret-\\\\d+"]') });
    expect(redactor.redactText(":secret-42")).toBe(REDACTED);
    expect(() => parseRedactionPatterns("not json")).toThrow(/NOIR_REDACT_PATTERNS/);
    expect(() => parseRedactionPatterns('["("]')).toThrow(/entry/);
  });

  it("collects sensitive environment values by name", () => {
    const secrets = environmentSecrets({ OPENAI_API_KEY: "sk-env-12345678", GITHUB_TOKEN: "ghp_1234567890abcdef", PATH: "/usr/bin", SHORT_TOKEN: "abc" });
    expect(secrets).toEqual(expect.arrayContaining(["sk-env-12345678", "ghp_1234567890abcdef"]));
    expect(secrets).not.toContain("/usr/bin");
    expect(secrets).not.toContain("abc");
    expect(secrets).toHaveLength(2);
  });

  it("redacts every occurrence of a non-global configured pattern", () => {
    const redactor = new Redactor({ patterns: [/token-\d+/] });
    expect(redactor.redactText("token-1 and token-2 and token-3")).toBe(`${REDACTED} and ${REDACTED} and ${REDACTED}`);
  });

  it("fails closed on a secret nested past the depth cap", () => {
    const redactor = new Redactor({ secrets: ["sk-live-1234567890"] });
    let nested: unknown = "sk-live-1234567890";
    for (let level = 0; level < 34; level += 1) nested = { child: nested };
    let node = redactor.redact(nested);
    for (let level = 0; level < 33; level += 1) {
      if (typeof node !== "object" || node === null || !("child" in node)) throw new Error("depth walk left the payload shape");
      node = node.child;
    }
    expect(node).toBe(REDACTED);
  });

  it("redacts secrets used as object keys", () => {
    const secret = "plain-provider-secret-9d2c";
    const redactor = new Redactor({ secrets: [secret] });
    const redacted = redactor.redact({ [secret]: 1, ok: 2 });
    expect(redacted).toEqual({ [REDACTED]: 1, ok: 2 });
    expect(JSON.stringify(redacted)).toBe(`{"${REDACTED}":1,"ok":2}`);
  });

  it("keeps a __proto__ own key in the redacted clone", () => {
    const redactor = new Redactor({ secrets: ["sk-live-1234567890"] });
    const redacted = redactor.redact(JSON.parse('{"__proto__":"sk-live-1234567890","keep":"sk-live-1234567890"}'));
    if (typeof redacted !== "object" || redacted === null) throw new Error("redact did not return an object");
    expect(Object.keys(redacted)).toContain("__proto__");
    expect(Object.getPrototypeOf(redacted)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(redacted, "keep")?.value).toBe(REDACTED);
    expect(JSON.stringify(redacted)).toBe('{"__proto__":"[REDACTED]","keep":"[REDACTED]"}');
  });
});
