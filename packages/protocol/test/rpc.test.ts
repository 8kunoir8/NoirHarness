import { describe, expect, it } from "vitest";
import { ProviderCreateParams, RpcFault, toRpcFailure } from "../src/rpc.js";

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
