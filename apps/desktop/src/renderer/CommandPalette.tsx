import { useEffect, useRef, useState } from "react";
import { filterCommands, shortcutLabel, type Command } from "./commands.js";

export interface CommandPaletteProps {
  commands: readonly Command[];
  onRun: (command: Command) => void;
  onClose: () => void;
}

/** ⌘K palette: fuzzy-ish filter, ↑/↓ to move, Enter to run, Esc to close. */
export function CommandPalette({ commands, onRun, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const visible = filterCommands(commands, query);
  const active = Math.min(index, Math.max(visible.length - 1, 0));

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <input
          ref={inputRef}
          aria-label="Command"
          placeholder="Run a command…"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setIndex(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              onClose();
              return;
            }
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setIndex((current) => (visible.length === 0 ? 0 : (current + 1) % visible.length));
              return;
            }
            if (event.key === "ArrowUp") {
              event.preventDefault();
              setIndex((current) => (visible.length === 0 ? 0 : (current - 1 + visible.length) % visible.length));
              return;
            }
            if (event.key === "Enter") {
              event.preventDefault();
              const command = visible[active];
              if (command !== undefined && command.enabled) onRun(command);
            }
          }}
        />
        {visible.length === 0 ? (
          <p className="empty">No command matches.</p>
        ) : (
          <ul className="palette-list" role="listbox" aria-label="Commands">
            {visible.map((command, position) => (
              <li
                key={command.id}
                role="option"
                aria-selected={position === active}
                aria-disabled={!command.enabled}
                data-testid={`palette-${command.id}`}
                onMouseEnter={() => setIndex(position)}
                onMouseDown={(event) => {
                  event.preventDefault();
                  if (command.enabled) onRun(command);
                }}
              >
                <span>{command.label}</span>
                {command.shortcut === undefined ? null : <kbd>{shortcutLabel(command.shortcut)}</kbd>}
              </li>
            ))}
          </ul>
        )}
        <p className="palette-hint">↑/↓ to move · Enter to run · Esc to close</p>
      </div>
    </div>
  );
}
