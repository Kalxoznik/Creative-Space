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
//   CS_BOARD_URL       the URL notifications link to    (default CS_API)
//   TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID        notifications over Telegram, and the replies to
//                                                them coming back into the cards; also read from .env

import { execFile } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { changedPaths, commitRun, gitSnapshot, parseSnapshot, serializeSnapshot } from "./git.mjs"
import { runStub } from "./adapters/stub.mjs"
import { runClaude } from "./adapters/claude.mjs"
import { runCodex } from "./adapters/codex.mjs"
import { runCommand } from "./adapters/process.mjs"
import { createNotifications } from "./notify.mjs"
import { createTelegramInbox } from "./telegram.mjs"
import { COMMIT_SUBJECT_MAX, sleep, taskRef } from "./lib.mjs"

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

// Exported so a test can swap an adapter for a fake one and drive a whole run.
export const ENGINES = { stub: runStub, claude: runClaude, codex: runCodex }

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

/**
 * Tell the board something for its event feed (the check, the commit). A line in the feed is
 * never worth failing a run over, so a refusal here only goes to the log.
 */
async function report(path, body) {
  try {
    await call("POST", path, body)
  } catch (error) {
    console.error(`[worker] could not report to ${path}: ${error.message}`)
  }
}

/**
 * Close a run on the board — the one step of a run that must happen.
 *
 * Everything else a finishing run does (the reply, the card's move, the log) can fail on its
 * own; a run left in `running` keeps its agent busy forever and leaves the card in In progress
 * with nobody on it. So this never throws, and it carries the tail of the log with it:
 * one request, and the log still lands when the flush before it did not.
 */
async function closeRun(runId, status, summary, logger, { tail = "", plain = null, turnLimit = false } = {}) {
  try {
    await logger.close()
  } catch (error) {
    console.error(`[worker] could not flush the log of run#${runId}: ${error.message}`)
  }
  try {
    await call("PATCH", `/api/agents/runs/${runId}`, {
      ...(tail ? { appendLog: tail } : {}),
      status,
      summary: summary || undefined,
      // The agent's `In short:` line, when the run got far enough to have written one: it is what
      // the owner's notification about a failed run says in words (`plain` on the feed event).
      ...(plain ? { plain } : {}),
      // This run ran out of turns and left work in the checkout: the board decides whether the
      // card gets one more run on it (`finishRun` in src/server/store.ts).
      ...(turnLimit ? { turnLimit: true } : {}),
    })
  } catch (error) {
    console.error(
      `[worker] could not close run#${runId} as ${status}: ${error.message}` +
        " — the board's watchdog will fail it once it stops hearing from this run"
    )
  }
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

/**
 * The commit message for a run: the coder's own subject (`"commit"` in its ACTIONS line), or the
 * card's title when it gave none the parser would take; then who did it and on which card.
 * The title is only the fallback: the owner writes cards as short tasks in their own language,
 * and a history of those reads like a to-do list rather than a history of the code.
 */
function commitMessage(agent, task, subject = null) {
  const title = task.title.replace(/\s+/g, " ").trim() || `Task ${task.id}`
  const fallback = title.length > COMMIT_SUBJECT_MAX ? `${title.slice(0, COMMIT_SUBJECT_MAX - 1)}…` : title
  return {
    subject: subject || fallback,
    trailer: `Creative Space task #${task.id}\nAgent: ${agent.name}`,
  }
}

const NO_SNAPSHOT = { isRepo: false, dirty: new Map(), head: null }
/** How many committed paths the card's chat lists by name. */
const COMMIT_FILES_SHOWN = 40
/** The system line a hand-off with no file changes leaves in the card's chat. */
export const NO_CHANGES_NOTE = "No file changes in this run — nothing to commit."

/**
 * What the repository looked like when work on this card started — the snapshot the commit is
 * taken against. The board keeps it on the card, because the run that does the work and the run
 * that hands the card off are usually not the same one (a chat message starts a new run): a
 * snapshot taken at the start of *this* run would see the earlier run's work as already there
 * and commit nothing.
 *
 * We offer what we see now and use whatever the card answers with; if the board cannot be
 * reached, this run's own snapshot is still better than no commit at all.
 */
async function workSnapshot(repo, taskId, { log, signal }) {
  const here = await gitSnapshot(repo, { signal })
  if (!here.isRepo) return here
  try {
    const { snapshot } = await call("POST", `/api/tasks/${encodeURIComponent(taskId)}/snapshot`, {
      snapshot: serializeSnapshot(here),
    })
    const kept = parseSnapshot(snapshot)
    if (!kept) return here
    if (snapshot !== serializeSnapshot(here)) {
      await log("[worker] committing against the state the card's work started from, not this run's\n")
    }
    return kept
  } catch (error) {
    await log(`[worker] could not read the card's starting snapshot (${error.message}) — using this run's\n`)
    return here
  }
}

/**
 * A run died. The order here is the point: the run is closed *first*, then the card's chat is
 * told. It used to be the other way round, and when the board refused the message (a dev server
 * whose database was behind its code) the PATCH below was never reached — the run stayed
 * `running` forever, its coder stayed busy and the card sat in In progress with nobody on it.
 * Each step stands on its own now: one failing does not take the others with it.
 */
export async function reportFailure({ run, task, agent, engineName, message, logger, plain = null, turnLimit = false }) {
  await closeRun(run.id, "failed", message.slice(0, 300), logger, {
    tail: `\n[worker] failed: ${message}\n`,
    plain,
    turnLimit,
  })
  try {
    await call("POST", `/api/tasks/${encodeURIComponent(task.id)}/messages`, {
      authorId: agent.id,
      text: `I couldn't finish this run (${engineName}): ${message.slice(0, 300)}`,
      ...(run.trigger === "dispatch" ? { participant: false } : {}),
    })
  } catch (inner) {
    console.error(`[worker] could not say in the chat that the run failed: ${inner instanceof Error ? inner.message : inner}`)
  }
}

export async function execute(agent, context) {
  const { run, task, board } = context
  const engineName = engineFor(agent)
  const engine = ENGINES[engineName]
  const logger = makeLogger(run.id)
  // The card's number first: that is how the card is called in the chats and in the UI.
  const ref = taskRef(board.key, task.number)
  const label = `${agent.handle}/${engineName} run#${run.id} task=${ref ? `${ref} ${task.id}` : task.id}`
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

  // What failed *after* the work itself — a chat message the board refused, a card it would not
  // move. It belongs in the run's summary, not in an exception: the work is done either way.
  const problems = []
  /** Run a reporting step; on failure note it and carry on. Stop still cancels the run. */
  const tolerate = async (what, fn) => {
    try {
      await fn()
    } catch (error) {
      if (stop.signal.aborted) throw error
      const message = error instanceof Error ? error.message : String(error)
      problems.push(`${what} failed: ${message}`)
      console.error(`[worker] ${label}: ${what} failed: ${message}`)
      await logger.log(`[worker] ${what} failed: ${message}\n`)
    }
  }
  const summaryOf = (...parts) => [...parts, ...problems].filter(Boolean).join(" · ").slice(0, 20000)

  // The agent's `In short:` line, once there is a reply to take it from: it travels with the
  // hand-off, the owner's flag and a failure, and is what the owner's notification says.
  // Declared out here so the failure below can still carry it.
  let plain = null
  // The state of the checkout the work on this card started from; out here because a run that
  // dies on its turn limit is judged against it too (see the catch below).
  let before = NO_SNAPSHOT

  try {
    const config = agent.agent ?? {}
    const tuning = [config.model, config.effort && `effort ${config.effort}`].filter(Boolean).join(", ")
    await logger.log(`[worker] ${agent.name} via ${engineName}${tuning ? ` (${tuning})` : ""} · trigger ${run.trigger}\n`)
    // The board commits a coder's work itself; to commit only what the work on this card touched
    // we need a fingerprint of the dirty files' contents from before it started — which paths
    // were dirty is not enough to see the agent's edit on top of one the owner had already made.
    if (agent.agentRole === "coder") {
      before = await workSnapshot(board.repoPath ?? process.cwd(), task.id, { log: logger.log, signal: stop.signal })
    }
    const result = await engine(agent.agentRole, context, { log: logger.log, timeoutMs: RUN_TIMEOUT_MS, signal: stop.signal })
    if (stop.signal.aborted) throw new Error("stopped")
    const reply = (result.reply ?? "").trim()
    plain = result.plain ?? null
    let actions = Array.isArray(result.actions) ? result.actions : []
    // The reply had an ACTIONS payload the parser could not use for something: say what was
    // wrong with it, whatever the trigger — otherwise the action silently never happens.
    if (result.problem) await logger.log(`[worker] ACTIONS not understood: ${result.problem}\n`)
    // The card stops on the owner's word: it does not move, so a `move` in the same line is
    // dropped here — before the check and the commit, which only belong to a real hand-off.
    const needsOwner = actions.find((a) => a.type === "needs_owner") ?? null
    if (needsOwner && actions.some((a) => a.type === "move")) {
      await logger.log(`[worker] waiting for the owner (${needsOwner.reason}) — the move is dropped\n`)
      actions = actions.filter((a) => a.type !== "move")
    }
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
        await report(`/api/tasks/${encodeURIComponent(task.id)}/check`, {
          actorId: agent.id,
          command: board.checkCommand,
          exitCode: 0,
        })
      } else {
        await logger.log(`[worker] check failed (exit ${code}) — the card stays in In progress\n`)
        actions = actions.filter((a) => !(a.type === "move" && a.to === "review"))
        checkNote = `Check failed (exit ${code}): ${board.checkCommand}`
        // Post the reply first so the thread reads in order: coder → check output.
        if (reply) {
          await tolerate("the reply", () =>
            call("POST", `/api/tasks/${encodeURIComponent(task.id)}/messages`, { authorId: agent.id, text: reply })
          )
        }
        await tolerate("reporting the check", () =>
          call("POST", `/api/tasks/${encodeURIComponent(task.id)}/check`, {
            actorId: agent.id,
            command: board.checkCommand,
            exitCode: code,
            output: output.slice(-4000),
          })
        )
        await closeRun(run.id, "done", summaryOf(checkNote), logger)
        clearInterval(watcher)
        console.log(`[worker] ✔ ${label} (check failed)`)
        return
      }
    }

    // Check passed (or there is none): the commit happens before the card moves on.
    let commitNote = null
    // The sha goes into the run's summary as well as the chat: if the chat message or the move
    // below is refused, the summary is the only place left that says the work was committed.
    let commitSha = null
    if (handingOff) {
      const outcome = await commitRun(board.repoPath ?? process.cwd(), commitMessage(agent, task, actions.find((a) => a.type === "commit")?.subject), before, {
        log: logger.log,
        signal: stop.signal,
      })
      if (stop.signal.aborted) throw new Error("stopped")
      // git refused: the card stays in In progress and the chat says why — a hand-off with its
      // commit missing is never silent.
      const blocked =
        outcome.failed !== undefined
          ? {
              note: `Commit failed (exit ${outcome.failed}) — the card stays in In progress.`,
              detail: " The changes are still in the working tree.",
              tail: (outcome.output ?? "").trim().slice(-2000),
              why: "commit failed",
            }
          : null
      // The card's work changed no file at all (a stub run, an answer-only card): there is nothing
      // to commit, and that is not a reason to hold the card — it goes on to the review like any
      // other hand-off, with a line in the chat saying no commit stands behind it.
      if (outcome.skipped === "unchanged") {
        await logger.log("[worker] no file changes — the hand-off goes on without a commit\n")
        commitNote = NO_CHANGES_NOTE
        await report(`/api/tasks/${encodeURIComponent(task.id)}/commit`, {
          actorId: agent.id,
          skipped: "nothing to commit",
        })
      }
      if (blocked) {
        await logger.log(`[worker] ${blocked.note}\n`)
        await report(`/api/tasks/${encodeURIComponent(task.id)}/commit`, {
          actorId: agent.id,
          skipped: blocked.why,
        })
        actions = actions.filter((a) => !(a.type === "move" && a.to === "review"))
        if (reply) {
          await tolerate("the reply", () =>
            call("POST", `/api/tasks/${encodeURIComponent(task.id)}/messages`, { authorId: agent.id, text: reply })
          )
        }
        if (checkNote) {
          await tolerate("the check note", () =>
            call("POST", `/api/tasks/${encodeURIComponent(task.id)}/messages`, { authorId: agent.id, kind: "system", text: checkNote })
          )
        }
        await tolerate("the commit note", () =>
          call("POST", `/api/tasks/${encodeURIComponent(task.id)}/messages`, {
            authorId: agent.id,
            kind: "system",
            text: `${blocked.note}${blocked.detail}${blocked.tail ? `\n\n\`\`\`\n${blocked.tail}\n\`\`\`` : ""}`,
          })
        )
        await closeRun(run.id, "done", summaryOf(blocked.note), logger)
        clearInterval(watcher)
        console.log(`[worker] ✔ ${label} (${blocked.why})`)
        return
      }
      if (outcome.committed) {
        // A sweeping change can touch hundreds of paths; the chat gets the first few dozen.
        const shown = outcome.paths.slice(0, COMMIT_FILES_SHOWN)
        const files = shown
          .map((file) => `- \`${file}\``)
          .concat(outcome.paths.length > shown.length ? [`- …and ${outcome.paths.length - shown.length} more`] : [])
          .join("\n")
        commitSha = outcome.sha ?? null
        commitNote = `Committed${outcome.sha ? ` \`${outcome.sha}\`` : ""} — ${outcome.paths.length} file(s):\n${files}`
        await report(`/api/tasks/${encodeURIComponent(task.id)}/commit`, {
          actorId: agent.id,
          sha: outcome.sha,
          files: outcome.paths,
        })
        // That work is in git now: the next round on this card starts from here.
        await tolerate("clearing the card's snapshot", () =>
          call("DELETE", `/api/tasks/${encodeURIComponent(task.id)}/snapshot`)
        )
      }
    }

    if (reply) {
      await tolerate("the reply", () =>
        call("POST", `/api/tasks/${encodeURIComponent(task.id)}/messages`, {
          authorId: agent.id,
          text: reply,
          // A dispatch note is about the queue, not this card — it must not tag the Architect on it.
          ...(dispatching ? { participant: false } : {}),
        })
      )
    }
    if (dispatching) {
      if (result.decision) {
        await tolerate("applying the dispatch", async () => {
          const outcome = await call("POST", `/api/boards/${encodeURIComponent(board.id)}/dispatch`, {
            actorId: agent.id,
            ...result.decision,
          })
          // Ids the board could not match to a Ready card: a typo in the ref, or a card that
          // left the queue while the model was thinking. Silent on the board, so say it here.
          const unresolved = Array.isArray(outcome.unresolved) ? outcome.unresolved : []
          await logger.log(
            `[worker] dispatch applied: ${outcome.assigned} card(s) assigned, ${outcome.pulled.length} started` +
              (unresolved.length > 0 ? `, ignored unknown card(s): ${unresolved.join(", ")}` : "") +
              `\n`
          )
        })
      } else {
        // Without the reason and the tail of what the model actually wrote, a miss here is
        // pure guesswork.
        const why = result.problem ?? "the reply has no ACTIONS line with assign / order / blocked_by"
        const tail = (result.raw ?? reply ?? "").trim().slice(-1200)
        await logger.log(
          `[worker] no dispatch decision in the reply — the queue is left as it was: ${why}\n` +
            `[worker] tail of the reply the parser saw:\n${tail || "(empty reply)"}\n`
        )
      }
    }
    if (checkNote) {
      await tolerate("the check note", () =>
        call("POST", `/api/tasks/${encodeURIComponent(task.id)}/messages`, { authorId: agent.id, kind: "system", text: checkNote })
      )
    }
    if (commitNote) {
      await tolerate("the commit note", () =>
        call("POST", `/api/tasks/${encodeURIComponent(task.id)}/messages`, { authorId: agent.id, kind: "system", text: commitNote })
      )
    }
    for (const action of actions) {
      if (action.type === "create") {
        // The board decides what is allowed here (who may ask for Ready, one step of
        // chaining, at most 3 cards); a refusal is the agent's problem, not a failed run.
        try {
          const { tasks } = await call("POST", `/api/tasks/${encodeURIComponent(task.id)}/subtasks`, {
            actorId: agent.id,
            cards: action.cards,
            column: action.column,
            parallel: action.parallel,
          })
          const where = tasks[0]?.columnId
          await logger.log(
            `[worker] created ${tasks.length} card(s) in column ${where}: ${tasks
              .map((t) => taskRef(board.key, t.number) ?? t.id)
              .join(" ")}\n`
          )
        } catch (error) {
          // Say it in the chat too: the reply above claims the cards exist.
          await logger.log(`[worker] creating cards was refused: ${error.message}\n`)
          await tolerate("saying the cards were refused", () =>
            call("POST", `/api/tasks/${encodeURIComponent(task.id)}/messages`, {
              authorId: agent.id,
              kind: "system",
              text: `The cards ${agent.name} asked for were not created: ${error.message}`,
            })
          )
        }
      }
      if (action.type === "needs_owner") {
        // A refusal here is the agent's problem, not a failed run — but it must not be silent:
        // the reply above says the card is waiting, and without the flag it only looks quiet.
        try {
          await call("POST", `/api/tasks/${encodeURIComponent(task.id)}/needs-owner`, {
            actorId: agent.id,
            reason: action.reason,
            text: action.text,
            plain,
          })
          await logger.log(`[worker] card waits for the owner (${action.reason}): ${action.text}\n`)
        } catch (error) {
          await logger.log(`[worker] the board refused the owner's flag: ${error.message}\n`)
          await tolerate("saying the owner's flag was refused", () =>
            call("POST", `/api/tasks/${encodeURIComponent(task.id)}/messages`, {
              authorId: agent.id,
              kind: "system",
              text: `${agent.name} asked to wait for the owner, but the board refused: ${error.message}`,
            })
          )
        }
      }
      if (action.type === "move" && action.to) {
        await logger.log(`[worker] moving task to ${action.to}\n`)
        // actorId lets the board say who moved the card — and, for a coder, hand it the next Ready card.
        await tolerate(`moving the card to ${action.to}`, () =>
          call("PATCH", `/api/tasks/${encodeURIComponent(task.id)}`, {
            columnRole: action.to,
            actorId: agent.id,
            plain,
          })
        )
      }
    }
    // The work is over whatever the board made of the hand-off: the commit is in git, and the
    // sha is in the summary even if the chat never got the note.
    await closeRun(
      run.id,
      "done",
      summaryOf(result.summary ?? reply.slice(0, 300), commitSha && `Commit ${commitSha}`),
      logger
    )
    console.log(`[worker] ✔ ${label}${problems.length > 0 ? ` (${problems.length} step(s) refused)` : ""}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (stop.signal.aborted) {
      console.log(`[worker] ■ ${label}: stopped`)
      await closeRun(run.id, "cancelled", "Stopped", logger, { tail: "\n[worker] stopped\n" })
      try {
        await call("POST", `/api/tasks/${encodeURIComponent(task.id)}/messages`, {
          authorId: agent.id,
          kind: "system",
          text: `${agent.name}'s run was stopped. The card stays where it is.`,
        })
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
    // The CLI ran out of turns rather than out of ideas: everything it managed to write is in
    // the working tree. If the work on this card touched anything, say so when closing the run —
    // the board gives the card one more run on it instead of just telling the owner it failed.
    let turnLimit = false
    if (error?.maxTurns === true && agent.agentRole === "coder" && before.isRepo) {
      const after = await gitSnapshot(board.repoPath ?? process.cwd())
      turnLimit = changedPaths(before, after).length > 0
      await logger.log(
        turnLimit
          ? "[worker] out of turns with work in the working tree — asking the board to continue on this card\n"
          : "[worker] out of turns and the working tree is unchanged — nothing to continue from\n"
      )
    }
    // `plain` is whatever the agent already said in words: a step that fails after the reply
    // (the check, the commit) still has it, and the owner's notification is the poorer without
    // it. A run that died inside the CLI never wrote one — the adapter's own line stands in.
    await reportFailure({ run, task, agent, engineName, message, logger, plain: plain ?? error?.plain ?? null, turnLimit })
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
  // Tells the owner about Review, needs_owner and the rest — reads the board's event feed, says
  // nothing about what happened before this moment (agents/notify.mjs).
  const notifications = createNotifications({ call, boardUrl: process.env.CS_BOARD_URL ?? API })
  // The other direction of the same bot: a reply to a notification becomes a message in that
  // card's chat (agents/telegram.mjs). Its own loop — one long poll blocks for half a minute,
  // and the loop below has runs to claim meanwhile. createNotifications has read .env by now.
  const telegram = createTelegramInbox({ call })
  if (telegram) void telegram.start()
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
    await notifications.tick()

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
  telegram?.stop()
  if (busy.size > 0) {
    console.log(`[worker] waiting for ${busy.size} run(s) to finish…`)
    await Promise.all(busy.values())
  }
  console.log("[worker] bye")
}

// The loop starts only when this file is the program — importing it (the tests do) must not
// start polling the board.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
