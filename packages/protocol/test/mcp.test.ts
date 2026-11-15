import { describe, expect, it } from "vitest";
import {
  McpServerCreateParams,
  McpServerUpdateParams,
  McpTestParams,
  Methods,
  PermissionCategory,
  PermissionPolicySchema,
} from "../src/index.js";

describe("mcp permission category", () => {
  it("is part of the permission category enum", () => {
    expect(PermissionCategory.options).toContain("mcp");
  });

  it("round-trips an mcp policy alongside other categories", () => {
    const parsed = PermissionPolicySchema.parse({ mcp: "allow", shell: "ask" });
    expect(parsed).toEqual({ mcp: "allow", shell: "ask" });
  });

  it("rejects an unknown mcp policy value", () => {
    expect(() => PermissionPolicySchema.parse({ mcp: "always" })).toThrow();
  });
});

describe("mcp server params", () => {
  it("defaults args, env, headers, and the stdio transport on create", () => {
    const parsed = McpServerCreateParams.parse({ name: "sqlite", command: "npx" });
    expect(parsed).toEqual({
      name: "sqlite",
      transport: "stdio",
      command: "npx",
      args: [],
      env: {},
      headers: {},
      enabled: true,
    });
  });

  it("rejects a server name with illegal characters", () => {
    expect(() => McpServerCreateParams.parse({ name: "sqlite server", command: "npx" })).toThrow();
  });

  // An empty command is only wrong for stdio and a missing url only wrong for http, so the schema
  // cannot decide: it must not invent the half the transport does not use. `McpService` rejects.
  it("carries only the half of a server its transport uses", () => {
    const parsed = McpServerCreateParams.parse({
      name: "remote",
      transport: "http",
      url: "https://example.test/mcp",
    });
    expect(parsed).toEqual({
      name: "remote",
      transport: "http",
      url: "https://example.test/mcp",
      args: [],
      env: {},
      headers: {},
      enabled: true,
    });
  });

  it("keeps id optional fields sparse on update", () => {
    const parsed = McpServerUpdateParams.parse({ id: "mcp-1", enabled: false });
    expect(parsed).toEqual({ id: "mcp-1", enabled: false });
  });
});

describe("mcp test params", () => {
  it("parses a probe configuration with env", () => {
    const parsed = McpTestParams.parse({ command: "node", args: ["server.mjs"], env: { DB: "x" } });
    expect(parsed).toEqual({
      transport: "stdio",
      command: "node",
      args: ["server.mjs"],
      env: { DB: "x" },
      headers: {},
    });
  });
});

describe("mcp rpc methods", () => {
  it("names every mcp endpoint", () => {
    expect(Methods.mcpList).toBe("mcp.list");
    expect(Methods.mcpCreate).toBe("mcp.create");
    expect(Methods.mcpUpdate).toBe("mcp.update");
    expect(Methods.mcpDelete).toBe("mcp.delete");
    expect(Methods.mcpTest).toBe("mcp.test");
  });
});
