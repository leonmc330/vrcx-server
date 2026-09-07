/**
 *
 *  Server-side implementation of the classes VRCX's frontend expects from its
 *  .NET backend.
 *
 *  Only four of them carry real weight:
 *
 *    WebApi       the VRChat HTTP client, and the cookie jar that holds a login
 *    SQLite       the database, three methods wide
 *    VRCXStorage  settings, a key/value file
 *    AppApi       eighty methods of desktop integration, nearly all of which
 *                 mean nothing on a server and answer with a safe default
 *
 *  LogWatcher and Discord exist because the app calls them; they return empty,
 *  since there is no VRChat client or desktop session on this machine.
 *
 */

const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { is_duplicate_feed_insert } = require("./feed-dedupe.js");

const DATA_DIR = process.env.VRCX_DATA || "/data";
const USER_AGENT = process.env.VRCX_USER_AGENT || "VRCX/2026.07.18 vrcx-web";

/**
 * Rebuilds the Maps the shim tagged on the way over
 * @param {any} value Decoded JSON
 * @returns {any} Value with Maps restored as plain objects
 */
function decode(value) {
    if (Array.isArray(value)) return value.map(decode);
    if (value && typeof value === "object") {
        if (Array.isArray(value.__map__)) {
            const out = {};
            for (const [key, item] of value.__map__) out[key] = decode(item);
            return out;
        }
        const out = {};
        for (const [key, item] of Object.entries(value)) out[key] = decode(item);
        return out;
    }
    return value;
}

/* -------------------------------------------------------------------------- */
/*  Cookie jar                                                                 */
/* -------------------------------------------------------------------------- */

class CookieJar {
    constructor(file) {
        this.file = file;
        this.cookies = new Map();
        this.load();
    }

    load() {
        try {
            if (fs.existsSync(this.file)) {
                const saved = JSON.parse(fs.readFileSync(this.file, "utf8"));
                this.cookies = new Map(Object.entries(saved));
            }
        } catch (e) {
            console.error(`Could not read cookies: ${e.message}`);
        }
    }

    save() {
        try {
            fs.writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.cookies), null, 2), {
                mode: 0o600,
            });
        } catch (e) {
            console.error(`Could not save cookies: ${e.message}`);
        }
    }

    /**
     * Records cookies from a response
     * @param {Headers} headers Response headers
     */
    absorb(headers) {
        const raw = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [];
        let changed = false;
        for (const line of raw) {
            const [pair] = line.split(";");
            const index = pair.indexOf("=");
            if (index === -1) continue;
            const name = pair.slice(0, index).trim();
            const value = pair.slice(index + 1).trim();
            // An expiry in the past is a deletion
            if (/expires=Thu, 01 Jan 1970/i.test(line) || value.length === 0) {
                changed = this.cookies.delete(name) || changed;
            } else {
                this.cookies.set(name, value);
                changed = true;
            }
        }
        if (changed) this.save();
    }

    header() {
        return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
    }

    clear() {
        this.cookies.clear();
        this.save();
    }
}

/* -------------------------------------------------------------------------- */
/*  The classes                                                                */
/* -------------------------------------------------------------------------- */

class Interop {
    constructor(dataDir = DATA_DIR) {
        fs.mkdirSync(dataDir, { recursive: true });
        this.dataDir = dataDir;
        this.jar = new CookieJar(path.join(dataDir, "cookies.json"));
        this.userAgent = USER_AGENT;

        this.db = new DatabaseSync(path.join(dataDir, "VRCX.sqlite3"));
        this.db.exec("PRAGMA journal_mode = WAL");

        this.settingsFile = path.join(dataDir, "settings.json");
        this.settings = {};
        try {
            if (fs.existsSync(this.settingsFile)) {
                this.settings = JSON.parse(fs.readFileSync(this.settingsFile, "utf8"));
            }
        } catch (e) {
            console.error(`Could not read settings: ${e.message}`);
        }
    }

    /**
     * Routes one call from the browser to the right implementation
     * @param {string} className Class the frontend asked for
     * @param {string} methodName Method on it
     * @param {Array<any>} args Arguments
     * @returns {Promise<any>} Whatever that method returns
     */
    async call(className, methodName, args) {
        const target = this[className];
        if (!target) throw new Error(`Unknown class ${className}`);
        const method = target[methodName];
        if (typeof method !== "function") {
            // An unimplemented desktop method is not worth breaking the app for
            console.warn(`Unimplemented: ${className}.${methodName}`);
            return null;
        }
        return await method.apply(target, args.map(decode));
    }

    /* ---------------------------------------------------------------- WebApi */
    get WebApi() {
        const jar = this.jar;
        const agent = () => this.userAgent;
        return {
            /**
             * Performs a VRChat API request and reports it the way the C#
             * backend does: a JSON string of {status, message}, status -1 for a
             * transport failure.
             * @param {string} requestJson JSON.stringify of the options object
             * @returns {Promise<string>} JSON string
             */
            ExecuteJson: async (requestJson) => {
                let options;
                try {
                    options = typeof requestJson === "string" ? JSON.parse(requestJson) : requestJson;
                } catch (e) {
                    return JSON.stringify({ status: -1, message: `Bad request: ${e.message}` });
                }

                if (options.uploadImage || options.uploadImageLegacy || options.uploadFilePUT || options.uploadImagePrint) {
                    return JSON.stringify({
                        status: -1,
                        message: "Image and file uploads are not supported by vrcx-web",
                    });
                }

                const headers = {
                    "User-Agent": agent(),
                    Accept: "*/*",
                    ...(options.headers || {}),
                };
                const cookies = jar.header();
                if (cookies.length > 0) headers.Cookie = cookies;

                const method = (options.method || "GET").toUpperCase();
                const init = { method, headers, redirect: "follow" };
                if (method !== "GET" && options.body !== undefined && options.body !== null) {
                    init.body = options.body;
                    if (!headers["Content-Type"] && !headers["content-type"]) {
                        headers["Content-Type"] = "application/json";
                    }
                }

                try {
                    const response = await fetch(options.url, init);
                    jar.absorb(response.headers);
                    const text = await response.text();
                    return JSON.stringify({ status: response.status, message: text });
                } catch (error) {
                    return JSON.stringify({ status: -1, message: String(error.message || error) });
                }
            },
            Execute: async (options) => {
                const json = await this.WebApi.ExecuteJson(JSON.stringify(options));
                const parsed = JSON.parse(json);
                return { Item1: parsed.status, Item2: parsed.message };
            },
            GetCookies: async () => JSON.stringify(Object.fromEntries(jar.cookies)),
            SetCookies: async (value) => {
                try {
                    const parsed = typeof value === "string" ? JSON.parse(value) : value;
                    jar.cookies = new Map(Object.entries(parsed || {}));
                    jar.save();
                } catch (e) {
                    console.error(`SetCookies: ${e.message}`);
                }
            },
            ClearCookies: async () => jar.clear(),
        };
    }

    /* ---------------------------------------------------------------- SQLite */
    get SQLite() {
        const db = this.db;
        /**
         * node:sqlite takes named parameters as an object. VRCX writes them as
         * @name in the SQL, so bare names are allowed here.
         */
        const run = (sql, args) => {
            const statement = db.prepare(sql);
            if (args && Object.keys(args).length > 0) {
                statement.setAllowBareNamedParameters(true);
                return statement;
            }
            return statement;
        };
        return {
            ExecuteJson: async (sql, args) => {
                const statement = run(sql, args);
                const rows = args && Object.keys(args).length > 0 ? statement.all(args) : statement.all();
                // The frontend reads rows positionally, as the C# layer returns them
                return JSON.stringify(rows.map((row) => Object.values(row)));
            },
            Execute: async (sql, args) => {
                const statement = run(sql, args);
                const rows = args && Object.keys(args).length > 0 ? statement.all(args) : statement.all();
                return rows.map((row) => Object.values(row));
            },
            ExecuteNonQuery: async (sql, args) => {
                // Running two live copies of VRCX at once (a real tab, and the
                // always-on engine tab) means both independently decide a
                // pipeline event is "new" and both write it - see
                // feed-dedupe.js for why this is checked here rather than in
                // VRCX itself.
                if (is_duplicate_feed_insert(db, sql, args)) return 0;
                const statement = run(sql, args);
                const result = args && Object.keys(args).length > 0 ? statement.run(args) : statement.run();
                return Number(result.changes);
            },
        };
    }

    /* ----------------------------------------------------------- VRCXStorage */
    get VRCXStorage() {
        const save = () => {
            fs.writeFileSync(this.settingsFile, JSON.stringify(this.settings, null, 2));
        };
        return {
            Get: async (key) => (this.settings[key] === undefined ? "" : String(this.settings[key])),
            Set: async (key, value) => {
                this.settings[key] = value;
                save();
            },
            GetAll: async () => JSON.stringify(this.settings),
            Remove: async (key) => {
                delete this.settings[key];
                save();
            },
            Save: async () => save(),
            GetArray: async (key) => {
                const raw = this.settings[key];
                try {
                    return raw ? JSON.parse(raw) : [];
                } catch (e) {
                    return [];
                }
            },
            SetArray: async (key, value) => {
                this.settings[key] = JSON.stringify(value);
                save();
            },
            GetObject: async (key) => {
                const raw = this.settings[key];
                try {
                    return raw ? JSON.parse(raw) : {};
                } catch (e) {
                    return {};
                }
            },
            SetObject: async (key, value) => {
                this.settings[key] = JSON.stringify(value);
                save();
            },
        };
    }

    /* ------------------------------------------------------------ LogWatcher */
    get LogWatcher() {
        // There is no VRChat client on this machine, so there are no logs. The
        // app polls these constantly; empty answers keep it happy.
        return {
            Get: async () => [],
            GetLogLines: async () => [],
            Reset: async () => {},
            SetDateTill: async () => {},
        };
    }

    /* --------------------------------------------------------------- Discord */
    get Discord() {
        return { SetActive: async () => false, SetAssets: async () => {} };
    }

    /* --------------------------------------------------- AssetBundleManager */
    get AssetBundleManager() {
        return { GetAssetId: async () => "", GetVersion: async () => "" };
    }

    /* ---------------------------------------------------------------- AppApi
       The frontend does not call the class "AppApi" directly: on Linux/Electron
       it aliases window.AppApi = InteropApi.AppApiElectron (src/plugins/interopApi.js),
       so callDotNetMethod always sends className "AppApiElectron". Missing this
       alias meant every one of these calls failed with "Unknown class
       AppApiElectron" - which is nearly the whole desktop-integration surface,
       including SetUserAgent, CurrentLanguage and ChangeTheme on every load. */
    get AppApiElectron() {
        return this.AppApi;
    }

    get AppApiVrElectron() {
        return this.AppApi;
    }

    get AppApi() {
        const self = this;
        return {
            // The few that carry meaning here
            SetUserAgent: async (value) => {
                if (typeof value === "string" && value.length > 0) self.userAgent = value;
            },
            GetVersion: async () => process.env.VRCX_VERSION || "vrcx-web",
            CurrentCulture: async () => process.env.LANG || "en-US",
            CurrentLanguage: async () => (process.env.LANG || "en-US").split(/[_.]/)[0],
            GetZoom: async () => 100,
            SetZoom: async () => {},
            ChangeTheme: async () => {},
            CustomCss: async () => "",
            CustomScript: async () => "",
            GetClipboard: async () => "",
            OpenLink: async () => {},
            GetColourFromUserID: async () => null,
            GetColourBulk: async () => ({}),
            PopulateImageHosts: async () => {},
            GetImage: async () => "",

            // Anything to do with a running game, a headset, the registry, the
            // filesystem or the updater is false or empty by definition here
            CheckGameRunning: async () => [false, false],
            IsGameRunning: async () => false,
            IsSteamVRRunning: async () => false,
            CheckForUpdateExe: async () => "",
            CheckUpdateProgress: async () => 0,
            DownloadUpdate: async () => {},
            CancelUpdate: async () => {},
            RestartApplication: async () => {},
            GetVRChatPhotosLocation: async () => "",
            HasVRChatRegistryFolder: async () => false,
            GetVRChatRegistry: async () => null,
            GetVRChatRegistryJson: async () => "{}",
            GetVRChatRegistryKey: async () => null,
            GetVRChatRegistryKeyString: async () => "",
            SetVRChatRegistry: async () => {},
            SetVRChatRegistryKey: async () => {},
            DeleteVRChatRegistryFolder: async () => {},
            ReadVrcRegJsonFile: async () => "{}",
            GetVRChatUserModeration: async () => "",
            SetVRChatUserModeration: async () => {},
            GetLastScreenshot: async () => "",
            FindScreenshotsBySearch: async () => [],
            GetScreenshotMetadata: async () => "",
            GetExtraScreenshotData: async () => "",
            AddScreenshotMetadata: async () => {},
            DeleteScreenshotMetadata: async () => {},
            DeleteAllScreenshotMetadata: async () => {},
            CropPrintImage: async () => "",
            CropAllPrints: async () => {},
            ResizeImageToFitLimits: async () => "",
            SaveEmojiToFile: async () => {},
            SavePrintToFile: async () => {},
            SaveStickerToFile: async () => {},
            CopyImageToClipboard: async () => {},
            GetFileBase64: async () => "",
            FileLength: async () => 0,
            MD5File: async () => "",
            SignFile: async () => "",
            ReadConfigFileSafe: async () => "",
            WriteConfigFile: async () => {},
            OpenFileSelectorDialog: async () => "",
            OpenFolderSelectorDialog: async () => "",
            OpenFolderAndSelectItem: async () => {},
            OpenShortcutFolder: async () => {},
            OpenUGCPhotosFolder: async () => {},
            OpenCalendarFile: async () => {},
            OpenDiscordProfile: async () => {},
            StartGame: async () => false,
            StartGameFromPath: async () => false,
            QuitGame: async () => 0,
            TryOpenInstanceInVrc: async () => false,
            VrcClosedGracefully: async () => true,
            GetLaunchCommand: async () => "",
            SetAppLauncherSettings: async () => {},
            SetStartup: async () => {},
            SetTrayIconNotification: async () => {},
            DesktopNotification: async () => {},
            FlashWindow: async () => {},
            FocusWindow: async () => {},
            ShowDevTools: async () => {},
            SendIpc: async () => {},
            IPCAnnounceStart: async () => {},
            SetVR: async () => {},
            ExecuteVrOverlayFunction: async () => {},
            OVRTNotification: async () => {},
            XSNotification: async () => {},
        };
    }

    close() {
        try {
            this.db.close();
        } catch (e) {
            /* already closed */
        }
    }
}

module.exports = { Interop, decode };
