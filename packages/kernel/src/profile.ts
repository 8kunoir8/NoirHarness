import { rm } from "node:fs/promises";
import { join } from "node:path";
import { materializeProfile, type ProfileModel, type ProfileProvider } from "@noir/omp-profile";
import { ErrorCodes, RpcFault } from "@noir/protocol";
import type { ModelService } from "./models.js";
import type { ProviderService } from "./providers.js";

/**
 * The engine's agent directory, owned by NoirHarness: `<dataDir>/engine`.
 *
 * `omp` reads it because `EngineManager` spawns the engine with `PI_CODING_AGENT_DIR` pointing
 * here, so nothing under the user's `~/.omp` is read or written. The layout inside is omp's own
 * (`models.yml`, `config.yml`, session state), which is why `--profile` is not used.
 */
export function profileAgentDir(dataDir: string): string {
  return join(dataDir, "engine");
}

/** Removes the rendered models file (and with it every key) without touching config.yml. */
export async function clearProfileModels(dataDir: string): Promise<void> {
  await rm(join(profileAgentDir(dataDir), "models.yml"), { force: true });
}

export interface SyncProfileDeps {
  providers: ProviderService;
  models: ModelService;
  /** Kernel data dir; the profile lives in `<dataDir>/engine`. */
  dataDir: string;
}

/**
 * Renders `models.yml`/`config.yml` from the enabled registry. Keys are read from the vault,
 * written only to the 0600 profile files, and never appear in errors or logs.
 *
 * An empty registry has no profile to write (a fresh install, or a user who removed the last
 * provider/model); the caller that actually needs an engine fails later with a clear conflict
 * when it cannot resolve a model selector.
 */
export async function syncProfile(deps: SyncProfileDeps): Promise<void> {
  const providers: ProfileProvider[] = [];
  const providerNames = new Map<string, string>();
  for (const provider of deps.providers.enabledWithKeys()) {
    if (provider.apiKey === null) continue;
    providers.push({
      name: provider.name,
      baseUrl: provider.baseUrl,
      apiKind: provider.apiKind,
      apiKey: provider.apiKey,
    });
    providerNames.set(provider.id, provider.name);
  }

  const models: ProfileModel[] = [];
  for (const model of deps.models.list()) {
    const providerName = providerNames.get(model.providerId);
    if (!model.enabled || providerName === undefined) continue;
    models.push({
      providerName,
      modelId: model.modelId,
      displayName: model.displayName,
      contextWindow: model.contextWindow,
      ...(model.maxTokens === null ? {} : { maxTokens: model.maxTokens }),
    });
  }

  if (providers.length === 0 || models.length === 0) {
    // Nothing can be rendered; drop the old file so a deleted provider's key does not linger on disk.
    await clearProfileModels(deps.dataDir);
    return;
  }

  const defaultModel = deps.models.defaultModel();
  if (
    defaultModel === undefined ||
    !models.some((model) => model.providerName === defaultModel.providerName && model.modelId === defaultModel.modelId)
  ) {
    throw new RpcFault(ErrorCodes.internal, "No enabled provider/model is available for the engine profile");
  }

  await materializeProfile({
    dir: profileAgentDir(deps.dataDir),
    providers,
    models,
    defaultModel: { providerName: defaultModel.providerName, modelId: defaultModel.modelId },
  });
}
