export interface Shortcut {
  key: string;
  /** Command/Control on every platform; the shell is Windows-first but must not fight macOS. */
  mod?: boolean;
  shift?: boolean;
}

export function shortcutLabel(shortcut: Shortcut): string {
  const mod = shortcut.mod === true ? "⌘" : "";
  const shift = shortcut.shift === true ? "⇧" : "";
  return `${mod}${shift}${shortcut.key.toUpperCase()}`;
}

/** Compares a keyboard event with a shortcut. Keys are matched case-insensitively by `key`. */
export function matchesShortcut(event: KeyboardEvent, shortcut: Shortcut): boolean {
  if (event.key.toLowerCase() !== shortcut.key.toLowerCase()) return false;
  const mod = event.metaKey || event.ctrlKey;
  if (mod !== (shortcut.mod === true)) return false;
  return (event.shiftKey === true) === (shortcut.shift === true);
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
