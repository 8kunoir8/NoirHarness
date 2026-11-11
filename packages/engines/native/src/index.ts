/**
 * The native engine: an OpenAI-compatible chat-completions loop that owns tool execution.
 *
 * It speaks the same `Engine` contract as the ACP adapter, so the kernel selects it per session
 * without changing the event stream it consumes.
 */
export { NativeEngine, createNativeEngine, nativeEngine } from "./loop.js";
export {
  reconstructHistory,
  type HistoryEvent,
  type HistoryLimits,
  type ReconstructedHistory,
} from "./history.js";
export {
  NATIVE_TOOLS,
  PERMISSION_DENIED,
  readMaterializedSkill,
  runTool,
  toolKind,
  toolTitle,
  type ToolContext,
} from "./tools.js";
export { ProviderHttpError, streamChat } from "./client.js";
export { parseSseChunks } from "./sse.js";

/** Provenance version stamped on turns this engine produces. Keep in sync with package.json. */
export const ADAPTER_VERSION = "0.0.0";
