#!/usr/bin/env node
// Creative Space agent worker.
//
// Polls the board for queued runs, executes them as Architect or Coder, and
// writes the result back through the same HTTP API the UI uses — so the
// browser sees every step live. One run at a time per agent.
//
//   npm run worker            # stub mode: no model calls, exercises the loop
//   npm run worker:live       # both agents on Claude Code (CS_CODER=codex for Codex CLI)
//
// Environment:
//   CS_API            board URL              (default http://localhost:43123)
//   CS_AGENT_MODE     stub | live            (default stub)
//   CS_ARCHITECT      stub | claude | codex  (default claude in live mode)
//   CS_CODER          stub | claude | codex  (default claude in live mode; codex if you have Codex CLI)
//   CS_POLL_MS        poll interval          (default 2000)
//   CS_RUN_TIMEOUT_MS max run duration       (default 20 minutes)

import { execFile } from "node:child_process"
import { runStub } from "./adapters/stub.mjs"
import { runClaude } from "./adapters/claude.mjs"
import { runCodex } from "./adapters/codex.mjs"
import { sleep } from "./lib.mjs"

const API = (process.env.CS_API ?? "http://localhost:43123").replace(/\/$/, "")
const MODE = process.env.CS_AGENT_MODE === "live" ? "live" : "stub"
const POLL_MS = Number(process.env.CS_POLL_MS ?? 2000)
const RUN_TIMEOUT_MS = Number(process.env.CS_RUN_TIMEOUT_MS ?? 20 * 60 * 1000)

const ENGINES = { stub: runStub, claude: runClaude, codex: runCodex }

const AGENTS = [
  { id: "architect", role: "architect", engine: pickEngine("architect", process.env.CS_ARCHITECT, "claude") },
  { id: "coder", role: "coder", engine: pickEngine("coder", process.env.CS_CODER, "claude") },
]

function pickEngine(role, override, liveDefault) {
  if (MODE === "stub") return "stub"
  const wanted = (override ?? liveDefault).toLowerCase()
  if (!ENGINES[wanted]) {
    console.error(`[worker] unknown engine '${wanted}' for ${role}; using stub`)
    return "stub"
  }
  return wanted
}

// --- HTTP ------------------------------------------------------------------

async function call(method, path, body) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = { raw: text }
  }
  if (!response.ok) {
    const hint =
      response.status === 404 && text.startsWith("<!DOCTYPE")
        ? " — that is not the Creative Space server (is another app on this port?); set CS_API to the board URL"
        : ""
    throw new Error(`${method} ${path} → ${response.status}: ${data?.error ?? text.slice(0, 120)}${hint}`)
  }
  return data
}

/** Batches log chunks so a chatty CLI doesn't hammer the API. */
function makeLogger(runId) {
  let buffer = ""
  let timer = null
  let chain = Promise.resolve()
  const flush = () => {
    if (!buffer) return chain
    const chunk = buffer
    buffer = ""
    chain = chain
      .then(() => call("PATCH", `/api/agents/runs/${runId}`, { appendLog: chunk }))
      .catch((error) => console.error(`[worker] log append failed: ${error.message}`))
    return chain
  }
  const log = (text) => {
    if (!text) return Promise.resolve()
    buffer += text
    if (buffer.length > 4000) return flush()
    if (!timer) {
      timer = setTimeout(() => {
        timer = null
        void flush()
      }, 1200)
    }
    return Promise.resolve()
  }
  const close = async () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    await flush()
    await chain
  }
  return { log, close }
}

// --- one run -----------------------------------------------------------------

async function execute(agent, context) {
  const { run, task } = context
  // A board can pin an engine per role (Board details); otherwise the worker default.
  const boardEngine = MODE === "live" ? context.board?.engines?.[agent.role] : null
  const engineName = boardEngine && ENGINES[boardEngine] ? boardEngine : agent.engine
  const engine = ENGINES[engineName]
  const logger = makeLogger(run.id)
  const label = `${agent.id}/${engineName} run#${run.id} task=${task.id}`
  console.log(`[worker] ▶ ${label} (${run.trigger}) "${task.title}"`)

  try {
    await logger.log(`[worker] ${agent.id} via ${engineName} · trigger ${run.trigger}\n`)
    const result = await engine(agent.role, context, { log: logger.log, timeoutMs: RUN_TIMEOUT_MS })
    const reply = (result.reply ?? "").trim()
    const actions = Array.isArray(result.actions) ? result.actions : []

    if (reply) {
      await call("POST", `/api/tasks/${encodeURIComponent(task.id)}/messages`, {
        authorId: agent.id,
        text: reply,
      })
    }
    for (const action of actions) {
      if (action.type === "move" && action.to) {
        await logger.log(`[worker] moving task to ${action.to}\n`)
        await call("PATCH", `/api/tasks/${encodeURIComponent(task.id)}`, { columnRole: action.to })
      }
    }
    await logger.close()
    await call("PATCH", `/api/agents/runs/${run.id}`, {
      status: "done",
      summary: result.summary ?? reply.slice(0, 300),
    })
    console.log(`[worker] ✔ ${label}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[worker] ✖ ${label}: ${message}`)
    if (/authenticat|oauth|log ?in/i.test(message)) {
      // Every run would fail the same way; don't flood the chat — wait for a fix.
      console.error("[worker] looks like a login problem — pausing 60s before the next run")
      pauseUntil = Date.now() + 60_000
    }
    try {
      await logger.log(`\n[worker] failed: ${message}\n`)
      await logger.close()
      await call("POST", `/api/tasks/${encodeURIComponent(task.id)}/messages`, {
        authorId: agent.id,
        text: `I couldn't finish this run (${engineName}): ${message.slice(0, 300)}`,
      })
      await call("PATCH", `/api/agents/runs/${run.id}`, { status: "failed", summary: message.slice(0, 300) })
    } catch (inner) {
      console.error(`[worker] could not report failure: ${inner instanceof Error ? inner.message : inner}`)
    }
  }
}

// --- main loop ---------------------------------------------------------------

let stopping = false
let pauseUntil = 0
process.on("SIGINT", () => {
  stopping = true
  console.log("\n[worker] stopping after the current run…")
})
process.on("SIGTERM", () => {
  stopping = true
})

/** Live mode: make sure the CLIs exist before claiming any run. */
async function preflight() {
  const bins = {
    claude: process.env.CS_CLAUDE_BIN ?? "claude",
    codex: process.env.CS_CODEX_BIN ?? "codex",
  }
  let ok = true
  for (const engine of new Set(AGENTS.map((a) => a.engine).filter((e) => e !== "stub"))) {
    const bin = bins[engine]
    const version = await new Promise((resolve) => {
      execFile(bin, ["--version"], { timeout: 15000 }, (error, stdout, stderr) => {
        resolve(error ? null : (stdout || stderr).toString().trim().split("\n")[0])
      })
    })
    if (version) {
      console.log(`[worker] ${engine}: ${version}`)
    } else {
      ok = false
      console.error(
        `[worker] ${engine}: '${bin}' not found or not runnable. Install and log in ` +
          (engine === "claude" ? "(npm i -g @anthropic-ai/claude-code && claude)" : "(npm i -g @openai/codex && codex login)") +
          `, or point CS_${engine.toUpperCase()}_BIN at it.`
      )
    }
  }
  return ok
}

async function main() {
  console.log(`[worker] board ${API} · mode ${MODE}`)
  for (const agent of AGENTS) console.log(`[worker] ${agent.id} → ${agent.engine}`)
  if (MODE === "live") {
    console.log("[worker] live mode: every run spends quota on your Claude / ChatGPT plans")
    if (!(await preflight())) {
      console.error("[worker] fix the missing CLI and start again; nothing was claimed")
      process.exit(1)
    }
  }

  // Anything left 'running' by a previous worker process goes back to the queue.
  for (const agent of AGENTS) {
    try {
      const { requeued } = await call("POST", "/api/agents/requeue", { agentId: agent.id })
      if (requeued) console.log(`[worker] requeued ${requeued} stale run(s) for ${agent.id}`)
    } catch (error) {
      console.error(`[worker] board not reachable yet: ${error.message}`)
    }
  }

  let offline = false
  while (!stopping) {
    if (Date.now() < pauseUntil) {
      await sleep(Math.min(pauseUntil - Date.now(), 5000))
      continue
    }
    let worked = false
    for (const agent of AGENTS) {
      if (stopping) break
      let context
      try {
        context = await call("POST", "/api/agents/claim", { agentId: agent.id })
        if (offline) {
          offline = false
          console.log("[worker] board is back")
        }
      } catch (error) {
        if (!offline) console.error(`[worker] board unreachable: ${error.message}`)
        offline = true
        break
      }
      if (context && context.run) {
        worked = true
        await execute(agent, context)
      }
    }
    if (!worked) await sleep(offline ? Math.max(POLL_MS, 5000) : POLL_MS)
  }
  console.log("[worker] bye")
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
