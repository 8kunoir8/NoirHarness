import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";
import {
  API_KIND_TO_OMP,
  materializeProfile,
  renderConfigYaml,
  renderModelsYaml,
} from "../src/index.js";
import type { ProfileModel, ProfileProvider } from "../src/index.js";

const KEY_ONE = "sk-test-one-DO-NOT-LEAK";
const KEY_TWO = "sk-test-two-DO-NOT-LEAK";

const ModelDoc = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    contextWindow: z.number().int(),
    maxTokens: z.number().int().optional(),
    reasoning: z.literal(true).optional(),
  })
  .strict();
const ProviderDoc = z
  .object({
    baseUrl: z.string(),
    api: z.string(),
    apiKey: z.string(),
    models: z.array(ModelDoc),
  })
  .strict();
const ModelsDoc = z.object({ providers: z.record(z.string(), ProviderDoc) }).strict();
const ConfigDoc = z
  .object({
    modelRoles: z.record(z.string(), z.string()).optional(),
    defaultThinkingLevel: z.enum(["off", "low", "medium", "high"]).optional(),
  })
  .strict();

type ModelsDoc = z.infer<typeof ModelsDoc>;
type ConfigDoc = z.infer<typeof ConfigDoc>;

/** Strict parse: an unknown field (e.g. a partial `cost`) fails the test instead of being stripped. */
function parseModels(text: string): ModelsDoc {
  return ModelsDoc.parse(parse(text));
}

function parseConfig(text: string): ConfigDoc {
  return ConfigDoc.parse(parse(text));
}

const providers: ProfileProvider[] = [
  { name: "mock", baseUrl: "http://127.0.0.1:18081/v1", apiKind: "openai-completions", apiKey: KEY_ONE },
  { name: "alt", baseUrl: "https://api.example.com/v1", apiKind: "anthropic-messages", apiKey: KEY_TWO },
];

const models: ProfileModel[] = [
  { providerName: "mock", modelId: "zeta-1", displayName: "Zeta One", contextWindow: 100_000 },
  {
    providerName: "mock",
    modelId: "alpha-2",
    displayName: "Alpha Two",
    contextWindow: 120_000,
    maxTokens: 4096,
    reasoning: true,
  },
  { providerName: "alt", modelId: "claude-x", contextWindow: 200_000, maxTokens: 8192 },
];

const DEFAULT_MODEL = { providerName: "mock", modelId: "zeta-1" } as const;

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "noir-omp-profile-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function collectError(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error(`threw a non-Error: ${String(error)}`);
  }
  throw new Error("expected a thrown Error");
}

async function collectRejection(run: Promise<unknown>): Promise<Error> {
  try {
    await run;
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error(`rejected with a non-Error: ${String(error)}`);
  }
  throw new Error("expected a rejection");
}

describe("renderModelsYaml", () => {
  it("emits the verified schema byte-for-byte", () => {
    expect(renderModelsYaml(providers, models, DEFAULT_MODEL)).toBe(
      [
        "providers:",
        "  mock:",
        "    baseUrl: http://127.0.0.1:18081/v1",
        "    api: openai-completions",
        `    apiKey: ${KEY_ONE}`,
        "    models:",
        "      - id: zeta-1",
        "        name: Zeta One",
        "        contextWindow: 100000",
        "      - id: alpha-2",
        "        name: Alpha Two",
        "        contextWindow: 120000",
        "        maxTokens: 4096",
        "        reasoning: true",
        "  alt:",
        "    baseUrl: https://api.example.com/v1",
        "    api: anthropic-messages",
        `    apiKey: ${KEY_TWO}`,
        "    models:",
        "      - id: claude-x",
        "        contextWindow: 200000",
        "        maxTokens: 8192",
        "",
      ].join("\n"),
    );
  });

  it("is deterministic across calls", () => {
    expect(renderModelsYaml(providers, models, DEFAULT_MODEL)).toBe(
      renderModelsYaml(providers, models, DEFAULT_MODEL),
    );
  });

  it("re-parses to the expected object with `id` and no `cost`", () => {
    const doc = parseModels(renderModelsYaml(providers, models, DEFAULT_MODEL));
    expect(doc).toEqual({
      providers: {
        mock: {
          baseUrl: "http://127.0.0.1:18081/v1",
          api: "openai-completions",
          apiKey: KEY_ONE,
          models: [
            { id: "zeta-1", name: "Zeta One", contextWindow: 100_000 },
            { id: "alpha-2", name: "Alpha Two", contextWindow: 120_000, maxTokens: 4096, reasoning: true },
          ],
        },
        alt: {
          baseUrl: "https://api.example.com/v1",
          api: "anthropic-messages",
          apiKey: KEY_TWO,
          models: [{ id: "claude-x", contextWindow: 200_000, maxTokens: 8192 }],
        },
      },
    });
    for (const model of doc.providers["mock"]!.models) expect(model).not.toHaveProperty("cost");
  });

  it("puts the default model first and sorts the rest by modelId, per provider", () => {
    const shuffled: ProfileModel[] = [
      { providerName: "mock", modelId: "m-c", contextWindow: 1000 },
      { providerName: "mock", modelId: "m-a", contextWindow: 1000 },
      { providerName: "mock", modelId: "m-b", contextWindow: 1000 },
    ];
    const sortedFromC = parseModels(
      renderModelsYaml([providers[0]!], shuffled, { providerName: "mock", modelId: "m-c" }),
    );
    expect(sortedFromC.providers["mock"]!.models.map((m) => m.id)).toEqual(["m-c", "m-a", "m-b"]);

    const sortedFromA = parseModels(
      renderModelsYaml([providers[0]!], shuffled, { providerName: "mock", modelId: "m-a" }),
    );
    expect(sortedFromA.providers["mock"]!.models.map((m) => m.id)).toEqual(["m-a", "m-b", "m-c"]);
  });

  it("keeps providers in input order", () => {
    const doc = parseModels(renderModelsYaml([...providers].reverse(), models, DEFAULT_MODEL));
    expect(Object.keys(doc.providers)).toEqual(["alt", "mock"]);
  });

  it("omits optional model fields when they are absent", () => {
    const doc = parseModels(
      renderModelsYaml(
        [providers[0]!],
        [{ providerName: "mock", modelId: "bare", contextWindow: 8000 }],
        { providerName: "mock", modelId: "bare" },
      ),
    );
    expect(doc.providers["mock"]!.models).toEqual([{ id: "bare", contextWindow: 8000 }]);
  });

  it("maps every ApiKind literal through API_KIND_TO_OMP", () => {
    const doc = parseModels(
      renderModelsYaml(
        [
          { name: "a", baseUrl: "https://a.example", apiKind: "openai-completions", apiKey: "k" },
          { name: "b", baseUrl: "https://b.example", apiKind: "anthropic-messages", apiKey: "k" },
          { name: "c", baseUrl: "https://c.example", apiKind: "google-generative-ai", apiKey: "k" },
        ],
        [
          { providerName: "a", modelId: "m", contextWindow: 1000 },
          { providerName: "b", modelId: "m", contextWindow: 1000 },
          { providerName: "c", modelId: "m", contextWindow: 1000 },
        ],
        { providerName: "a", modelId: "m" },
      ),
    );
    expect(doc.providers["a"]!.api).toBe(API_KIND_TO_OMP["openai-completions"]);
    expect(doc.providers["b"]!.api).toBe(API_KIND_TO_OMP["anthropic-messages"]);
    expect(doc.providers["c"]!.api).toBe(API_KIND_TO_OMP["google-generative-ai"]);
  });

  it("rejects an empty provider list", () => {
    const error = collectError(() => renderModelsYaml([], [], DEFAULT_MODEL));
    expect(error.message).toMatch(/at least one provider/);
  });

  it("rejects duplicate provider names", () => {
    const error = collectError(() =>
      renderModelsYaml([providers[0]!, providers[0]!], models, DEFAULT_MODEL),
    );
    expect(error.message).toMatch(/duplicate provider "mock"/);
  });

  it("rejects duplicate models within a provider", () => {
    const dup: ProfileModel[] = [
      { providerName: "mock", modelId: "same", contextWindow: 1000 },
      { providerName: "mock", modelId: "same", contextWindow: 2000 },
    ];
    const error = collectError(() =>
      renderModelsYaml([providers[0]!], dup, { providerName: "mock", modelId: "same" }),
    );
    expect(error.message).toMatch(/duplicate model "mock\/same"/);
  });

  it("rejects a model whose provider is absent", () => {
    const error = collectError(() =>
      renderModelsYaml(
        [providers[0]!],
        [{ providerName: "ghost", modelId: "m1", contextWindow: 1000 }],
        { providerName: "mock", modelId: "zeta-1" },
      ),
    );
    expect(error.message).toMatch(/no provider "ghost"/);
  });

  it("rejects a default model that is not in models", () => {
    const error = collectError(() =>
      renderModelsYaml(providers, models, { providerName: "mock", modelId: "missing" }),
    );
    expect(error.message).toMatch(/default model "mock\/missing" is not declared/);
  });

  it("rejects an invalid contextWindow", () => {
    const error = collectError(() =>
      renderModelsYaml(
        [providers[0]!],
        [{ providerName: "mock", modelId: "bad", contextWindow: 0 }],
        { providerName: "mock", modelId: "bad" },
      ),
    );
    expect(error.message).toMatch(/invalid contextWindow/);
  });

  it("never puts an apiKey into a thrown error message", () => {
    const attempts: Array<() => unknown> = [
      () => renderModelsYaml([providers[0]!, providers[0]!], models, DEFAULT_MODEL),
      () => renderModelsYaml([], [], DEFAULT_MODEL),
      () =>
        renderModelsYaml(
          [providers[0]!],
          [{ providerName: "ghost", modelId: "m1", contextWindow: 1000 }],
          DEFAULT_MODEL,
        ),
      () => renderModelsYaml(providers, models, { providerName: "mock", modelId: "missing" }),
      () =>
        renderModelsYaml(
          [providers[0]!],
          [{ providerName: "mock", modelId: "bad", contextWindow: -1 }],
          { providerName: "mock", modelId: "bad" },
        ),
    ];
    for (const attempt of attempts) {
      const message = collectError(attempt).message;
      expect(message).not.toContain(KEY_ONE);
      expect(message).not.toContain(KEY_TWO);
    }
  });
});

describe("renderConfigYaml", () => {
  it("emits only the roles that are provided", () => {
    expect(renderConfigYaml({ roles: { default: "mock/zeta-1", smol: "mock/alpha-2" } })).toBe(
      ["modelRoles:", "  default: mock/zeta-1", "  smol: mock/alpha-2", ""].join("\n"),
    );
  });

  it("adds defaultThinkingLevel when given", () => {
    expect(
      renderConfigYaml({ roles: { default: "mock/zeta-1" }, defaultThinkingLevel: "medium" }),
    ).toBe(["modelRoles:", "  default: mock/zeta-1", "defaultThinkingLevel: medium", ""].join("\n"));
  });

  it("emits an empty object document when there are no roles", () => {
    expect(renderConfigYaml({})).toBe("{}\n");
    expect(renderConfigYaml({ defaultThinkingLevel: "low" })).toBe("defaultThinkingLevel: low\n");
  });

  it("re-parses to modelRoles and nothing else", () => {
    expect(parseConfig(renderConfigYaml({ roles: { default: "a/b", plan: "a/c" } }))).toEqual({
      modelRoles: { default: "a/b", plan: "a/c" },
    });
  });

  it("rejects a role reference that is not <provider>/<model>", () => {
    const error = collectError(() => renderConfigYaml({ roles: { default: "no-slash" } }));
    expect(error.message).toMatch(/role "default"/);
  });
});

describe("materializeProfile", () => {
  it("writes models.yml and config.yml that re-parse as expected", async () => {
    const dir = join(await tempDir(), "agent");
    await materializeProfile({
      dir,
      providers,
      models,
      defaultModel: DEFAULT_MODEL,
      roles: { default: "mock/zeta-1", slow: "alt/claude-x" },
    });

    const written = await readdir(dir);
    expect(written.sort()).toEqual(["config.yml", "models.yml"]);

    const modelsYaml = await readFile(join(dir, "models.yml"), "utf8");
    const configYaml = await readFile(join(dir, "config.yml"), "utf8");
    expect(parseModels(modelsYaml)).toEqual(parseModels(renderModelsYaml(providers, models, DEFAULT_MODEL)));
    expect(parseConfig(configYaml)).toEqual({
      modelRoles: { default: "mock/zeta-1", slow: "alt/claude-x" },
    });
  });

  it("overwrites a stale profile so removed models disappear", async () => {
    const dir = await tempDir();
    await materializeProfile({ dir, providers, models, defaultModel: DEFAULT_MODEL });
    await materializeProfile({
      dir,
      providers: [providers[0]!],
      models: [{ providerName: "mock", modelId: "zeta-1", contextWindow: 100_000 }],
      defaultModel: DEFAULT_MODEL,
      roles: { default: "mock/zeta-1" },
    });

    const doc = parseModels(await readFile(join(dir, "models.yml"), "utf8"));
    expect(doc.providers["mock"]!.models.map((m) => m.id)).toEqual(["zeta-1"]);
    expect(doc.providers["alt"]).toBeUndefined();
    expect(parseConfig(await readFile(join(dir, "config.yml"), "utf8"))).toEqual({
      modelRoles: { default: "mock/zeta-1" },
    });
  });

  it("writes an empty config.yml when there are no roles", async () => {
    const dir = await tempDir();
    await materializeProfile({ dir, providers, models, defaultModel: DEFAULT_MODEL });
    expect(await readFile(join(dir, "config.yml"), "utf8")).toBe("{}\n");
  });

  it.skipIf(process.platform === "win32")("writes 0600 files", async () => {
    const dir = await tempDir();
    await materializeProfile({ dir, providers, models, defaultModel: DEFAULT_MODEL });
    for (const name of ["models.yml", "config.yml"]) {
      const stats = await stat(join(dir, name));
      expect(stats.mode & 0o777).toBe(0o600);
    }
  });

  it("rejects a relative dir", async () => {
    const error = await collectRejection(
      materializeProfile({ dir: "relative/agent", providers, models, defaultModel: DEFAULT_MODEL }),
    );
    expect(error.message).toMatch(/must be absolute/);
    expect(error.message).not.toContain(KEY_ONE);
  });

  it("rejects a dir containing .. segments", async () => {
    const dir = `${tmpdir()}${sep}agent${sep}..${sep}other`;
    const error = await collectRejection(
      materializeProfile({ dir, providers, models, defaultModel: DEFAULT_MODEL }),
    );
    expect(error.message).toMatch(/"\.\." segments/);
  });

  it("names the file path but not the content when a write fails", async () => {
    const dir = await tempDir();
    // A directory squatting on models.yml makes the final rename fail.
    await mkdir(join(dir, "models.yml"));
    const error = await collectRejection(
      materializeProfile({ dir, providers, models, defaultModel: DEFAULT_MODEL }),
    );
    expect(error.message).toContain(join(dir, "models.yml"));
    expect(error.message).not.toContain(KEY_ONE);
    expect(error.message).not.toContain(KEY_TWO);
  });

  it("does not leave temp files behind", async () => {
    const dir = await tempDir();
    await materializeProfile({ dir, providers, models, defaultModel: DEFAULT_MODEL });
    const entries = await readdir(dir);
    expect(entries.some((entry) => entry.endsWith(".tmp"))).toBe(false);
  });

  it("replaces a pre-existing file with a stale model entry", async () => {
    const dir = await tempDir();
    await writeFile(
      join(dir, "models.yml"),
      "providers:\n  stale:\n    baseUrl: http://stale\n    api: openai-completions\n    apiKey: sk-stale\n    models:\n      - id: old\n        contextWindow: 1\n",
    );
    const only: ProfileModel = { providerName: "mock", modelId: "zeta-1", contextWindow: 100_000 };
    await materializeProfile({
      dir,
      providers: [providers[0]!],
      models: [only],
      defaultModel: DEFAULT_MODEL,
    });
    const text = await readFile(join(dir, "models.yml"), "utf8");
    expect(text).not.toContain("stale");
    expect(parseModels(text)).toEqual(
      parseModels(renderModelsYaml([providers[0]!], [only], DEFAULT_MODEL)),
    );
  });
});
