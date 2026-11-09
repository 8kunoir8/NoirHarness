import { useEffect, useState, type FormEvent } from "react";
import {
  ProviderListResult as ProviderListResultSchema,
  type ProviderCreateParams,
  type ProviderView,
} from "@noir/protocol";

export type RequestFn = <T>(method: string, params?: unknown) => Promise<T>;

export function Settings({ request }: { request: RequestFn }) {
  const [providers, setProviders] = useState<ProviderView[]>([]);
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [apiKind, setApiKind] = useState<ProviderCreateParams["apiKind"]>("openai-completions");

  const load = async () => {
    const result = ProviderListResultSchema.parse(await request("provider.list"));
    setProviders(result.providers);
  };
  useEffect(() => { void load(); }, []);

  const valid = name.trim().length > 0 && baseUrl.trim().length > 0 && apiKey.length > 0;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!valid) return;
    const params: ProviderCreateParams = { name: name.trim(), baseUrl: baseUrl.trim(), apiKind, apiKey, enabled: true };
    await request("provider.create", params);
    setName(""); setBaseUrl(""); setApiKey("");
    await load();
  }

  return (
    <section>
      <h2>Providers</h2>
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
