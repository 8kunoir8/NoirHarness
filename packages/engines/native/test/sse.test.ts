import { describe, expect, it } from "vitest";
import { parseSseChunks } from "../src/sse.js";

async function* asIterable(chunks: readonly string[]): AsyncGenerator<Uint8Array> {
  const encoder = new TextEncoder();
  for (const chunk of chunks) yield encoder.encode(chunk);
}

async function collect<T>(chunks: AsyncIterable<T>): Promise<T[]> {
  const events: T[] = [];
  for await (const event of chunks) events.push(event);
  return events;
}

describe("parseSseChunks", () => {
  it("reassembles events split across chunks and ignores comments", async () => {
    const chunks = [": keepalive\n", "data: {\"a\":", "1}\n\n", "data: [DONE]\n\n"];
    expect(await collect(parseSseChunks(asIterable(chunks)))).toEqual([{ a: 1 }]);
  });

  it("supports CRLF and multi-line data", async () => {
    const chunks = ["data: {\"a\":\r\n", "data: 1}\r\n\r\n"];
    expect(await collect(parseSseChunks(asIterable(chunks)))).toEqual([{ a: 1 }]);
  });

  it("throws on malformed JSON instead of skipping the event", async () => {
    const chunks = ["data: not json\n\n"];
    await expect(collect(parseSseChunks(asIterable(chunks)))).rejects.toThrow("invalid SSE chunk");
  });

  it("reassembles multi-byte characters split across chunks", async () => {
    const encoded = new TextEncoder().encode("data: {\"a\":\"é\"}\n\n");
    const split = 13; // between the 0xC3 and 0xA9 bytes of é
    const chunks = [encoded.slice(0, split), encoded.slice(split)];
    expect(await collect(parseSseChunks(asIterableChunks(chunks)))).toEqual([{ a: "é" }]);
  });

  it("stops at [DONE] and emits nothing after it", async () => {
    const chunks = ["data: {\"a\":1}\n\n", "data: [DONE]\n\n", "data: {\"b\":2}\n\n"];
    expect(await collect(parseSseChunks(asIterable(chunks)))).toEqual([{ a: 1 }]);
  });

  it("discards an event the stream ends without terminating", async () => {
    const chunks = ["data: {\"a\":1}\n\n", "data: {\"b\":2}"];
    expect(await collect(parseSseChunks(asIterable(chunks)))).toEqual([{ a: 1 }]);
  });
});

async function* asIterableChunks(chunks: readonly Uint8Array[]): AsyncGenerator<Uint8Array> {
  for (const chunk of chunks) yield chunk;
}
