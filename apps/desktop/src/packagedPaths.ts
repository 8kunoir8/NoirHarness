import { join } from "node:path";

/** Absolute path of the bundled kernel entry copied into the packaged app's resources. */
export function packagedKernelEntry(resourcesPath: string): string {
  return join(resourcesPath, "kernel", "dist", "index.cjs");
}

/** Absolute path of the built renderer copy a paired browser is served from. */
export function packagedRendererRoot(resourcesPath: string): string {
  return join(resourcesPath, "renderer");
}

/** Absolute path of the Node runtime shipped next to the packaged kernel. */
export function packagedNodeBinary(resourcesPath: string, platform: NodeJS.Platform = process.platform): string {
  return join(resourcesPath, "runtime", platform === "win32" ? "node.exe" : "node");
}
