import { homedir } from "node:os";
import { join } from "node:path";

export function dataDir(): string {
  const override = process.env.NOIR_DATA_DIR;
  if (override) return override;
  const home = homedir();
  if (process.platform === "win32") return join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "NoirHarness");
  if (process.platform === "darwin") return join(home, "Library", "Application Support", "NoirHarness");
  return join(process.env.XDG_DATA_HOME ?? join(home, ".local", "share"), "noirharness");
}
