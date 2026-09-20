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

async function execute(agent, context) {
  const { run, task, board } = context
  const engineName = engineFor(agent)
  const engine = ENGINES[engineName]
  const logger = makeLogger(run.id)
  const label = `${agent.handle}/${engineName} run#${run.id} task=${task.id}`
  console.log(`[worker] ▶ ${label} (${run.trigger}) "${task.title}"`)

  try {
    const config = agent.agent ?? {}
    const tuning = [config.model, config.effort && `effort ${config.effort}`].filter(Boolean).join(", ")
    await logger.log(`[worker] ${agent.name} via ${engineName}${tuning ? ` (${tuning})` : ""} · trigger ${run.trigger}\n`)
    const result = await engine(agent.agentRole, context, { log: logger.log, timeoutMs: RUN_TIMEOUT_MS })
    const reply = (result.reply ?? "").trim()
    const actions = Array.isArray(result.actions) ? result.actions : []
    const dispatching = run.trigger === "dispatch"

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

/** Live mode: make sure the CLIs the agents need exist before claiming any run. */
async function preflight(agents) {
  const bins = {
    claude: process.env.CS_CLAUDE_BIN ?? "claude",
    codex: process.env.CS_CODEX_BIN ?? "codex",
  }
  let ok = true
  for (const engine of new Set(agents.map(engineFor).filter((e) => e !== "stub"))) {
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
  if (MODE === "live" && !(await preflight(agents))) {
    console.error("[worker] fix the missing CLI and start again; nothing was claimed")
    process.exit(1)
  }

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
