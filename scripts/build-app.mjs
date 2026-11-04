#!/usr/bin/env node
// The board's half of the Mac app: a standalone Next.js build in .next/standalone with the
// static files it does not copy on its own (Next leaves those to a CDN). electron-builder
// then packs that folder, agents/ and the bundled git into the app (electron-builder.yml).
//
//   node scripts/build-app.mjs

import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const STANDALONE = path.join(ROOT, ".next", "standalone")

fs.rmSync(STANDALONE, { recursive: true, force: true })
const build = spawnSync(process.execPath, [path.join(ROOT, "node_modules", "next", "dist", "bin", "next"), "build"], {
  cwd: ROOT,
  env: { ...process.env, CS_STANDALONE: "1" },
  stdio: "inherit",
})
if (build.status !== 0) process.exit(build.status ?? 1)

// Defense in depth: keep only server files even if future tracing changes pull in runtime
// data or the repository. The owner's .env, .git and data/ must never ship inside the DMG.
const KEEP = new Set(["server.js", "package.json", "node_modules", ".next"])
for (const entry of fs.readdirSync(STANDALONE)) {
  if (!KEEP.has(entry)) fs.rmSync(path.join(STANDALONE, entry), { recursive: true, force: true })
}

fs.cpSync(path.join(ROOT, "public"), path.join(STANDALONE, "public"), { recursive: true })
fs.cpSync(path.join(ROOT, ".next", "static"), path.join(STANDALONE, ".next", "static"), { recursive: true })
