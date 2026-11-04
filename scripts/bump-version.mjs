// `npm run version:bump -- patch|minor|major|x.y.z [--dry]` rewrites "version" in package.json
// and package-lock.json, nothing else. No commit, no tag (unlike `npm version`): cutting a
// release is the owner's call. The Mac app compares this number with the latest GitHub Release.

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const [kind = "patch", ...flags] = process.argv.slice(2)
const pkgPath = path.join(root, "package.json")
const lockPath = path.join(root, "package-lock.json")
const current = JSON.parse(fs.readFileSync(pkgPath, "utf8")).version

const [major, minor, patch] = current.split(".").map(Number)
const next = /^\d+\.\d+\.\d+$/.test(kind)
  ? kind
  : { major: `${major + 1}.0.0`, minor: `${major}.${minor + 1}.0`, patch: `${major}.${minor}.${patch + 1}` }[kind]
if (!next) {
  console.error("Usage: npm run version:bump -- patch|minor|major|x.y.z [--dry]")
  process.exit(1)
}

console.log(`${current} -> ${next}`)
if (flags.includes("--dry")) process.exit(0)

// Textual replace, so the files keep their formatting. The lockfile names the root package
// twice: at the top and under packages[""].
const version = /("version": ")[^"]+(")/
fs.writeFileSync(pkgPath, fs.readFileSync(pkgPath, "utf8").replace(version, `$1${next}$2`))
if (fs.existsSync(lockPath)) {
  const rootEntry = /("packages": \{\s*"": \{[^}]*?"version": ")[^"]+(")/
  fs.writeFileSync(
    lockPath,
    fs.readFileSync(lockPath, "utf8").replace(version, `$1${next}$2`).replace(rootEntry, `$1${next}$2`)
  )
}
