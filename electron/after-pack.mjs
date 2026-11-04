// electron-builder hook: copies the board's server and the bundled git into
// Contents/Resources. extraResources cannot do it — its filter silently drops node_modules
// and dot folders (.next), which are the server, and it dereferences git's 148 symlinks
// into full copies of the binary.
import fs from "node:fs"
import path from "node:path"

export default async function afterPack(context) {
  const root = context.packager.projectDir
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  const resources = path.join(app, "Contents", "Resources")
  const copy = (from, to) => {
    fs.rmSync(path.join(resources, to), { recursive: true, force: true })
    fs.cpSync(path.join(root, from), path.join(resources, to), { recursive: true, verbatimSymlinks: true })
  }
  copy(path.join(".next", "standalone"), "server")
  copy(path.join("node_modules", "dugite", "git"), "git")
}
