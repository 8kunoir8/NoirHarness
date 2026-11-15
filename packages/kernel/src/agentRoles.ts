import type { AgentRoleView, McpServerView, SkillView } from "@noir/protocol";

/** What the catalog is built from; either side may be empty. */
export type RoleInputs = {
  skills: readonly Pick<SkillView, "name" | "description">[];
  servers: readonly Pick<McpServerView, "id" | "name" | "command" | "url">[];
};

/**
 * A role is a capability preset: a vocabulary that claims the skills and MCP servers it is for. The
 * catalog is derived from what exists, so a preset with nothing behind it never shows up, and
 * anything the vocabulary misses gets a role of its own rather than being hidden.
 */
interface RolePreset {
  id: string;
  name: string;
  description: string;
  /** Matched against skill names and descriptions, and against server names, commands and urls. */
  keywords: readonly string[];
}

/** The profile field this name lands in, and the widest value every picker can show. */
const ROLE_NAME_MAX = 40;

/**
 * Ordered: when two presets match an item equally well the earlier one claims it. The words are the
 * ones that show up in real skill and server metadata, so the catalog offers roles this machine can
 * actually staff instead of a wish list.
 */
const PRESETS: readonly RolePreset[] = [
  {
    id: "engineer",
    name: "Engineer",
    description: "Reads, writes and tests code, and drives a repository through its build and git.",
    keywords: [
      "code", "coding", "refactor", "refactoring", "implement", "implementation", "test", "tests",
      "testing", "tdd", "debug", "debugging", "compile", "build", "lint", "typecheck", "typescript",
      "javascript", "python", "rust", "golang", "java", "kotlin", "swift", "php", "ruby", "csharp",
      "dotnet", "git", "commit", "branch", "merge", "diff", "api", "sdk", "cli",
    ],
  },
  {
    id: "reviewer",
    name: "Reviewer",
    description: "Audits a change or a codebase for defects and vulnerabilities before it ships.",
    keywords: [
      "review", "reviewer", "audit", "secure", "security", "vulnerability", "vulnerabilities",
      "threat", "pentest", "accessibility", "compliance", "sast", "dast", "secret", "secrets",
      "coderabbit",
    ],
  },
  {
    id: "researcher",
    name: "Researcher",
    description: "Finds, reads and cites material from the web, papers and feeds.",
    keywords: [
      "research", "search", "browser", "crawl", "crawler", "scrape", "scraper", "scraping", "web",
      "http", "url", "serp", "dataset", "literature", "paper", "papers", "arxiv", "news", "feed",
      "brightdata", "firecrawl", "exa", "tavily", "perplexity", "prospect",
    ],
  },
  {
    id: "analyst",
    name: "Analyst",
    description: "Answers questions from warehouses, spreadsheets and pipelines with the numbers attached.",
    keywords: [
      "data", "analytics", "analysis", "sql", "database", "warehouse", "postgres", "sqlite",
      "snowflake", "bigquery", "duckdb", "airflow", "dbt", "spark", "kafka", "metrics", "dashboard",
      "chart", "charts", "csv", "xlsx", "excel", "spreadsheet", "statistic", "statistics", "pandas",
      "table", "query",
    ],
  },
  {
    id: "designer",
    name: "Designer",
    description: "Builds and judges interfaces, documents and images to a visual standard.",
    keywords: [
      "design", "ui", "ux", "figma", "shader", "css", "html", "frontend", "poster", "slide",
      "slides", "presentation", "typography", "brand", "image", "images", "adobe", "animation",
      "mockup", "theme", "icon", "diagram",
    ],
  },
  {
    id: "writer",
    name: "Writer",
    description: "Turns notes and evidence into prose that reads as if a person wrote it.",
    keywords: [
      "write", "writer", "writing", "docs", "documentation", "markdown", "prose", "edit", "editing",
      "translate", "translation", "copy", "copywriting", "book", "notes", "knowledge", "readme",
      "changelog", "summary",
    ],
  },
  {
    id: "operator",
    name: "Operator",
    description: "Ships and watches running systems: containers, cloud, CI and on-call.",
    keywords: [
      "deploy", "deployment", "devops", "infra", "infrastructure", "docker", "container",
      "kubernetes", "k8s", "cloud", "cloudflare", "workers", "wrangler", "aws", "gcp", "azure",
      "terraform", "pipeline", "sre", "observability", "uptime", "cron", "automation", "proxy",
    ],
  },
  {
    id: "maker",
    name: "Maker",
    description: "Works in a game engine or a 3D tool, from asset to shipped build.",
    keywords: ["game", "unity", "unreal", "godot", "roblox", "blender", "level", "voxel", "3d", "mesh"],
  },
];

/** Every catalog starts here: it claims nothing, so it is always a valid choice. */
const GENERALIST: AgentRoleView = {
  id: "generalist",
  name: "Generalist",
  description: "No specialism selected; the default for a chat that names no agent.",
  skills: [],
  mcpServerIds: [],
  derived: false,
};

/**
 * How strongly a piece of text claims one preset: one point per distinct keyword it contains. Word
 * boundaries keep `code` out of `encode` and `api` out of `capital`, so a description cannot inflate
 * its score by accident.
 */
function score(text: string, keywords: readonly string[]): number {
  let hits = 0;
  for (const keyword of keywords) {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(text)) hits += 1;
  }
  return hits;
}

/** The preset that claims this text, or `undefined` when no vocabulary recognises it. */
function bestPreset(text: string): RolePreset | undefined {
  let best: RolePreset | undefined;
  let bestScore = 0;
  for (const preset of PRESETS) {
    const hits = score(text, preset.keywords);
    if (hits > bestScore) {
      best = preset;
      bestScore = hits;
    }
  }
  return best;
}

/**
 * The role catalog for one set of skills and servers.
 *
 * Every preset that claims at least one item becomes a role listing what it claimed. An item no preset
 * claims becomes its own role, named after the item, so adding a skill or an MCP server always lands
 * somewhere the user can see and pick — either an existing role widens, or a new role appears.
 */
export function buildRoles(inputs: RoleInputs): AgentRoleView[] {
  const claimedSkills = new Map<string, string[]>();
  const claimedServers = new Map<string, string[]>();
  const claim = (target: Map<string, string[]>, presetId: string, item: string): void => {
    const list = target.get(presetId) ?? [];
    list.push(item);
    target.set(presetId, list);
  };

  const unclaimedSkills: typeof inputs.skills[number][] = [];
  for (const skill of inputs.skills) {
    const preset = bestPreset(`${skill.name} ${skill.description}`);
    if (preset === undefined) unclaimedSkills.push(skill);
    else claim(claimedSkills, preset.id, skill.name);
  }

  const unclaimedServers: typeof inputs.servers[number][] = [];
  for (const server of inputs.servers) {
    const preset = bestPreset(`${server.name} ${server.command} ${server.url}`);
    if (preset === undefined) unclaimedServers.push(server);
    else claim(claimedServers, preset.id, server.id);
  }

  const roles: AgentRoleView[] = [];
  for (const preset of PRESETS) {
    const skills = claimedSkills.get(preset.id) ?? [];
    const mcpServerIds = claimedServers.get(preset.id) ?? [];
    if (skills.length === 0 && mcpServerIds.length === 0) continue;
    roles.push({
      id: preset.id,
      name: preset.name,
      description: preset.description,
      skills: [...skills].sort(),
      mcpServerIds: [...mcpServerIds].sort(),
      derived: false,
    });
  }

  // One descriptor per unclaimed item, then one pass that names and slugs them: a skill and a server
  // are different kinds but the role they get is built the same way.
  const loose = [
    ...unclaimedSkills.map((skill) => ({
      kind: "skill" as const,
      title: skill.name,
      description: skill.description === "" ? `The ${skill.name} skill.` : skill.description,
      skills: [skill.name],
      mcpServerIds: [] as string[],
    })),
    ...unclaimedServers.map((server) => ({
      kind: "mcp" as const,
      title: server.name,
      description: `The ${server.name} MCP server.`,
      skills: [] as string[],
      mcpServerIds: [server.id],
    })),
  ];
  // A role name is what a profile stores (`role` is capped at 40 characters), and it has to stay
  // distinct from the presets above or the picker would hold two options with the same value.
  const taken = new Set(roles.map((role) => role.name.toLowerCase()));
  const derived: AgentRoleView[] = [];
  for (const item of loose) {
    const words = item.title.split(/[^a-zA-Z0-9]+/).filter((word) => word !== "");
    const titled = words.map((word) => (word[0] ?? "").toUpperCase() + word.slice(1)).join(" ") || item.title;
    let name = titled.slice(0, ROLE_NAME_MAX);
    if (taken.has(name.toLowerCase())) name = `${name} (${item.kind === "skill" ? "skill" : "server"})`.slice(0, ROLE_NAME_MAX);
    taken.add(name.toLowerCase());
    derived.push({
      id: `derived:${item.kind}:${words.map((word) => word.toLowerCase()).join("-") || "item"}`,
      name,
      description: item.description,
      skills: item.skills,
      mcpServerIds: item.mcpServerIds,
      derived: true,
    });
  }
  derived.sort((a, b) => (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1));

  return [GENERALIST, ...roles, ...derived];
}
