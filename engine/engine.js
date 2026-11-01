/**
 *
 *  ## OVERVIEW
 *
 *  Keeps VRCX's live tracking running with no browser tab open.
 *
 *  The reason that tracking normally stops when you close the tab is that
 *  VRCX's real-time friend/location feed is a WebSocket the frontend opens
 *  directly from the browser (src/services/websocket.js in VRCX), not
 *  something the server does. Reimplementing that feed server-side would mean
 *  re-deriving VRCX's own pipeline-to-store logic - friend online/offline,
 *  location changes, invites, feed entries - in Node, guessing at business
 *  logic that actually lives in its Vue stores. Getting that subtly wrong
 *  would be worse than not having it.
 *
 *  So instead: this keeps a second, invisible copy of the exact same frontend
 *  open in a headless browser, permanently, pointed at the vrcx-server
 *  container over the internal network. It is the real app doing the real
 *  work - same code, same pipeline handling, same database writes. A tab you
 *  open yourself is then just another view onto state that was already being
 *  tracked; closing it changes nothing.
 *
 *  VRChat supports multiple concurrent sessions per account (desktop + web +
 *  mobile is normal), so this tab and any tab you open coexist without
 *  conflict; every write lands in the same server-side database either way.
 *
 */

const puppeteer = require("puppeteer-core");

const TARGET_URL = process.env.VRCX_URL || "http://vrcx:8080/";
const CHROMIUM_PATH = process.env.CHROMIUM_PATH || "/usr/bin/chromium";
const HEALTH_INTERVAL_MS = Number(process.env.ENGINE_HEALTH_INTERVAL_MS || 30000);
const STARTUP_RETRY_MS = 5000;

let browser = null;
let page = null;
let shuttingDown = false;

/**
 * Sleeps for a duration
 * @param {number} ms Milliseconds
 * @returns {Promise<void>}
 */
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Timestamp for log lines
 * @returns {string} ISO-ish timestamp
 */
function stamp() {
    return new Date().toISOString().replace("T", " ").slice(0, 19);
}

/**
 * Waits for the vrcx-server container to answer before pointing a browser at it
 */
async function wait_for_server() {
    for (;;) {
        try {
            const response = await fetch(new URL("healthz", TARGET_URL));
            if (response.ok) return;
        } catch (e) {
            /* not up yet */
        }
        console.log(`[${stamp()}] waiting for ${TARGET_URL} ...`);
        await sleep(STARTUP_RETRY_MS);
    }
}

/**
 * Opens the headless tab and leaves it running
 */
async function launch() {
    console.log(`[${stamp()}] launching engine tab -> ${TARGET_URL}`);
    browser = await puppeteer.launch({
        executablePath: CHROMIUM_PATH,
        headless: "new",
        args: [
            "--no-sandbox",
            "--disable-gpu",
            "--disable-dev-shm-usage",
            "--disable-background-timer-throttling",
            "--disable-backgrounding-occluded-windows",
            "--disable-renderer-backgrounding",
        ],
    });
    page = await browser.newPage();

    page.on("console", async (message) => {
        if (message.type() === "error") {
            let text = message.text();
            try {
                const args = await Promise.all(message.args().map((arg) => arg.jsonValue().catch(() => String(arg))));
                if (args.length > 0) text = args.map((value) => (typeof value === "object" ? JSON.stringify(value) : String(value))).join(" ");
            } catch (e) { /* use text */ }
            console.error(`[${stamp()}] page: ${text.slice(0, 500)}`);
        }
    });
    page.on("pageerror", (error) => console.error(`[${stamp()}] page error: ${String(error).slice(0, 300)}`));
    page.on("close", () => {
        if (!shuttingDown) console.warn(`[${stamp()}] engine tab closed unexpectedly`);
    });

    await page.goto(TARGET_URL, { waitUntil: "networkidle0", timeout: 30000 });
    console.log(`[${stamp()}] engine tab loaded and running`);
}

/**
 * True if the tab is still alive and on the right page
 * @returns {Promise<boolean>} Health
 */
async function is_healthy() {
    if (!browser || !page || page.isClosed()) return false;
    try {
        await page.evaluate(() => document.readyState);
        return true;
    } catch (e) {
        return false;
    }
}

/**
 * Closes whatever is left of a dead browser before relaunching
 */
async function cleanup() {
    try {
        if (browser) await browser.close();
    } catch (e) {
        /* already gone */
    }
    browser = null;
    page = null;
}

async function main() {
    await wait_for_server();
    await launch();

    setInterval(async () => {
        if (shuttingDown) return;
        if (await is_healthy()) return;
        console.warn(`[${stamp()}] engine tab is unhealthy, restarting`);
        await cleanup();
        try {
            await launch();
        } catch (error) {
            console.error(`[${stamp()}] relaunch failed: ${error.message}`);
        }
    }, HEALTH_INTERVAL_MS);
}

const shutdown = async () => {
    shuttingDown = true;
    console.log(`[${stamp()}] shutting down`);
    await cleanup();
    process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((error) => {
    console.error(`[${stamp()}] fatal: ${error.message}`);
    process.exit(1);
});
