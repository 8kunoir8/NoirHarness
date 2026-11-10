import { useEffect, useState, type FormEvent } from "react";
import {
  ProviderListResult as ProviderListResultSchema,
  type ProviderCreateParams,
  type ProviderView,
} from "@noir/protocol";

export type RequestFn = <T>(method: string, params?: unknown) => Promise<T>;

export function Settings({ request, onProvidersChanged }: { request: RequestFn; onProvidersChanged?: () => void }) {
  const [providers, setProviders] = useState<ProviderView[]>([]);
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [apiKind, setApiKind] = useState<ProviderCreateParams["apiKind"]>("openai-completions");
  const [error, setError] = useState<string | undefined>(undefined);

  const load = async () => {
    try {
      const result = ProviderListResultSchema.parse(await request("provider.list"));
      setProviders(result.providers);
      setError(undefined);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "request failed");
    }
  };
  useEffect(() => { void load(); }, []);

  const valid = name.trim().length > 0 && baseUrl.trim().length > 0 && apiKey.length > 0;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!valid) return;
    const params: ProviderCreateParams = { name: name.trim(), baseUrl: baseUrl.trim(), apiKind, apiKey, enabled: true };
    try {
      const created = await request<{ id?: string }>("provider.create", params);
      if (typeof created?.id !== "string") {
        setError("provider.create returned no id");
        return;
      }
      setName(""); setBaseUrl(""); setApiKey("");
      await load();
      onProvidersChanged?.();
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "request failed");
    }
  }

  return (
    <section>
      <h2>Providers</h2>
      {error === undefined ? null : <p role="alert">{error}</p>}
      <ul>
        {providers.map((p) => <li key={p.id}><strong>{p.name}</strong> — {p.baseUrl}</li>)}
      </ul>
      <form onSubmit={submit}>
        <label>Name <input value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label>Base URL <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} /></label>
        <label>API key <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} /></label>
        <label>API kind
          <select value={apiKind} onChange={(e) => setApiKind(e.target.value as ProviderCreateParams["apiKind"])}>
            <option value="openai-completions">OpenAI-compatible</option>
            <option value="anthropic-messages">Anthropic</option>
            <option value="google-generative-ai">Google</option>
          </select>
        </label>
        <button type="submit" disabled={!valid}>Add provider</button>
      </form>
    </section>
  );
}
