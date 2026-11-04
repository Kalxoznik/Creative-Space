// Shared by the board, worker and adapters: the app has no implicit project checkout.
import fs from "node:fs"
import path from "node:path"

export function appMode() {
  return process.env.CS_APP === "1"
}

// A folder merely named "x.app" (a project named after its domain) is not a bundle; a real one
// has Contents/Info.plist.
/** @param {string} p */
function insideBundle(p) {
  for (let cur = p; ; cur = path.dirname(cur)) {
    if (/\.app$/i.test(path.basename(cur)) && fs.existsSync(path.join(/* turbopackIgnore: true */ cur, "Contents", "Info.plist"))) return true
    if (path.dirname(cur) === cur) return false
  }
}

/** @param {string | null | undefined} dir @param {boolean} [allowMissing] */
export function projectDirError(dir, allowMissing = false) {
  if (!appMode()) return null
  if (!dir?.trim() || !path.isAbsolute(dir)) {
    return "Choose an absolute project folder in Board settings before running agents."
  }
  try {
    // For a folder about to be created, resolve the nearest existing parent as well. This
    // catches a workspace root symlink into an app before mkdir or git can write anything.
    let parent = dir
    while (allowMissing && !fs.existsSync(/* turbopackIgnore: true */ parent)) {
      const next = path.dirname(parent)
      if (next === parent) break
      parent = next
    }
    const real = fs.realpathSync(/* turbopackIgnore: true */ parent)
    if (insideBundle(real) || insideBundle(path.resolve(/* turbopackIgnore: true */ dir))) {
      return "Choose a project folder outside the app bundle before running agents."
    }
    if (fs.statSync(/* turbopackIgnore: true */ real).isDirectory()) return null
  } catch {
    // A missing or inaccessible folder must never fall back to the app or the worker's cwd.
  }
  return "The project folder is unavailable. Choose an existing folder in Board settings before running agents."
}

/** @param {string | null | undefined} dir @param {string} fallback */
export function projectDir(dir, fallback) {
  const error = projectDirError(dir)
  if (error) throw new Error(error)
  return dir ?? fallback
}
