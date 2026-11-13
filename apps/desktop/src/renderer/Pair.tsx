import { useEffect, useRef, useState } from "react";

type Phase = "redeeming" | "done" | "failed";

/**
 * The page a pairing link lands on. The code is in the fragment, so it is read here and immediately
 * scrubbed from the address bar — a fragment is never sent to the server, and after this it is not
 * in the browser's history either.
 */
export function Pair() {
  const [phase, setPhase] = useState<Phase>("redeeming");
  const [message, setMessage] = useState("Pairing this device…");
  const started = useRef(false);

  useEffect(() => {
    // StrictMode mounts twice in development; a one-time code must survive the second mount.
    if (started.current) return;
    started.current = true;
    const code = location.hash.replace(/^#/, "");
    history.replaceState(null, "", "/pair");
    if (code === "") {
      setPhase("failed");
      setMessage("This link has no pairing code. Create a new one in the desktop app.");
      return;
    }
    void fetch("/pair/redeem", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    })
      .then(async (response) => {
        if (!response.ok) {
          setPhase("failed");
          setMessage(
            response.status === 429
              ? "Too many attempts. Wait a minute and create a new link."
              : "That link is no longer valid. Create a new one in the desktop app.",
          );
          return;
        }
        setPhase("done");
        setMessage("Paired. Opening the harness…");
        location.replace("/");
      })
      .catch(() => {
        setPhase("failed");
        setMessage("Could not reach the kernel on this machine.");
      });
  }, []);

  return (
    <main className="pair" aria-live="polite">
      <h1>NoirHarness</h1>
      <p>{message}</p>
      {phase === "failed" ? <p className="hint">Ask the desktop app for a new pairing link.</p> : null}
    </main>
  );
}
