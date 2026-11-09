interface KernelInfo {
  port: number;
  token: string;
}

declare global {
  interface Window {
    noir: { kernelInfo(): Promise<KernelInfo> };
  }
}

interface KernelFrame {
  id?: number;
  method?: string;
  result?: unknown;
  error?: { code: number; message: string };
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export class KernelRequestError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
    this.name = "KernelRequestError";
  }
}

let socket: WebSocket | undefined;
let connecting: Promise<void> | undefined;
let nextId = 1;
const pending = new Map<number, PendingCall>();

export function kernelInfo(): Promise<KernelInfo> {
  return window.noir.kernelInfo();
}

export function connect(onEvent?: (event: unknown) => void): Promise<void> {
  if (socket) return Promise.resolve();
  connecting ??= (async () => {
    const info = await kernelInfo();
    const ws = new WebSocket(`ws://127.0.0.1:${info.port}/?token=${info.token}`);
    const opened = Promise.withResolvers<void>();
    ws.addEventListener("open", () => opened.resolve(), { once: true });
    ws.addEventListener("error", () => opened.reject(new Error("kernel connection failed")), { once: true });
    await opened.promise;
    socket = ws;
    ws.addEventListener("message", (message) => {
      const frame = JSON.parse(String(message.data)) as KernelFrame;
      if (typeof frame.id === "number") {
        const call = pending.get(frame.id);
        pending.delete(frame.id);
        if (!call) return;
        if (frame.error) call.reject(new KernelRequestError(frame.error.code, frame.error.message));
        else call.resolve(frame.result);
      } else if (frame.method) {
        onEvent?.(frame);
      }
    });
  })().catch((error: unknown) => {
    connecting = undefined;
    throw error;
  });
  return connecting;
}

export function request<T = unknown>(method: string, params?: unknown): Promise<T> {
  if (!socket) return Promise.reject(new Error("kernel not connected"));
  const id = nextId++;
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  pending.set(id, { resolve: (value) => resolve(value as T), reject });
  socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  return promise;
}
