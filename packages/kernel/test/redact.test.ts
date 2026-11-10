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
    expect(environmentSecrets({ OPENAI_API_KEY: "sk-env-12345678", GITHUB_TOKEN: "ghp_1234567890abcdef", PATH: "/usr/bin", SHORT_TOKEN: "abc" }))
      .toEqual(expect.arrayContaining(["sk-env-12345678", "ghp_1234567890abcdef"]));
  });
});
