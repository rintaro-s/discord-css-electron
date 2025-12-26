import {app, BrowserWindow, dialog, ipcMain, Menu, session} from "electron";
import path from "node:path";
import fs from "node:fs/promises";
import {existsSync} from "node:fs";

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

type Settings = {
    activeThemeFilename: string | null;
};

type ThemeVariables = Record<string, string>;

type SettingsWithVariables = Settings & {
    themeVariables: Record<string, ThemeVariables>; // { [themeFilename]: { --var-name: value } }
};

const DISCORD_URL = "https://discord.com/app";

const DEBUG = process.env.SISCORD_DEBUG === "1";

function debugLog(...args: unknown[]) {
    if (!DEBUG) return;
    // eslint-disable-next-line no-console
    console.log("[Siscord]", ...args);
}

function getUserDataPath(...segments: string[]) {
    return path.join(app.getPath("userData"), ...segments);
}

function getThemesDir() {
    return getUserDataPath("themes");
}

async function ensureDirs() {
    await fs.mkdir(getThemesDir(), {recursive: true});
}

async function readSettings(): Promise<SettingsWithVariables> {
    const settingsPath = getUserDataPath("settings.json");
    try {
        const raw = await fs.readFile(settingsPath, "utf8");
        const parsed = JSON.parse(raw) as Partial<SettingsWithVariables>;
        return {
            activeThemeFilename: parsed.activeThemeFilename ?? null,
            themeVariables: parsed.themeVariables ?? {}
        };
    }
    catch {
        return {activeThemeFilename: null, themeVariables: {}};
    }
}

async function writeSettings(settings: SettingsWithVariables): Promise<void> {
    const settingsPath = getUserDataPath("settings.json");
    await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2), "utf8");
}

function parseBetterDiscordThemeMeta(cssText: string): ThemeMeta {
    // BetterDiscord themes typically include a JSDoc-like header:
    // /**
    //  * @name ...
    //  * @description ...
    //  * @author ...
    //  * @version ...
    //  */
    const meta: ThemeMeta = {};
    const headerMatch = cssText.match(/^\s*\/\*\*([\s\S]*?)\*\/\s*/);
    if (!headerMatch) return meta;

    const header = headerMatch[1];
    const lines = header.split(/\r?\n/);
    for (const line of lines) {
        const m = line.match(/@([a-zA-Z]+)\s+(.+)/);
        if (!m) continue;
        const key = m[1].toLowerCase();
        const value = m[2].trim();
        if (key === "name") meta.name = value;
        else if (key === "description") meta.description = value;
        else if (key === "author") meta.author = value;
        else if (key === "version") meta.version = value;
    }

    return meta;
}

function sanitizeThemeCss(cssText: string): string {
    // Safety-biased: only CSS is injected, but we also strip constructs that can pull remote resources
    // or look like non-CSS payloads. This is not a security boundary; it is a compatibility filter.

    // If the file obviously contains JS/non-CSS payload, skip entirely.
    // (Some malicious or mispackaged "themes" append JS.)
    if (/(\bBdApi\b|\brequire\s*\(|\bmodule\.exports\b|webpackChunkdiscord_app|<\s*script\b)/i.test(cssText)) {
        return "";
    }

    // Remove any embedded HTML/script tags if present (some malformed files can contain them).
    cssText = cssText.replace(/<\/?script\b[^>]*>/gi, "");
    cssText = cssText.replace(/<\/?style\b[^>]*>/gi, "");

    // Drop obviously dangerous URL schemes and legacy JS-in-CSS constructs.
    cssText = cssText.replace(/url\(\s*(['"])?\s*javascript:[^)]*\)/gmi, "");
    cssText = cssText.replace(/expression\s*\(/gmi, "");

    // Drop legacy IE behavior property.
    cssText = cssText.replace(/^\s*behavior\s*:\s*[^;]+;\s*$/gmi, "");

    return cssText;
}

function extractCssVariables(cssText: string): ThemeVariables {
    // Extract CSS variables from :root or other blocks.
    // Looks for patterns like: --var-name: value; 
    const vars: ThemeVariables = {};
    const re = /(--[a-zA-Z0-9\-_]+)\s*:\s*([^;]+);/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(cssText)) !== null) {
        const name = m[1].trim();
        const value = m[2].trim();
        if (name && value) {
            vars[name] = value;
        }
    }
    return vars;
}

function buildCssVariablesBlock(vars: ThemeVariables): string {
    // Build a :root { ... } block with CSS variables.
    // Use !important to ensure custom variables override theme defaults.
    if (Object.keys(vars).length === 0) return "";
    const lines = Object.entries(vars).map(([name, value]) => `    ${name}: ${value} !important;`);
    const block = `:root {\n${lines.join("\n")}\n}\n`;
    debugLog("Built CSS variables block:", {varCount: lines.length, blockLength: block.length});
    return block;
}

type InlineImportOptions = {
    maxDepth: number;
    maxTotalBytes: number;
};

const DEFAULT_INLINE_IMPORTS: InlineImportOptions = {
    maxDepth: 3,
    maxTotalBytes: 1_500_000
};

function extractImportUrls(cssText: string): string[] {
    // Handles:
    //   @import "https://...";
    //   @import url("https://...");
    //   @import url(https://...);
    const urls: string[] = [];
    const re = /^\s*@import\s+(?:url\(\s*)?(?:['"])?([^'"\)\s;]+)(?:['"])?\s*\)?\s*;\s*$/gmi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(cssText)) !== null) {
        urls.push(m[1]);
    }
    return urls;
}

function removeImportStatements(cssText: string): string {
    return cssText.replace(/^\s*@import\s+[^;]+;\s*$/gmi, "");
}

function rewriteRelativeUrls(cssText: string, baseUrl: string): string {
    // Rewrite url(...) so relative paths continue to work after inlining.
    // Leaves absolute (http/https/data) untouched.
    return cssText.replace(/url\(\s*(['"]?)([^'"\)]+)\1\s*\)/gmi, (_full, quote: string, rawUrl: string) => {
        const trimmed = String(rawUrl).trim();
        if (!trimmed) return "url()";
        if (/^(data:|https?:|blob:)/i.test(trimmed)) return `url(${quote}${trimmed}${quote})`;
        if (trimmed.startsWith("#")) return `url(${quote}${trimmed}${quote})`;
        try {
            const resolved = new URL(trimmed, baseUrl).toString();
            return `url(${quote}${resolved}${quote})`;
        }
        catch {
            return `url(${quote}${trimmed}${quote})`;
        }
    });
}

async function fetchText(url: string): Promise<string> {
    const res = await fetch(url, {
        redirect: "follow",
        headers: {
            "User-Agent": "Siscord"
        }
    });
    if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
    return await res.text();
}

async function inlineCssImports(cssText: string, baseUrl: string | undefined, options: InlineImportOptions, seen: Set<string>, state: {totalBytes: number}): Promise<string> {
    if (options.maxDepth <= 0) return cssText;

    const importUrls = extractImportUrls(cssText);
    if (importUrls.length === 0) return cssText;

    const inlinedParts: string[] = [];

    for (const u of importUrls) {
        // Allow only http(s) imports.
        let resolved: string;
        try {
            resolved = baseUrl ? new URL(u, baseUrl).toString() : new URL(u).toString();
        }
        catch {
            continue;
        }

        if (!/^https?:/i.test(resolved)) continue;
        if (seen.has(resolved)) continue;
        seen.add(resolved);

        try {
            const fetched = await fetchText(resolved);
            state.totalBytes += Buffer.byteLength(fetched, "utf8");
            if (state.totalBytes > options.maxTotalBytes) break;

            // Rewrite relative url(...) inside imported file, then recursively inline its imports.
            let rewritten = rewriteRelativeUrls(fetched, resolved);
            rewritten = sanitizeThemeCss(rewritten);
            rewritten = await inlineCssImports(rewritten, resolved, {maxDepth: options.maxDepth - 1, maxTotalBytes: options.maxTotalBytes}, seen, state);

            inlinedParts.push(`/* @import inlined: ${resolved} */\n${rewritten}\n`);
        }
        catch (e) {
            // If fetch fails, leave it to the page (may still be blocked by CSP, but we don't crash).
            // Keep the original import by not adding anything here.
            debugLog("Failed to inline @import", {url: resolved, error: String(e)});
        }
    }

    // Remove @import lines from the original CSS and prepend inlined content.
    const withoutImports = removeImportStatements(cssText);
    return `${inlinedParts.join("\n")}\n${withoutImports}`;
}

async function listThemes(): Promise<ThemeInfo[]> {
    await ensureDirs();
    const dir = getThemesDir();
    const entries = await fs.readdir(dir, {withFileTypes: true});
    const themeFiles = entries
        .filter((e) => e.isFile())
        .map((e) => e.name)
        .filter((name) => name.toLowerCase().endsWith(".css"));

    const results: ThemeInfo[] = [];
    for (const filename of themeFiles) {
        const fullPath = path.join(dir, filename);
        try {
            const css = await fs.readFile(fullPath, "utf8");
            const meta = parseBetterDiscordThemeMeta(css);
            results.push({filename, meta});
        }
        catch {
            results.push({filename, meta: {}});
        }
    }

    results.sort((a, b) => a.filename.localeCompare(b.filename));
    return results;
}

async function importThemeViaDialog(): Promise<{importedFilename: string} | null> {
    await ensureDirs();

    const result = await dialog.showOpenDialog({
        title: "Import BetterDiscord Theme (.theme.css / .css)",
        properties: ["openFile"],
        filters: [
            {name: "CSS Themes", extensions: ["css"]}
        ]
    });

    if (result.canceled || result.filePaths.length === 0) return null;

    const srcPath = result.filePaths[0];
    const base = path.basename(srcPath);
    const destDir = getThemesDir();
    let destPath = path.join(destDir, base);

    // Avoid overwriting by suffixing.
    if (existsSync(destPath)) {
        const ext = path.extname(base);
        const name = base.slice(0, -ext.length);
        let i = 1;
        while (existsSync(destPath)) {
            destPath = path.join(destDir, `${name} (${i})${ext}`);
            i++;
        }
    }

    const raw = await fs.readFile(srcPath, "utf8");
    // We store the original file content as-is for compatibility;
    // sanitization happens at injection time.
    await fs.writeFile(destPath, raw, "utf8");
    return {importedFilename: path.basename(destPath)};
}

let mainWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
let insertedCssKey: string | null = null;

async function applyThemeToMainWindow(themeFilename: string | null) {
    if (!mainWindow) return;

    // If the main frame is still loading, apply after load to avoid racing navigation.
    if (mainWindow.webContents.isLoadingMainFrame()) {
        debugLog("Main frame loading; deferring theme apply", themeFilename);
        mainWindow.webContents.once("did-finish-load", async () => {
            try { await applyThemeToMainWindow(themeFilename); }
            catch { /* ignore */ }
        });
        return;
    }

    // Remove previous CSS if applied.
    if (insertedCssKey) {
        try {
            await mainWindow.webContents.removeInsertedCSS(insertedCssKey);
        }
        catch {
            // ignore
        }
        insertedCssKey = null;
    }

    if (!themeFilename) return;

    const themePath = path.join(getThemesDir(), themeFilename);
    const raw = await fs.readFile(themePath, "utf8");
    let css = sanitizeThemeCss(raw);

    const originalImportCount = extractImportUrls(css).length;

    // Inline HTTP(S) @import rules to keep BetterDiscord-style themes working even if Discord CSP blocks them.
    try {
        const before = css;
        css = await inlineCssImports(css, undefined, DEFAULT_INLINE_IMPORTS, new Set<string>(), {totalBytes: 0});
        debugLog("Theme prepared", {
            themeFilename,
            rawBytes: Buffer.byteLength(raw, "utf8"),
            sanitizedBytes: Buffer.byteLength(before, "utf8"),
            finalBytes: Buffer.byteLength(css, "utf8"),
            originalImportCount
        });
    }
    catch {
        // ignore
    }

    if (!css.trim()) return;

    // Apply custom CSS variable overrides if saved.
    const settings = await readSettings();
    const customVars = settings.themeVariables[themeFilename] || {};
    if (Object.keys(customVars).length > 0) {
        const varsBlock = buildCssVariablesBlock(customVars);
        css = varsBlock + css;
        debugLog("Applied custom variables", {themeFilename, varCount: Object.keys(customVars).length, varsBlock: varsBlock.substring(0, 100)});
    } else {
        debugLog("No custom variables for theme", {themeFilename});
    }

    try {
        insertedCssKey = await mainWindow.webContents.insertCSS(css);
        debugLog("insertCSS ok", {themeFilename, insertedCssKey, cssLength: css.length});
    }
    catch (e) {
        debugLog("insertCSS failed", {themeFilename, error: String(e)});
        throw e;
    }
}

function createMainWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            // disable webSecurity to relax CORS checks
            webSecurity: false,
            // allow loading mixed/content if needed
            allowRunningInsecureContent: true
        }
    });

    mainWindow.on("closed", () => {
        mainWindow = null;
    });

    mainWindow.loadURL(DISCORD_URL);

    // Re-apply theme whenever Discord reloads.
    mainWindow.webContents.on("did-finish-load", async () => {
        const settings = await readSettings();
        await applyThemeToMainWindow(settings.activeThemeFilename);
    });

    const menu = Menu.buildFromTemplate([
        {
            label: "Siscord",
            submenu: [
                {
                    label: "Theme Settings…",
                    click: () => openSettingsWindow()
                },
                {type: "separator"},
                {role: "quit"}
            ]
        },
        {role: "viewMenu"}
    ]);
    Menu.setApplicationMenu(menu);
}

function openSettingsWindow() {
    if (settingsWindow) {
        settingsWindow.focus();
        return;
    }

    settingsWindow = new BrowserWindow({
        width: 520,
        height: 620,
        resizable: true,
        webPreferences: {
            preload: path.join(app.getAppPath(), "preload.cjs"),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true
        }
    });

    settingsWindow.on("closed", () => {
        settingsWindow = null;
    });

    settingsWindow.loadFile(path.join(app.getAppPath(), "assets", "settings.html"));
}

function registerIpc() {
    ipcMain.handle("siscord:listThemes", async () => {
        return await listThemes();
    });

    ipcMain.handle("siscord:getActiveTheme", async () => {
        const settings = await readSettings();
        return settings.activeThemeFilename;
    });

    ipcMain.handle("siscord:setActiveTheme", async (_event, filename: string | null) => {
        const settings = await readSettings();
        settings.activeThemeFilename = filename;
        await writeSettings(settings);
        await applyThemeToMainWindow(filename);
        return true;
    });

    ipcMain.handle("siscord:importTheme", async () => {
        const imported = await importThemeViaDialog();
        return imported;
    });

    ipcMain.handle("siscord:getThemeVariables", async (_event, themeFilename: string | null) => {
        if (!themeFilename) return {};
        const settings = await readSettings();
        return settings.themeVariables[themeFilename] || {};
    });

    ipcMain.handle("siscord:setThemeVariables", async (_event, themeFilename: string | null, vars: ThemeVariables) => {
        if (!themeFilename) return false;
        debugLog("setThemeVariables called", {themeFilename, varCount: Object.keys(vars).length, vars});
        const settings = await readSettings();
        if (!settings.themeVariables) settings.themeVariables = {};
        settings.themeVariables[themeFilename] = vars;
        await writeSettings(settings);
        debugLog("Settings written for", {themeFilename});
        // Re-apply theme to see changes immediately.
        debugLog("Re-applying theme", {themeFilename});
        await applyThemeToMainWindow(themeFilename);
        return true;
    });

    ipcMain.handle("siscord:extractThemeVariables", async (_event, themeFilename: string | null) => {
        if (!themeFilename) return {};
        const themePath = path.join(getThemesDir(), themeFilename);
        try {
            const raw = await fs.readFile(themePath, "utf8");
            return extractCssVariables(raw);
        }
        catch {
            return {};
        }
    });
}

app.whenReady().then(async () => {
    await ensureDirs();
    registerIpc();
    // Strip Content-Security-Policy headers from Discord responses so themes/@import and resources can load.
    // This weakens security and should only be used in this external wrapper with user consent.
    try {
        const filter = { urls: ["https://discord.com/*", "https://*.discord.com/*"] };
        session.defaultSession.webRequest.onHeadersReceived(filter, (details, callback) => {
            const responseHeaders = Object.assign({}, details.responseHeaders || {});
            // Remove CSP headers (various casings)
            for (const k of Object.keys(responseHeaders)) {
                if (/content-security-policy/i.test(k)) delete responseHeaders[k];
                if (/content-security-policy-report-only/i.test(k)) delete responseHeaders[k];
            }
            // Optionally ensure CORS allows everything (not required when webSecurity=false, but helps some resources)
            responseHeaders['Access-Control-Allow-Origin'] = ['*'];
            callback({ responseHeaders });
        });
    }
    catch (e) {
        debugLog('Failed to register header override', String(e));
    }
    createMainWindow();

    app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
});

app.on("window-all-closed", () => {
    // On macOS, it's common for apps to stay active. On Windows/Linux, quit.
    if (process.platform !== "darwin") app.quit();
});
