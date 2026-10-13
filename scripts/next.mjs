#!/usr/bin/env node
// `npm run dev` / `npm run start`: Next.js on the board's port, bound to this
// computer only. Next listens on every interface by default, and anyone who can
// reach the board can queue cards that agents run with write access to the
// owner's files — so the address is 127.0.0.1 unless HOST says otherwise.
// A script rather than flags in package.json: a shell default for HOST
// (`${HOST:-127.0.0.1}`) would not work in Windows' cmd.
//
//   node scripts/next.mjs dev|start

import { spawn } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const PORT = process.env.PORT ?? "43123"
const HOST = process.env.HOST || "127.0.0.1"

const child = spawn(
  process.execPath,
  [path.join(ROOT, "node_modules", "next", "dist", "bin", "next"), process.argv[2] ?? "dev", "--port", PORT, "--hostname", HOST],
  { cwd: ROOT, stdio: "inherit" },
)
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal))
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)))
