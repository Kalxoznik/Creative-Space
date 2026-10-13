// A board with its architect switched off (`Board.architectEnabled`): the architect agent
// does not run on it at all, and the three places that used to go through it do without —
// Ready hands the card to its coder, a finished card goes to Review itself, and @architect
// starts nothing. The seeded board next door keeps its architect — the switch is per board.
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, before, describe, it } from "node:test"

const SEEDED = "creative-space"
let store
let dir
/** The board with the architect off — created once, reused by the cases. */
let off

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-arch-"))
  process.env.CS_DB_PATH = path.join(dir, "board.db")
  store = await import("../src/server/store.ts")
  off = store.createBoard({ name: "No architect", repoPath: dir, architectEnabled: false })
})

after(() => fs.rmSync(dir, { recursive: true, force: true }))

const column = (board, role) => board.columns.find((c) => c.role === role).id
const triggers = (taskId) => store.listRuns(taskId).map((run) => run.trigger)
const board = (boardId) => store.getState().boards.find((b) => b.id === boardId)
/** Free the coder again: archive the card and finish whatever it had queued or running. */
function finish(taskId) {
  store.updateTask(taskId, { archived: true })
  for (const run of store.listRuns(taskId)) {
    if (run.status === "queued") store.cancelRun(run.id)
    else if (run.status === "running") store.finishRun(run.id, { status: "done" })
  }
}
const mentions = (taskId) => triggers(taskId).filter((trigger) => trigger.startsWith("mention:"))

describe("a board with the architect switched off", () => {
  it("keeps the switch and leaves the architect a member of the board", () => {
    assert.equal(board(off.id).architectEnabled, false)
    assert.ok(board(off.id).memberIds.includes("architect"))
    // The boards next door are untouched.
    assert.equal(board(SEEDED).architectEnabled, true)
  })

  it("Ready hands the card to its coder instead of queueing a dispatch", () => {
    const task = store.createTask({
      boardId: off.id,
      columnId: column(off, "ready"),
      title: "A card for the coder",
      assigneeIds: ["coder"],
    })
    const moved = store.getTask(task.id)
    assert.equal(store.getState().boards.find((b) => b.id === off.id).columns.find((c) => c.id === moved.columnId).role, "in_progress")
    assert.deepEqual(triggers(task.id), ["column:in_progress"])
    finish(task.id)
  })

  it("an untagged Ready card does not wait for a dispatch either", () => {
    const task = store.createTask({
      boardId: off.id,
      columnId: column(off, "ready"),
      title: "An untagged card",
      assigneeIds: [],
    })
    const columns = board(off.id).columns
    assert.equal(columns.find((c) => c.id === store.getTask(task.id).columnId).role, "in_progress")
    assert.deepEqual(triggers(task.id), ["column:in_progress"])
    finish(task.id)
  })

  it("a coder that finishes puts the card in Review, with no review run", () => {
    const task = store.createTask({
      boardId: off.id,
      columnId: column(off, "in_progress"),
      title: "A card to hand off",
      assigneeIds: ["coder"],
    })
    const done = store.updateTask(task.id, { columnRole: "review", actorId: "coder" })
    const columns = board(off.id).columns
    assert.equal(columns.find((c) => c.id === done.columnId).role, "review")
    assert.ok(!triggers(task.id).includes("review"))
    finish(task.id)
  })

  it("mentioning the architect starts nothing", () => {
    const task = store.createTask({
      boardId: off.id,
      columnId: column(off, "backlog"),
      title: "A card that asks the architect",
      assigneeIds: [],
    })
    store.addMessage({ taskId: task.id, text: "@architect what do you think?" })
    assert.deepEqual(triggers(task.id), [])
    // The coder on the same board is still woken by its own mention.
    store.addMessage({ taskId: task.id, text: "@coder then just do it" })
    assert.equal(mentions(task.id).length, 1)
    finish(task.id)
  })
})

describe("the seeded board keeps its architect", () => {
  it("Ready queues a dispatch and a hand-off queues a review", () => {
    const ready = store.createTask({
      boardId: SEEDED,
      columnId: `${SEEDED}:ready`,
      title: "A card for the queue",
      assigneeIds: [],
    })
    assert.deepEqual(triggers(ready.id), ["dispatch"])
    // Untagged, so it stays in Ready until the dispatch hands it to a coder.
    assert.equal(
      board(SEEDED).columns.find((c) => c.id === store.getTask(ready.id).columnId).role,
      "ready"
    )
    assert.equal(store.queueWaitNote(SEEDED, ready.id), "waiting for the Architect to hand it to a coder")

    const working = store.createTask({
      boardId: SEEDED,
      columnId: `${SEEDED}:in_progress`,
      title: "A card in progress",
      assigneeIds: ["coder"],
    })
    const handed = store.updateTask(working.id, { columnRole: "review", actorId: "coder" })
    // The card stays in In progress until the Architect's review passes.
    const columns = board(SEEDED).columns
    assert.equal(columns.find((c) => c.id === handed.columnId).role, "in_progress")
    assert.ok(triggers(working.id).includes("review"))
  })

  it("switching the architect off moves a card waiting for its review to Review", () => {
    const task = store.createTask({
      boardId: SEEDED,
      columnId: `${SEEDED}:in_progress`,
      title: "A card whose review never came",
      assigneeIds: ["coder"],
    })
    store.updateTask(task.id, { columnRole: "review", actorId: "coder" })
    assert.ok(triggers(task.id).includes("review"))

    store.updateBoard(SEEDED, { architectEnabled: false })
    const columns = board(SEEDED).columns
    const moved = store.getTask(task.id)
    assert.equal(columns.find((c) => c.id === moved.columnId).role, "review")
    assert.equal(
      store.listRuns(task.id).find((run) => run.trigger === "review").status,
      "cancelled"
    )
    // And the queued dispatch of the earlier case is gone with it.
    assert.ok(
      !store
        .getState()
        .boards.find((b) => b.id === SEEDED)
        .columns.some((c) => c.tasks.some((t) => t.agentStatus?.trigger === "dispatch"))
    )
    store.updateBoard(SEEDED, { architectEnabled: true })
  })
})

describe("a person who is not the owner", () => {
  it("can be added over the API and wakes the agents like the owner does", () => {
    const person = store.createPerson({ name: "Claude (chat)", handle: "claude" })
    assert.equal(person.handle, "claude")
    assert.equal(person.kind, "human")
    assert.equal(person.isOwner, false)
    assert.ok(store.listMembers().some((m) => m.id === person.id))

    const task = store.createTask({
      boardId: off.id,
      columnId: column(off, "backlog"),
      title: "A card the outside architect comments on",
      assigneeIds: [],
    })
    store.addMessage({ taskId: task.id, authorId: person.id, text: "@coder please start with the tests" })
    assert.equal(mentions(task.id).length, 1)
    finish(task.id)
  })
})
