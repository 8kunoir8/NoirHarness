import { randomBytes } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { stringify } from "yaml";
import type { ApiKind } from "@noir/protocol";

/**
 * `models.yml` writes the API kind as a bare literal in a two-level schema; a wrong
 * literal silently disables every custom provider, so every mapping lives in this one
 * table. Only `openai-completions` is wire-verified (see
 * docs/superpowers/notes/2026-11-10-acp-spike.md §1.2); the other two are the literals the
 * schema accepts, not literals exercised against a live provider. Fixing one is one line.
 */
export const API_KIND_TO_OMP: Readonly<Record<ApiKind, string>> = {
  "openai-completions": "openai-completions",
  "anthropic-messages": "anthropic-messages",
  "google-generative-ai": "google-generative-ai",
};

export interface ModelRef {
  providerName: string;
  modelId: string;
}

export interface ProfileProvider {
  name: string;
  baseUrl: string;
  apiKind: ApiKind;
  apiKey: string;
}

export interface ProfileModel {
  providerName: string;
  modelId: string;
  displayName?: string;
  contextWindow: number;
  maxTokens?: number;
  /** Emitted only when `true`; omp's default is `false`. */
  reasoning?: boolean;
}

export interface ProfileRoles {
  default: string;
  smol?: string;
  slow?: string;
  plan?: string;
  commit?: string;
}

export type ThinkingLevel = "off" | "low" | "medium" | "high";

const ROLE_ORDER = ["default", "smol", "slow", "plan", "commit"] as const;

const PROVIDER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Model selectors are `<providerName>/<modelId>`, so neither half may contain `/` or spaces. */
function checkName(kind: string, value: string): void {
  if (value.length === 0) throw new Error(`${kind} must not be empty`);
  if (/\s/.test(value)) throw new Error(`${kind} "${value}" must not contain whitespace`);
  if (value.includes("/")) throw new Error(`${kind} "${value}" must not contain "/"`);
}

function checkRef(kind: string, value: string): void {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) {
    throw new Error(`${kind} "${value}" must be "<providerName>/<modelId>"`);
  }
  if (value.indexOf("/", slash + 1) !== -1) {
    throw new Error(`${kind} "${value}" must be "<providerName>/<modelId>"`);
  }
}

function modelDoc(model: ProfileModel): Record<string, unknown> {
  if (!Number.isInteger(model.contextWindow) || model.contextWindow <= 0) {
    throw new Error(
      `model "${model.providerName}/${model.modelId}" has an invalid contextWindow (${String(model.contextWindow)})`,
    );
  }
  if (model.maxTokens !== undefined && (!Number.isInteger(model.maxTokens) || model.maxTokens <= 0)) {
    throw new Error(
      `model "${model.providerName}/${model.modelId}" has an invalid maxTokens (${String(model.maxTokens)})`,
    );
  }
  if (model.displayName !== undefined && model.displayName.trim().length === 0) {
    throw new Error(`model "${model.providerName}/${model.modelId}" has an empty displayName`);
  }
  const doc: Record<string, unknown> = { id: model.modelId };
  if (model.displayName !== undefined) doc.name = model.displayName;
  doc.contextWindow = model.contextWindow;
  if (model.maxTokens !== undefined) doc.maxTokens = model.maxTokens;
  if (model.reasoning === true) doc.reasoning = true;
  return doc;
}

function compareIds(a: ProfileModel, b: ProfileModel): number {
  if (a.modelId === b.modelId) return 0;
  return a.modelId < b.modelId ? -1 : 1;
}

/**
 * Renders `models.yml`. The default model is declared first and everything else is sorted by
 * `modelId`, because omp treats the first declared model of a provider as the session default.
 */
export function renderModelsYaml(
  providers: readonly ProfileProvider[],
  models: readonly ProfileModel[],
  defaultModel: ModelRef,
): string {
  if (providers.length === 0) throw new Error("models.yml: at least one provider is required");

  const known = new Set<string>();
  for (const provider of providers) {
    if (!PROVIDER_NAME.test(provider.name)) {
      throw new Error(`provider "${provider.name}" is not a valid provider name`);
    }
    if (known.has(provider.name)) throw new Error(`duplicate provider "${provider.name}"`);
    if (provider.baseUrl.trim().length === 0) throw new Error(`provider "${provider.name}" has an empty baseUrl`);
    if (provider.apiKey.length === 0) throw new Error(`provider "${provider.name}" has an empty apiKey`);
    known.add(provider.name);
  }

  const grouped = new Map<string, ProfileModel[]>();
  const seen = new Set<string>();
  for (const model of models) {
    checkName("model id", model.modelId);
    if (!known.has(model.providerName)) {
      throw new Error(
        `model "${model.providerName}/${model.modelId}" has no provider "${model.providerName}"`,
      );
    }
    const selector = `${model.providerName}/${model.modelId}`;
    if (seen.has(selector)) throw new Error(`duplicate model "${selector}"`);
    seen.add(selector);
    const group = grouped.get(model.providerName);
    if (group === undefined) grouped.set(model.providerName, [model]);
    else group.push(model);
  }

  checkName("default model provider", defaultModel.providerName);
  checkName("default model id", defaultModel.modelId);
  const defaultSelector = `${defaultModel.providerName}/${defaultModel.modelId}`;
  if (!seen.has(defaultSelector)) {
    throw new Error(`default model "${defaultSelector}" is not declared in models`);
  }

  const providersDoc: Record<string, unknown> = {};
  for (const provider of providers) {
    const list = grouped.get(provider.name) ?? [];
    const ordered = [...list].sort((a, b) => {
      const aDefault = a.modelId === defaultModel.modelId;
      const bDefault = b.modelId === defaultModel.modelId;
      if (aDefault !== bDefault) return aDefault ? -1 : 1;
      return compareIds(a, b);
    });
    providersDoc[provider.name] = {
      baseUrl: provider.baseUrl,
      api: API_KIND_TO_OMP[provider.apiKind],
      apiKey: provider.apiKey,
      models: ordered.map(modelDoc),
    };
  }

  return stringify({ providers: providersDoc }, { lineWidth: 0 });
}

export function renderConfigYaml(input: {
  roles?: ProfileRoles;
  defaultThinkingLevel?: ThinkingLevel;
}): string {
  const doc: Record<string, unknown> = {};
  if (input.roles !== undefined) {
    const modelRoles: Record<string, string> = {};
    for (const role of ROLE_ORDER) {
      const ref = input.roles[role];
      if (ref === undefined) continue;
      checkRef(`role "${role}"`, ref);
      modelRoles[role] = ref;
    }
    doc.modelRoles = modelRoles;
  }
  if (input.defaultThinkingLevel !== undefined) doc.defaultThinkingLevel = input.defaultThinkingLevel;
  return stringify(doc, { lineWidth: 0 });
}

function assertSafeDir(dir: string): void {
  if (dir.length === 0) throw new Error("profile dir must not be empty");
  if (!isAbsolute(dir)) throw new Error(`profile dir must be absolute: ${dir}`);
  if (dir.split(/[\\/]+/).includes("..")) {
    throw new Error(`profile dir must not contain ".." segments: ${dir}`);
  }
}

function describeWriteFailure(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    // fs errors and their codes never carry file content; never echo the content ourselves.
    return code === undefined ? error.name : `${code}: ${error.message}`;
  }
  return String(error);
}

async function writeAtomically(target: string, content: string): Promise<void> {
  const tmp = join(
    dirname(target),
    `.${basename(target)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    await writeFile(tmp, content, { mode: 0o600 });
    await rename(tmp, target);
  } catch (error) {
    await unlink(tmp).catch(() => undefined);
    throw new Error(`failed to write ${target}: ${describeWriteFailure(error)}`);
  }
}

export interface MaterializeProfileInput {
  /** Absolute path to the profile's `agent` directory. */
  dir: string;
  providers: readonly ProfileProvider[];
  models: readonly ProfileModel[];
  defaultModel: ModelRef;
  roles?: ProfileRoles;
}

/**
 * Writes `models.yml` and `config.yml` into `dir` (temp file + rename, mode 0600). Never logs
 * and never returns file content, so an API key can only reach disk.
 */
export async function materializeProfile(input: MaterializeProfileInput): Promise<void> {
  assertSafeDir(input.dir);
  const modelsYaml = renderModelsYaml(input.providers, input.models, input.defaultModel);
  const configYaml = renderConfigYaml(input.roles === undefined ? {} : { roles: input.roles });

  try {
    await mkdir(input.dir, { recursive: true });
  } catch (error) {
    throw new Error(`failed to create profile dir ${input.dir}: ${describeWriteFailure(error)}`);
  }

  await writeAtomically(join(input.dir, "models.yml"), modelsYaml);
  await writeAtomically(join(input.dir, "config.yml"), configYaml);
}
