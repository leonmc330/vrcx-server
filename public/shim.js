/**
 *
 *  Loaded before the VRCX bundle. VRCX's frontend expects to be running inside
 *  Electron, where `window.interopApi.callDotNetMethod` reaches a .NET backend
 *  over IPC. This defines the same globals, but routed to this server instead.
 *
 *  Everything the app does - the VRChat API, the database, its settings - goes
 *  through that one function, so this is the whole bridge.
 *
 */

(function () {
    // VRCX branches on these. "LINUX" is the Electron path, which talks to the
    // backend through interopApi; the Windows path expects CefSharp bindings.
    window.LINUX = true;
    window.WINDOWS = false;

    /**
     * Electron's IPC preserves Maps through structured clone; JSON does not.
     * SQLite arguments arrive as a Map, so they are tagged on the way out and
     * rebuilt on the server.
     * @param {any} value Anything being sent
     * @returns {any} A JSON-safe copy
     */
    function encode(value) {
        if (value instanceof Map) {
            return { __map__: [...value.entries()].map(([k, v]) => [k, encode(v)]) };
        }
        if (Array.isArray(value)) return value.map(encode);
        if (value && typeof value === "object") {
            const out = {};
            for (const [key, item] of Object.entries(value)) out[key] = encode(item);
            return out;
        }
        return value;
    }

    let pending = 0;

    window.interopApi = {
        async callDotNetMethod(className, methodName, args) {
            pending += 1;
            try {
                const response = await fetch("/interop", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(encode({ className, methodName, args: args || [] })),
                });
                if (!response.ok) {
                    throw new Error(`${className}.${methodName} failed: HTTP ${response.status}`);
                }
                const payload = await response.json();
                if (payload.error) throw new Error(payload.error);
                return payload.result;
            } finally {
                pending -= 1;
            }
        },
    };

    // The desktop shell. None of it exists in a browser, so these are the
    // sanest equivalents: links open in a tab, dialogs and the tray do nothing.
    window.electron = {
        getArch: async () => "x64",
        getClipboardText: async () => {
            try {
                return await navigator.clipboard.readText();
            } catch (e) {
                return "";
            }
        },
        getNoUpdater: async () => true,
        setTrayIconNotification: async () => {},
        openFileDialog: async () => null,
        openDirectoryDialog: async () => null,
        onWindowPositionChanged: () => () => {},
        onWindowSizeChanged: () => () => {},
        onWindowStateChange: () => () => {},
        onBrowserFocus: () => () => {},
        desktopNotification: async (title, body) => {
            try {
                if (Notification.permission === "granted") new Notification(title, { body });
            } catch (e) {
                /* notifications are optional */
            }
        },
        restartApp: async () => window.location.reload(),
        getOverlayWindow: async () => null,
        updateVr: async () => {},
        ipcRenderer: { on: () => undefined },
    };

    // Asking once, up front, so desktopNotification can work later
    try {
        if (window.Notification && Notification.permission === "default") {
            Notification.requestPermission();
        }
    } catch (e) {
        /* not fatal */
    }
})();
