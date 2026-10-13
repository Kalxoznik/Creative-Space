// How a run reports its own death (`reportFailure` in agents/worker.mjs). The rule under test:
// the run is closed on the board before anything else, so a board that refuses the chat message
// still gets the run out of `running` — the failure that blocked a coder for half an hour.
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, it } from "node:test"
import { git } from "./git.mjs"

process.env.CS_API = "http://board.test"
const { ENGINES, NO_CHANGES_NOTE, execute, reportFailure } = await import("./worker.mjs")

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

/** A board that answers `handler(method, path, body)` with { status, body } and records calls. */
function board(handler) {
  const calls = []
  globalThis.fetch = async (url, init) => {
    const method = init?.method ?? "GET"
    const path = url.replace("http://board.test", "")
    const body = init?.body ? JSON.parse(init.body) : null
    calls.push({ method, path, body })
    const answer = handler(method, path, body) ?? { status: 200, body: {} }
    return new Response(JSON.stringify(answer.body ?? {}), {
      status: answer.status,
      headers: { "Content-Type": "application/json" },
    })
  }
  return calls
}

const context = {
  run: { id: 7, trigger: "column:in_progress" },
  task: { id: "t_1" },
  agent: { id: "coder", name: "Board Claude" },
  engineName: "claude",
  message: "500: no such column architect_enabled",
  logger: { log: async () => {}, close: async () => {} },
}

describe("reportFailure: a failed run always gets closed", () => {
  it("closes the run even when the card's chat refuses the message", async () => {
    const calls = board((method, path) =>
      path.includes("/messages") ? { status: 500, body: { error: "no such column architect_enabled" } } : null
    )

    await reportFailure(context)

    const closed = calls.find((c) => c.method === "PATCH" && c.path === "/api/agents/runs/7")
    assert.ok(closed, "the run was not closed")
    assert.equal(closed.body.status, "failed")
    assert.match(closed.body.summary, /no such column/)
    // …and it was closed first: the message the board refuses comes after it.
    assert.ok(calls.indexOf(closed) < calls.findIndex((c) => c.path.includes("/messages")))
  })

  it("still writes in the chat when closing the run is what fails", async () => {
    const calls = board((method, path) =>
      path === "/api/agents/runs/7" ? { status: 503, body: { error: "the board is restarting" } } : null
    )

    await reportFailure(context)

    const said = calls.find((c) => c.method === "POST" && c.path.includes("/messages"))
    assert.ok(said, "the chat was never told")
    assert.match(said.body.text, /I couldn't finish this run \(claude\)/)
  })

  it("carries the tail of the log into the request that closes the run", async () => {
    const calls = board(() => null)

    await reportFailure(context)

    const closed = calls.find((c) => c.method === "PATCH" && c.path === "/api/agents/runs/7")
    assert.match(closed.body.appendLog, /\[worker\] failed: 500: no such column/)
  })
})

// The whole run, not just `reportFailure`: the agent's `In short:` line is parsed, then a step
// *after* the reply dies (here the board's check, in a repoPath that does not exist). The owner's
// notification about the failed run is all they see of it, so the line has to survive the fall.
describe("a run that dies after the reply", () => {
  const stub = ENGINES.stub
  afterEach(() => {
    ENGINES.stub = stub
  })

  it("carries the agent's plain line into the failed run", async () => {
    ENGINES.stub = async () => ({
      reply: "Done.\n\nIn short: cleaned up the queue, ready to look at.\n",
      plain: "cleaned up the queue, ready to look at.",
      actions: [{ type: "move", to: "review" }],
    })
    const calls = board(() => null)

    await execute(
      { id: "coder", handle: "coder", name: "Board Claude", agentRole: "coder", agent: { engine: "stub" } },
      {
        run: { id: 7, trigger: "column:in_progress" },
        task: { id: "t_1", number: 69, title: "A card" },
        board: { id: "b_1", key: "BI", repoPath: "/nonexistent-creative-space-repo", checkCommand: "true" },
      }
    )

    const closed = calls.find((c) => c.method === "PATCH" && c.path === "/api/agents/runs/7" && c.body.status === "failed")
    assert.ok(closed, "the run was not closed as failed")
    assert.equal(closed.body.plain, "cleaned up the queue, ready to look at.")
  })
})

// The turn limit: the CLI stopped mid-work, so whatever it wrote is in the checkout.
// The worker's part is to say that when it closes the run — `turnLimit` is what makes the board
// put one more run on the card — and only when the work on the card actually touched something.
describe("a coder run that ran out of turns", () => {
  const stub = ENGINES.stub
  afterEach(() => {
    ENGINES.stub = stub
  })

  const quiet = () => Promise.resolve()
  const coder = { id: "coder", handle: "coder", name: "Board Claude", agentRole: "coder", agent: { engine: "stub" } }

  /** A throwaway repository with one commit, so a snapshot of it has something to compare against. */
  async function repo() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cs-worker-"))
    const run = (...args) => git(dir, args, { log: quiet })
    await run("init", "-q", "-b", "main")
    await run("config", "user.email", "coder@example.com")
    await run("config", "user.name", "Coder")
    await fs.writeFile(path.join(dir, "README.md"), "base\n")
    await run("add", "-A")
    await run("commit", "-q", "-m", "base")
    return dir
  }

  /** Runs a coder on `dir` whose engine writes `files`, then dies on the turn limit. */
  async function outOfTurns(dir, files) {
    ENGINES.stub = async () => {
      for (const [file, body] of Object.entries(files)) await fs.writeFile(path.join(dir, file), body)
      const error = new Error("Claude Code: Hit the turn limit (80). The work is left in the working tree.")
      error.plain = "Hit the turn limit (80). The work is left in the working tree."
      error.maxTurns = true
      throw error
    }
    const calls = board(() => null)
    await execute(coder, {
      run: { id: 7, trigger: "column:in_progress" },
      task: { id: "t_1", number: 80, title: "A card" },
      board: { id: "b_1", key: "BI", repoPath: dir },
    })
    return calls.find((c) => c.method === "PATCH" && c.path === "/api/agents/runs/7" && c.body.status === "failed")
  }

  it("asks the board to continue when the work left changes behind", async () => {
    const closed = await outOfTurns(await repo(), { "README.md": "half the work\n" })
    assert.ok(closed, "the run was not closed as failed")
    assert.equal(closed.body.turnLimit, true)
    // And the honest reason reaches the owner, instead of "unknown error".
    assert.match(closed.body.plain, /turn limit/)
  })

  it("asks for nothing when the working tree is untouched", async () => {
    const closed = await outOfTurns(await repo(), {})
    assert.ok(closed, "the run was not closed as failed")
    assert.equal(closed.body.turnLimit, undefined)
  })
})

// A hand-off whose work changed no file (the stub coder, an answer-only card) used to stop on
// "No commit" and keep the card in In progress forever. It goes on now, with a line in
// the chat; a failed check still holds the card as before.
describe("a coder hand-off with no file changes", () => {
  const stub = ENGINES.stub
  afterEach(() => {
    ENGINES.stub = stub
  })

  const quiet = () => Promise.resolve()
  const coder = { id: "coder", handle: "coder", name: "Board Claude", agentRole: "coder", agent: { engine: "stub" } }

  async function handOff(checkCommand) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cs-worker-"))
    const run = (...args) => git(dir, args, { log: quiet })
    await run("init", "-q", "-b", "main")
    await run("config", "user.email", "coder@example.com")
    await run("config", "user.name", "Coder")
    await fs.writeFile(path.join(dir, "README.md"), "base\n")
    await run("add", "-A")
    await run("commit", "-q", "-m", "base")
    ENGINES.stub = async () => ({ reply: "Done, nothing to change.", actions: [{ type: "move", to: "review" }] })
    const calls = board(() => null)
    await execute(coder, {
      run: { id: 7, trigger: "column:in_progress" },
      task: { id: "t_1", number: 90, title: "A card" },
      board: { id: "b_1", key: "BI", repoPath: dir, checkCommand },
    })
    return calls
  }

  const moved = (calls) => calls.find((c) => c.method === "PATCH" && c.path === "/api/tasks/t_1" && c.body.columnRole === "review")
  const said = (calls, text) =>
    calls.find((c) => c.method === "POST" && c.path === "/api/tasks/t_1/messages" && c.body.kind === "system" && c.body.text === text)

  it("still hands the card on, with a system line in the chat", async () => {
    const calls = await handOff("true")
    assert.ok(moved(calls), "the card was not handed on")
    assert.ok(said(calls, NO_CHANGES_NOTE), "the chat was not told there is nothing to commit")
    assert.ok(calls.find((c) => c.method === "PATCH" && c.path === "/api/agents/runs/7" && c.body.status === "done"))
  })

  it("keeps the card where it is when the check fails", async () => {
    const calls = await handOff("false")
    assert.equal(moved(calls), undefined)
    assert.equal(said(calls, NO_CHANGES_NOTE), undefined)
    assert.ok(calls.find((c) => c.path === "/api/tasks/t_1/check" && c.body.exitCode !== 0), "the failed check was not reported")
  })
})

// The board's commit carries the coder's own subject; the card's title is only the fallback.
describe("the subject of the board's commit", () => {
  const stub = ENGINES.stub
  afterEach(() => {
    ENGINES.stub = stub
  })

  const quiet = () => Promise.resolve()
  const coder = { id: "coder", handle: "coder", name: "Board Claude", agentRole: "coder", agent: { engine: "stub" } }

  /** A hand-off that edits a file, with `actions` as the coder's ACTIONS; resolves with the commit message. */
  async function commitOf(actions) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cs-worker-"))
    const run = (...args) => git(dir, args, { log: quiet })
    await run("init", "-q", "-b", "main")
    await run("config", "user.email", "coder@example.com")
    await run("config", "user.name", "Coder")
    await fs.writeFile(path.join(dir, "README.md"), "base\n")
    await run("add", "-A")
    await run("commit", "-q", "-m", "base")
    ENGINES.stub = async () => {
      await fs.writeFile(path.join(dir, "README.md"), "changed\n")
      return { reply: "Done.", actions }
    }
    board(() => null)
    await execute(coder, {
      run: { id: 7, trigger: "column:in_progress" },
      task: { id: "t_1", number: 92, title: "Убрать эту кнопку" },
      board: { id: "b_1", key: "BI", repoPath: dir, checkCommand: "true" },
    })
    return (await run("log", "-1", "--format=%B")).stdout.trim()
  }

  it("is the coder's line, with the card and the agent in the body", async () => {
    const message = await commitOf([
      { type: "move", to: "review" },
      { type: "commit", subject: "Collapse long task descriptions" },
    ])
    assert.equal(message, "Collapse long task descriptions\n\nCreative Space task #t_1\nAgent: Board Claude")
  })

  it("falls back to the card's title when the coder gave none", async () => {
    const message = await commitOf([{ type: "move", to: "review" }])
    assert.equal(message, "Убрать эту кнопку\n\nCreative Space task #t_1\nAgent: Board Claude")
  })
})
