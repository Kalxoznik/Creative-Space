// The card's "before" snapshot (`keepWorkSnapshot` in src/server/store.ts) against the commit step
// (agents/git.mjs). The rule under test: the commit after a hand-off covers all the work on the
// card, however many runs it took. On UG-39 the first run wrote six files and stopped for the
// owner; the owner confirmed by moving the card through Ready, that move wiped the snapshot, the
// second run took a fresh one with the six files already in it — and the commit left them out.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, before, describe, it } from "node:test"
import { commitRun, gitSnapshot, parseSnapshot, serializeSnapshot } from "../agents/git.mjs"

const BOARD = "creative-space"
const QUIET = () => Promise.resolve()
const message = { subject: "Task", trailer: "Creative Space task #t_1\nAgent: Coder" }
let store
let dir

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-snapshot-"))
  process.env.CS_DB_PATH = path.join(dir, "board.db")
  store = await import("../src/server/store.ts")
})

after(() => fs.rmSync(dir, { recursive: true, force: true }))

function workingCard(title) {
  const task = store.createTask({ boardId: BOARD, columnId: `${BOARD}:backlog`, title, assigneeIds: ["coder"] })
  store.updateTask(task.id, { columnRole: "in_progress" })
  return task.id
}

function repoWith(files) {
  const repo = fs.mkdtempSync(path.join(dir, "repo-"))
  const git = (...args) => execFileSync("git", ["-C", repo, ...args])
  git("init", "-q", "-b", "main")
  git("config", "user.email", "coder@example.com")
  git("config", "user.name", "Coder")
  write(repo, files)
  git("add", "-A")
  git("commit", "-q", "-m", "base")
  return repo
}

function write(repo, files) {
  for (const [file, body] of Object.entries(files)) fs.writeFileSync(path.join(repo, file), body)
}

/** What a coder run does first: offer its own snapshot, get back the card's. */
async function startRun(repo, taskId) {
  const { snapshot } = store.keepWorkSnapshot(taskId, serializeSnapshot(await gitSnapshot(repo)))
  return parseSnapshot(snapshot)
}

describe("keepWorkSnapshot: the card's starting point outlives the runs on it", () => {
  it("commits the first run's files after the owner confirms through Ready", async () => {
    const repo = repoWith({ "a.py": "base\n", "b.py": "base\n", "owner.md": "base\n" })
    write(repo, { "owner.md": "owner's own work\n" })
    const taskId = workingCard("Two runs, one commit")

    // Run #1 writes a.py and stops for the owner.
    const first = await startRun(repo, taskId)
    write(repo, { "a.py": "run one\n" })
    store.setNeedsOwner(taskId, { actorId: "coder", reason: "question", text: "More than five files — go on?" })

    // The owner says go by sending the card back through Ready.
    store.updateTask(taskId, { columnRole: "ready" })
    store.updateTask(taskId, { columnRole: "in_progress" })

    // Run #2 writes b.py and hands off: its "before" is still run #1's.
    const second = await startRun(repo, taskId)
    assert.deepEqual([...second.dirty], [...first.dirty])
    write(repo, { "b.py": "run two\n" })
    const outcome = await commitRun(repo, message, second, { log: QUIET })
    assert.equal(outcome.committed, true)
    assert.deepEqual(outcome.paths.sort(), ["a.py", "b.py"])
    // Only the owner's edit is left, and it is named.
    assert.deepEqual(outcome.left, ["owner.md"])
  })

  it("starts over once the card is done", async () => {
    const repo = repoWith({ "a.py": "base\n" })
    const taskId = workingCard("Done, then reopened")
    await startRun(repo, taskId)
    store.updateTask(taskId, { columnRole: "done" })
    write(repo, { "a.py": "owner, much later\n" })
    store.updateTask(taskId, { columnRole: "in_progress" })

    const fresh = await startRun(repo, taskId)
    assert.ok(fresh.dirty.has("a.py"), "the owner's later edit is part of the new starting point")
  })
})
