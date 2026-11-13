import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, readSettings, settingsPath, writeSettings } from "../src/settings.js";
import { Supervision, type SupervisionState } from "../src/supervision.js";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "noir settings "));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("desktop settings", () => {
  it("starts closed and round-trips a choice", () => {
    const dir = tempDir();
    expect(readSettings(dir)).toEqual(DEFAULT_SETTINGS);
    writeSettings(dir, { openAtLogin: true });
    expect(readSettings(dir)).toEqual({ openAtLogin: true });
    expect(settingsPath(dir).endsWith("desktop.json")).toBe(true);
  });

  it("reads a corrupt file as the defaults rather than failing a launch", () => {
    const dir = tempDir();
    writeFileSync(settingsPath(dir), "{ not json");
    expect(readSettings(dir)).toEqual(DEFAULT_SETTINGS);
    writeFileSync(settingsPath(dir), JSON.stringify({ openAtLogin: "yes" }));
    expect(readSettings(dir)).toEqual(DEFAULT_SETTINGS);
  });
});

function harness(options: { alive: boolean[]; failRespawn?: boolean; now?: () => number }) {
  const states: SupervisionState[] = [];
  const calls = { probes: 0, respawns: 0 };
  const supervision = new Supervision({
    probe: async () => {
      calls.probes += 1;
      return options.alive[calls.probes - 1] ?? false;
    },
    respawn: async () => {
      calls.respawns += 1;
      if (options.failRespawn === true) throw new Error("spawn failed");
    },
    onState: (state) => states.push(state),
    misses: 2,
    cooldownMs: 60_000,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return { supervision, states, calls };
}

describe("supervision", () => {
  it("does nothing on the first miss, because one slow answer is not a dead kernel", async () => {
    const { supervision, calls, states } = harness({ alive: [false] });
    await supervision.tick();
    expect(calls.respawns).toBe(0);
    expect(states.at(-1)).toEqual({ alive: false, misses: 1 });
  });

  it("restarts on the second consecutive miss and clears the count", async () => {
    const { supervision, calls, states } = harness({ alive: [false, false] });
    await supervision.tick();
    await supervision.tick();
    expect(calls.respawns).toBe(1);
    expect(states.at(-1)).toEqual({ alive: true, misses: 0 });
  });

  it("forgets the count once the kernel answers again", async () => {
    const { supervision, calls } = harness({ alive: [false, true, false] });
    await supervision.tick();
    await supervision.tick();
    await supervision.tick();
    expect(calls.respawns).toBe(0);
  });

  it("waits out the cooldown instead of spawning in a loop", async () => {
    let clock = 1_000_000;
    const { supervision, calls, states } = harness({ alive: [false, false, false, false, false], now: () => clock });
    await supervision.tick();
    await supervision.tick();
    expect(calls.respawns).toBe(1);
    clock += 1_000;
    await supervision.tick();
    await supervision.tick();
    expect(calls.respawns).toBe(1);
    expect(states.at(-1)?.error).toContain("too often");
  });

  it("reports a spawn that failed rather than pretending the kernel is back", async () => {
    const { supervision, states } = harness({ alive: [false, false], failRespawn: true });
    await supervision.tick();
    await supervision.tick();
    expect(states.at(-1)).toEqual({ alive: false, misses: 2, error: "spawn failed" });
  });

  it("does not let a slow poll stack on the next interval", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls = { probes: 0 };
    const supervision = new Supervision({
      probe: async () => {
        calls.probes += 1;
        await gate;
        return true;
      },
      respawn: async () => undefined,
      misses: 2,
    });
    const first = supervision.tick();
    await supervision.tick();
    expect(calls.probes).toBe(1);
    release?.();
    await first;
  });
});
