import type { AgentEvent } from "@noir/protocol";
import { ScheduleWatcher, type NotificationSink } from "./notifications.js";

export interface KernelEventSourceOptions {
  port: number;
  token: string;
  sink: NotificationSink;
  /** Called for every event, so a caller can keep its own bookkeeping. */
  onEvent?: (event: AgentEvent) => void;
  /** Reconnect backoff floor; a kernel restart is the usual reason a socket closes. */
  retryMs?: number;
}

const MAX_RETRY_MS = 30_000;

function eventOf(frame: unknown): AgentEvent | undefined {
  if (typeof frame !== "object" || frame === null) return undefined;
  const params = Object.getOwnPropertyDescriptor(frame, "params")?.value;
  if (typeof params !== "object" || params === null) return undefined;
  const event = Object.getOwnPropertyDescriptor(params, "event")?.value;
  if (typeof event !== "object" || event === null) return undefined;
  if (Object.getOwnPropertyDescriptor(event, "type")?.value === undefined) return undefined;
  return event as AgentEvent;
}

/**
 * The app's own witness. The renderer has a socket too, but the window can be closed, and a run that
 * finishes at 06:03 has to be reported by whoever is still alive.
 */
export class KernelEvents {
  private socket: WebSocket | undefined;
  private stopped = false;
  private retryMs: number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly watcher: ScheduleWatcher;

  constructor(private readonly opts: KernelEventSourceOptions) {
    this.watcher = new ScheduleWatcher(opts.sink);
    this.retryMs = opts.retryMs ?? 1_000;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.socket?.close();
    this.socket = undefined;
  }

  /** The sessions a schedule started, for the log and the e2e. */
  scheduledSessions(): string[] {
    return this.watcher.sessions();
  }

  private connect(): void {
    if (this.stopped) return;
    const ws = new WebSocket(`ws://127.0.0.1:${this.opts.port}/?token=${this.opts.token}`);
    this.socket = ws;
    ws.addEventListener("message", (message) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(message.data));
      } catch {
        return;
      }
      const event = eventOf(parsed);
      if (event === undefined) return;
      this.watcher.observe(event);
      this.opts.onEvent?.(event);
    });
    ws.addEventListener("close", () => this.scheduleReconnect());
    ws.addEventListener("error", () => {
      // An error is followed by a close; the close handler owns the retry so the backoff is one path.
      ws.close();
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.connect();
    }, this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, MAX_RETRY_MS);
  }
}
