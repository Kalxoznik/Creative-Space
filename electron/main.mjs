// Creative Space as a Mac app: the Electron main process is only a launcher. It starts the
// board (the Next.js standalone server) and the agent worker as hidden child processes on a
// free 127.0.0.1 port, opens one window on the board, and stops both when the app quits.
//
// The children are Electron's own binary with ELECTRON_RUN_AS_NODE=1 — the same Node that
// `node:sqlite` was checked against — so the app needs no Node on the Mac.
//
// A Finder-launched app gets launchd's PATH (/usr/bin:/bin:…), not the shell's, so `claude`
// and `codex` are looked for in the usual install places and that PATH is handed down. The
// bundled git goes first: on a Mac without the developer tools /usr/bin/git is only a stub
// that opens an install dialog. Every `git` the board, the worker and the agents run is then
// the app's own.
//
//   npm run app        # unpackaged, against `npm run build:app` output
//   npm run dist:mac   # Creative Space.dmg in release/

import { app, BrowserWindow, dialog, Menu, shell } from "electron"
import { spawn } from "node:child_process"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createUpdater } from "./updates.mjs"

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const HOME = os.homedir()

// Packaged: everything sits in Contents/Resources (electron-builder.yml, extraResources).
// Unpackaged: the repository's own build output. The data is the app data folder either way
// (~/Library/Application Support/creative-space, packaged or unpackaged) — never
// data/: a second board and worker on the database `npm run up` is serving would claim its runs.
const layout = app.isPackaged
  ? {
      server: path.join(process.resourcesPath, "server"),
      agents: path.join(process.resourcesPath, "agents"),
      git: path.join(process.resourcesPath, "git"),
    }
  : {
      server: path.join(REPO, ".next", "standalone"),
      agents: path.join(REPO, "agents"),
      git: path.join(REPO, "node_modules", "dugite", "git"),
    }
const DATA = app.getPath("userData")
const DB_PATH = path.join(DATA, "data", "board.db")
const UPLOADS_DIR = path.join(DATA, "uploads")
const LOG_DIR = path.join(DATA, "logs")

function agentPath() {
  const nvm = path.join(HOME, ".nvm", "versions", "node")
  const nvmBins = fs.existsSync(nvm)
    ? fs
        .readdirSync(nvm)
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
        .map((version) => path.join(nvm, version, "bin"))
    : []
  const dirs = [
    path.join(layout.git, "bin"),
    path.join(HOME, ".local", "bin"),
    path.join(HOME, ".claude", "local"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    path.join(HOME, ".npm-global", "bin"),
    path.join(HOME, ".volta", "bin"),
    path.join(HOME, ".bun", "bin"),
    ...nvmBins,
    ...(process.env.PATH ?? "").split(":"),
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ]
  return [...new Set(dirs.filter(Boolean))].filter((dir) => fs.existsSync(dir)).join(":")
}

// The children run as Node on Electron's own binary. On macOS the app's main executable shows
// up in the Dock as a second, bouncing "Creative Space" even with ELECTRON_RUN_AS_NODE, because
// it is the app's bundle executable. The Helper binary is marked LSUIElement, so a process
// started from it stays out of the Dock. Unpackaged (`npm run app`) there is no own Helper.
function nodeBinary() {
  if (process.platform !== "darwin" || !app.isPackaged) return process.execPath
  // The bundle executable's own name ("Creative Space"), not app.getName(): that one is the
  // package.json name ("creative-space"), and the Helper is named after the product.
  const product = path.basename(process.execPath)
  const helper = path.join(
    path.dirname(process.execPath),
    "..",
    "Frameworks",
    `${product} Helper.app`,
    "Contents",
    "MacOS",
    `${product} Helper`
  )
  return fs.existsSync(helper) ? helper : process.execPath
}

// The board's usual port first, so tools that talk to http://localhost:43123 keep working;
// any free port when it is taken (for example by `npm run up`).
const PREFERRED_PORT = 43123
function portFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.unref()
    server.once("error", () => resolve(false))
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)))
  })
}

async function boardPort() {
  return (await portFree(PREFERRED_PORT)) ? PREFERRED_PORT : freePort()
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

const children = []
let quitting = false

function start(label, script, cwd, env) {
  fs.mkdirSync(LOG_DIR, { recursive: true })
  const log = fs.openSync(path.join(LOG_DIR, `${label}.log`), "a")
  const child = spawn(nodeBinary(), [script], {
    cwd,
    env: {
      ...process.env, ...env, ELECTRON_RUN_AS_NODE: "1",
      // Empty (rather than absent) also prevents Next's dotenv loader from filling them in.
      TELEGRAM_BOT_TOKEN: "", TELEGRAM_CHAT_ID: "",
    },
    stdio: ["ignore", log, log],
    detached: true,
  })
  child.on("exit", (code, signal) => {
    if (quitting) return
    dialog.showErrorBox("Creative Space", `The ${label} stopped (${signal ?? code}). See ${path.join(LOG_DIR, `${label}.log`)}`)
    app.quit()
  })
  children.push(child)
  return child
}

// Each child leads its own process group, and the `claude` / `codex` a run spawns stays in the
// worker's. SIGTERM to the worker alone is not enough: it waits for the run in flight, so the
// app would close with an agent still working. Quit signals both groups, worker first, gives
// them a few seconds and then kills whatever is left.
function signalGroup(child, signal) {
  try {
    process.kill(-child.pid, signal)
    return true
  } catch {
    return false // the group is gone
  }
}

let stopping = null
function stopChildren(graceMs = 5_000) {
  quitting = true
  stopping ??= (async () => {
    const order = [...children].reverse() // the worker was started last
    for (const child of order) signalGroup(child, "SIGTERM")
    const started = Date.now()
    while (order.some((child) => signalGroup(child, 0)) && Date.now() - started < graceMs) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    for (const child of order) signalGroup(child, "SIGKILL")
  })()
  return stopping
}

async function waitForBoard(url, timeoutMs = 60_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      if ((await fetch(`${url}/api/state`)).ok) return true
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  return false
}

const updater = createUpdater({
  app,
  getWindow: () => BrowserWindow.getAllWindows()[0],
  onChange: () => buildMenu(),
})

// Replacing the default menu means listing the standard roles again — without the Edit menu
// copy and paste stop working in the board.
function buildMenu() {
  const found = updater.available
  const checkItem = { label: "Check for Updates…", click: () => updater.check({ manual: true }) }
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        role: "appMenu",
        submenu: [
          { role: "about" },
          ...(found
            ? [{ label: `Creative Space ${found.version} is available — Download`, click: () => shell.openExternal(found.url) }]
            : []),
          checkItem,
          { type: "separator" },
          { role: "services" },
          { type: "separator" },
          { role: "hide" },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { role: "quit" },
        ],
      },
      {
        label: "File",
        submenu: [
          {
            // The menu owns ⌘, in the app, so the page hears about it as a window event.
            label: "Board Details…",
            accelerator: "CmdOrCtrl+,",
            click: () =>
              BrowserWindow.getAllWindows()[0]?.webContents
                .executeJavaScript('window.dispatchEvent(new Event("cs:board-details"))')
                .catch(() => {}),
          },
          { type: "separator" },
          { role: "close" },
        ],
      },
      { role: "editMenu" },
      { role: "viewMenu" },
      { role: "windowMenu" },
      { role: "help", submenu: [checkItem] },
    ])
  )
}

async function launch() {
  buildMenu()
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true })
  fs.mkdirSync(UPLOADS_DIR, { recursive: true })
  const port = await boardPort()
  const url = `http://127.0.0.1:${port}`
  const env = {
    PATH: agentPath(),
    GIT_EXEC_PATH: path.join(layout.git, "libexec", "git-core"),
    GIT_TEMPLATE_DIR: path.join(layout.git, "share", "git-core", "templates"),
    CS_APP: "1",
    CS_APP_DATA_DIR: DATA,
    CS_DB_PATH: DB_PATH,
    CS_UPLOADS_DIR: UPLOADS_DIR,
  }

  start("board", path.join(layout.server, "server.js"), layout.server, {
    ...env,
    PORT: String(port),
    HOSTNAME: "127.0.0.1",
    NODE_ENV: "production",
  })
  const window = new BrowserWindow({ width: 1440, height: 900, title: "Creative Space", show: false })
  // Links out of the board (a card's URL, docs) open in the browser, not in the app's window.
  window.webContents.setWindowOpenHandler(({ url: target }) => {
    shell.openExternal(target)
    return { action: "deny" }
  })
  if (!(await waitForBoard(url))) {
    dialog.showErrorBox("Creative Space", `The board did not start. See ${path.join(LOG_DIR, "board.log")}`)
    app.quit()
    return
  }
  start("worker", path.join(layout.agents, "worker.mjs"), HOME, {
    ...env,
    CS_API: url,
    CS_AGENT_MODE: process.env.CS_AGENT_MODE ?? "live",
  })
  await window.loadURL(url)
  window.show()
  updater.start() // the update dialog needs a visible window to attach to
}

if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on("second-instance", () => BrowserWindow.getAllWindows()[0]?.focus())
  app.on("window-all-closed", () => app.quit())
  app.on("before-quit", (event) => {
    event.preventDefault()
    stopChildren().then(() => app.exit())
  })
  // Ctrl-C under `npm run app`: the children are in their own groups, so only Electron gets it.
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => app.quit())
  app.whenReady().then(launch)
}
