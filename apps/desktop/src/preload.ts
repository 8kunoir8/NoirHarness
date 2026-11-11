import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("noir", {
  kernelInfo: () => ipcRenderer.invoke("kernel:info"),
  openExternal: (url: string) => ipcRenderer.invoke("shell:openExternal", url),
});
