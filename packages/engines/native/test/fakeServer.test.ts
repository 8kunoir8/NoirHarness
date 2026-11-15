import { describe, expect, it } from "vitest";
import { startFakeOpenAiServer } from "./fakeOpenAiServer.js";

/**
 * The fake answers every request it can reach a script step for; a request it cannot parse used to
 * reject a promise `createServer` discards, which left the client waiting on a reply that never came
 * and showed up as an unhandled rejection far from the test that sent it. It answers a 500 now, so the
 * failure lands on the request.
 */
describe("the fake provider", () => {
  it("answers an unparseable body with a 500 and keeps the script for the next request", async () => {
    const server = await startFakeOpenAiServer([{ text: "first" }]);
    try {
      const bad = await fetch(`${server.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      });
      expect(bad.status).toBe(500);
      // The body is the parse error itself; its wording belongs to the runtime, so only its reach is asserted.
      expect((await bad.text()).length).toBeGreaterThan(0);

      // The parse failed before a step was consumed, so the next request still gets the first one.
      expect(server.requests).toHaveLength(0);
      const good = await fetch(`${server.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "m", messages: [] }),
      });
      expect(await good.text()).toContain("first");
      expect(server.requests).toHaveLength(1);
    } finally {
      await server.close();
    }
  });
});
