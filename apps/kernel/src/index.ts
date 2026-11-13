import { startKernel, type Kernel } from "@noir/kernel";

let kernel: Kernel | null = null;
let shuttingDown = false;

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
    console.log(JSON.stringify({ event: "kernel.ready", port: kernel.port }));
  } catch (error) {
    console.log(JSON.stringify({ event: "kernel.failed", reason: error instanceof Error ? error.message : String(error) }));
    process.exit(1);
  }
})();
