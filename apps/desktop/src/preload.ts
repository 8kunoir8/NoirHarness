import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("noir", {
  kernelInfo: () => ipcRenderer.invoke("kernel:info"),
});
