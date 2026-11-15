export interface Shortcut {
  key: string;
  /** Command/Control on every platform; the shell is Windows-first but must not fight macOS. */
  mod?: boolean;
  shift?: boolean;
  /** Alt/Option. Compared exactly, so `Ctrl+Alt+X` never answers a `Ctrl+X` binding. */
  alt?: boolean;
}

/** Read once: the renderer never changes platforms mid-session, and a test passes it explicitly. */
const DEFAULT_PLATFORM = typeof navigator === "undefined" ? "win32" : navigator.platform;

/** Canonical form for comparison and collision checks; `K` and `k` are one chord. */
export function shortcutKey(shortcut: Shortcut): string {
  const parts = [
    shortcut.mod === true ? "mod" : "",
    shortcut.alt === true ? "alt" : "",
    shortcut.shift === true ? "shift" : "",
    shortcut.key.toLowerCase(),
  ].filter((part) => part !== "");
  return parts.join("+");
}

/**
 * `Ctrl+Shift+K` on the platform this app ships for, `⌘⇧K` on macOS. The glyph form is a macOS
 * convention: printing it on Windows taught a key combination that does not exist there.
 */
export function shortcutLabel(shortcut: Shortcut, platform: string = DEFAULT_PLATFORM): string {
  const key = shortcut.key.toUpperCase();
  if (platform.startsWith("darwin") || platform.startsWith("Mac")) {
    return `${shortcut.mod === true ? "⌘" : ""}${shortcut.alt === true ? "⌥" : ""}${
      shortcut.shift === true ? "⇧" : ""
    }${key}`;
  }
  const parts = [
    shortcut.mod === true ? "Ctrl" : "",
    shortcut.alt === true ? "Alt" : "",
    shortcut.shift === true ? "Shift" : "",
    key,
  ].filter((part) => part !== "");
  return parts.join("+");
}

/** A chord on a digit: the only keys whose `key` shifts away from the character it was typed as. */
const DIGIT = /^[0-9]$/;

/** Compares a keyboard event with a shortcut. Keys are matched case-insensitively by `key`. */
export function matchesShortcut(event: KeyboardEvent, shortcut: Shortcut): boolean {
  // `Shift+1` reports `!` as `key` on a US layout, so a chord that names a digit falls back to the
  // physical key; without that, every shifted-digit shortcut is dead.
  const named = event.key.toLowerCase() === shortcut.key.toLowerCase();
  if (!named && !(DIGIT.test(shortcut.key) && event.code === `Digit${shortcut.key}`)) return false;
  const mod = event.metaKey || event.ctrlKey;
  if (mod !== (shortcut.mod === true)) return false;
  if ((event.shiftKey === true) !== (shortcut.shift === true)) return false;
  return (event.altKey === true) === (shortcut.alt === true);
}

export interface Command {
  id: string;
  label: string;
  /** Extra words the palette matches against, not shown in the row. */
  keywords?: string;
  shortcut?: Shortcut;
  /** Prefix shown in the palette; `disabled` commands are listed but cannot run. */
  enabled: boolean;
  /** Fires even while a text field has focus. Only for actions that never type a character. */
  allowInInput?: boolean;
  run: () => void;
}

export function isTypingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable)
  );
}

/** Palette filter: every whitespace-separated token must appear in the label or the keywords. */
export function filterCommands(commands: readonly Command[], query: string): Command[] {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter((token) => token !== "");
  if (tokens.length === 0) return [...commands];
  return commands.filter((command) => {
    const haystack = `${command.label} ${command.keywords ?? ""}`.toLowerCase();
    return tokens.every((token) => haystack.includes(token));
  });
}

/** Resolves the command a keyboard event should trigger, honouring the typing guard. */
export function commandForEvent(
  commands: readonly Command[],
  event: KeyboardEvent,
  target: EventTarget | null,
): Command | undefined {
  const typing = isTypingTarget(target);
  return commands.find((command) => {
    if (command.shortcut === undefined || !command.enabled) return false;
    if (typing && command.allowInInput !== true) return false;
    return matchesShortcut(event, command.shortcut);
  });
}
