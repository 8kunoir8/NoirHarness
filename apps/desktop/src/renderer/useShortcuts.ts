import { useEffect } from "react";
import { commandForEvent, type Command } from "./commands.js";

/** Installs one keydown listener that dispatches the first matching command. */
export function useShortcuts(commands: readonly Command[]): void {
  useEffect(() => {
    const listener = (event: KeyboardEvent): void => {
      const command = commandForEvent(commands, event, event.target);
      if (command === undefined) return;
      event.preventDefault();
      command.run();
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [commands]);
}
