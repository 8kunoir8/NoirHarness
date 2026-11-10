import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { app, BrowserWindow, ipcMain } from "electron";
import { packagedKernelEntry, packagedNodeBinary } from "./packagedPaths.js";

interface KernelInfo {
  port: number;
  token: string;
}

function runtimeFilePath(dir: string): string {
  return join(dir, "runtime", "kernel.json");
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readRuntimeFile(file: string): { pid: number; port: number; token: string } | null {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { pid?: unknown; port?: unknown; token?: unknown };
    if (typeof parsed.pid !== "number" || typeof parsed.port !== "number" || typeof parsed.token !== "string") return null;
    return { pid: parsed.pid, port: parsed.port, token: parsed.token };
  } catch {
    return null;
  }
}

const dataDir = process.env.NOIR_DATA_DIR ?? app.getPath("userData");
const packaged = app.isPackaged;
const kernelEntry = process.env.NOIR_KERNEL_ENTRY
  ?? (packaged ? packagedKernelEntry(process.resourcesPath) : join(app.getAppPath(), "..", "kernel", "dist", "index.cjs"));
const nodeBin = process.env.NOIR_NODE_BIN
  ?? (packaged ? packagedNodeBinary(process.resourcesPath) : process.env.npm_node_execpath ?? "node");

let kernel: ChildProcess | undefined;
let info: KernelInfo | undefined;
let kernelFailure: Error | undefined;
let kernelReady = false;

async function waitForKernel(file: string, timeoutMs = 20_000): Promise<KernelInfo> {
  const started = Date.now();
  for (;;) {
    if (kernelFailure) throw kernelFailure;
    const current = readRuntimeFile(file);
    if (current && isProcessAlive(current.pid)) {
      kernelReady = true;
      return { port: current.port, token: current.token };
    }
    if (Date.now() - started > timeoutMs) throw new Error("Kernel did not start");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function startKernel(): Promise<KernelInfo> {
  mkdirSync(dataDir, { recursive: true });
  const child = spawn(nodeBin, [kernelEntry], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", NOIR_DATA_DIR: dataDir },
    stdio: ["ignore", "inherit", "inherit"],
  });
  kernel = child;
  kernelFailure = undefined;
  child.once("error", (error) => {
    kernelFailure = new Error(`Kernel process failed to start: ${error.message}`);
  });
  child.once("exit", (code, signal) => {
    if (!kernelReady) {
      kernelFailure = new Error(`Kernel exited before it became ready (code ${code ?? "null"}, signal ${signal ?? "null"})`);
    }
  });
  return waitForKernel(runtimeFilePath(dataDir));
}

async function createWindow(): Promise<void> {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: "#f4efe6",
    webPreferences: { preload: join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false },
  });
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) await win.loadURL(devUrl);
  else await win.loadFile(join(__dirname, "renderer", "index.html"));
}

app.whenReady().then(async () => {
  try {
    info = await startKernel();
  } catch (error) {
    console.error("Kernel failed to start:", error instanceof Error ? error.message : error);
  }
  ipcMain.handle("kernel:info", () => {
    if (!info) throw new Error("Kernel did not start");
    return info;
  });
  await createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on("before-quit", () => {
  kernel?.kill();
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
