interface KernelInfo {
  port: number;
  token: string;
}

declare global {
  interface Window {
    noir: { kernelInfo(): Promise<KernelInfo> };
  }
}

let socket: WebSocket | undefined;
let connecting: Promise<void> | undefined;
let nextId = 1;
const pending = new Map<number, (value: unknown) => void>();

export function kernelInfo(): Promise<KernelInfo> {
  return window.noir.kernelInfo();
}

export async function connect(onEvent?: (event: unknown) => void): Promise<void> {
  if (socket) return;
  connecting ??= (async () => {
    const info = await kernelInfo();
    const ws = new WebSocket(`ws://127.0.0.1:${info.port}/?token=${info.token}`);
    const opened = Promise.withResolvers<void>();
    ws.addEventListener("open", () => opened.resolve(), { once: true });
    ws.addEventListener("error", () => opened.reject(new Error("kernel connection failed")), { once: true });
    await opened.promise;
    socket = ws;
    ws.addEventListener("message", (message) => {
      const frame = JSON.parse(String(message.data)) as { id?: number; method?: string; result?: unknown };
      if (typeof frame.id === "number") {
        pending.get(frame.id)?.(frame.result);
        pending.delete(frame.id);
      } else if (frame.method) {
        onEvent?.(frame);
      }
    });
  })();
  return connecting;
}

export function request<T = unknown>(method: string, params?: unknown): Promise<T> {
  if (!socket) return Promise.reject(new Error("kernel not connected"));
  const id = nextId++;
  const { promise, resolve } = Promise.withResolvers<T>();
  pending.set(id, (value) => resolve(value as T));
  socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  return promise;
}
