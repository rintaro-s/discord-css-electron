const {contextBridge, ipcRenderer} = require('electron');

contextBridge.exposeInMainWorld('siscord', {
  listThemes: () => ipcRenderer.invoke('siscord:listThemes'),
  getActiveTheme: () => ipcRenderer.invoke('siscord:getActiveTheme'),
  setActiveTheme: (filename) => ipcRenderer.invoke('siscord:setActiveTheme', filename ?? null),
  importTheme: () => ipcRenderer.invoke('siscord:importTheme'),
  getThemeVariables: (filename) => ipcRenderer.invoke('siscord:getThemeVariables', filename),
  setThemeVariables: (filename, vars) => ipcRenderer.invoke('siscord:setThemeVariables', filename, vars),
  extractThemeVariables: (filename) => ipcRenderer.invoke('siscord:extractThemeVariables', filename)
});
