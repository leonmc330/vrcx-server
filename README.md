# vrcx-server

[VRCX](https://github.com/vrcx-team/VRCX) served as a web page, in a container.

The frontend is **upstream's own**, built unmodified from a pinned VRCX tag. What is replaced
is the part underneath it.

## Why this is not just "run VRCX in a container"

VRCX is a desktop application: an Electron shell around a .NET backend, with a Vue frontend
that talks to that backend over IPC. There is no server build and no web port to expose.

But the entire bridge is a single function:

```js
window.interopApi.callDotNetMethod(className, methodName, args)
```

Everything the UI does — every VRChat API call, every database query, every setting — goes
through it. So this project serves VRCX's frontend, injects a shim that points that one
function at this server, and implements the classes behind it in Node:

| Class | Methods used | What this does |
| --- | --- | --- |
| `WebApi` | 5 | The VRChat API client, with a cookie jar holding your login |
| `SQLite` | 3 | The database, `node:sqlite` |
| `VRCXStorage` | 9 | Settings, a JSON file |
| `AppApi` | 81 | Desktop integration — a handful implemented, the rest safe defaults |
| `LogWatcher` | 4 | Returns empty: there is no VRChat client on this machine |
| `Discord` | 2 | No-op |

## Running it

```bash
docker compose up -d
```

Then open `http://<host>:8080`.

## Logging in

Exactly as on the desktop: the normal VRCX login screen, your VRChat username and password,
then 2FA if you have it. There is no API key or token to obtain beforehand.

What differs is where the session lives. The browser never talks to VRChat directly — it
talks to this server, which makes the API calls and keeps the `auth` and `twoFactorAuth`
cookies in `/data/cookies.json`. That means the login survives restarts and follows the
container, not your browser: clearing site data does not log you out, and opening the page
from another device finds you already logged in.

Which is also the warning. **Anyone who can open that page is already logged in as you.**
There is no login screen in front of it. Keep it on a trusted network, behind a reverse proxy
with authentication, or on loopback with a tunnel — publishing it openly hands your VRChat
account to whoever finds it.

## What works and what does not

Working: friends list and online status, the feed, worlds, avatars, groups, favorites,
notifications, search, user and world dialogs, notes, the database and everything built on it.

Not working, by definition of running on a server with no VRChat client:

- **Game log** — GameLog, instance tracking and "who was in this world with you" read
  VRChat's local log files. There is no VRChat installation here, so `LogWatcher` returns
  empty and those views stay blank.
- **VR overlay, screenshots, registry, game launching** — desktop features with no meaning
  in a browser. They answer with empty defaults rather than errors, so the UI stays usable.
- **Image and file uploads** — avatar and world image uploads go through a native path that
  is not implemented; the API returns a clear error rather than failing silently.

Everything else is real VRCX talking to the real VRChat API.

## Known issue, fixed

VRCX's frontend does not call the backend class named `AppApi`. On Linux/Electron it aliases
`window.AppApi = InteropApi.AppApiElectron` (`src/plugins/interopApi.js` in VRCX), so every
call - `SetUserAgent`, `ChangeTheme`, `CurrentLanguage`, `GetVersion` and the rest - actually
goes out as class `AppApiElectron`. The first build of this shim only registered `AppApi`,
so every one of those calls failed on every single page load. Fixed by aliasing
`AppApiElectron` (and `AppApiVrElectron`) to the same implementation in `src/interop.js`.

## Login persistence, and staying logged in with every tab closed

The login is not stored in the browser. VRCX writes your saved credentials and cookies to
`VRCXStorage`, which this project backs with a file on `/data` - server-side, not per-tab. So
closing the tab and opening a new one, or opening the page on a different device, resumes
your session automatically; there is nothing to log back into.

What does not normally carry across a closed tab is the **live connection**: VRCX's real-time
friend/location feed is a WebSocket the frontend opens directly from the browser to
`wss://pipeline.vrchat.cloud` (`src/services/websocket.js` in VRCX). That is JavaScript
running in your tab, not something a server can do on your behalf by itself - closing the tab
ends that connection the same way quitting the desktop app would.

### The engine service

`docker-compose.yml` includes a second container, `vrcx-engine`, that solves this without
reimplementing VRCX's pipeline handling from scratch (which would mean guessing at business
logic that lives in its Vue stores - friend online/offline, location changes, feed entries -
and risking getting it subtly wrong). Instead it keeps a **second, invisible copy of the
exact same frontend** open in a headless browser, permanently, pointed at the `vrcx` container
over the internal Docker network. It is the real app doing the real work - same code, same
pipeline handling, same database writes.

A browser tab you open yourself is then just another view onto state that is already being
tracked. Closing it changes nothing; the engine's tab was never affected by it. VRChat
supports multiple concurrent sessions per account (desktop, web and mobile logged in
simultaneously is normal), so the engine's tab and any tab you open coexist without conflict,
and every write from either lands in the same server-side database.

Don't want the extra container? `docker compose up -d vrcx` starts only the server: login and
the friend list still work, and reopening the page always shows current state, but live
tracking then only runs while that page is open, same as the desktop app while it is running.

### Duplicate feed entries a few seconds apart

Running two live copies of VRCX at once - your tab, and the always-on engine tab - means both
independently receive the same VRChat pipeline event and both decide, from their own
in-memory state, that it is new. VRCX has no database constraint stopping a second write of
the same thing (its feed tables have no unique index; `INSERT OR IGNORE` has nothing to
ignore against normally, since only one copy is ever writing) - so both write it, a few
seconds apart, matching whatever timing skew exists between the two pipeline connections.

`src/feed-dedupe.js` fixes this at the one place both copies meet: the shared database.
Before running one of VRCX's own feed inserts (`_feed_gps`, `_feed_status`, `_feed_bio`,
`_feed_avatar`, `_feed_online_offline`, `_friend_log_history`), it checks for matching content
written in the last 20 seconds and skips the insert if there is one. It never edits VRCX's SQL
or schema - it reads the exact query VRCX already sent and decides whether to run it. Verified
with VRCX's own INSERT statements against a real database (`tools/dedupe-test.js`), and
through the actual HTTP path a browser tab uses, not just the function in isolation.

A genuine repeat of the same event outside that window - going offline and coming back online
five minutes later, say - is unaffected; only the multi-tab timing case is caught.

### A real bug this surfaced

Reached by hostname or LAN IP over plain HTTP - the normal way to open a self-hosted page -
Chrome does not consider the page a secure context (only HTTPS, or plain HTTP on exactly
`localhost`/`127.0.0.1`, count). `crypto.randomUUID()` requires one and VRCX calls it
unguarded once (`stores/vrcxUpdater.js`, a first-run install id), throwing on every load. This
was caught by actually running the built image in headless Chromium rather than assuming
success, and is fixed in `public/shim.js` with a `crypto.getRandomValues`-based polyfill,
which needs no secure context. `crypto.subtle` (used only by the optional Primary Password
local-encryption feature) has no such polyfill and genuinely requires HTTPS; that one feature
will not work without it.

## Upgrading VRCX

The frontend version is pinned in the Dockerfile:

```dockerfile
ARG VRCX_REF=v2026.07.18
```

Bump it and rebuild. Worth knowing: a new VRCX release can call backend methods this shim
does not implement. Unknown methods are logged as `Unimplemented: Class.Method` and return
`null` rather than throwing, so the app degrades instead of breaking — check the container
logs after an upgrade.

## Layout

```
server.js               HTTP server, static frontend, /interop dispatch
src/interop.js          the backend: WebApi, SQLite, VRCXStorage, AppApi, stubs
public/shim.js          injected into index.html, defines the Electron globals + crypto polyfill
Dockerfile               stage 1 builds VRCX's frontend, stage 2 runs the server
engine/                  the always-on headless tab that keeps tracking alive
docker-compose.yml       the stack: vrcx + vrcx-engine
src/feed-dedupe.js       suppresses duplicate feed rows from running two live tabs
tools/dedupe-test.js     tests it against VRCX's real INSERT statements
/data                    VRCX.sqlite3, settings.json, cookies.json
```
