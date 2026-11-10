import type { AgentEvent } from "@noir/protocol";

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
  id?: number | string;
  method?: string;
  params?: unknown;
  event?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export interface SessionSubscription {
  events: AgentEvent[];
  lastSeq: number;
}

export type KernelEventListener = (event: AgentEvent) => void;

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
const listeners = new Set<KernelEventListener>();

export function kernelInfo(): Promise<KernelInfo> {
  return window.noir.kernelInfo();
}

/**
 * Notification frames carry the event at `params.event`. Older kernels wrapped it one
 * level deeper (`params.params.event`) or put it on the frame itself; accept all three.
 */
export function unwrapEventFrame(frame: KernelFrame): unknown {
  const params = frame.params;
  if (typeof params === "object" && params !== null) {
    if ("event" in params && params.event !== undefined) return params.event;
    const nested = "params" in params ? params.params : undefined;
    if (typeof nested === "object" && nested !== null && "event" in nested && nested.event !== undefined) {
      return nested.event;
    }
  }
  return frame.event;
}

function dispatchEvent(frame: KernelFrame): void {
  const event = unwrapEventFrame(frame);
  if (event === undefined) return;
  for (const listener of listeners) listener(event as AgentEvent);
}

function failPending(error: Error): void {
  const calls = [...pending.values()];
  pending.clear();
  for (const call of calls) call.reject(error);
}

function handleFrame(ws: WebSocket, data: unknown): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof data === "string" ? data : String(data));
  } catch {
    return;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
  const frame = parsed as KernelFrame;
  if (typeof frame.id === "number") {
    const call = pending.get(frame.id);
    pending.delete(frame.id);
    if (call === undefined) return;
    if (frame.error !== undefined) call.reject(new KernelRequestError(frame.error.code, frame.error.message));
    else call.resolve(frame.result);
    return;
  }
  if (frame.method !== undefined) dispatchEvent(frame);
}

function releaseSocket(ws: WebSocket, error: Error): void {
  // A stale socket finishing late must not clear the live one.
  if (socket !== ws) return;
  socket = undefined;
  connecting = undefined;
  failPending(error);
}

async function openSocket(): Promise<void> {
  const info = await kernelInfo();
  const ws = new WebSocket(`ws://127.0.0.1:${info.port}/?token=${info.token}`);
  const opened = Promise.withResolvers<void>();
  const onOpen = (): void => opened.resolve();
  const onOpenError = (): void => opened.reject(new Error("kernel connection failed"));
  ws.addEventListener("open", onOpen, { once: true });
  ws.addEventListener("error", onOpenError, { once: true });
  try {
    await opened.promise;
  } finally {
    ws.removeEventListener("open", onOpen);
    ws.removeEventListener("error", onOpenError);
  }
  socket = ws;
  ws.addEventListener("message", (message) => handleFrame(ws, message.data));
  ws.addEventListener("close", () => releaseSocket(ws, new Error("kernel connection closed")));
  ws.addEventListener("error", () => releaseSocket(ws, new Error("kernel connection failed")));
}

function ensureSocket(): Promise<void> {
  if (socket !== undefined && socket.readyState === WebSocket.OPEN) return Promise.resolve();
  connecting ??= openSocket().catch((error: unknown) => {
    connecting = undefined;
    throw error;
  });
  return connecting;
}

export function connect(onEvent?: KernelEventListener): Promise<void> {
  if (onEvent !== undefined) listeners.add(onEvent);
  return ensureSocket();
}

export function offEvent(onEvent: KernelEventListener): void {
  listeners.delete(onEvent);
}

export type RequestFn = <T>(method: string, params?: unknown) => Promise<T>;

export function request<T = unknown>(method: string, params?: unknown): Promise<T> {
  if (socket === undefined || socket.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error("kernel not connected"));
  }
  const id = nextId++;
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  pending.set(id, { resolve: (value) => resolve(value as T), reject });
  // Omit the key entirely; the kernel parses `params ?? {}` and rejects explicit undefined.
  const frame = params === undefined
    ? { jsonrpc: "2.0", id, method }
    : { jsonrpc: "2.0", id, method, params };
  socket.send(JSON.stringify(frame));
  return promise;
}

export function subscribe(sessionId: string, fromSeq = 0): Promise<SessionSubscription> {
  return request<SessionSubscription>("session.subscribe", { sessionId, sinceSeq: fromSeq });
}
