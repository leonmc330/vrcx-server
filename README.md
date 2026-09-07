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

## Login persistence, and why the friend list stops when every tab is closed

The login is not stored in the browser. VRCX writes your saved credentials and cookies to
`VRCXStorage`, which this project backs with a file on `/data` - server-side, not per-tab. So
closing the tab and opening a new one, or opening the page on a different device, resumes
your session automatically; there is nothing to log back into.

What does not carry across a closed tab is the **live connection**. VRCX's real-time
friend/location updates come from a WebSocket the frontend opens directly from the browser to
`wss://pipeline.vrchat.cloud` (`src/services/websocket.js` in VRCX) - that is JavaScript
running in your tab, not something this server does on your behalf. Closing the tab ends that
connection the same way quitting the desktop app would. Reopening the page reconnects
immediately using the stored session and pulls fresh state; it is not a live feed while no
tab is open.

Making the friend list update in the background with every tab closed would mean building a
second engine that holds that pipeline connection server-side and pushes updates to any open
tab - the same shape DSCX already uses for Discord. That is a real, separate project, not a
one-line fix; ask if you want it built.

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
server.js             HTTP server, static frontend, /interop dispatch
src/interop.js        the backend: WebApi, SQLite, VRCXStorage, AppApi, stubs
public/shim.js        injected into index.html, defines the Electron globals
Dockerfile            stage 1 builds VRCX's frontend, stage 2 runs the server
docker-compose.yml    the stack
/data                 VRCX.sqlite3, settings.json, cookies.json
```
