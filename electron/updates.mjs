// "Is there a newer Creative Space?" for the Mac app. The build is unsigned, so there is no
// silent in-place update (electron-updater needs a signed app — docs/decisions.md): the app
// only asks GitHub for the latest release and, when it is newer, offers its .dmg in the browser.
//
// The background check (launch, then every few hours) stays quiet on a network error and on
// "up to date"; the menu's "Check for updates…" always answers. A new version is announced by
// Download / Later dialog, once — the version is remembered in the app data folder — and then
// lives on as a menu item. Not a macOS notification: those reach only code-signed apps. CS_UPDATE_URL points the check at another endpoint (a fake release).

import { dialog, shell } from "electron"
import fs from "node:fs"
import path from "node:path"

const RELEASE_URL =
  process.env.CS_UPDATE_URL || "https://api.github.com/repos/Kalxoznik/Creative-Space/releases/latest"
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000

// Numbers, not strings: 0.10.0 is newer than 0.9.0. A "v" prefix and a "-beta" tail are ignored.
export function parseVersion(text) {
  const match = /^v?(\d+(?:\.\d+)*)/.exec(String(text ?? "").trim())
  return match ? match[1].split(".").map(Number) : null
}

export function isNewer(candidate, current) {
  const a = parseVersion(candidate)
  const b = parseVersion(current)
  if (!a || !b) return false
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0)
    if (diff !== 0) return diff > 0
  }
  return false
}

// GitHub renames uploaded files ("Creative Space.dmg" becomes "Creative.Space.dmg"), so the
// asset is found by its ending. No .dmg: the release page.
export function releaseDownload(release) {
  const dmg = (release.assets ?? []).find((asset) => /\.dmg$/i.test(asset.name ?? ""))
  return dmg?.browser_download_url || release.html_url
}

// -> { status: "available", version, url } | { status: "current" } | { status: "error" }
export async function fetchLatest(currentVersion) {
  try {
    const res = await fetch(RELEASE_URL, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "Creative-Space-app" },
      signal: AbortSignal.timeout(10_000),
    })
    if (res.status === 404) return { status: "current" } // no release published yet
    if (!res.ok) return { status: "error" }
    const release = await res.json()
    const version = String(release.tag_name ?? "").replace(/^v/, "")
    const url = releaseDownload(release)
    if (!isNewer(version, currentVersion) || !url) return { status: "current" }
    return { status: "available", version, url }
  } catch {
    return { status: "error" }
  }
}

// onChange() is called when a newer version becomes known, so the menu can be rebuilt.
export function createUpdater({ app, getWindow, onChange }) {
  const seenFile = path.join(app.getPath("userData"), "update-notified.txt")
  let available = null

  async function offer(found) {
    const { response } = await dialog.showMessageBox(getWindow() ?? undefined, {
      message: `Creative Space ${found.version} is available`,
      detail: `You have ${app.getVersion()}.`,
      buttons: ["Download", "Later"],
      defaultId: 0,
      cancelId: 1,
    })
    if (response === 0) shell.openExternal(found.url)
  }

  async function announce(found) {
    let seen = ""
    try {
      seen = fs.readFileSync(seenFile, "utf8").trim()
    } catch {
      // first time
    }
    if (seen === found.version) return
    fs.writeFileSync(seenFile, found.version)
    await offer(found)
  }

  async function check({ manual = false } = {}) {
    const found = await fetchLatest(app.getVersion())
    if (found.status === "available") {
      const isNew = available?.version !== found.version
      available = found
      if (isNew) onChange()
      if (manual) await offer(found)
      else if (isNew) await announce(found)
    } else if (manual) {
      await dialog.showMessageBox(getWindow() ?? undefined, {
        message: found.status === "current" ? "You're up to date" : "Couldn't check for updates",
        detail:
          found.status === "current"
            ? `Creative Space ${app.getVersion()} is the latest version.`
            : "Check your internet connection and try again.",
      })
    }
  }

  return {
    check,
    get available() {
      return available
    },
    start() {
      check()
      setInterval(check, CHECK_EVERY_MS).unref()
    },
  }
}
