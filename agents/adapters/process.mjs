import { spawn } from "node:child_process"

/**
 * Spawn a CLI, feed it the prompt on stdin, stream its output into the run log.
 * Resolves with the full stdout/stderr and exit code; kills the process on timeout or
 * when `signal` (an AbortSignal — the Stop button) fires.
 *
 * `onLine` gets stdout one line at a time, as it arrives — a CLI streaming JSON events is watched
 * for loops that way (`agents/loops.mjs`); its stdout then stays out of the log, which gets the
 * watcher's one-line summary of each step instead of every file the agent read.
 */
export function runCommand(bin, args, { cwd, stdin, log, timeoutMs = 20 * 60 * 1000, signal, onLine }) {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(bin, args, { cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] })
    } catch (error) {
      reject(error)
      return
    }
    let stdout = ""
    let stderr = ""
    let settled = false
    const kill = (why) => {
      if (settled) return
      log(`\n[worker] ${why} — killing ${bin}\n`)
      child.kill("SIGTERM")
      setTimeout(() => child.kill("SIGKILL"), 5000).unref()
    }
    const timer = setTimeout(() => kill(`timeout after ${Math.round(timeoutMs / 1000)}s`), timeoutMs)
    // A string reason says why (the worker's run timeout); Stop aborts without one.
    const onAbort = () => kill(typeof signal.reason === "string" ? signal.reason : "stopped")
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener("abort", onAbort, { once: true })
    }

    let pending = ""
    const feed = (text) => {
      try {
        onLine(text)
      } catch (error) {
        void log(`\n[worker] could not read a line of ${bin}'s output: ${error.message}\n`)
      }
    }
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString()
      stdout += text
      if (!onLine) {
        void log(text)
        return
      }
      pending += text
      const lines = pending.split("\n")
      pending = lines.pop() ?? ""
      for (const line of lines) feed(line)
    })
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString()
      stderr += text
      void log(text)
    })
    child.on("error", (error) => {
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
      reject(
        error.code === "ENOENT"
          ? new Error(`${bin} is not installed or not on PATH (set CS_CLAUDE_BIN / CS_CODEX_BIN)`)
          : error
      )
    })
    child.on("close", (code) => {
      if (onLine && pending) feed(pending)
      pending = ""
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
      resolve({ stdout, stderr, code: code ?? -1 })
    })

    if (stdin != null) {
      child.stdin.on("error", () => {})
      child.stdin.write(stdin)
      child.stdin.end()
    } else {
      child.stdin.end()
    }
  })
}
