import { useEffect, useState } from "react";
import { connect, request } from "./api.js";
import { Settings } from "./Settings.js";
import { Workspace } from "./Workspace.js";
import "./styles.css";

export function App() {
  const [status, setStatus] = useState("connecting");
  const [providersVersion, setProvidersVersion] = useState(0);

  useEffect(() => {
    void (async () => {
      try {
        await connect();
        const health = await request<{ status: string }>("system.health");
        setStatus(health.status === "ok" ? "kernel ok" : "kernel error");
      } catch {
        setStatus("kernel error");
      }
    })();
  }, []);

  return (
    <main>
      <h1>NoirHarness</h1>
      <p data-testid="kernel-status">{status}</p>
      {status === "kernel ok" ? (
        <>
          <Workspace request={request} providersVersion={providersVersion} />
          <Settings request={request} onProvidersChanged={() => setProvidersVersion((version) => version + 1)} />
        </>
      ) : null}
    </main>
  );
}
