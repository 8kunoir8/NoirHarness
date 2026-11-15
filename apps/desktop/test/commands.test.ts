import { describe, expect, it } from "vitest";
import { matchesShortcut, shortcutKey, shortcutLabel, type Shortcut } from "../src/renderer/commands.js";

function event(init: { key: string; code?: string; ctrl?: boolean; shift?: boolean; alt?: boolean }): KeyboardEvent {
  return {
    key: init.key,
    ...(init.code === undefined ? {} : { code: init.code }),
    ctrlKey: init.ctrl ?? false,
    metaKey: false,
    shiftKey: init.shift ?? false,
    altKey: init.alt ?? false,
  } as KeyboardEvent;
}

describe("shortcutLabel", () => {
  it("writes a chord the way this platform's keyboard reads it", () => {
    expect(shortcutLabel({ key: "k", mod: true, shift: true }, "win32")).toBe("Ctrl+Shift+K");
    expect(shortcutLabel({ key: "g", mod: true, shift: true }, "linux")).toBe("Ctrl+Shift+G");
    expect(shortcutLabel({ key: "f1" }, "win32")).toBe("F1");
    expect(shortcutLabel({ key: "a", mod: true, alt: true }, "win32")).toBe("Ctrl+Alt+A");
  });

  it("keeps the glyph form on macOS", () => {
    expect(shortcutLabel({ key: "k", mod: true, shift: true }, "darwin")).toBe("⌘⇧K");
    expect(shortcutLabel({ key: "g", mod: true, alt: true }, "darwin")).toBe("⌘⌥G");
  });
});

describe("matchesShortcut", () => {
  it("treats an unset alt as absent and a set alt as required", () => {
    expect(matchesShortcut(event({ key: "x", ctrl: true }), { key: "x", mod: true })).toBe(true);
    expect(matchesShortcut(event({ key: "x", ctrl: true, alt: true }), { key: "x", mod: true })).toBe(false);
    expect(matchesShortcut(event({ key: "x", ctrl: true, alt: true }), { key: "x", mod: true, alt: true })).toBe(true);
    expect(matchesShortcut(event({ key: "x", ctrl: true }), { key: "x", mod: true, alt: true })).toBe(false);
  });

  it("matches a bare key only when no modifier is held", () => {
    expect(matchesShortcut(event({ key: "c" }), { key: "c" })).toBe(true);
    expect(matchesShortcut(event({ key: "c", ctrl: true }), { key: "c" })).toBe(false);
    expect(matchesShortcut(event({ key: "c", alt: true }), { key: "c" })).toBe(false);
  });

  it("finds a digit chord on the physical key the user pressed", () => {
    const chord = { key: "1", mod: true, shift: true };
    expect(matchesShortcut(event({ key: "!", code: "Digit1", ctrl: true, shift: true }), chord)).toBe(true);
    expect(matchesShortcut(event({ key: "1", code: "Digit1", ctrl: true, shift: true }), chord)).toBe(true);
    // A chord on another digit, or the same character typed without a modifier, is not this chord.
    expect(matchesShortcut(event({ key: "!", code: "Digit2", ctrl: true, shift: true }), chord)).toBe(false);
    expect(matchesShortcut(event({ key: "!", code: "Digit1", shift: true }), chord)).toBe(false);
  });
});

describe("shortcutKey", () => {
  it("distinguishes a chord from the same key with different modifiers", () => {
    expect(shortcutKey({ key: "k", mod: true })).not.toBe(shortcutKey({ key: "k", mod: true, shift: true }));
    expect(shortcutKey({ key: "K", mod: true })).toBe(shortcutKey({ key: "k", mod: true }));
  });
});

/** The chords `App` declares. Extended as commands are added; a duplicate fails here, not at runtime. */
const DECLARED: Shortcut[] = [
  { key: "n", mod: true },
  { key: "p", mod: true },
  { key: "s", mod: true },
  { key: "w", mod: true },
  { key: "b", mod: true },
  { key: "j", mod: true },
  { key: "c" },
  { key: ".", mod: true },
  { key: ",", mod: true },
  { key: "a", mod: true, shift: true },
  { key: "g", mod: true, shift: true },
  { key: "f1" },
  { key: "1", mod: true, shift: true },
  { key: "2", mod: true, shift: true },
  { key: "t", mod: true, shift: true },
  { key: "k", mod: true },
];

describe("declared shortcuts", () => {
  it("puts no two commands on the same chord", () => {
    const keys = DECLARED.map(shortcutKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
