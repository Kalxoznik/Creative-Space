// Parallel work, step two: several coders at once (`Board.maxCoders`, `coderSlots` and
// `repoBusyForCoder` in src/server/store.ts). With Parallel work on, up to that many coder runs
// work in one repository side by side, each in its own card's worktree; One card at a time holds
// the queue once that many cards are in work. A coder still does one card at a time, and a card
// waiting for another starts only after that card's branch is on main.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, before, describe, it } from "node:test"
import { commitRun, gitSnapshot, parseSnapshot, prepareWorktree, serializeSnapshot } from "../agents/git.mjs"
import { plannedWorktree } from "../agents/worker.mjs"

const QUIET = () => Promise.resolve()
let store
let dir
let boards = 0

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-parallel-"))
  process.env.CS_DB_PATH = path.join(dir, "board.db")
  store = await import("../src/server/store.ts")
})

after(() => fs.rmSync(dir, { recursive: true, force: true }))

const git = (repo, ...args) => execFileSync("git", ["-C", repo, ...args]).toString().trim()

function repoWith(files) {
  const repo = fs.mkdtempSync(path.join(dir, "repo-"))
  git(repo, "init", "-q", "-b", "main")
  git(repo, "config", "user.email", "coder@example.com")
  git(repo, "config", "user.name", "Coder")
  for (const [file, body] of Object.entries(files)) fs.writeFileSync(path.join(repo, file), body)
  git(repo, "add", "-A")
  git(repo, "commit", "-q", "-m", "base")
  return repo
}

/** A board of its own coders, no Architect, so a tagged Ready card goes straight to its coder. */
function boardWith(coderCount, patch) {
  const n = ++boards
  const coders = Array.from({ length: coderCount }, (_, i) =>
    store.createAgent({ name: `Coder ${n}.${i}`, handle: `c${n}x${i}`, role: "coder", engine: "stub" })
  )
  const repo = repoWith({ "app.txt": "base\n" })
  const board = store.createBoard({ name: `Parallel ${n}`, repoPath: repo, memberIds: coders.map((c) => c.id), architectEnabled: false })
  store.updateBoard(board.id, { parallelWork: true, queueRelease: "done", ...patch })
  return { board: store.getState().boards.find((b) => b.id === board.id), coders, repo }
}

const roleOf = (taskId) => {
  const task = store.getTask(taskId)
  return store
    .getState()
    .boards.find((b) => b.id === task.boardId)
    .columns.find((c) => c.id === task.columnId).role
}
function readyCard(boardId, title, coder, blockedBy = []) {
  const id = store.createTask({ boardId, columnId: `${boardId}:backlog`, title, assigneeIds: [coder.id] }).id
  store.updateTask(id, { blockedBy, columnRole: "ready" })
  return id
}
function endRuns(taskId) {
  for (const run of store.listRuns(taskId)) {
    if (run.status === "queued") store.cancelRun(run.id)
    else if (run.status === "running") store.finishRun(run.id, { status: "done" })
  }
}

/** The worker's part of a run: the card's worktree, recorded on the card, a file committed there. */
async function workOn(repo, context, file) {
  const plan = plannedWorktree({ agentRole: "coder" }, context)
  assert.ok(plan, "a coder on an In progress card gets a worktree")
  const made = await prepareWorktree(repo, plan)
  assert.equal(made.failed, undefined, made.failed)
  store.recordWorktree(context.task.id, { branch: made.branch, path: made.path, base: made.base })
  const { snapshot } = store.keepWorkSnapshot(context.task.id, serializeSnapshot(await gitSnapshot(made.path)))
  fs.writeFileSync(path.join(made.path, file), `${file}\n`)
  const outcome = await commitRun(made.path, { subject: `Add ${file}`, trailer: "Agent: Coder" }, parseSnapshot(snapshot), { log: QUIET })
  assert.equal(outcome.committed, true)
  return made
}

describe("Max coders at once", () => {
  it("defaults to 2 and only takes 1–3", () => {
    const { board } = boardWith(1, {})
    assert.equal(board.maxCoders, 2)
    assert.throws(() => store.updateBoard(board.id, { maxCoders: 4 }), /maxCoders must be 1, 2 or 3/)
    assert.throws(() => store.updateBoard(board.id, { maxCoders: 0 }), /maxCoders/)
    assert.equal(store.updateBoard(board.id, { maxCoders: 3 }).maxCoders, 3)
  })

  it("a run's context carries the board's limit, for the dispatch prompt", () => {
    const { board, coders } = boardWith(1, { maxCoders: 3 })
    const id = readyCard(board.id, "Card", coders[0])
    const context = store.claimRun(coders[0].id)
    assert.equal(context.board.maxCoders, 3)
    endRuns(id)
  })

  it("two Ready cards with two coders run at the same time in two worktrees and both land on main", async () => {
    const { board, coders, repo } = boardWith(2, { maxCoders: 2 })
    const a = readyCard(board.id, "Card A", coders[0])
    const b = readyCard(board.id, "Card B", coders[1])
    assert.equal(roleOf(a), "in_progress")
    assert.equal(roleOf(b), "in_progress")

    const first = store.claimRun(coders[0].id)
    const second = store.claimRun(coders[1].id)
    assert.ok(first, "the first coder starts")
    assert.ok(second, "the second coder starts beside it")
    assert.equal(store.getState().boards.find((x) => x.id === board.id).codersRunning, 2)

    const madeA = await workOn(repo, first, "a.txt")
    const madeB = await workOn(repo, second, "b.txt")
    assert.notEqual(madeA.path, madeB.path)
    endRuns(a)
    endRuns(b)
    store.updateTask(a, { columnRole: "done" })
    store.updateTask(b, { columnRole: "done" })
    assert.ok(fs.existsSync(path.join(repo, "a.txt")))
    assert.ok(fs.existsSync(path.join(repo, "b.txt")))
    assert.equal(store.getTask(a).worktree, null)
    assert.equal(store.getTask(b).worktree, null)
  })

  it("with one card at a time, holds the queue once that many cards are in work", () => {
    const { board, coders } = boardWith(3, { maxCoders: 2 })
    const a = readyCard(board.id, "One", coders[0])
    const b = readyCard(board.id, "Two", coders[1])
    const c = readyCard(board.id, "Three", coders[2])
    assert.deepEqual([roleOf(a), roleOf(b), roleOf(c)], ["in_progress", "in_progress", "ready"])
    assert.equal(store.queueWaitNote(board.id, c), "waiting for a free slot — 2 cards are in work")

    // A slot frees where a single card would free the queue: Done (Review still holds it here).
    endRuns(a)
    store.updateTask(a, { columnRole: "review" })
    assert.equal(roleOf(c), "ready")
    store.updateTask(a, { columnRole: "done" })
    assert.equal(roleOf(c), "in_progress")
  })

  it("a coder still does one card at a time", () => {
    const { board, coders } = boardWith(1, { maxCoders: 3, oneCardAtATime: false })
    const a = readyCard(board.id, "Mine", coders[0])
    const b = readyCard(board.id, "Mine too", coders[0])
    assert.equal(roleOf(a), "in_progress")
    assert.equal(roleOf(b), "ready")
  })

  it("one slot: the second coder's run waits for the first", () => {
    const { board, coders } = boardWith(2, { maxCoders: 1, oneCardAtATime: false })
    const a = readyCard(board.id, "First", coders[0])
    readyCard(board.id, "Second", coders[1])
    assert.ok(store.claimRun(coders[0].id))
    assert.equal(store.claimRun(coders[1].id), null)
    endRuns(a)
    assert.ok(store.claimRun(coders[1].id))
  })

  it("Parallel work off: one coder at a time in the repository, whatever the setting says", () => {
    const { board, coders } = boardWith(2, { maxCoders: 3, oneCardAtATime: false, parallelWork: false })
    const a = readyCard(board.id, "First", coders[0])
    readyCard(board.id, "Second", coders[1])
    assert.ok(store.claimRun(coders[0].id))
    assert.equal(store.claimRun(coders[1].id), null)
    endRuns(a)
    assert.ok(store.claimRun(coders[1].id))
  })

  it("a card's worktree takes one coder at a time", () => {
    const { board, coders } = boardWith(2, { maxCoders: 2 })
    const id = store.createTask({ boardId: board.id, columnId: `${board.id}:backlog`, title: "Both of us", assigneeIds: coders.map((c) => c.id) }).id
    store.updateTask(id, { columnRole: "ready" })
    assert.equal(roleOf(id), "in_progress")
    assert.equal(store.listRuns(id).filter((r) => r.status === "queued").length, 2, "both coders are queued on the card")

    const first = store.claimRun(coders[0].id) ?? store.claimRun(coders[1].id)
    assert.ok(first)
    const other = coders.find((c) => c.id !== first.run.agentId)
    assert.equal(store.claimRun(other.id), null, "the other coder waits, though a slot is free")
    store.finishRun(first.run.id, { status: "done" })
    assert.ok(store.claimRun(other.id))
  })

  it("a run started in the checkout keeps the repository after Parallel work is switched on", () => {
    const { board, coders } = boardWith(2, { maxCoders: 2, oneCardAtATime: false, parallelWork: false })
    const a = readyCard(board.id, "In the checkout", coders[0])
    assert.ok(store.claimRun(coders[0].id))
    store.updateBoard(board.id, { parallelWork: true })
    const b = readyCard(board.id, "In a worktree", coders[1])
    assert.equal(roleOf(b), "in_progress")
    assert.equal(store.claimRun(coders[1].id), null, "its card now reads as a worktree card, its run does not")
    endRuns(a)
    assert.ok(store.claimRun(coders[1].id))
  })

  it("a blocked card waits for its blocker's branch to land, though a slot is free", async () => {
    const { board, coders, repo } = boardWith(2, { maxCoders: 2 })
    const a = readyCard(board.id, "Writes the plan", coders[0])
    const b = readyCard(board.id, "Reads the plan", coders[1], [a])
    assert.equal(roleOf(a), "in_progress")
    assert.equal(roleOf(b), "ready")

    await workOn(repo, store.claimRun(coders[0].id), "plan.md")
    endRuns(a)
    store.updateTask(a, { columnRole: "review" })
    assert.equal(roleOf(b), "ready")
    store.updateTask(a, { columnRole: "done" })
    assert.equal(roleOf(b), "in_progress")
    const context = store.claimRun(coders[1].id)
    assert.ok(context)
    const made = await prepareWorktree(repo, plannedWorktree({ agentRole: "coder" }, context))
    assert.ok(fs.existsSync(path.join(made.path, "plan.md")), "cut from a main that has the blocker's work")
  })
})
