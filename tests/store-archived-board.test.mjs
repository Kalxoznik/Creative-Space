// An archived board (`queueHeld` in src/server/store.ts): its queue stands still whatever its
// settings — no coder takes a Ready card from it — until it is restored. A board with a run
// still queued or running cannot be archived: the agent would go on working where nobody sees.
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, before, describe, it } from "node:test"

let store
let dir
/** A board without an architect, so a tagged Ready card goes straight to its coder. */
let board

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-archived-board-"))
  process.env.CS_DB_PATH = path.join(dir, "board.db")
  store = await import("../src/server/store.ts")
  board = store.createBoard({ name: "Bubble pop", repoPath: dir, architectEnabled: false, starterCard: false })
})

after(() => fs.rmSync(dir, { recursive: true, force: true }))

const columnOf = (boardId, role) =>
  store.getState().boards.find((b) => b.id === boardId).columns.find((c) => c.role === role).id
const roleOf = (taskId) => {
  const task = store.getTask(taskId)
  return store
    .getState()
    .boards.find((b) => b.id === task.boardId)
    .columns.find((c) => c.id === task.columnId).role
}
const texts = (taskId) => store.listMessages(taskId).map((m) => m.text)
function endRuns(taskId) {
  for (const run of store.listRuns(taskId)) {
    if (run.status === "queued") store.cancelRun(run.id)
    else if (run.status === "running") store.finishRun(run.id, { status: "done" })
  }
}
function readyCard(boardId, title, assigneeIds) {
  const id = store.createTask({ boardId, columnId: columnOf(boardId, "backlog"), title, assigneeIds }).id
  store.updateTask(id, { columnRole: "ready" })
  return id
}

describe("an archived board", () => {
  let current
  let waiting

  it("cannot be archived while a run on it is queued or running", () => {
    current = readyCard(board.id, "In work", ["coder"])
    assert.equal(roleOf(current), "in_progress")
    assert.throws(() => store.updateBoard(board.id, { archived: true }), store.ValidationError)
    assert.equal(store.getState().boards.find((b) => b.id === board.id).archived, false)
  })

  it("its Ready cards are taken by nobody", () => {
    endRuns(current)
    store.updateTask(current, { columnRole: "done" })
    store.updateBoard(board.id, { archived: true, oneCardAtATime: false })
    assert.equal(store.getState().boards.find((b) => b.id === board.id).archived, true)
    waiting = readyCard(board.id, "Next", ["coder"])
    assert.equal(roleOf(waiting), "ready")
    assert.deepEqual(store.listRuns(waiting), [])
    assert.equal(store.queueWaitNote(board.id, waiting), "the board is archived")
  })

  it("restored, its queue moves again and says why", () => {
    store.updateBoard(board.id, { archived: false })
    assert.equal(roleOf(waiting), "in_progress")
    assert.ok(texts(waiting).some((t) => t.startsWith("The board is back from the archive — ")))
  })
})
