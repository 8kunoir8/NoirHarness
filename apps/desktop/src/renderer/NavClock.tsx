import { useEffect, useState } from "react";
import { every } from "./defer.js";

/**
 * The nav clock. One interval in its own component so the seconds tick repaints this span and not
 * the shell around it; a shell-wide timer would re-render every open chat once a second.
 */
export function NavClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    return every(1000, () => setNow(new Date()));
  }, []);
  return <time className="nav-clock">{now.toLocaleTimeString([], { hour12: false })}</time>;
}
