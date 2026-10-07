const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("ipinfo", {
  check: (ip) => ipcRenderer.invoke("ipinfo:check", ip),
  copy: (text) => ipcRenderer.invoke("ipinfo:copy", text),
  open: (host) => ipcRenderer.invoke("ipinfo:open", host),
  settings: () => ipcRenderer.invoke("ipinfo:settings"),
  saveSettings: (value) => ipcRenderer.invoke("ipinfo:save-settings", value),
});
