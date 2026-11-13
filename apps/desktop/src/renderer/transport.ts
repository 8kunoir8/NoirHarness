/**
 * Where the socket lives. The desktop window learns it from the preload bridge; a browser is served
 * by the kernel itself, so it is the origin it was loaded from — and the cookie rides the upgrade.
 */
export type TransportMode = "desktop" | "browser";

export interface Transport {
  mode: TransportMode;
  url: string;
}

interface KernelBridge {
  kernelInfo(): Promise<{ port: number; token: string }>;
}

function bridge(): KernelBridge | undefined {
  return typeof window === "undefined" ? undefined : window.noir;
}

/** True in a browser tab; the preload bridge is only ever injected into the Electron window. */
export function isBrowser(): boolean {
  return bridge() === undefined;
}

export async function resolveTransport(): Promise<Transport> {
  const preload = bridge();
  if (preload !== undefined) {
    const info = await preload.kernelInfo();
    return { mode: "desktop", url: `ws://127.0.0.1:${info.port}/?token=${info.token}` };
  }
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  return { mode: "browser", url: `${scheme}://${location.host}/` };
}
