// One card at a time (`Board.oneCardAtATime`, `queueHeld` in src/server/store.ts): while any
// card is in In progress or Review, Ready stands still — no coder takes a card, no dispatch is
// queued. The card in Review holds the queue until the owner moves it to Done; then the next
// Ready card starts by itself. Switched off, the queue works as it did before.
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, before, describe, it } from "node:test"

const SEEDED = "creative-space"
let store
let dir
/** A board without an architect, so a tagged Ready card goes straight to its coder. */
let board

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-one-card-"))
  process.env.CS_DB_PATH = path.join(dir, "board.db")
  store = await import("../src/server/store.ts")
  board = store.createBoard({ name: "One at a time", repoPath: dir, architectEnabled: false })
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
const triggers = (taskId) => store.listRuns(taskId).map((run) => run.trigger)
const texts = (taskId) => store.listMessages(taskId).map((m) => m.text)
/** The coder's run on the card ends, as the worker would end it. */
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

describe("one card at a time", () => {
  it("is on by default for a new board", () => {
    assert.equal(store.getState().boards.find((b) => b.id === board.id).oneCardAtATime, true)
  })

  let first
  let second

  it("two cards in Ready: only the first goes into work", () => {
    first = readyCard(board.id, "First card", ["coder"])
    second = readyCard(board.id, "Second card", ["coder"])
    assert.equal(roleOf(first), "in_progress")
    assert.equal(roleOf(second), "ready")
    assert.deepEqual(triggers(second), [])
    assert.equal(store.queueWaitNote(board.id, second), "waiting for the current card")
  })

  it("the card in Review holds the queue", () => {
    endRuns(first)
    store.updateTask(first, { columnRole: "review", actorId: "coder" })
    assert.equal(roleOf(first), "review")
    assert.equal(roleOf(second), "ready", "the coder is free, but the queue waits for Done")
    assert.deepEqual(triggers(second), [])
  })

  it("a card sent back from Review to In progress continues, and the next one keeps waiting", () => {
    store.updateTask(first, { columnRole: "in_progress" })
    assert.equal(roleOf(second), "ready")
    assert.ok(triggers(first).filter((t) => t === "column:in_progress").length >= 2, "the coder picks the card up again")
    endRuns(first)
    store.updateTask(first, { columnRole: "review", actorId: "coder" })
    assert.equal(roleOf(second), "ready")
  })

  it("the owner moves it to Done → the next card starts by itself", () => {
    store.updateTask(first, { columnRole: "done" })
    assert.equal(roleOf(second), "in_progress")
    assert.deepEqual(triggers(second), ["column:in_progress"])
    assert.ok(texts(second).some((t) => t.startsWith("Previous card is done — ")))
  })

  it("switched off, the queue behaves as before: a free coder takes Ready while a card is in Review", () => {
    store.updateBoard(board.id, { oneCardAtATime: false })
    endRuns(second)
    store.updateTask(second, { columnRole: "review", actorId: "coder" })
    assert.equal(roleOf(second), "review")
    const third = readyCard(board.id, "Third card", ["coder"])
    assert.equal(roleOf(third), "in_progress")
    endRuns(third)
    store.updateTask(third, { archived: true })
    store.updateTask(second, { archived: true })
    store.updateBoard(board.id, { oneCardAtATime: true })
  })
})

describe("one card at a time with an architect", () => {
  it("a card entering Ready while the queue is held gets no dispatch until the queue frees", () => {
    const current = store.createTask({
      boardId: SEEDED,
      columnId: `${SEEDED}:in_progress`,
      title: "The current card",
      assigneeIds: ["owner", "coder"],
    }).id
    const waiting = store.createTask({
      boardId: SEEDED,
      columnId: `${SEEDED}:ready`,
      title: "A card that waits its turn",
      assigneeIds: [],
    }).id
    assert.deepEqual(triggers(waiting), [], "no dispatch while the queue is held")
    assert.deepEqual(texts(waiting), [], "and nothing in its chat")

    store.updateTask(current, { columnRole: "review" })
    assert.deepEqual(triggers(waiting), [])

    store.updateTask(current, { columnRole: "done" })
    assert.deepEqual(triggers(waiting), ["dispatch"])
    assert.ok(texts(waiting).some((t) => t.startsWith("Previous card is done — ")))
    endRuns(waiting)
    store.updateTask(waiting, { archived: true })
  })

  it("moving a card of people only dispatches nothing", () => {
    const agents = store.createTask({
      boardId: SEEDED,
      columnId: `${SEEDED}:in_progress`,
      title: "The coder's card",
      assigneeIds: ["coder"],
    }).id
    const people = store.createTask({
      boardId: SEEDED,
      columnId: `${SEEDED}:in_progress`,
      title: "A sheet in Figma",
      assigneeIds: ["owner"],
    }).id
    const waiting = store.createTask({ boardId: SEEDED, columnId: `${SEEDED}:ready`, title: "Next", assigneeIds: [] }).id
    store.updateTask(people, { columnRole: "review" })
    store.updateTask(people, { columnRole: "done" })
    assert.deepEqual(triggers(waiting), [], "the coder's card still holds the queue")
    assert.deepEqual(texts(waiting), [])
    store.updateTask(agents, { columnRole: "done" })
    assert.deepEqual(triggers(waiting), ["dispatch"])
    endRuns(waiting)
    store.updateTask(waiting, { archived: true })
  })
})

// Only cards with an agent among their assignees hold the queue: people work alongside it.
describe("one card at a time counts only cards of agents", () => {
  let own
  before(() => {
    own = store.createBoard({ name: "People alongside", repoPath: dir, architectEnabled: false })
  })

  it("a card of people only in In progress or Review does not hold Ready", () => {
    const people = store.createTask({
      boardId: own.id,
      columnId: columnOf(own.id, "in_progress"),
      title: "A sheet in Figma",
      assigneeIds: ["owner"],
    }).id
    const nobody = store.createTask({
      boardId: own.id,
      columnId: columnOf(own.id, "review"),
      title: "A decision",
      assigneeIds: [],
    }).id
    const card = readyCard(own.id, "Coder's card", ["coder"])
    assert.equal(roleOf(card), "in_progress", "the coder takes it at once")
    assert.equal(roleOf(people), "in_progress")
    endRuns(card)
    store.updateTask(card, { columnRole: "done" })
    store.updateTask(nobody, { archived: true })
  })

  it("a card with an agent and a person holds it", () => {
    const mixed = readyCard(own.id, "Mixed", ["coder", "owner"])
    const next = readyCard(own.id, "Next", ["coder"])
    assert.equal(roleOf(mixed), "in_progress")
    assert.equal(roleOf(next), "ready")
    assert.equal(store.queueWaitNote(own.id, next), "waiting for the current card")
    endRuns(mixed)
    store.updateTask(mixed, { columnRole: "done" })
    assert.equal(roleOf(next), "in_progress")
  })
})

// `Board.queueRelease` = 'review': the Architect's approval frees the queue, not the owner's Done.
describe("one card at a time, released by the Architect's review", () => {
  let reviewed
  let first
  let second

  before(() => {
    reviewed = store.createBoard({ name: "Released on review", repoPath: dir, queueRelease: "review" })
  })

  it("defaults to 'done' and takes 'review' when asked; anything else is refused", () => {
    const state = store.getState().boards
    assert.equal(state.find((b) => b.id === board.id).queueRelease, "done")
    assert.equal(state.find((b) => b.id === reviewed.id).queueRelease, "review")
    assert.throws(() => store.updateBoard(reviewed.id, { queueRelease: "later" }), store.ValidationError)
  })

  it("the coder's hand-off does not free the queue: the card waits for the Architect in In progress", () => {
    first = readyCard(reviewed.id, "First card", ["coder"])
    second = readyCard(reviewed.id, "Second card", ["coder"])
    assert.equal(roleOf(first), "in_progress")
    assert.equal(roleOf(second), "ready")
    endRuns(first)
    store.updateTask(first, { columnRole: "review", actorId: "coder" })
    assert.equal(roleOf(first), "in_progress", "the Architect reviews it where it is")
    assert.equal(roleOf(second), "ready")
    assert.equal(store.queueWaitNote(reviewed.id, second), "waiting for the current card")
  })

  it("the Architect moves it to Review → the next card starts", () => {
    endRuns(first)
    store.updateTask(first, { columnRole: "review", actorId: "architect" })
    assert.equal(roleOf(first), "review")
    assert.equal(roleOf(second), "in_progress")
    assert.ok(texts(second).some((t) => t.startsWith("Previous card is in Review — ")))
  })

  it("a card sent back from Review to In progress holds the queue again", () => {
    endRuns(second)
    store.updateTask(second, { columnRole: "review", actorId: "coder" })
    store.updateTask(second, { columnRole: "review", actorId: "architect" })
    assert.equal(roleOf(second), "review")
    store.updateTask(first, { columnRole: "in_progress" })
    const third = readyCard(reviewed.id, "Third card", ["coder"])
    assert.equal(roleOf(third), "ready", "the reworked card holds it")
    assert.equal(store.queueWaitNote(reviewed.id, third), "waiting for the current card")
    endRuns(first)
    store.updateTask(first, { columnRole: "review", actorId: "coder" })
    store.updateTask(first, { columnRole: "review", actorId: "architect" })
    assert.equal(roleOf(third), "in_progress", "back in Review, the queue moves on")
  })

  it("switching a held board to 'review' starts the next card at once", () => {
    const current = readyCard(board.id, "Current", ["coder"])
    const next = readyCard(board.id, "Next", ["coder"])
    endRuns(current)
    store.updateTask(current, { columnRole: "review", actorId: "coder" })
    assert.equal(roleOf(next), "ready", "with 'done', Review still holds it")
    store.updateBoard(board.id, { queueRelease: "review" })
    assert.equal(roleOf(next), "in_progress")
  })
})
