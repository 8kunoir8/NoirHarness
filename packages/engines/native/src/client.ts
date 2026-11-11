import { parseSseChunks } from "./sse.js";

/**
 * A non-2xx provider response. The body is retained so the caller can redact
 * provider echoes of the request before surfacing it; it is never part of the
 * message and request headers never enter either.
 */
export class ProviderHttpError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string) {
    super(`Provider request failed with status ${status}`);
    this.name = "ProviderHttpError";
    this.status = status;
    this.body = body;
  }
}

export async function* streamChat(opts: {
  baseUrl: string;
  apiKey: string;
  body: unknown;
  signal: AbortSignal;
}): AsyncGenerator<unknown> {
  const res = await fetch(`${opts.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    redirect: "error",
    signal: opts.signal,
    headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` },
    body: JSON.stringify(opts.body),
  });
  if (!res.ok) throw new ProviderHttpError(res.status, (await res.text()).slice(0, 8192));
  if (!res.body) throw new Error("Provider returned no body");
  yield* parseSseChunks(res.body);
}
