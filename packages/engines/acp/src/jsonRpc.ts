export interface JsonRpcTransport {
  write(line: string): void;
  onLine(handler: (line: string) => void): void;
  onClose(handler: (error?: Error) => void): void;
  dispose(): void;
}

/** An error the agent sent for one of our requests. */
export class JsonRpcError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(error: { code?: unknown; message?: unknown; data?: unknown }) {
    const base = typeof error.message === "string" && error.message.length > 0 ? error.message : "JSON-RPC error";
    super(describe(base, error.data));
    this.name = "JsonRpcError";
    this.code = typeof error.code === "number" ? error.code : -32603;
    this.data = error.data;
  }
}

/** An error an inbound-request handler wants echoed verbatim to the agent. */
export class JsonRpcMethodError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = "JsonRpcMethodError";
    this.code = code;
  }
}

function describe(message: string, data: unknown): string {
  if (typeof data === "object" && data !== null) {
    const details = (data as Record<string, unknown>).details;
    if (typeof details === "string" && details.length > 0) return `${message}: ${details}`;
  }
  return message;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout | undefined;
}

interface InboundMessage {
  id?: unknown;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: { code?: unknown; message?: unknown; data?: unknown };
}

export interface JsonRpcClientOptions {
  requestTimeoutMs?: number;
}

type RequestHandler = (method: string, params: unknown) => Promise<unknown> | unknown;
type NotificationHandler = (method: string, params: unknown) => void;

export class JsonRpcClient {
  readonly #transport: JsonRpcTransport;
  readonly #requestTimeoutMs: number | undefined;
  readonly #pending = new Map<number, PendingRequest>();
  readonly #notificationHandlers: NotificationHandler[] = [];
  readonly #closeHandlers: Array<(error?: Error) => void> = [];
  #nextId = 1;
  #requestHandler: RequestHandler | undefined;
  #disposed = false;

  constructor(transport: JsonRpcTransport, opts: JsonRpcClientOptions = {}) {
    this.#transport = transport;
    this.#requestTimeoutMs = opts.requestTimeoutMs;
    transport.onLine((line) => this.#handleLine(line));
    transport.onClose((error) => this.#handleClose(error));
  }

  /**
   * `timeoutMs` overrides the client-wide timeout; `0` (or a negative number) disables it for this
   * request, which is how a caller that owns its own deadline opts out of the generic one.
   */
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    if (this.#disposed) return Promise.reject(new Error(`JSON-RPC client is disposed (${method})`));
    return this.#dispatch<T>(method, params, timeoutMs).promise;
  }

  /**
   * Like `request`, but also returns the frame id, so a caller that gave up waiting (e.g. a turn
   * watchdog) can drop the pending entry with `abandon` instead of leaking it for the connection's
   * lifetime.
   */
  requestWithId<T = unknown>(
    method: string,
    params?: unknown,
    timeoutMs?: number,
  ): { id: number; promise: Promise<T> } {
    if (this.#disposed) throw new Error(`JSON-RPC client is disposed (${method})`);
    return this.#dispatch<T>(method, params, timeoutMs);
  }

  /** Drops a still-pending request, clearing its timer, and settles it as abandoned. */
  abandon(id: number): void {
    const entry = this.#pending.get(id);
    if (entry === undefined) return;
    clearTimeout(entry.timer);
    this.#pending.delete(id);
    entry.reject(new Error(`JSON-RPC request abandoned (id ${id})`));
  }

  /** Requests still awaiting a response. Diagnostics only. */
  get pendingCount(): number {
    return this.#pending.size;
  }

  #dispatch<T>(
    method: string,
    params: unknown,
    timeoutMs: number | undefined,
  ): { id: number; promise: Promise<T> } {
    const id = this.#nextId;
    this.#nextId += 1;
    const effectiveTimeout = timeoutMs ?? this.#requestTimeoutMs;
    let settle: (value: T) => void = () => undefined;
    let fail: (error: Error) => void = () => undefined;
    const promise = new Promise<T>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });
    const entry: PendingRequest = {
      resolve: (value) => settle(value as T),
      reject: fail,
      timer: undefined,
    };
    if (effectiveTimeout !== undefined && effectiveTimeout > 0) {
      entry.timer = setTimeout(() => {
        if (this.#pending.get(id) !== entry) return;
        this.#pending.delete(id);
        fail(new Error(`JSON-RPC request timed out after ${effectiveTimeout}ms: ${method}`));
      }, effectiveTimeout);
    }
    this.#pending.set(id, entry);

    const message: Record<string, unknown> = { jsonrpc: "2.0", id, method };
    if (params !== undefined) message.params = params;
    try {
      this.#transport.write(JSON.stringify(message));
    } catch (error) {
      clearTimeout(entry.timer);
      this.#pending.delete(id);
      fail(error instanceof Error ? error : new Error(String(error)));
    }
    return { id, promise };
  }

  notify(method: string, params?: unknown): void {
    if (this.#disposed) throw new Error(`JSON-RPC client is disposed (${method})`);
    const message: Record<string, unknown> = { jsonrpc: "2.0", method };
    if (params !== undefined) message.params = params;
    this.#transport.write(JSON.stringify(message));
  }

  onRequest(handler: RequestHandler): void {
    this.#requestHandler = handler;
  }

  onNotification(handler: NotificationHandler): void {
    this.#notificationHandlers.push(handler);
  }

  onClose(handler: (error?: Error) => void): void {
    this.#closeHandlers.push(handler);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const error = new Error("JSON-RPC client disposed");
    for (const [id, entry] of this.#pending) {
      clearTimeout(entry.timer);
      this.#pending.delete(id);
      entry.reject(error);
    }
    this.#transport.dispose();
  }

  #handleLine(line: string): void {
    if (this.#disposed) return;
    if (line.trim() === "") return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof parsed !== "object" || parsed === null) return;
    const message = parsed as InboundMessage;

    if (typeof message.method === "string") {
      if (message.id === undefined || message.id === null) {
        for (const handler of this.#notificationHandlers) {
          try {
            handler(message.method, message.params);
          } catch (error) {
            // A throwing consumer must not abort the framing loop.
            if (process.env.NOIR_ACP_DEBUG === "1") console.error("[acp] notification handler failed", error);
          }
        }
        return;
      }
      void this.#handleRequest(message.id, message.method, message.params);
      return;
    }

    if (typeof message.id !== "number") return;
    const entry = this.#pending.get(message.id);
    if (entry === undefined) return;
    clearTimeout(entry.timer);
    this.#pending.delete(message.id);

    if (message.error !== undefined) {
      entry.reject(new JsonRpcError(message.error));
      return;
    }
    entry.resolve(message.result);
  }

  async #handleRequest(id: unknown, method: string, params: unknown): Promise<void> {
    const reply = (payload: Record<string, unknown>): void => {
      try {
        this.#transport.write(JSON.stringify({ jsonrpc: "2.0", id, ...payload }));
      } catch {
        // The transport is gone; there is nobody left to answer.
      }
    };

    const handler = this.#requestHandler;
    if (handler === undefined) {
      reply({ error: { code: -32603, message: `No inbound request handler: ${method}` } });
      return;
    }

    try {
      const result = await handler(method, params);
      reply({ result: result === undefined ? {} : result });
    } catch (error) {
      if (error instanceof JsonRpcMethodError) {
        reply({ error: { code: error.code, message: error.message } });
        return;
      }
      reply({ error: { code: -32603, message: "Internal error" } });
    }
  }

  #handleClose(error?: Error): void {
    const failure = error ?? new Error("ACP agent connection closed");
    for (const [id, entry] of this.#pending) {
      clearTimeout(entry.timer);
      this.#pending.delete(id);
      entry.reject(failure);
    }
    for (const handler of this.#closeHandlers) handler(error);
  }
}
