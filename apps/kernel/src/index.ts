import { startKernel } from "@noir/kernel";

void (async () => {
  const kernel = await startKernel();
  const shutdown = async () => {
    await kernel.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  console.log(JSON.stringify({ event: "kernel.ready", port: kernel.port }));
})();
