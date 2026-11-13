import { useEffect, useState } from "react";

/**
 * The nav clock. One interval in its own component so the seconds tick repaints this span and not
 * the shell around it; a shell-wide timer would re-render every open chat once a second.
 */
export function NavClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return <time className="nav-clock">{now.toLocaleTimeString([], { hour12: false })}</time>;
}
