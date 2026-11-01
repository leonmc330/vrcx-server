/**
 *
 *  vrcx-web: serves VRCX's own frontend as a web page.
 *
 *  VRCX is an Electron app whose Vue frontend reaches a .NET backend through a
 *  single IPC function. This serves that same frontend, injects a shim that
 *  points the function at this server, and implements the backend in Node.
 *
 *  The frontend is upstream's, built unmodified from a pinned VRCX tag.
 *
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const { Interop } = require("./src/interop.js");
const { loadConfig, saveConfig, createClient, importSqliteToClient } = require("./src/db.js");
const os = require("os");

const HTML_DIR = process.env.VRCX_HTML || path.join(__dirname, "html");
const PUBLIC_DIR = path.join(__dirname, "public");
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || "0.0.0.0";

const TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".webp": "image/webp",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
};

const interop = new Interop();

/**
 * Reads a JSON request body
 * @param {Object} request Node request
 * @returns {Promise<Object>} Parsed body
 */
function read_body(request) {
    return new Promise((resolve, reject) => {
        let raw = "";
        request.on("data", (chunk) => {
            raw += chunk;
            if (raw.length > 64 * 1024 * 1024) reject(new Error("Body too large"));
        });
        request.on("end", () => {
            try {
                resolve(raw.length === 0 ? {} : JSON.parse(raw));
            } catch (e) {
                reject(e);
            }
        });
        request.on("error", reject);
    });
}

/**
 * Serves index.html with the shim inserted ahead of the app bundle
 * @param {Object} response Node response
 */
function send_index(response) {
    let html;
    try {
        html = fs.readFileSync(path.join(HTML_DIR, "index.html"), "utf8");
    } catch (e) {
        response.writeHead(500, { "Content-Type": "text/plain" });
        return response.end(
            "VRCX frontend is missing. It is built into ./html at image build time."
        );
    }
    // Must run before the bundle, which reads LINUX and interopApi on load
    html = html.replace("<head>", '<head>\n<script src="/__shim.js"></script>');
    const body = Buffer.from(html, "utf8");
    response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": body.length,
        "Cache-Control": "no-store",
    });
    response.end(body);
}

/**
 * Serves a file from a directory, refusing to escape it
 * @param {string} root Directory
 * @param {string} relative Requested path
 * @param {Object} response Node response
 * @returns {boolean} Whether the file was served
 */
function send_file(root, relative, response) {
    const target = path.join(root, relative);
    if (!target.startsWith(root)) {
        response.writeHead(403).end("Forbidden");
        return true;
    }
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return false;
    const body = fs.readFileSync(target);
    response.writeHead(200, {
        "Content-Type": TYPES[path.extname(target).toLowerCase()] || "application/octet-stream",
        "Content-Length": body.length,
        "Cache-Control": relative.includes("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
    });
    response.end(body);
    return true;
}

const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const route = decodeURIComponent(url.pathname);

    try {
        if (route === "/interop" && request.method === "POST") {
            const body = await read_body(request);
            try {
                const result = await interop.call(body.className, body.methodName, body.args || []);
                const payload = JSON.stringify({ result: result === undefined ? null : result });
                response.writeHead(200, {
                    "Content-Type": "application/json; charset=utf-8",
                    "Content-Length": Buffer.byteLength(payload),
                });
                return response.end(payload);
            } catch (error) {
                const payload = JSON.stringify({ error: String(error.message || error) });
                response.writeHead(200, {
                    "Content-Type": "application/json; charset=utf-8",
                    "Content-Length": Buffer.byteLength(payload),
                });
                return response.end(payload);
            }
        }

        if (route === "/client-log" && request.method === "POST") {
            const body = await read_body(request);
            console.error(`client ${body.level || "error"}: ${body.message || ""}\n${body.stack || ""}`);
            response.writeHead(204);
            return response.end();
        }

        if (route === "/healthz") {
            response.writeHead(200, { "Content-Type": "text/plain" });
            return response.end("ok");
        }

        if (route === "/db/config" && request.method === "GET") {
            const payload = JSON.stringify(loadConfig(interop.dataDir));
            response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(payload) });
            return response.end(payload);
        }

        if (route === "/db/config" && request.method === "POST") {
            const body = await read_body(request);
            const cfg = body && Object.keys(body).length ? body : loadConfig(interop.dataDir);
            // keep engine stable unless provided
            if (!cfg.engine) cfg.engine = (process.env.DB_ENGINE || "mariadb").toLowerCase();
            saveConfig(interop.dataDir, cfg);
            try { interop.db.close(); } catch (e) { /* ignore */ }
            interop.db = createClient(cfg, interop.dataDir);
            const payload = JSON.stringify({ ok: true, config: loadConfig(interop.dataDir) });
            response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(payload) });
            return response.end(payload);
        }

        if (route === "/db/import" && request.method === "POST") {
            const body = await read_body(request);
            if (!body || !body.data) {
                response.writeHead(400, { "Content-Type": "application/json" });
                return response.end(JSON.stringify({ error: "missing data (base64 sqlite file)" }));
            }
            const tmp = path.join(os.tmpdir(), `import-${Date.now()}.sqlite3`);
            try {
                fs.writeFileSync(tmp, Buffer.from(body.data, "base64"));
                const result = await importSqliteToClient(tmp, interop.db);
                response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
                return response.end(JSON.stringify({ ok: true, ...result }));
            } catch (e) {
                response.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
                return response.end(JSON.stringify({ error: String(e.message || e) }));
            } finally {
                try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ }
            }
        }

        if (route === "/admin" || route === "/admin.html") {
            if (send_file(PUBLIC_DIR, "admin.html", response)) return;
            // fallback simple page
            response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            return response.end("<html><body><p>admin page missing</p></body></html>");
        }

        if (route === "/__shim.js") {
            if (send_file(PUBLIC_DIR, "shim.js", response)) return;
        }

        if (route === "/" || route === "/index.html") return send_index(response);

        if (send_file(HTML_DIR, route.replace(/^\//, ""), response)) return;

        // Vue router handles its own paths, so unknown routes fall back to the app
        return send_index(response);
    } catch (error) {
        response.writeHead(500, { "Content-Type": "text/plain" });
        response.end(String(error.message || error));
    }
});

server.listen(PORT, HOST, () => {
    console.log(`vrcx-web listening on http://${HOST}:${PORT}`);
    console.log(`data directory: ${interop.dataDir}`);
});

const shutdown = () => {
    console.log("shutting down");
    server.close();
    interop.close();
    process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
