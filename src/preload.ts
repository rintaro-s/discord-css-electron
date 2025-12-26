import {contextBridge, ipcRenderer} from "electron";

type ThemeMeta = {
    name?: string;
    description?: string;
    author?: string;
    version?: string;
};

type ThemeInfo = {
    filename: string;
    meta: ThemeMeta;
};

contextBridge.exposeInMainWorld("siscord", {
    listThemes: (): Promise<ThemeInfo[]> => ipcRenderer.invoke("siscord:listThemes"),
    getActiveTheme: (): Promise<string | null> => ipcRenderer.invoke("siscord:getActiveTheme"),
    setActiveTheme: (filename: string | null): Promise<boolean> => ipcRenderer.invoke("siscord:setActiveTheme", filename),
    importTheme: (): Promise<{importedFilename: string} | null> => ipcRenderer.invoke("siscord:importTheme")
});

export {}; // ensure this file is treated as a module
