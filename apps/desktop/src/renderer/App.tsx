import { useEffect, useState } from "react";
import { connect, request } from "./api.js";

export function App() {
  const [status, setStatus] = useState("connecting");

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
    <main style={{ fontFamily: "Inter, system-ui, sans-serif", padding: 24 }}>
      <h1>NoirHarness</h1>
      <p data-testid="kernel-status">{status}</p>
    </main>
  );
}
