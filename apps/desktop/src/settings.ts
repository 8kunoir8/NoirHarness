import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface DesktopSettings {
  /** Start with the machine, so a 06:00 schedule has a kernel to fire on. */
  openAtLogin: boolean;
}

export const DEFAULT_SETTINGS: DesktopSettings = { openAtLogin: false };

export function settingsPath(dataDir: string): string {
  return join(dataDir, "desktop.json");
}

/** A missing or unreadable file is the defaults: startup must not fail because of a preference. */
export function readSettings(dataDir: string): DesktopSettings {
  try {
    const raw: unknown = JSON.parse(readFileSync(settingsPath(dataDir), "utf8"));
    if (typeof raw !== "object" || raw === null) return { ...DEFAULT_SETTINGS };
    const value = Object.getOwnPropertyDescriptor(raw, "openAtLogin")?.value;
    return { openAtLogin: value === true };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function writeSettings(dataDir: string, settings: DesktopSettings): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(settingsPath(dataDir), `${JSON.stringify(settings, null, 2)}\n`);
}
