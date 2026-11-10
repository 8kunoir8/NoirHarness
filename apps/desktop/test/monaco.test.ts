import { describe, expect, it } from "vitest";
import { editorThemeFor, languageFor } from "../src/renderer/monaco.js";

describe("monaco helpers", () => {
  it("maps extensions to Monaco languages", () => {
    expect(languageFor("src/main.ts")).toBe("typescript");
    expect(languageFor("a.tsx")).toBe("typescript");
    expect(languageFor("a.mjs")).toBe("javascript");
    expect(languageFor("package.json")).toBe("json");
    expect(languageFor("README.md")).toBe("markdown");
    expect(languageFor("a.py")).toBe("python");
    expect(languageFor("a.yml")).toBe("yaml");
    expect(languageFor("a.sh")).toBe("shell");
    expect(languageFor("a.css")).toBe("css");
    expect(languageFor("a.html")).toBe("html");
    expect(languageFor("Makefile")).toBe("plaintext");
  });

  it("uses one theme per app theme", () => {
    expect(editorThemeFor("paper")).toBe("noir-paper");
    expect(editorThemeFor("ink")).toBe("noir-ink");
  });
});
