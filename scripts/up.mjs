#!/usr/bin/env node
// One command for the whole space: the board (Next.js dev server) and the
// agent worker together, browser opened once the board answers, both stopped
// with a single Ctrl+C.
//
//   npm run up                      # board + live agents
//   CS_AGENT_MODE=stub npm run up   # board + stub agents (no model calls)
//   CS_NO_OPEN=1 npm run up         # don't open the browser

import { spawn } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const PORT = process.env.PORT ?? "43123"
const URL = `http://localhost:${PORT}`
const MODE = process.env.CS_AGENT_MODE ?? "live"

const children = []
let shuttingDown = false

function run(label, color, command, args, extraEnv = {}) {
  const child = spawn(command, args, {
    cwd: ROOT,
    env: { ...process.env, FORCE_COLOR: "1", ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  })
  const tag = `\x1b[${color}m[${label}]\x1b[0m `
  const pipe = (stream, out) => {
    let rest = ""
    stream.on("data", (chunk) => {
      rest += chunk.toString()
      const lines = rest.split("\n")
      rest = lines.pop() ?? ""
      for (const line of lines) out.write(tag + line + "\n")
    })
    stream.on("end", () => {
      if (rest) out.write(tag + rest + "\n")
    })
  }
  pipe(child.stdout, process.stdout)
  pipe(child.stderr, process.stderr)
  child.on("exit", (code, signal) => {
    if (shuttingDown) return
    console.log(`${tag}exited (${signal ?? code}) — stopping the rest`)
    shutdown(code ?? 0)
  })
  children.push(child)
  return child
}

function shutdown(code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  for (const child of children) {
    if (child.exitCode == null) child.kill("SIGTERM")
  }
  setTimeout(() => {
    for (const child of children) {
      if (child.exitCode == null) child.kill("SIGKILL")
    }
    process.exit(code)
  }, 4000).unref()
}

process.on("SIGINT", () => {
  console.log("\n[space] stopping…")
  shutdown(0)
})
process.on("SIGTERM", () => shutdown(0))

async function waitForBoard(timeoutMs = 90_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`${URL}/api/state`)
      if (response.ok) return true
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 700))
  }
  return false
}

function openBrowser() {
  if (process.env.CS_NO_OPEN) return
  const opener =
    process.platform === "darwin" ? ["open", [URL]] : process.platform === "win32" ? ["cmd", ["/c", "start", URL]] : ["xdg-open", [URL]]
  spawn(opener[0], opener[1], { stdio: "ignore", detached: true }).unref()
}

console.log(`[space] Creative Space → ${URL} · agents: ${MODE}`)
run("board", "33", process.execPath, [path.join(ROOT, "node_modules", "next", "dist", "bin", "next"), "dev", "--port", PORT])

const up = await waitForBoard()
if (!up) {
  console.error("[space] the board did not come up in time")
  shutdown(1)
} else {
  openBrowser()
  run("agents", "36", process.execPath, [path.join(ROOT, "agents", "worker.mjs")], {
    CS_AGENT_MODE: MODE,
    CS_API: URL,
  })
}
