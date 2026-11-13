import { join } from "node:path";
import { app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeImage, shell } from "electron";
import { hostKernel, type HostedKernel } from "./kernelHost.js";
import { packagedKernelEntry, packagedNodeBinary } from "./packagedPaths.js";
import { armedLabel, trayMenu, type TrayActions } from "./tray.js";

const dataDir = process.env.NOIR_DATA_DIR ?? app.getPath("userData");
const packaged = app.isPackaged;
const kernelEntry = process.env.NOIR_KERNEL_ENTRY
  ?? (packaged ? packagedKernelEntry(process.resourcesPath) : join(app.getAppPath(), "..", "kernel", "dist", "index.cjs"));
const nodeBin = process.env.NOIR_NODE_BIN
  ?? (packaged ? packagedNodeBinary(process.resourcesPath) : process.env.npm_node_execpath ?? "node");

let hosted: HostedKernel | undefined;
let mainWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let armed = 0;
let quitting = false;

async function createWindow(): Promise<void> {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: "#f4efe6",
    webPreferences: { preload: join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false },
  });
  mainWindow = win;
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = undefined;
  });
  win.on("close", (event) => {
    // The daemon outlives the window, so a close is not a quit while a tray can bring it back.
    if (quitting || tray === undefined) return;
    event.preventDefault();
    win.hide();
  });
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) await win.loadURL(devUrl);
  else await win.loadFile(join(__dirname, "renderer", "index.html"));
}

function showWindow(): void {
  if (mainWindow === undefined) {
    void createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/** Asks the daemon to stop through its own control plane. A failure leaves it to die with us. */
async function stopHosted(): Promise<void> {
  if (hosted === undefined) return;
  const { port, token } = hosted;
  hosted = undefined;
  await fetch(`http://127.0.0.1:${String(port)}/shutdown`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", connection: "close" },
    body: JSON.stringify({ force: true }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => undefined);
}

function quitNow(): void {
  quitting = true;
  app.quit();
}

function createTray(): void {
  // Embedded so packaging cannot miss it and a missing asset cannot break startup.
  const icon = nativeImage.createFromDataURL(
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAIklEQVR4nGNgGDTgxb1j/0nBNDVgFQE8asDIMGCAUuKAAQB49+kANVznbgAAAABJRU5ErkJggg==",
  );
  try {
    tray = new Tray(icon.resize({ width: 16, height: 16 }));
  } catch {
    // No tray in this session (headless Linux, a locked-down desktop): the window keeps its quit.
    tray = undefined;
    return;
  }
  const actions: TrayActions = {
    show: showWindow,
    quit: quitNow,
    quitAndStop: () => {
      void stopHosted().finally(quitNow);
    },
  };
  const rebuild = (): void => {
    tray?.setContextMenu(Menu.buildFromTemplate(trayMenu(armed, actions)));
    tray?.setToolTip(armedLabel(armed));
  };
  rebuild();
  tray.on("click", showWindow);
  ipcMain.on("automations:armed", (_event, count: unknown) => {
    armed = typeof count === "number" ? count : 0;
    rebuild();
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", showWindow);

  app.whenReady().then(async () => {
    hosted = await hostKernel(
      { dataDir, kernelEntry, nodeBin },
      {
        promptBusy: async (live) => {
          // The only question the daemon ever asks: replacing an idle build is silent.
          const choice = dialog.showMessageBoxSync({
            type: "question",
            buttons: ["Stop and restart", "Keep the old build"],
            defaultId: 1,
            cancelId: 1,
            message: live === 1 ? "A turn is running on an older kernel." : `${String(live)} turns are running on an older kernel.`,
            detail: "Restarting stops them. Keeping the old build runs this window against it until you restart later.",
          });
          return choice === 0 ? "stop" : "keep";
        },
      },
    ).catch((error: unknown) => {
      // The window still opens: the banner says nothing survives it.
      console.error("Kernel failed to start:", error instanceof Error ? error.message : error);
      return undefined;
    });
    ipcMain.handle("kernel:info", () => {
      if (hosted === undefined) throw new Error("Kernel did not start");
      return { port: hosted.port, token: hosted.token, buildMatches: hosted.buildMatches, daemon: hosted.daemon };
    });
    // The renderer never touches Electron directly; only these protocols may leave the app.
    ipcMain.handle("shell:openExternal", async (_event, raw: unknown) => {
      if (typeof raw !== "string") throw new Error("invalid url");
      let url: URL;
      try {
        url = new URL(raw);
      } catch {
        throw new Error("invalid url");
      }
      if (!["http:", "https:", "mailto:"].includes(url.protocol)) throw new Error("blocked url");
      await shell.openExternal(url.toString());
    });
    await createWindow();
    createTray();
    app.on("activate", showWindow);
  });

  app.on("before-quit", () => {
    // The window's `close` handler decides whether a close is a hide; this only opens the gate.
    quitting = true;
  });
  app.on("window-all-closed", () => {
    // With a tray the window never truly closes, so this fires only when nothing can reopen it.
    if (tray === undefined && process.platform !== "darwin") app.quit();
  });
}
