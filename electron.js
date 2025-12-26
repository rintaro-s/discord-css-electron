import {app} from "electron";
import path from "node:path";
import {pathToFileURL} from "node:url";

// Electron entrypoint. Loads compiled main process.
const mainPath = path.join(app.getAppPath(), "dist", "main.js");
await import(pathToFileURL(mainPath).toString());
