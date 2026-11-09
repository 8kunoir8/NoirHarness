import { describe, expect, it } from "vitest";
import { PayloadSchemas } from "../src/events.js";
import { ModelCreateParams, ProviderCreateParams, RpcFault, SessionPromptParams, toRpcFailure } from "../src/rpc.js";

describe("provider params", () => {
  it("trims and accepts a valid provider", () => {
    const parsed = ProviderCreateParams.parse({ name: "  Local  ", baseUrl: "http://localhost:11434/v1", apiKind: "openai-completions", apiKey: "abc" });
    expect(parsed.name).toBe("Local");
    expect(parsed.enabled).toBe(true);
  });

  it("rejects a whitespace-only name", () => {
    expect(() => ProviderCreateParams.parse({ name: "   ", baseUrl: "http://x/v1", apiKind: "openai-completions", apiKey: "k" })).toThrow();
  });

  it("rejects a non-URL baseUrl", () => {
    expect(() => ProviderCreateParams.parse({ name: "x", baseUrl: "not a url", apiKind: "openai-completions", apiKey: "k" })).toThrow();
  });
});

describe("session prompt params", () => {
  it("round-trips a valid prompt", () => {
    const input = { sessionId: "s1", requestId: "req-1", content: [{ type: "text" as const, text: "hello" }] };
    const parsed = SessionPromptParams.parse(input);
    expect(SessionPromptParams.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(input);
  });

  it("rejects empty content", () => {
    expect(() => SessionPromptParams.parse({ sessionId: "s1", requestId: "req-1", content: [] })).toThrow();
  });
});

describe("model create params", () => {
  it("defaults contextWindow and enabled", () => {
    const parsed = ModelCreateParams.parse({ providerId: "p1", modelId: "gpt-x" });
    expect(parsed.contextWindow).toBe(200_000);
    expect(parsed.enabled).toBe(true);
  });
});

describe("event payload schemas", () => {
  it("defaults turn.completed status to completed", () => {
    const parsed = PayloadSchemas["turn.completed"].parse({ turnId: "t1" });
    expect(parsed).toEqual({ turnId: "t1", status: "completed" });
  });

  it("rejects permission.requested without options", () => {
    expect(() =>
      PayloadSchemas["permission.requested"].parse({ approvalId: "a1", category: "shell", title: "Run?", options: [] }),
    ).toThrow();
  });
});

describe("error mapping", () => {
  it("maps RpcFault to a JSON-RPC failure", () => {
    expect(toRpcFailure(7, new RpcFault(-32004, "missing", true))).toEqual({
      jsonrpc: "2.0", id: 7,
      error: { code: -32004, message: "missing", data: { retryable: true } },
    });
  });

  it("maps unknown errors to internal without leaking the message", () => {
    const failure = toRpcFailure(8, new Error("secret sk-123"));
    expect(failure.error.code).toBe(-32603);
    expect(failure.error.message).toBe("Internal error");
  });
});
