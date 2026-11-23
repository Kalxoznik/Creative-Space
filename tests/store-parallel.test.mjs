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
  it("defaults to 2 and only takes 1–6", () => {
    const { board } = boardWith(1, {})
    assert.equal(board.maxCoders, 2)
    assert.throws(() => store.updateBoard(board.id, { maxCoders: 0 }), /maxCoders must be a whole number from 1 to 6/)
    assert.throws(() => store.updateBoard(board.id, { maxCoders: 7 }), /maxCoders must be a whole number from 1 to 6/)
    assert.throws(() => store.updateBoard(board.id, { maxCoders: 2.5 }), /maxCoders/)
    for (const n of [1, 2, 3, 4, 5, 6]) assert.equal(store.updateBoard(board.id, { maxCoders: n }).maxCoders, n)
  })

  it("five slots, eight Ready cards: five start, three wait, the next starts when one finishes", () => {
    const { board, coders } = boardWith(8, { maxCoders: 5 })
    const cards = coders.map((coder, i) => readyCard(board.id, `Card ${i + 1}`, coder))
    assert.deepEqual(
      cards.map(roleOf),
      ["in_progress", "in_progress", "in_progress", "in_progress", "in_progress", "ready", "ready", "ready"]
    )
    assert.equal(store.queueWaitNote(board.id, cards[5]), "waiting for a free slot — 5 cards are in work")

    const contexts = coders.slice(0, 5).map((coder) => store.claimRun(coder.id))
    assert.ok(contexts.every(Boolean), "all five coders start")
    assert.equal(new Set(contexts.map((c) => c.task.id)).size, 5, "five different cards, never two runs on one")
    assert.equal(store.getState().boards.find((x) => x.id === board.id).codersRunning, 5)
    assert.equal(store.claimRun(coders[5].id), null, "the sixth coder has no card yet")

    // One card finishes and is released: its slot goes to the sixth card, and only to it.
    endRuns(cards[0])
    store.updateTask(cards[0], { columnRole: "done" })
    assert.deepEqual(cards.slice(5).map(roleOf), ["in_progress", "ready", "ready"])
    assert.ok(store.claimRun(coders[5].id), "the sixth coder starts in the freed slot")
    assert.equal(store.claimRun(coders[6].id), null)
    assert.equal(store.getState().boards.find((x) => x.id === board.id).codersRunning, 5)
    for (const id of cards) endRuns(id)
  })

  it("the machine-wide cap (CS_MAX_CODERS) holds a run across boards, whatever their slots say", () => {
    const was = process.env.CS_MAX_CODERS
    process.env.CS_MAX_CODERS = "2"
    try {
      assert.equal(store.machineCoderCap(), 2)
      const one = boardWith(2, { maxCoders: 3 })
      const two = boardWith(2, { maxCoders: 3 })
      const cards = [
        readyCard(one.board.id, "A1", one.coders[0]),
        readyCard(one.board.id, "A2", one.coders[1]),
        readyCard(two.board.id, "B1", two.coders[0]),
        readyCard(two.board.id, "B2", two.coders[1]),
      ]
      assert.ok(store.claimRun(one.coders[0].id))
      assert.ok(store.claimRun(two.coders[0].id), "a second board starts beside the first")
      assert.equal(store.claimRun(one.coders[1].id), null, "the third run waits for the machine")
      assert.equal(store.claimRun(two.coders[1].id), null)
      endRuns(cards[0])
      assert.ok(store.claimRun(one.coders[1].id), "and starts when one finishes")
      for (const id of cards) endRuns(id)
    } finally {
      if (was === undefined) delete process.env.CS_MAX_CODERS
      else process.env.CS_MAX_CODERS = was
    }
    assert.equal(store.machineCoderCap(), 6)
  })

  it("five cards finishing at once land one after another, all of them, with nothing left half-merged", async () => {
    const { board, coders, repo } = boardWith(5, { maxCoders: 5, oneCardAtATime: false })
    const cards = coders.map((coder, i) => readyCard(board.id, `Card ${i + 1}`, coder))
    const contexts = coders.map((coder) => store.claimRun(coder.id))
    assert.ok(contexts.every(Boolean))
    const made = []
    for (const [i, context] of contexts.entries()) made.push(await workOn(repo, context, `file-${i + 1}.txt`))
    assert.equal(new Set(made.map((m) => m.path)).size, 5, "five worktrees, none shared")
    for (const id of cards) endRuns(id)

    // Released in one go: every landing runs in the board process, one at a time, so the main
    // branch takes all five and no card is told its merge failed.
    for (const id of cards) store.updateTask(id, { columnRole: "done" })
    for (let i = 1; i <= 5; i += 1) assert.ok(fs.existsSync(path.join(repo, `file-${i}.txt`)), `file-${i}.txt is on main`)
    for (const id of cards) {
      assert.equal(store.getTask(id).worktree, null)
      const failed = store.listMessages(id).filter((m) => m.kind === "system" && /Could not merge/.test(m.text))
      assert.equal(failed.length, 0)
    }
    assert.equal(git(repo, "status", "--porcelain"), "", "the checkout is clean")
    assert.throws(() => git(repo, "rev-parse", "--verify", "--quiet", "MERGE_HEAD"), "no merge is left open")
    assert.equal(git(repo, "worktree", "list").split("\n").length, 1, "all five worktrees are gone")
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
