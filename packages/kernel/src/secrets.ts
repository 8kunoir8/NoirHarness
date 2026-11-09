import { Entry } from "@napi-rs/keyring";

export interface Secrets {
  set(id: string, value: string): void;
  get(id: string): string | null;
  delete(id: string): void;
}

export class KeyringSecrets implements Secrets {
  private entry(id: string): Entry { return new Entry("NoirHarness", id); }
  set(id: string, value: string): void { this.entry(id).setPassword(value); }
  get(id: string): string | null { try { return this.entry(id).getPassword(); } catch { return null; } }
  delete(id: string): void { try { this.entry(id).deletePassword(); } catch { /* already absent */ } }
}
