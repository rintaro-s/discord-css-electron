export {};

declare global {
    interface Window {
        siscord: {
            listThemes: () => Promise<Array<{filename: string; meta: {name?: string; description?: string; author?: string; version?: string}}>>;
            getActiveTheme: () => Promise<string | null>;
            setActiveTheme: (filename: string | null) => Promise<boolean>;
            importTheme: () => Promise<{importedFilename: string} | null>;
        };
    }
}
