import { startKernel as startKernelReal, type Kernel } from "../src/index.js";
import type { Secrets } from "../src/secrets.js";

/**
 * Tests own their key store: the real one is the OS vault, which is shared machine state — a suite
 * that writes there leaks credentials and fails once it fills up.
 */
export function memorySecrets(): Secrets {
  const store = new Map<string, string>();
  return {
    set: (id, value) => void store.set(id, value),
    get: (id) => store.get(id) ?? null,
    delete: (id) => void store.delete(id),
  };
}

/** `startKernel` with an in-memory key store. Share one `secrets` to model a restart. */
export function startKernel(opts: { dataDir?: string; secrets?: Secrets } = {}): Promise<Kernel> {
  return startKernelReal({ ...opts, secrets: opts.secrets ?? memorySecrets() });
}
