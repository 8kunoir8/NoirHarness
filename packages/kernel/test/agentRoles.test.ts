import { describe, expect, it } from "vitest";
import { buildRoles } from "../src/agentRoles.js";

describe("buildRoles", () => {
  it("leads with the generalist even when nothing exists to claim", () => {
    const roles = buildRoles({ skills: [], servers: [] });
    expect(roles.map((role) => role.id)).toEqual(["generalist"]);
    expect(roles[0]?.skills).toEqual([]);
  });

  it("claims skills and servers by vocabulary and leaves out presets with nothing behind them", () => {
    const roles = buildRoles({
      skills: [
        { name: "flutter-dart", description: "Build a mobile app in Dart" },
        { name: "sql-warehouse", description: "Query the warehouse with SQL" },
      ],
      servers: [{ id: "s-1", name: "postgres", command: "npx meow-postgres-mcp", url: "" }],
    });
    const analyst = roles.find((role) => role.id === "analyst");
    expect(analyst?.skills).toEqual(["sql-warehouse"]);
    expect(analyst?.mcpServerIds).toEqual(["s-1"]);
    // Nothing in this workspace mentions a game engine or a pull request.
    expect(roles.some((role) => role.id === "maker")).toBe(false);
    expect(roles.some((role) => role.id === "reviewer")).toBe(false);
  });

  it("gives a skill no vocabulary recognises its own role, named after the skill", () => {
    const roles = buildRoles({
      skills: [{ name: "brainstorming", description: "Explore intent before building features" }],
      servers: [],
    });
    expect(roles.slice(1)).toEqual([
      {
        id: "derived:skill:brainstorming",
        name: "Brainstorming",
        description: "Explore intent before building features",
        skills: ["brainstorming"],
        mcpServerIds: [],
        derived: true,
      },
    ]);
  });

  it("derives a role per unrecognised server and lists the derived ones by name", () => {
    const roles = buildRoles({
      skills: [{ name: "whimsy", description: "Add playful flourishes" }],
      servers: [
        { id: "m-2", name: "zeta-connector", command: "node zeta.js", url: "" },
        { id: "m-1", name: "alpha-connector", command: "node alpha.js", url: "" },
      ],
    });
    expect(roles.map((role) => role.name)).toEqual(["Generalist", "Alpha Connector", "Whimsy", "Zeta Connector"]);
    expect(roles.find((role) => role.id === "derived:mcp:alpha-connector")?.mcpServerIds).toEqual(["m-1"]);
  });

  it("keeps a derived role distinct from a preset and inside the profile's role cap", () => {
    const roles = buildRoles({
      // "refactor" makes the Engineer preset real, so a skill named "engineer" must be named apart
      // from it; the server name alone would overflow the profile's 40-character role field.
      skills: [
        { name: "refactor", description: "Rewrite code without changing behaviour" },
        { name: "engineer", description: "Unplaceable" },
      ],
      servers: [{ id: "m-9", name: "a-really-long-connector-name-that-overflows-the-field", command: "", url: "" }],
    });
    const names = roles.map((role) => role.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain("Engineer (skill)");
    for (const name of names) expect(name.length).toBeLessThanOrEqual(40);
  });
});
