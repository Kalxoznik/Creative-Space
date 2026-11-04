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
const { ENGINES, NO_CHANGES_NOTE, execute, reportFailure, runTimeoutMs, timeoutNote } = await import("./worker.mjs")
const { sleep } = await import("./lib.mjs")

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

// A run the loop watch stopped (`agents/loops.mjs`): closed as failed with `loop`, continued like a
// run out of turns when it left work behind, and the chat gets a plain system line saying what
// repeated — not the agent's "I couldn't finish".
describe("a run stopped as a loop", () => {
  const stub = ENGINES.stub
  afterEach(() => {
    ENGINES.stub = stub
  })
  const quiet = () => Promise.resolve()
  const coder = { id: "coder", handle: "coder", name: "Board Claude", agentRole: "coder", agent: { engine: "stub" } }

  async function looping(files, agent = coder) {
    const { loopError } = await import("./loops.mjs")
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cs-worker-loop-"))
    const run = (...args) => git(dir, args, { log: quiet })
    await run("init", "-q", "-b", "main")
    await run("config", "user.email", "coder@example.com")
    await run("config", "user.name", "Coder")
    await fs.writeFile(path.join(dir, "README.md"), "base\n")
    await run("add", "-A")
    await run("commit", "-q", "-m", "base")
    ENGINES.stub = async () => {
      for (const [file, body] of Object.entries(files)) await fs.writeFile(path.join(dir, file), body)
      throw loopError({ kind: "failing", count: 3, label: "Bash npm test", error: "not ok 1 - moves the card" })
    }
    const calls = board(() => null)
    await execute(agent, {
      run: { id: 7, trigger: "column:in_progress" },
      task: { id: "t_1", number: 120, title: "A card" },
      board: { id: "b_1", key: "BI", repoPath: dir },
    })
    return calls
  }

  it("closes the run as a loop and says in a system line what repeated", async () => {
    const calls = await looping({ "README.md": "half the work\n" })
    const closed = calls.find((c) => c.method === "PATCH" && c.path === "/api/agents/runs/7" && c.body.status)
    assert.equal(closed.body.status, "failed")
    assert.equal(closed.body.loop, true)
    assert.equal(closed.body.turnLimit, true, "the work in the tree gets the one continuation")
    assert.ok(closed.body.plain)
    const said = calls.find((c) => c.method === "POST" && c.path === "/api/tasks/t_1/messages")
    assert.equal(said.body.kind, "system")
    assert.match(said.body.text, /^Board Claude's run: The same command failed 3 times .*`Bash npm test`.*Stopped as a loop\./)
    assert.match(said.body.text, /The work is left in the working tree\.$/)
    assert.match(closed.body.plain, /working tree/)
    assert.doesNotMatch(said.body.text, /I couldn't finish/)
  })

  it("says nothing about the working tree for an Architect, which never writes there", async () => {
    const architect = { ...coder, id: "architect", handle: "architect", name: "Architect", agentRole: "architect" }
    const calls = await looping({}, architect)
    const closed = calls.find((c) => c.method === "PATCH" && c.path === "/api/agents/runs/7" && c.body.status)
    const said = calls.find((c) => c.method === "POST" && c.path === "/api/tasks/t_1/messages")
    assert.match(said.body.text, /Stopped as a loop\.$/)
    assert.doesNotMatch(`${said.body.text} ${closed.body.plain}`, /working tree/)
  })

  it("asks for no continuation when the tree is untouched", async () => {
    const calls = await looping({})
    const closed = calls.find((c) => c.method === "PATCH" && c.path === "/api/agents/runs/7" && c.body.status)
    assert.equal(closed.body.loop, true)
    assert.equal(closed.body.turnLimit, undefined)
  })
})

// The agent's own time limit: read from its settings, and a run killed at it ends as `timeout`
// with a plain line in the chat — not as a failure quoting whatever the CLI printed last.
describe("the run timeout", () => {
  const stub = ENGINES.stub
  afterEach(() => {
    ENGINES.stub = stub
  })

  it("comes from the agent's runTimeoutMinutes, else the worker's 20 minutes", () => {
    assert.equal(runTimeoutMs({ agent: { runTimeoutMinutes: 60 } }), 60 * 60 * 1000)
    assert.equal(runTimeoutMs({ agent: { runTimeoutMinutes: null } }), 20 * 60 * 1000)
    assert.equal(runTimeoutMs({ agent: null }), 20 * 60 * 1000)
  })

  it("closes a run that outlives it as timeout, with the plain note in the chat", async () => {
    let seenTimeout = null
    ENGINES.stub = async (role, context, { signal, timeoutMs }) => {
      seenTimeout = timeoutMs
      // A CLI that would print a build log and keep going; the deadline kills it first.
      await sleep(10_000, signal)
      return { reply: "never", actions: [] }
    }
    const calls = board(() => null)
    // A fraction of a minute, so the test does not wait for a real one.
    const agent = { id: "coder", handle: "coder", name: "Board Codex", agentRole: "architect", agent: { engine: "stub", runTimeoutMinutes: 0.005 } }
    await execute(agent, {
      run: { id: 7, trigger: "mention:1" },
      task: { id: "t_1", number: 97, title: "A long card" },
      board: { id: "b_1", key: "BI" },
    })

    assert.equal(seenTimeout, 300)
    const closed = calls.find((c) => c.method === "PATCH" && c.path === "/api/agents/runs/7" && c.body.status)
    assert.equal(closed.body.status, "timeout")
    assert.equal(closed.body.summary, timeoutNote(300))
    const said = calls.find((c) => c.method === "POST" && c.path === "/api/tasks/t_1/messages")
    assert.equal(said.body.kind, "system")
    assert.equal(said.body.text, "Stopped by the run timeout (1 min). The working tree is kept; mention the agent to continue.")
    assert.doesNotMatch(said.body.text, /couldn't finish/)
  })

  it("names the limit in minutes", () => {
    assert.equal(
      timeoutNote(60 * 60 * 1000),
      "Stopped by the run timeout (60 min). The working tree is kept; mention the agent to continue."
    )
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

// The Architect's `escalate:` run: its reply wakes nobody (a coder it names would run before the
// swap), and a decision that does not land sends the card to the owner — the failed retry no
// longer notifies them, so otherwise nobody hears of it. The new coder's run has the same trigger
// but is an ordinary coder run.
describe("an escalate run", () => {
  const stub = ENGINES.stub
  afterEach(() => {
    ENGINES.stub = stub
  })

  const architect = { id: "arch", handle: "architect", name: "Architect", agentRole: "architect", agent: { engine: "stub" } }
  const coder = { id: "coder", handle: "coder", name: "Board Claude", agentRole: "coder", agent: { engine: "stub" } }

  async function escalateRun(agent, result, handler = () => null) {
    ENGINES.stub = async () => result
    const calls = board(handler)
    await execute(agent, {
      run: { id: 7, trigger: "escalate:m_1" },
      task: { id: "t_1", number: 123, title: "A card" },
      board: { id: "b_1", key: "BI", repoPath: process.cwd() },
    })
    return calls
  }
  const reply = (calls) => calls.find((c) => c.method === "POST" && c.path === "/api/tasks/t_1/messages" && !c.body.kind)
  const flags = (calls) => calls.filter((c) => c.method === "POST" && c.path === "/api/tasks/t_1/needs-owner")

  it("posts the Architect's reply as a non-participant", async () => {
    const calls = await escalateRun(architect, {
      reply: "@coder_strong should take it.",
      actions: [{ type: "escalate", to: "coder_strong", reason: "too hard" }],
    })
    assert.equal(reply(calls).body.participant, false)
  })

  it("posts the new coder's reply as a participant", async () => {
    const calls = await escalateRun(coder, { reply: "@architect which file?", actions: [] })
    assert.equal(reply(calls).body.participant, undefined)
    assert.equal(flags(calls).length, 0)
  })

  it("sends the card to the owner when the board refuses the escalate", async () => {
    const calls = await escalateRun(
      architect,
      { reply: "Strong it is.", plain: "Handing it up.", actions: [{ type: "escalate", to: "coder_strong", reason: "too hard" }] },
      (method, path) => (path.endsWith("/escalate") ? { status: 400, body: { error: "the next tier up is Standard" } } : null)
    )
    const [flag] = flags(calls)
    assert.ok(flag, "the owner was not asked")
    assert.equal(flag.body.reason, "question")
    assert.match(flag.body.text, /the next tier up is Standard/)
    // "Handing it up." promises a swap that never happened — it must not reach the owner's phone.
    assert.equal(flag.body.plain, undefined)
  })

  it("leaves the In short line out when the ACTIONS line was unreadable", async () => {
    const calls = await escalateRun(architect, {
      reply: "Standard it is.",
      plain: "Handing it up.",
      actions: [],
      problem: "the ACTIONS payload is not valid JSON",
    })
    const [flag] = flags(calls)
    assert.ok(flag, "the owner was not asked")
    assert.equal(flag.body.plain, undefined)
  })

  it("sends the card to the owner when the reply has no action, with its In short line", async () => {
    const calls = await escalateRun(architect, { reply: "Hmm.", plain: "Is the spec right?", actions: [] })
    const [flag] = flags(calls)
    assert.ok(flag, "the owner was not asked")
    assert.equal(flag.body.reason, "question")
    assert.equal(flag.body.plain, "Is the spec right?")
  })

  it("asks nothing more when the escalate is accepted", async () => {
    const calls = await escalateRun(
      architect,
      { reply: "Standard it is.", actions: [{ type: "escalate", to: "coder_std", reason: "too hard" }] },
      (method, path) => (path.endsWith("/escalate") ? { status: 200, body: { from: "coder_fast", to: "coder_std" } } : null)
    )
    assert.ok(calls.find((c) => c.path === "/api/tasks/t_1/escalate"))
    assert.equal(flags(calls).length, 0)
  })

  it("asks nothing more when the Architect already asked the owner", async () => {
    const calls = await escalateRun(architect, {
      reply: "The test environment is down.",
      actions: [{ type: "needs_owner", reason: "question", text: "Is the test database up?" }],
    })
    assert.equal(flags(calls).length, 1)
    assert.equal(flags(calls)[0].body.text, "Is the test database up?")
  })
})

describe("app project folders", () => {
  const stub = ENGINES.stub
  afterEach(() => {
    ENGINES.stub = stub
    delete process.env.CS_APP
  })

  it("rejects a missing project before an adapter, snapshot, check or commit can run", async () => {
    process.env.CS_APP = "1"
    let called = false
    ENGINES.stub = async () => { called = true; throw new Error("must not run") }
    const calls = board(() => null)
    await execute(
      { id: "coder", handle: "coder", name: "Coder", agentRole: "coder", agent: { engine: "stub" } },
      { run: { id: 7, trigger: "column:in_progress" }, task: { id: "t_1" }, board: { id: "b_1", repoPath: null, checkCommand: "true" } }
    )
    assert.equal(called, false)
    const closed = calls.find((c) => c.path === "/api/agents/runs/7" && c.body?.status === "failed")
    assert.match(closed.body.summary, /Choose an absolute project folder/)
    assert.ok(calls.some((c) => c.path.includes("/messages") && /project folder/.test(c.body.text)))
    assert.equal(calls.some((c) => c.path.includes("work-snapshot")), false)
  })

  it("adapters and prompt generation also reject a missing app folder", async () => {
    process.env.CS_APP = "1"
    const { runClaude } = await import("./adapters/claude.mjs")
    const { runCodex } = await import("./adapters/codex.mjs")
    const { buildPrompt } = await import("./lib.mjs")
    const context = { run: { trigger: "mention:1" }, board: { repoPath: null, columns: [] }, task: {}, members: [], messages: [], agent: {} }
    for (const adapter of [runClaude, runCodex]) {
      await assert.rejects(adapter("coder", context, { log: async () => {} }), /Choose an absolute project folder/)
    }
    await assert.rejects(buildPrompt("coder", context), /Choose an absolute project folder/)
  })
})
