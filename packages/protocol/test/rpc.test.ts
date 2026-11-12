import { describe, expect, it } from "vitest";
import { PayloadSchemas } from "../src/events.js";
import { ModelCreateParams, ProviderCreateParams, RpcFault, SessionPromptParams, SkillListParams, SkillReadParams, SkillRemoveResult, SkillSetEnabledParams, SkillUpdateParams, SkillView, toRpcFailure } from "../src/rpc.js";

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

  it("accepts turn.completed status interrupted", () => {
    const parsed = PayloadSchemas["turn.completed"].parse({ turnId: "t1", status: "interrupted", stopReason: "user" });
    expect(parsed).toEqual({ turnId: "t1", status: "interrupted", stopReason: "user" });
  });

  it("rejects permission.requested without options", () => {
    expect(() =>
      PayloadSchemas["permission.requested"].parse({ approvalId: "a1", category: "shell", title: "Run?", options: [] }),
    ).toThrow();
  });

  it("rejects a permission option with an invalid kind", () => {
    expect(() =>
      PayloadSchemas["permission.requested"].parse({
        approvalId: "a1", category: "shell", title: "Run?",
        options: [{ optionId: "o1", name: "Allow", kind: "allow_forever" }],
      }),
    ).toThrow();
  });

  it("rejects permission.resolved with an invalid decision", () => {
    expect(() => PayloadSchemas["permission.resolved"].parse({ approvalId: "a1", decision: "maybe" })).toThrow();
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

describe("skill params", () => {
  const valid = { scope: "project" as const, name: "demo", enabled: true };

  it("accepts an omitted workspaceId", () => {
    expect(SkillSetEnabledParams.parse(valid)).toEqual(valid);
    expect(SkillListParams.parse({})).toEqual({});
    expect(SkillReadParams.parse({ scope: "global", name: "demo" })).toEqual({ scope: "global", name: "demo" });
  });

  it("rejects an empty skill name", () => {
    expect(() => SkillSetEnabledParams.parse({ ...valid, name: "" })).toThrow();
    expect(() => SkillReadParams.parse({ scope: "global", name: "" })).toThrow();
  });

  it("rejects an unknown scope", () => {
    expect(() => SkillSetEnabledParams.parse({ ...valid, scope: "nope" })).toThrow();
    expect(() => SkillReadParams.parse({ scope: "nope", name: "demo" })).toThrow();
  });

  it("rejects a missing enabled flag", () => {
    expect(() => SkillSetEnabledParams.parse({ scope: "project", name: "demo" })).toThrow();
    expect(() => SkillSetEnabledParams.parse({ scope: "project", name: "demo", enabled: "yes" })).toThrow();
  });

  it("rejects an empty-string workspaceId", () => {
    expect(() => SkillListParams.parse({ workspaceId: "" })).toThrow();
    expect(() => SkillSetEnabledParams.parse({ ...valid, workspaceId: "" })).toThrow();
    expect(() => SkillReadParams.parse({ scope: "global", name: "demo", workspaceId: "" })).toThrow();
  });
});

describe("skill source schemas", () => {
  it("accepts a git source on SkillView and rejects an unknown kind", () => {
    const base = { scope: "global" as const, name: "s", description: "", hash: "h", enabled: true };
    expect(SkillView.parse({ ...base, source: null }).source).toBeNull();
    expect(
      SkillView.parse({
        ...base,
        source: { kind: "git", url: "https://e.test/r.git", ref: "main", commit: "abc", hash: "h", updateAvailable: false },
      }).source?.commit,
    ).toBe("abc");
    expect(() => SkillView.parse({ ...base, source: { kind: "http", url: "x", ref: null, commit: null, hash: "h", updateAvailable: false } })).toThrow();
  });

  it("requires expectHash for an update", () => {
    expect(SkillUpdateParams.safeParse({ scope: "global", name: "s", expectHash: "h" }).success).toBe(true);
    expect(SkillUpdateParams.safeParse({ scope: "global", name: "s" }).success).toBe(false);
  });

  it("returns the remaining listing from a removal", () => {
    const row = { scope: "global" as const, name: "s", description: "", hash: "h", enabled: true, source: null };
    expect(SkillRemoveResult.parse({ ok: true, skills: [row] }).skills).toHaveLength(1);
    expect(SkillRemoveResult.parse({ ok: true, skills: [] }).skills).toEqual([]);
    expect(() => SkillRemoveResult.parse({ ok: true })).toThrow();
  });
});
