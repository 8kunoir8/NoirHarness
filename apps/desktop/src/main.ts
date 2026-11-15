import { appendFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { app, BrowserWindow, Menu, Notification, Tray, dialog, ipcMain, nativeImage, shell, type IpcMainInvokeEvent } from "electron";
import { KernelEvents } from "./kernelEvents.js";
import { hostKernel, probeHealth, type HostedKernel } from "./kernelHost.js";
import type { NotificationSink } from "./notifications.js";
import { packagedKernelEntry, packagedNodeBinary, packagedRendererRoot } from "./packagedPaths.js";
import { readSettings, writeSettings } from "./settings.js";
import { Supervision } from "./supervision.js";
import { armedLabel, trayMenu, type TrayActions } from "./tray.js";

const dataDir = process.env.NOIR_DATA_DIR ?? app.getPath("userData");
const packaged = app.isPackaged;
const kernelEntry = process.env.NOIR_KERNEL_ENTRY
  ?? (packaged ? packagedKernelEntry(process.resourcesPath) : join(app.getAppPath(), "..", "kernel", "dist", "index.cjs"));
const rendererRoot = packaged ? packagedRendererRoot(process.resourcesPath) : join(app.getAppPath(), "dist", "renderer");
const nodeBin = process.env.NOIR_NODE_BIN
  ?? (packaged ? packagedNodeBinary(process.resourcesPath) : process.env.npm_node_execpath ?? "node");

// Windows groups a window, its taskbar entry and its notifications by AppUserModelID, and
// electron-builder stamps the Start-menu shortcut with `appId` (electron-builder.yml). The running
// process has to claim the same id: without it the shell finds no entry to borrow the app's name and
// icon from and shows the generic Electron identity instead.
app.setAppUserModelId("dev.noirharness.app");

let hosted: HostedKernel | undefined;
let mainWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let armed = 0;
let quitting = false;
let settings = readSettings(dataDir);
let supervisor: Supervision | undefined;
let witness: KernelEvents | undefined;

const notifyLogPath = process.env.NOIR_NOTIFY_LOG;

const quitLogPath = process.env.NOIR_QUIT_LOG;

/**
 * One line per step of the app's own shutdown, appended to `NOIR_QUIT_LOG` when that is set.
 *
 * Electron's exit is not observable from the outside on every platform, so "did this app really
 * quit, or did it merely hide its window" has no evidence without this. The e2e asserts these
 * lines; the window's close handler and `app.quit()` are the two things under test, and both are
 * inside the process.
 */
const quitLog = (step: string): void => {
  if (quitLogPath === undefined || quitLogPath === "") return;
  try {
    appendFileSync(quitLogPath, `${step}\n`);
  } catch {
    // A log that cannot be written must not change what it is logging.
  }
};

/**
 * A run that finished with no window open has to say so somewhere. When a log path is set the line
 * goes there as well, so an e2e can prove the notification without a notification daemon.
 */
const notifySink: NotificationSink = {
  show(title, body) {
    if (notifyLogPath !== undefined && notifyLogPath !== "") {
      try {
        appendFileSync(notifyLogPath, `${JSON.stringify({ title, body })}\n`);
      } catch {
        // A log that cannot be written must not take the notification with it.
      }
    }
    if (!Notification.isSupported()) return;
    const notification = new Notification({ title, body });
    notification.on("click", showWindow);
    notification.show();
  },
};

async function createWindow(): Promise<void> {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: "#f4efe6",
    // The page draws its own caption row: the window has one surface from edge to edge, and the
    // buttons follow the app's theme instead of the OS one. `thickFrame` keeps the resize border
    // and the snap/maximize animations that a frameless Windows window otherwise loses.
    frame: false,
    thickFrame: true,
    webPreferences: { preload: join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false },
  });
  mainWindow = win;
  /** The page's maximize glyph is the only thing it cannot read from its own state. */
  const announceState = (): void => {
    if (win.isDestroyed()) return;
    win.webContents.send("window:changed", { maximized: win.isMaximized(), fullScreen: win.isFullScreen() });
  };
  win.on("maximize", announceState);
  win.on("unmaximize", announceState);
  win.on("enter-full-screen", announceState);
  win.on("leave-full-screen", announceState);
  win.on("closed", () => {
    quitLog("window:closed");
    if (mainWindow === win) mainWindow = undefined;
  });
  win.on("close", (event) => {
    // The daemon outlives the window, so a close is not a quit while a tray can bring it back.
    const hiding = !quitting && tray !== undefined;
    quitLog(`window:close ${hiding ? "hide" : "quit"}`);
    if (!hiding) return;
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

/**
 * With a tray a closed window is hidden, so only the tray can end the app — and an automated run
 * has no tray row to click. `NOIR_NO_TRAY=1` takes the no-tray path, where close means quit.
 */
const trayDisabled = process.env.NOIR_NO_TRAY === "1";

function createTray(): void {
  if (trayDisabled) return;
  // Embedded so packaging cannot miss it and a missing asset cannot break startup. The source is
  // `build/icon.png` reduced to 16x16 and quantized to 32 colours, which is all a tray row shows.
  const icon = nativeImage.createFromDataURL(
    "data:image/png;base64," +
      "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAMAAAAoLQ9TAAAAYFBMVEXd3+6sq8Bxn7iNiKQpd7GIYZ9MYJQpXJcS" +
      "YKCGP55bRoNESpBBNoAoT5ELTn8bO28KOHJ9Kn1hKYFOG1EkJmM0GVAtDy8QJkQPIEsJFCsJBRgCAQICAAEAAgIA" +
      "AAEAAACKAnPRAAAAvElEQVR42h1QCQ6EMAikay9t6eVRa1X+/8ulTkIgE5gBgOjt9NCHmwNGUV1M274e1Jl4n9bM" +
      "ib8f7vNg4KGKRgOA2kreewdqCeUiQE9mWSvdQEFKM03C+eAWs7NGi1wJEHrL3q3s0le0J4aUTlfiRdCpShtC8n6z" +
      "s386j9hoAqI0fvH5eIGqjZKhlRK5DI0ma0jWuDLPZR5EwIkhhBgps201Tvvlg1Lc8VI7E6IfE3webzpOv9q5H9c9" +
      "HvAHpIsRT9CQUz4AAAAASUVORK5CYII=",
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
      // Stop watching before stopping the daemon, or the supervisor reads its absence as a crash.
      supervisor?.stop();
      witness?.stop();
      void stopHosted().finally(quitNow);
    },
    openAtLogin: () => settings.openAtLogin,
    setOpenAtLogin: (on) => {
      settings = { ...settings, openAtLogin: on };
      writeSettings(dataDir, settings);
      app.setLoginItemSettings({ openAtLogin: on, args: [] });
      rebuild();
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

  const startKernel = (): Promise<HostedKernel> =>
    hostKernel(
      { dataDir, kernelEntry, nodeBin, webRoot: rendererRoot, appVersion: app.getVersion() },
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
    );

  /** Sixteen seconds of retry backoff is longer than the thing it waits for is worth. */
  const startWitness = (kernel: HostedKernel): void => {
    witness?.stop();
    witness = new KernelEvents({ port: kernel.port, token: kernel.token, sink: notifySink });
    witness.start();
  };

  void app.whenReady().then(async () => {
    hosted = await startKernel().catch((error: unknown) => {
      // The window still opens: the banner says nothing survives it.
      console.error("Kernel failed to start:", error instanceof Error ? error.message : error);
      return undefined;
    });
    if (hosted !== undefined) startWitness(hosted);
    // Stored value wins over whatever the OS thinks: a reinstall must not resurrect a choice.
    app.setLoginItemSettings({ openAtLogin: settings.openAtLogin, args: [] });

    supervisor = new Supervision({
      probe: async () => {
        if (hosted === undefined) return false;
        const health = await probeHealth(hosted.port, 2_000);
        // A different pid is a kernel someone else started; the respawn path adopts it.
        return health !== null && health.pid === hosted.pid;
      },
      respawn: async () => {
        hosted = await startKernel();
        startWitness(hosted);
        // The window holds the old port and token; without a reload it would stay disconnected.
        mainWindow?.webContents.reload();
      },
      onState: (state) => {
        if (state.alive) {
          tray?.setToolTip(armedLabel(armed));
          return;
        }
        tray?.setToolTip(state.error === undefined ? "Kernel not answering" : `Kernel not running: ${state.error}`);
      },
    });
    supervisor.start();
    ipcMain.handle("kernel:info", () => {
      if (hosted === undefined) throw new Error("Kernel did not start");
      return { port: hosted.port, token: hosted.token, buildMatches: hosted.buildMatches, daemon: hosted.daemon, buildId: hosted.buildId };
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
    // A reveal names a workspace root plus a relative path; the join and the escape check happen
    // here so the page cannot hand the shell an absolute path of its own choosing.
    ipcMain.handle("shell:revealInFolder", async (_event, rawRoot: unknown, rawPath: unknown) => {
      if (typeof rawRoot !== "string" || typeof rawPath !== "string") throw new Error("invalid path");
      const root = resolve(rawRoot);
      const target = resolve(root, rawPath);
      const step = relative(root, target);
      if (step === "" || step.startsWith("..") || isAbsolute(step)) throw new Error("path leaves the workspace");
      await stat(target).catch(() => {
        throw new Error("path not found");
      });
      shell.showItemInFolder(target);
    });
    // Adding a project is a directory choice, so the OS picker is the honest control: the page
    // cannot enumerate the disk, and a typed path is a guess the kernel then has to reject.
    ipcMain.handle("dialog:pickFolder", async (event) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      const options = { properties: ["openDirectory" as const], title: "Choose a project folder" };
      const result = win === null ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(win, options);
      return result.canceled ? null : (result.filePaths[0] ?? null);
    });
    // The caption buttons live in the page, so the page needs these four verbs. Each call resolves
    // its own window from the sender: a reload or a second window can never target the wrong one.
    const windowOf = (event: IpcMainInvokeEvent): BrowserWindow => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (win === null) throw new Error("no window for this sender");
      return win;
    };
    // Both replies carry the same shape the preload's `WindowState` promises; keep them literal so a
    // field added to one cannot silently diverge from the other.
    ipcMain.handle("window:minimize", (event) => {
      windowOf(event).minimize();
    });
    ipcMain.handle("window:toggle-maximize", (event) => {
      const win = windowOf(event);
      // In full screen the maximize glyph means "leave full screen": maximizing under a full-screen
      // window would move nothing the user can see.
      if (win.isFullScreen()) win.setFullScreen(false);
      else if (win.isMaximized()) win.unmaximize();
      else win.maximize();
      return { maximized: win.isMaximized(), fullScreen: win.isFullScreen() };
    });
    // `close`, never `hide`: the window's own close handler decides whether a tray turns it into a
    // hide, so a custom button cannot diverge from the titlebar it replaced.
    ipcMain.handle("window:close", (event) => {
      windowOf(event).close();
    });
    ipcMain.handle("window:state", (event) => {
      const win = windowOf(event);
      return { maximized: win.isMaximized(), fullScreen: win.isFullScreen() };
    });
    await createWindow();
    createTray();
    app.on("activate", showWindow);
  });

  app.on("before-quit", () => {
    // The window's `close` handler decides whether a close is a hide; this only opens the gate.
    quitLog("app:before-quit");
    quitting = true;
    supervisor?.stop();
    witness?.stop();
  });
  app.on("window-all-closed", () => {
    // With a tray the window never truly closes, so this fires only when nothing can reopen it.
    quitLog("app:window-all-closed");
    if (tray === undefined && process.platform !== "darwin") app.quit();
  });
  app.on("will-quit", () => {
    // Not prevented anywhere in this app: a line here without `app:quit` would name a real hang.
    quitLog("app:will-quit");
  });
  app.on("quit", () => {
    quitLog("app:quit");
  });
}
