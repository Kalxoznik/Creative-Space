#!/usr/bin/env node
// Creative Space agent worker.
//
// Asks the board which agents exist, polls for their queued runs, executes each run
// through the agent's engine (Claude Code / Codex CLI / stub) and writes the result back
// through the same HTTP API the UI uses — so the browser sees every step live.
//
// Agents run in parallel (one run at a time each); the board itself makes sure only one
// coder run executes per repository, so two agents never edit the same checkout at once.
// Agents and their configuration (engine, model, effort, turn limit, extra instructions)
// live on the board — Agents in the sidebar — and are picked up without a restart.
//
//   npm run worker            # stub mode: no model calls, exercises the loop
//   npm run worker:live       # real CLIs, spends quota on your Claude / ChatGPT plans
//
// Environment:
//   CS_API             board URL                 (default http://localhost:43123)
//   CS_AGENT_MODE      stub | live               (default stub)
//   CS_POLL_MS         poll interval             (default 2000)
//   CS_RUN_TIMEOUT_MS  max run duration          (default 20 minutes)
//   CS_CLAUDE_BIN / CS_CODEX_BIN                 CLI binaries
//   CS_CLAUDE_MAX_TURNS                          turn limit for agents that set none
//   CS_CHECK_TIMEOUT_MS                          max duration of a board's check command (default 10 minutes)

import { execFile } from "node:child_process"
import { runStub } from "./adapters/stub.mjs"
import { runClaude } from "./adapters/claude.mjs"
import { runCodex } from "./adapters/codex.mjs"
import { runCommand } from "./adapters/process.mjs"
import { sleep } from "./lib.mjs"

const API = (process.env.CS_API ?? "http://localhost:43123").replace(/\/$/, "")
const MODE = process.env.CS_AGENT_MODE === "live" ? "live" : "stub"
const POLL_MS = Number(process.env.CS_POLL_MS ?? 2000)
const RUN_TIMEOUT_MS = Number(process.env.CS_RUN_TIMEOUT_MS ?? 20 * 60 * 1000)
const CHECK_TIMEOUT_MS = Number(process.env.CS_CHECK_TIMEOUT_MS ?? 10 * 60 * 1000)
/** How often the board hears from us, and how often a running run looks for the Stop flag. */
const HEARTBEAT_MS = 5000
const CANCEL_POLL_MS = 3000
/** Re-check the CLIs now and then, so an install or login done meanwhile shows up on the board. */
const CLI_RECHECK_MS = 60_000

const ENGINES = { stub: runStub, claude: runClaude, codex: runCodex }

/** Which adapter runs this agent: its own engine in live mode, the stub otherwise. */
function engineFor(agent) {
  if (MODE === "stub") return "stub"
  const wanted = agent.agent?.engine ?? "claude"
  return ENGINES[wanted] ? wanted : "claude"
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

/** Run the board's check command in the repository; resolves with { code, output }. */
async function runCheck(command, cwd, { log, signal }) {
  const [bin, args] = process.platform === "win32" ? ["cmd", ["/c", command]] : ["sh", ["-c", command]]
  await log(`\n[worker] check: ${command}\n`)
  const { stdout, stderr, code } = await runCommand(bin, args, { cwd, log, timeoutMs: CHECK_TIMEOUT_MS, signal })
  return { code, output: `${stdout}${stderr}` }
}

async function execute(agent, context) {
  const { run, task, board } = context
  const engineName = engineFor(agent)
  const engine = ENGINES[engineName]
  const logger = makeLogger(run.id)
  const label = `${agent.handle}/${engineName} run#${run.id} task=${task.id}`
  console.log(`[worker] ▶ ${label} (${run.trigger}) "${task.title}"`)

  // The Stop button sets cancelRequested on the run; we poll for it and abort the CLI.
  const stop = new AbortController()
  const watcher = setInterval(() => {
    call("GET", `/api/agents/runs/${run.id}`)
      .then((latest) => {
        if (latest?.cancelRequested && !stop.signal.aborted) stop.abort()
      })
      .catch(() => {})
  }, CANCEL_POLL_MS)

  try {
    const config = agent.agent ?? {}
    const tuning = [config.model, config.effort && `effort ${config.effort}`].filter(Boolean).join(", ")
    await logger.log(`[worker] ${agent.name} via ${engineName}${tuning ? ` (${tuning})` : ""} · trigger ${run.trigger}\n`)
    const result = await engine(agent.agentRole, context, { log: logger.log, timeoutMs: RUN_TIMEOUT_MS, signal: stop.signal })
    if (stop.signal.aborted) throw new Error("stopped")
    const reply = (result.reply ?? "").trim()
    let actions = Array.isArray(result.actions) ? result.actions : []
    const dispatching = run.trigger === "dispatch"
    let checkNote = null

    // A coder hands a card to Review → the board's check command must pass first.
    const handingOff = agent.agentRole === "coder" && actions.some((a) => a.type === "move" && a.to === "review")
    if (handingOff && board.checkCommand) {
      const cwd = board.repoPath ?? process.cwd()
      const { code, output } = await runCheck(board.checkCommand, cwd, { log: logger.log, signal: stop.signal })
      if (stop.signal.aborted) throw new Error("stopped")
      if (code === 0) {
        await logger.log("[worker] check passed\n")
        checkNote = `Check passed: ${board.checkCommand}`
      } else {
        await logger.log(`[worker] check failed (exit ${code}) — the card stays in In progress\n`)
        actions = actions.filter((a) => !(a.type === "move" && a.to === "review"))
        checkNote = `Check failed (exit ${code}): ${board.checkCommand}`
        // Post the reply first so the thread reads in order: coder → check output.
        if (reply) {
          await call("POST", `/api/tasks/${encodeURIComponent(task.id)}/messages`, { authorId: agent.id, text: reply })
        }
        await call("POST", `/api/tasks/${encodeURIComponent(task.id)}/check`, {
          actorId: agent.id,
          command: board.checkCommand,
          exitCode: code,
          output: output.slice(-4000),
        })
        await logger.close()
        await call("PATCH", `/api/agents/runs/${run.id}`, { status: "done", summary: checkNote })
        clearInterval(watcher)
        console.log(`[worker] ✔ ${label} (check failed)`)
        return
      }
    }

    if (reply) {
      await call("POST", `/api/tasks/${encodeURIComponent(task.id)}/messages`, {
        authorId: agent.id,
        text: reply,
        // A dispatch note is about the queue, not this card — it must not tag the Architect on it.
        ...(dispatching ? { participant: false } : {}),
      })
    }
    if (dispatching) {
      if (result.decision) {
        const outcome = await call("POST", `/api/boards/${encodeURIComponent(board.id)}/dispatch`, {
          actorId: agent.id,
          ...result.decision,
        })
        await logger.log(
          `[worker] dispatch applied: ${outcome.assigned} card(s) assigned, ${outcome.pulled.length} started\n`
        )
      } else {
        await logger.log("[worker] no dispatch decision in the reply — the queue is left as it was\n")
      }
    }
    if (checkNote) {
      await call("POST", `/api/tasks/${encodeURIComponent(task.id)}/messages`, { authorId: agent.id, kind: "system", text: checkNote })
    }
    for (const action of actions) {
      if (action.type === "move" && action.to) {
        await logger.log(`[worker] moving task to ${action.to}\n`)
        // actorId lets the board say who moved the card — and, for a coder, hand it the next Ready card.
        await call("PATCH", `/api/tasks/${encodeURIComponent(task.id)}`, { columnRole: action.to, actorId: agent.id })
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
    if (stop.signal.aborted) {
      console.log(`[worker] ■ ${label}: stopped`)
      try {
        await logger.log("\n[worker] stopped\n")
        await logger.close()
        await call("POST", `/api/tasks/${encodeURIComponent(task.id)}/messages`, {
          authorId: agent.id,
          kind: "system",
          text: `${agent.name}'s run was stopped. The card stays where it is.`,
        })
        await call("PATCH", `/api/agents/runs/${run.id}`, { status: "cancelled", summary: "Stopped" })
      } catch (inner) {
        console.error(`[worker] could not report the stop: ${inner instanceof Error ? inner.message : inner}`)
      }
      clearInterval(watcher)
      return
    }
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
        ...(run.trigger === "dispatch" ? { participant: false } : {}),
      })
      await call("PATCH", `/api/agents/runs/${run.id}`, { status: "failed", summary: message.slice(0, 300) })
    } catch (inner) {
      console.error(`[worker] could not report failure: ${inner instanceof Error ? inner.message : inner}`)
    }
  } finally {
    clearInterval(watcher)
  }
}

// --- main loop ---------------------------------------------------------------

let stopping = false
let pauseUntil = 0
process.on("SIGINT", () => {
  stopping = true
  console.log("\n[worker] stopping after the current run(s)…")
})
process.on("SIGTERM", () => {
  stopping = true
})

async function fetchAgents() {
  const { agents } = await call("GET", "/api/agents")
  return Array.isArray(agents) ? agents : []
}

const BINS = {
  claude: process.env.CS_CLAUDE_BIN ?? "claude",
  codex: process.env.CS_CODEX_BIN ?? "codex",
}

/**
 * Which CLIs are runnable: { claude: "2.1.x" | null, codex: … }. Reported to the board
 * in every heartbeat, so a missing CLI shows up there instead of only in this terminal.
 */
async function cliVersions(engines) {
  const out = {}
  for (const engine of engines) {
    const bin = BINS[engine]
    if (!bin) continue
    out[engine] = await new Promise((resolve) => {
      execFile(bin, ["--version"], { timeout: 15000 }, (error, stdout, stderr) => {
        resolve(error ? null : (stdout || stderr).toString().trim().split("\n")[0])
      })
    })
  }
  return out
}

function complain(engine) {
  console.error(
    `[worker] ${engine}: '${BINS[engine]}' not found or not runnable. Install and log in ` +
      (engine === "claude" ? "(npm i -g @anthropic-ai/claude-code && claude)" : "(npm i -g @openai/codex && codex login)") +
      `, or point CS_${engine.toUpperCase()}_BIN at it. Runs of agents on ${engine} will fail until then.`
  )
}

let engines = {}
let lastBeat = 0
let lastCliCheck = 0

/** Tell the board we are alive (and which CLIs we found). Silent on failure — the poll loop reports outages. */
async function heartbeat(agents, { force = false } = {}) {
  const now = Date.now()
  if (!force && now - lastBeat < HEARTBEAT_MS) return
  if (MODE === "live" && (force || now - lastCliCheck > CLI_RECHECK_MS)) {
    const wanted = new Set(agents.map(engineFor).filter((e) => e !== "stub"))
    const fresh = await cliVersions([...wanted])
    for (const [engine, version] of Object.entries(fresh)) {
      if (version && !engines[engine]) console.log(`[worker] ${engine}: ${version}`)
      if (!version && (force || engines[engine])) complain(engine)
    }
    engines = fresh
    lastCliCheck = Date.now()
  }
  lastBeat = now
  try {
    await call("POST", "/api/agents/heartbeat", { mode: MODE, engines })
  } catch {
    // the poll loop will notice the board is gone
  }
}

function describe(agent) {
  const c = agent.agent ?? {}
  const bits = [engineFor(agent), c.model, c.effort && `effort ${c.effort}`, c.maxTurns && `${c.maxTurns} turns`].filter(Boolean)
  return `${agent.name} (@${agent.handle}, ${agent.agentRole}) → ${bits.join(", ")}`
}

async function main() {
  console.log(`[worker] board ${API} · mode ${MODE}`)
  if (MODE === "live") console.log("[worker] live mode: every run spends quota on your Claude / ChatGPT plans")

  // Wait for the board, then learn who the agents are.
  let agents = []
  for (;;) {
    try {
      agents = await fetchAgents()
      break
    } catch (error) {
      if (stopping) return
      console.error(`[worker] board not reachable yet: ${error.message}`)
      await sleep(3000)
    }
  }
  if (agents.length === 0) console.log("[worker] no agents yet — add one under Agents in the sidebar")
  for (const agent of agents) console.log(`[worker] ${describe(agent)}`)
  await heartbeat(agents, { force: true })

  // Anything left 'running' by a previous worker process goes back to the queue.
  for (const agent of agents) {
    try {
      const { requeued } = await call("POST", "/api/agents/requeue", { agentId: agent.id })
      if (requeued) console.log(`[worker] requeued ${requeued} stale run(s) for ${agent.handle}`)
    } catch (error) {
      console.error(`[worker] requeue failed for ${agent.handle}: ${error.message}`)
    }
  }

  const known = new Map(agents.map((a) => [a.id, describe(a)]))
  const busy = new Map() // agentId → promise of the run in flight
  let offline = false
  while (!stopping) {
    if (Date.now() < pauseUntil) {
      await sleep(Math.min(pauseUntil - Date.now(), 5000))
      continue
    }
    try {
      agents = await fetchAgents()
      if (offline) {
        offline = false
        console.log("[worker] board is back")
      }
    } catch (error) {
      if (!offline) console.error(`[worker] board unreachable: ${error.message}`)
      offline = true
      await sleep(Math.max(POLL_MS, 5000))
      continue
    }
    // Agents added or reconfigured while we run: say so once.
    for (const agent of agents) {
      const line = describe(agent)
      if (known.get(agent.id) !== line) {
        console.log(`[worker] ${known.has(agent.id) ? "updated" : "new agent"}: ${line}`)
        known.set(agent.id, line)
      }
    }
    await heartbeat(agents)

    let claimed = false
    for (const agent of agents) {
      if (stopping || busy.has(agent.id)) continue
      let context
      try {
        context = await call("POST", "/api/agents/claim", { agentId: agent.id })
      } catch (error) {
        console.error(`[worker] claim failed for ${agent.handle}: ${error.message}`)
        break
      }
      if (context && context.run) {
        claimed = true
        const job = execute(agent, context).finally(() => busy.delete(agent.id))
        busy.set(agent.id, job)
      }
    }
    if (!claimed) await sleep(POLL_MS)
  }
  if (busy.size > 0) {
    console.log(`[worker] waiting for ${busy.size} run(s) to finish…`)
    await Promise.all(busy.values())
  }
  console.log("[worker] bye")
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
