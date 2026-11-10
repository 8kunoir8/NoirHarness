import { useEffect, useState } from "react";
import { SystemHealthResult } from "@noir/protocol";
import { connect, request } from "./api.js";
import { Setup } from "./Setup.js";
import { Workspace } from "./Workspace.js";
import "./styles.css";

type View = "setup" | "chat";

export function App() {
  const [status, setStatus] = useState("connecting");
  const [view, setView] = useState<View>("setup");

  useEffect(() => {
    void (async () => {
      try {
        await connect();
        SystemHealthResult.parse(await request("system.health"));
        setStatus("kernel ok");
        // First run has nothing to chat with, so land on Setup; afterwards land on the chat.
        const { models } = await request<{ models: unknown[] }>("model.list");
        setView(models.length > 0 ? "chat" : "setup");
      } catch {
        setStatus("kernel error");
      }
    })();
  }, []);

  return (
    <main>
      <h1>NoirHarness</h1>
      <p data-testid="kernel-status">{status}</p>
      <nav aria-label="Main">
        <button type="button" aria-pressed={view === "setup"} onClick={() => setView("setup")}>
          Setup
        </button>
        <button type="button" aria-pressed={view === "chat"} onClick={() => setView("chat")}>
          Chat
        </button>
      </nav>
      {status === "kernel ok" ? (
        view === "setup" ? (
          <Setup request={request} onOpenChat={() => setView("chat")} />
        ) : (
          <Workspace request={request} />
        )
      ) : null}
    </main>
  );
}
