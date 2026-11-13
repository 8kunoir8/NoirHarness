import { useEffect, useState, type FormEvent } from "react";
import {
  McpServerCreateParams,
  McpServerDeleteParams,
  McpServerListResult,
  McpServerName,
  McpServerUpdateParams,
  McpTestParams,
  McpTestResult,
  ModelListResult,
  ProviderDeleteParams,
  ProviderListResult,
  SystemHealthResult,
  type ApiKind,
  type EngineKind,
  type McpServerView,
  type ModelCreateParams,
  type ModelView,
  type ProviderCreateParams,
  type ProviderView,
} from "@noir/protocol";
import type { RequestFn } from "./api.js";
import { Devices } from "./Devices.js";
import { isBrowser } from "./transport.js";
import { errorMessage } from "./events.js";

const API_KIND_LABEL: Record<ApiKind, string> = {
  "openai-completions": "OpenAI-compatible",
  "anthropic-messages": "Anthropic",
  "google-generative-ai": "Google",
};

const MCP_NAME_HINT = "Use lowercase letters, digits, _ or - (max 40, no double underscore)";

/**
 * One argument per line: an argument may contain spaces (a Windows path is the common case), so
 * splitting on whitespace would silently turn one argument into several.
 */
function parseArgs(text: string): string[] {
  return text.split(/\r?\n/).filter((arg) => arg !== "");
}

function argsText(args: readonly string[]): string {
  return args.join("\n");
}

/** `KEY=value` per line; the value may be empty and keeps everything after the first `=`. */
function parseEnv(text: string): Record<string, string> | undefined {
  const env: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const index = line.indexOf("=");
    if (index <= 0) return undefined;
    env[line.slice(0, index).trim()] = line.slice(index + 1);
  }
  return env;
}

function envText(env: Record<string, string>): string {
  return Object.entries(env).map(([key, value]) => `${key}=${value}`).join("\n");
}

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
  const [engine, setEngine] = useState<EngineKind>("acp");
  const [engineDir, setEngineDir] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const [mcpServers, setMcpServers] = useState<McpServerView[]>([]);
  /** The server id the form is editing, or `undefined` when it is creating a new one. */
  const [mcpEditing, setMcpEditing] = useState<string | undefined>(undefined);
  const [mcpName, setMcpName] = useState("");
  const [mcpCommand, setMcpCommand] = useState("");
  const [mcpArgs, setMcpArgs] = useState("");
  const [mcpEnv, setMcpEnv] = useState("");
  const [mcpError, setMcpError] = useState<string | undefined>(undefined);
  /** Probe outcome per server id; a successful probe reports the discovered tool count. */
  const [mcpProbes, setMcpProbes] = useState<Record<string, McpTestResult>>({});
  const [busy, setBusy] = useState(false);

  async function load(): Promise<void> {
    try {
      const [providerResult, modelResult, health, mcpResult] = await Promise.all([
        request("provider.list").then((value) => ProviderListResult.parse(value)),
        request("model.list").then((value) => ModelListResult.parse(value)),
        request("system.health").then((value) => SystemHealthResult.parse(value)),
        request("mcp.list").then((value) => McpServerListResult.parse(value)),
      ]);
      setProviders(providerResult.providers);
      setModels(modelResult.models);
      setEngineDir(health.engineDir);
      setMcpServers(mcpResult.servers);
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
  // The native loop speaks the chat-completions protocol, so only such a provider can back it.
  const selectedProvider = providers.find((candidate) => candidate.id === providerId);
  const nativeSupported = selectedProvider?.apiKind === "openai-completions";

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
      engine,
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
      if (providerId === provider.id) {
        setProviderId("");
        // The native choice belonged to that provider's API kind; without one there is nothing to
        // validate it against, and leaving it would show a value whose option is disabled.
        setEngine("acp");
      }
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

  async function saveMcpServer(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (busy) return;
    const trimmed = mcpName.trim();
    if (!McpServerName.safeParse(trimmed).success) {
      setMcpError(MCP_NAME_HINT);
      return;
    }
    if (mcpCommand.trim() === "") {
      setMcpError("Command is required");
      return;
    }
    const env = parseEnv(mcpEnv);
    if (env === undefined) {
      setMcpError("Each environment line must be KEY=value");
      return;
    }
    const definition = {
      name: trimmed,
      command: mcpCommand.trim(),
      args: parseArgs(mcpArgs),
      env,
    };
    setBusy(true);
    try {
      if (mcpEditing === undefined) {
        await request("mcp.create", McpServerCreateParams.parse({ ...definition, enabled: true }));
      } else {
        await request("mcp.update", McpServerUpdateParams.parse({ id: mcpEditing, ...definition }));
        // The probe described the old settings; a saved edit invalidates it.
        setMcpProbes((current) => {
          const next = { ...current };
          delete next[mcpEditing];
          return next;
        });
      }
      resetMcpForm();
      await load();
    } catch (saveError) {
      // Keep the typed definition so a rejected name can be corrected without retyping.
      setMcpError(errorMessage(saveError));
    } finally {
      setBusy(false);
    }
  }

  async function setMcpEnabled(server: McpServerView, enabled: boolean): Promise<void> {
    setBusy(true);
    try {
      await request("mcp.update", McpServerUpdateParams.parse({ id: server.id, enabled }));
      setMcpError(undefined);
      await load();
    } catch (updateError) {
      setMcpError(errorMessage(updateError));
    } finally {
      setBusy(false);
    }
  }

  async function removeMcpServer(server: McpServerView): Promise<void> {
    setBusy(true);
    try {
      await request("mcp.delete", McpServerDeleteParams.parse({ id: server.id }));
      // The form may still hold the row that just went away; saving it would fail with not-found.
      if (mcpEditing === server.id) resetMcpForm();
      setMcpProbes((current) => {
        const next = { ...current };
        delete next[server.id];
        return next;
      });
      setMcpError(undefined);
      await load();
    } catch (deleteError) {
      setMcpError(errorMessage(deleteError));
    } finally {
      setBusy(false);
    }
  }

  /** Probes the saved settings: starting the real process is the only honest test of a server. */
  async function testMcpServer(server: McpServerView): Promise<void> {
    setBusy(true);
    try {
      const result = McpTestResult.parse(
        await request(
          "mcp.test",
          McpTestParams.parse({ command: server.command, args: server.args, env: server.env }),
        ),
      );
      setMcpProbes((current) => ({ ...current, [server.id]: result }));
      setMcpError(undefined);
    } catch (testError) {
      setMcpProbes((current) => ({
        ...current,
        [server.id]: { ok: false, tools: [], error: errorMessage(testError) },
      }));
    } finally {
      setBusy(false);
    }
  }

  /** Loads a row into the form; saving then `mcp.update`s it instead of creating a second server. */
  function editMcpServer(server: McpServerView): void {
    setMcpEditing(server.id);
    setMcpName(server.name);
    setMcpCommand(server.command);
    setMcpArgs(argsText(server.args));
    setMcpEnv(envText(server.env));
    setMcpError(undefined);
  }

  function resetMcpForm(): void {
    setMcpEditing(undefined);
    setMcpName("");
    setMcpCommand("");
    setMcpArgs("");
    setMcpEnv("");
    setMcpError(undefined);
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
                <strong>{model.displayName} · {model.engine}</strong>
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
            <select
              aria-label="Provider"
              value={providerId}
              onChange={(event) => {
                const next = event.target.value;
                setProviderId(next);
                // A previously chosen native engine cannot survive a provider switch it cannot use.
                if (providers.find((provider) => provider.id === next)?.apiKind !== "openai-completions") {
                  setEngine("acp");
                }
              }}
            >
              <option value="">Select a provider</option>
              {providers.map((provider) => (
                <option key={provider.id} value={provider.id}>{provider.name}</option>
              ))}
            </select>
          </label>
          <label>
            Engine
            <select
              aria-label="Engine"
              value={engine}
              onChange={(event) => setEngine(event.target.value as EngineKind)}
              disabled={providerId !== "" && !nativeSupported}
            >
              <option value="acp">ACP</option>
              <option value="native" disabled={!nativeSupported}>Native</option>
            </select>
          </label>
          {providerId !== "" && !nativeSupported ? (
            <p className="hint">Native requires an OpenAI-compatible provider</p>
          ) : null}
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

      <section aria-label="MCP Servers">
        <h3>MCP servers</h3>
        <p className="hint">
          Model Context Protocol servers run as local processes. An agent runs only the servers its
          profile selects, and every MCP call passes through that agent&apos;s permission policy.
        </p>
        {mcpError === undefined ? null : <p role="alert">{mcpError}</p>}
        <ul className="setup-list">
          {mcpServers.map((server) => {
            const probe = mcpProbes[server.id];
            return (
              <li key={server.id}>
                <strong>{server.name}</strong>
                <span>{[server.command, ...server.args].join(" ")}</span>
                <label className="setup-inline">
                  <input
                    type="checkbox"
                    checked={server.enabled}
                    disabled={busy}
                    onChange={(event) => void setMcpEnabled(server, event.target.checked)}
                  />
                  Enabled {server.name}
                </label>
                <button type="button" disabled={busy} onClick={() => editMcpServer(server)}>
                  Edit {server.name}
                </button>
                <button type="button" disabled={busy} onClick={() => void testMcpServer(server)}>
                  Test {server.name}
                </button>
                {probe === undefined ? null : probe.ok ? (
                  <span>{probe.tools.length === 1 ? "1 tool" : `${probe.tools.length} tools`}</span>
                ) : (
                  <span className="setup-error">{probe.error ?? "Probe failed"}</span>
                )}
                <button type="button" disabled={busy} onClick={() => void removeMcpServer(server)}>
                  Remove {server.name}
                </button>
              </li>
            );
          })}
        </ul>
        {mcpServers.length === 0 ? <p className="hint">No MCP servers configured.</p> : null}
        <form onSubmit={(event) => void saveMcpServer(event)}>
          <label>
            Server name
            <input
              placeholder="calc"
              value={mcpName}
              onChange={(event) => setMcpName(event.target.value)}
            />
          </label>
          <label>
            Server command
            <input
              placeholder="node"
              value={mcpCommand}
              onChange={(event) => setMcpCommand(event.target.value)}
            />
          </label>
          <label>
            Arguments
            <textarea
              rows={2}
              placeholder="server.js"
              value={mcpArgs}
              onChange={(event) => setMcpArgs(event.target.value)}
            />
          </label>
          <p className="hint">One argument per line, so an argument may contain spaces.</p>
          <label>
            Environment
            <textarea
              rows={3}
              placeholder="KEY=value"
              value={mcpEnv}
              onChange={(event) => setMcpEnv(event.target.value)}
            />
          </label>
          <button type="submit" disabled={busy}>
            {mcpEditing === undefined ? "Add MCP server" : "Save MCP server"}
          </button>
          {mcpEditing === undefined ? null : (
            <button type="button" disabled={busy} onClick={resetMcpForm}>
              Cancel
            </button>
          )}
        </form>
      </section>

      {/* The door is managed from the machine it is on; a paired browser would only see forbidden. */}
      {isBrowser() ? null : <Devices request={request} />}

      <button type="button" className="primary" onClick={onOpenChat} disabled={models.length === 0}>
        Open chat
      </button>
    </section>
  );
}
