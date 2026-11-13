import { useCallback, useEffect, useState } from "react";
import type { DeviceView, RemotePairResult, RemoteStatusResult } from "@noir/protocol";
import type { RequestFn } from "./api.js";
import { errorMessage } from "./events.js";

interface DevicesProps {
  request: RequestFn;
}

interface DevicesState {
  devices: DeviceView[];
}

const REFRESH_MS = 5_000;

function secondsLeft(expiresAt: number, now: number): number {
  return Math.max(0, Math.ceil((expiresAt - now) / 1000));
}

/**
 * The door to this kernel. Everything here is a loopback-only RPC: a paired browser can drive
 * sessions, but it cannot open, close, or re-key the door it came in by.
 */
export function Devices({ request }: DevicesProps) {
  const [status, setStatus] = useState<RemoteStatusResult | undefined>(undefined);
  const [devices, setDevices] = useState<DeviceView[]>([]);
  const [pairing, setPairing] = useState<RemotePairResult | undefined>(undefined);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const refresh = useCallback(async (): Promise<void> => {
    const next = await request<RemoteStatusResult>("remote.status");
    setStatus(next);
    if (!next.enabled) {
      setDevices([]);
      return;
    }
    const listed = await request<DevicesState>("remote.devices");
    setDevices(listed.devices);
  }, [request]);

  useEffect(() => {
    void refresh().catch((cause: unknown) => setError(errorMessage(cause)));
  }, [refresh]);

  // A paired device can appear at any moment; the list is the only place that says so.
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
      if (status?.enabled === true) void refresh().catch(() => undefined);
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh, status]);

  const run = useCallback(
    async (action: () => Promise<void>): Promise<void> => {
      setBusy(true);
      setError(undefined);
      try {
        await action();
      } catch (cause) {
        setError(errorMessage(cause));
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  function toggle(): void {
    void run(async () => {
      const next = await request<RemoteStatusResult>(status?.enabled === true ? "remote.disable" : "remote.enable");
      setStatus(next);
      setPairing(undefined);
      if (next.enabled) {
        const listed = await request<DevicesState>("remote.devices");
        setDevices(listed.devices);
      } else {
        setDevices([]);
      }
    });
  }

  function pair(): void {
    void run(async () => {
      setPairing(await request<RemotePairResult>("remote.pair"));
    });
  }

  function revoke(id: string): void {
    void run(async () => {
      await request("remote.revoke", { id });
      const listed = await request<DevicesState>("remote.devices");
      setDevices(listed.devices);
    });
  }

  const expired = pairing !== undefined && secondsLeft(pairing.expiresAt, now) === 0;

  return (
    <section className="devices" aria-label="Devices">
      <h2>Devices</h2>
      <p className="hint">
        Pair a browser on this network and it runs this same harness over TLS. The certificate is
        made by this kernel, not by an authority, so the browser warns once — compare the
        fingerprint before you accept it.
      </p>
      {error === undefined ? null : <p role="alert">{error}</p>}

      <label>
        <input type="checkbox" checked={status?.enabled === true} disabled={busy || status === undefined} onChange={toggle} />
        Allow devices on this network
      </label>

      {status === undefined || !status.enabled ? null : (
        <>
          {status.canServe ? null : (
            <p className="hint">
              This kernel was started without a web root, so a browser can pair but has no page to load.
            </p>
          )}
          {status.url === null ? <p className="hint">No network address to advertise yet.</p> : null}
          {status.fingerprint === null ? null : (
            <p className="hint">
              SHA-256 <code className="devices-fingerprint">{status.fingerprint}</code>
            </p>
          )}
          <button type="button" onClick={pair} disabled={busy || status.url === null}>
            Create a pairing link
          </button>
          {pairing === undefined ? null : expired ? (
            <p className="hint" role="status">
              That link expired. Create a new one.
            </p>
          ) : (
            <div className="devices-pair">
              <p>Open this on the device, within ten minutes:</p>
              <code className="devices-url">{pairing.url}</code>
              <p className="hint">
                Expires in {secondsLeft(pairing.expiresAt, now)}s. The code is in the part of the link
                after the <code>#</code>, so it never reaches a log.
              </p>
            </div>
          )}

          <ul className="devices-list">
            {devices.map((device) => (
              <li key={device.id} className="devices-row">
                <span>
                  {device.label}
                  {device.connected ? " · connected" : ""}
                  {device.revokedAt === null ? "" : " · revoked"}
                </span>
                <button
                  type="button"
                  disabled={busy || device.revokedAt !== null}
                  onClick={() => revoke(device.id)}
                >
                  Revoke
                </button>
              </li>
            ))}
          </ul>
          {devices.length === 0 ? <p className="hint">No device has paired yet.</p> : null}
        </>
      )}
    </section>
  );
}
