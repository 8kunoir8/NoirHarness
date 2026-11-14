import { ADAPTER_VERSION } from "@noir/engine-acp";
import { ADAPTER_VERSION as NATIVE_ADAPTER_VERSION } from "@noir/engine-native";
import type { EngineKind } from "@noir/protocol";

const ENGINE_PROVENANCE: Record<EngineKind, { engineName: string; adapterVersion: string }> = {
  acp: { engineName: "omp", adapterVersion: ADAPTER_VERSION },
  native: { engineName: "native", adapterVersion: NATIVE_ADAPTER_VERSION },
};

/** What the session's engine stamps on the events the kernel appends for it. */
export function provenanceFor(engine: EngineKind): { engine: EngineKind; engineName: string; adapterVersion: string } {
  switch (engine) {
    case "native":
      return { engine, ...ENGINE_PROVENANCE.native };
    default:
      return { engine: "acp", ...ENGINE_PROVENANCE.acp };
  }
}
