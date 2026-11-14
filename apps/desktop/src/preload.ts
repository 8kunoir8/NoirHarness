import { contextBridge, ipcRenderer } from "electron";

/** What the page needs to draw a caption button: only the maximize glyph depends on it. */
export interface WindowState {
  maximized: boolean;
  fullScreen: boolean;
}

export interface WindowControls {
  minimize(): Promise<void>;
  toggleMaximize(): Promise<WindowState>;
  close(): Promise<void>;
  state(): Promise<WindowState>;
  /** Resolves to the unsubscribe, so a re-render cannot leave a listener behind. */
  onState(listener: (state: WindowState) => void): () => void;
}

const windowControls: WindowControls = {
  minimize: () => ipcRenderer.invoke("window:minimize"),
  toggleMaximize: () => ipcRenderer.invoke("window:toggle-maximize"),
  close: () => ipcRenderer.invoke("window:close"),
  state: () => ipcRenderer.invoke("window:state"),
  onState: (listener) => {
    const handler = (_event: unknown, state: WindowState): void => listener(state);
    ipcRenderer.on("window:changed", handler);
    return () => {
      ipcRenderer.removeListener("window:changed", handler);
    };
  },
};

contextBridge.exposeInMainWorld("noir", {
  kernelInfo: () => ipcRenderer.invoke("kernel:info"),
  openExternal: (url: string) => ipcRenderer.invoke("shell:openExternal", url),
  automationsArmed: (count: number) => ipcRenderer.send("automations:armed", count),
  windowControls,
});
