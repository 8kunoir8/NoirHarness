/**
 * Minimal streaming parser for the server-sent-events framing used by
 * OpenAI-compatible chat-completions endpoints.
 *
 * It accepts any async iterable of bytes (a `ReadableStream` from `fetch` is
 * async-iterable in Node) and yields one parsed JSON payload per event. Comment
 * lines keepalive the connection and are ignored; `[DONE]` terminates the
 * stream. Invalid JSON is a protocol error, not something to skip quietly.
 */
export async function* parseSseChunks(
  chunks: AsyncIterable<Uint8Array>,
): AsyncGenerator<unknown> {
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];

  for await (const chunk of chunks) {
    buffer += decoder.decode(chunk, { stream: true });

    let start = 0;
    for (;;) {
      const newline = buffer.indexOf("\n", start);
      if (newline === -1) break;
      const raw = buffer.slice(start, newline);
      start = newline + 1;
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;

      if (line === "") {
        if (data.length === 0) continue;
        const payload = data.join("\n");
        data = [];
        if (payload === "[DONE]") return;
        yield parsePayload(payload);
        continue;
      }
      if (line.startsWith(":")) continue;

      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      if (field !== "data") continue;
      const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
      data.push(value);
    }

    buffer = start === 0 ? buffer : buffer.slice(start);
  }

  // An event not terminated by a blank line is incomplete and is discarded,
  // as the SSE spec requires.
}

function parsePayload(payload: string): unknown {
  try {
    return JSON.parse(payload);
  } catch {
    throw new Error("invalid SSE chunk");
  }
}
