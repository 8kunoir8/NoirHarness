import { describe, expect, it } from "vitest";
import { RpcFault } from "@noir/protocol";
import { openDb } from "../src/db.js";
import { ProviderService, type Secrets } from "../src/providers.js";

function memorySecrets(): Secrets & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    set: (id, v) => void store.set(id, v),
    get: (id) => store.get(id) ?? null,
    delete: (id) => void store.delete(id),
  };
}

describe("ProviderService", () => {
  it("stores the key in secrets and never returns it", () => {
    const db = openDb(":memory:");
    const secrets = memorySecrets();
    const service = new ProviderService(db, secrets);
    const created = service.create({ name: "Local", baseUrl: "http://localhost:11434/v1", apiKind: "openai-completions", apiKey: "sk-secret", enabled: true });
    expect(created.hasKey).toBe(true);
    expect(JSON.stringify(created)).not.toContain("sk-secret");
    expect(secrets.store.get(created.id)).toBe("sk-secret");
  });

  it("rejects a duplicate provider name", () => {
    const db = openDb(":memory:");
    const service = new ProviderService(db, memorySecrets());
    const p = { name: "Dup", baseUrl: "http://x/v1", apiKind: "openai-completions" as const, apiKey: "k", enabled: true };
    service.create(p);
    expect(() => service.create(p)).toThrow(RpcFault);
  });

  it("deletes the row and the secret together", () => {
    const db = openDb(":memory:");
    const secrets = memorySecrets();
    const service = new ProviderService(db, secrets);
    const p = service.create({ name: "D", baseUrl: "http://x/v1", apiKind: "openai-completions", apiKey: "k", enabled: true });
    service.remove(p.id);
    expect(service.list()).toEqual([]);
    expect(secrets.store.has(p.id)).toBe(false);
  });

  it("preserves unicode and spaces in names", () => {
    const db = openDb(":memory:");
    const service = new ProviderService(db, memorySecrets());
    const p = service.create({ name: "Ünïcode Provider", baseUrl: "http://x/v1", apiKind: "openai-completions", apiKey: "k", enabled: true });
    expect(service.list()[0]!.name).toBe("Ünïcode Provider");
  });
});
