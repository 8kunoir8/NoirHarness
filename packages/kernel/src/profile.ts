import { join } from "node:path";
import { materializeProfile, type ProfileModel, type ProfileProvider } from "@noir/omp-profile";
import { ErrorCodes, RpcFault } from "@noir/protocol";
import type { ModelService } from "./models.js";
import type { ProviderService } from "./providers.js";

/** The omp profile directory the kernel owns: `~/.omp/profiles/noir/agent`. */
export function profileAgentDir(home: string): string {
  return join(home, ".omp", "profiles", "noir", "agent");
}

export interface SyncProfileDeps {
  providers: ProviderService;
  models: ModelService;
  /** Kernel data dir. Reserved for future profile state; never holds provider keys. */
  dataDir: string;
  /** Profile home (`NOIR_PROFILE_HOME` or the user's home directory). */
  home: string;
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

  if (providers.length === 0 || models.length === 0) return;

  const defaultModel = deps.models.defaultModel();
  if (
    defaultModel === undefined ||
    !models.some((model) => model.providerName === defaultModel.providerName && model.modelId === defaultModel.modelId)
  ) {
    throw new RpcFault(ErrorCodes.internal, "No enabled provider/model is available for the engine profile");
  }

  await materializeProfile({
    dir: profileAgentDir(deps.home),
    providers,
    models,
    defaultModel: { providerName: defaultModel.providerName, modelId: defaultModel.modelId },
  });
}
