import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { startKernel, type Kernel } from "@noir/kernel";

let kernel: Kernel | null = null;
let shuttingDown = false;

/**
 * The supervisor spawns this daemon with no inherited handles — an inherited stdout keeps the
 * launching process's pipe open, so that process cannot tell when the daemon ends. A log path is
 * therefore the only channel out, and a daemon started by hand keeps the console.
 */
const logFile = process.env.NOIR_KERNEL_LOG;

function report(event: Record<string, unknown>): void {
  const line = `${JSON.stringify(event)}\n`;
  if (logFile === undefined) {
    console.log(line.trimEnd());
    return;
  }
  try {
    mkdirSync(dirname(logFile), { recursive: true });
    appendFileSync(logFile, line);
  } catch {
    // A log that cannot be written is not a reason to stop running schedules.
  }
}

function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  void (async () => {
    try {
      await kernel?.close();
    } finally {
      process.exit(signal === "SIGINT" ? 130 : 143);
    }
  })();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

void (async () => {
  try {
    // The kernel has already closed itself by the time this runs; exiting is the daemon's last act.
    kernel = await startKernel({ onShutdown: () => process.exit(0) });
    report({ event: "kernel.ready", port: kernel.port });
  } catch (error) {
    report({ event: "kernel.failed", reason: error instanceof Error ? error.message : String(error) });
    process.exit(1);
  }
})();
