import { useEffect, useState, type FormEvent } from "react";
import {
  ModelListResult,
  ProviderDeleteParams,
  ProviderListResult,
  SystemHealthResult,
  type ApiKind,
  type ModelCreateParams,
  type ModelView,
  type ProviderCreateParams,
  type ProviderView,
} from "@noir/protocol";
import type { RequestFn } from "./api.js";
import { errorMessage } from "./events.js";

const API_KIND_LABEL: Record<ApiKind, string> = {
  "openai-completions": "OpenAI-compatible",
  "anthropic-messages": "Anthropic",
  "google-generative-ai": "Google",
};

interface SetupProps {
  request: RequestFn;
  onOpenChat: () => void;
}

/**
 * First-run setup: provider and key, then a model. Keys are entered here and sent once to the
 * kernel over the local socket; the kernel keeps them in the OS keychain and in the generated
 * profile file, and no RPC ever returns a key to this window.
 */
export function Setup({ request, onOpenChat }: SetupProps) {
  const [providers, setProviders] = useState<ProviderView[]>([]);
  const [models, setModels] = useState<ModelView[]>([]);
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [apiKind, setApiKind] = useState<ApiKind>("openai-completions");
  const [providerId, setProviderId] = useState("");
  const [modelId, setModelId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [contextWindow, setContextWindow] = useState("200000");
  const [engineDir, setEngineDir] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  async function load(): Promise<void> {
    try {
      const [providerResult, modelResult, health] = await Promise.all([
        request("provider.list").then((value) => ProviderListResult.parse(value)),
        request("model.list").then((value) => ModelListResult.parse(value)),
        request("system.health").then((value) => SystemHealthResult.parse(value)),
      ]);
      setProviders(providerResult.providers);
      setModels(modelResult.models);
      setEngineDir(health.engineDir);
      setError(undefined);
    } catch (loadError) {
      setError(errorMessage(loadError));
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const providerValid =
    name.trim().length > 0 && baseUrl.trim().length > 0 && apiKey.length > 0 && !busy;
  const modelValid =
    providerId !== "" && modelId.trim().length > 0 && Number.isInteger(Number(contextWindow)) &&
    Number(contextWindow) > 0 && !busy;

  async function addProvider(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!providerValid) return;
    const params: ProviderCreateParams = {
      name: name.trim(),
      baseUrl: baseUrl.trim(),
      apiKind,
      apiKey,
      enabled: true,
    };
    setBusy(true);
    try {
      await request("provider.create", params);
      setName("");
      setBaseUrl("");
      setApiKey("");
      setError(undefined);
      await load();
    } catch (createError) {
      // Keep the typed values so the user can correct the URL instead of retyping everything.
      setError(errorMessage(createError));
    } finally {
      setBusy(false);
    }
  }

  async function addModel(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!modelValid) return;
    const params: ModelCreateParams = {
      providerId,
      modelId: modelId.trim(),
      contextWindow: Number(contextWindow),
      enabled: true,
      engine: "acp",
    };
    if (displayName.trim() !== "") params.displayName = displayName.trim();
    setBusy(true);
    try {
      await request("model.create", params);
      setModelId("");
      setDisplayName("");
      setError(undefined);
      await load();
    } catch (createError) {
      setError(errorMessage(createError));
    } finally {
      setBusy(false);
    }
  }

  async function removeProvider(provider: ProviderView): Promise<void> {
    setBusy(true);
    try {
      await request("provider.delete", ProviderDeleteParams.parse({ id: provider.id }));
      if (providerId === provider.id) setProviderId("");
      setError(undefined);
      await load();
    } catch (deleteError) {
      setError(errorMessage(deleteError));
    } finally {
      setBusy(false);
    }
  }

  async function removeModel(model: ModelView): Promise<void> {
    setBusy(true);
    try {
      await request("model.delete", { id: model.id });
      setError(undefined);
      await load();
    } catch (deleteError) {
      setError(errorMessage(deleteError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="setup" aria-label="Setup">
      <h2>Setup</h2>
      <p className="hint">
        Your API key is sent once to the local kernel and kept in the OS keychain. It is written only
        to <code>{engineDir === "" ? "models.yml" : `${engineDir}/models.yml`}</code> (owner-only
        permissions) so the engine can use it; it is never stored in the database, logs, or read back
        into this window. That directory belongs to NoirHarness — your own omp profile is not read or
        modified.
      </p>
      {error === undefined ? null : <p role="alert">{error}</p>}

      <section aria-label="Providers">
        <h3>Providers</h3>
        <ul className="setup-list">
          {providers.map((provider) => (
            <li key={provider.id}>
              <strong>{provider.name}</strong>
              <span>{provider.baseUrl}</span>
              <span>{API_KIND_LABEL[provider.apiKind]}</span>
              <span>{provider.hasKey ? "key stored" : "no key"}</span>
              <button type="button" disabled={busy} onClick={() => void removeProvider(provider)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
        <form onSubmit={(event) => void addProvider(event)}>
          <label>Name <input value={name} onChange={(event) => setName(event.target.value)} /></label>
          <label>
            Base URL
            <input
              placeholder="https://api.deepseek.com/v1"
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
            />
          </label>
          <label>
            API kind
            <select value={apiKind} onChange={(event) => setApiKind(event.target.value as ApiKind)}>
              {(Object.keys(API_KIND_LABEL) as ApiKind[]).map((kind) => (
                <option key={kind} value={kind}>{API_KIND_LABEL[kind]}</option>
              ))}
            </select>
          </label>
          <label>
            API key
            <input
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
            />
          </label>
          <button type="submit" disabled={!providerValid}>Add provider</button>
        </form>
      </section>

      <section aria-label="Models">
        <h3>Models</h3>
        <ul className="setup-list">
          {models.map((model) => {
            const provider = providers.find((candidate) => candidate.id === model.providerId);
            return (
              <li key={model.id}>
                <strong>{model.displayName}</strong>
                <span>{provider === undefined ? model.modelId : `${provider.name}/${model.modelId}`}</span>
                <span>{model.contextWindow.toLocaleString()} ctx</span>
                <button type="button" disabled={busy} onClick={() => void removeModel(model)}>
                  Remove
                </button>
              </li>
            );
          })}
        </ul>
        <form onSubmit={(event) => void addModel(event)}>
          <label>
            Provider
            <select aria-label="Provider" value={providerId} onChange={(event) => setProviderId(event.target.value)}>
              <option value="">Select a provider</option>
              {providers.map((provider) => (
                <option key={provider.id} value={provider.id}>{provider.name}</option>
              ))}
            </select>
          </label>
          <label>
            Model id
            <input
              placeholder="deepseek-chat"
              value={modelId}
              onChange={(event) => setModelId(event.target.value)}
            />
          </label>
          <label>
            Display name
            <input
              placeholder="DeepSeek Chat"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
            />
          </label>
          <label>
            Context window
            <input value={contextWindow} onChange={(event) => setContextWindow(event.target.value)} />
          </label>
          <button type="submit" disabled={!modelValid}>Add model</button>
        </form>
      </section>

      <button type="button" className="primary" onClick={onOpenChat} disabled={models.length === 0}>
        Open chat
      </button>
    </section>
  );
}
