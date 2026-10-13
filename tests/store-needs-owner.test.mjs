// "Waiting for the owner" (src/server/store.ts): an agent stops a card on the owner's word,
// the card keeps the flag and wakes nobody, and a human's message — or the badge's button —
// lets it go on again.
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, before, describe, it } from "node:test"

const BOARD = "creative-space"
let store
let feed
let dir

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-needs-owner-"))
  process.env.CS_DB_PATH = path.join(dir, "board.db")
  store = await import("../src/server/store.ts")
  feed = await import("../src/server/feed.ts")
})

after(() => fs.rmSync(dir, { recursive: true, force: true }))

/** A card in In progress with the coder's run claimed — where a coder stops for the owner. */
function workingCard(title) {
  const taskId = store.createTask({
    boardId: BOARD,
    columnId: `${BOARD}:backlog`,
    title,
    assigneeIds: ["coder"],
  }).id
  store.updateTask(taskId, { columnRole: "in_progress" })
  const claimed = store.claimRun("coder")
  store.finishRun(claimed.run.id, { status: "done" })
  return taskId
}

const queuedRuns = (taskId) => store.listRuns(taskId).filter((r) => r.status === "queued")
const cursor = () => feed.listBoardEvents(BOARD, { limit: 500 }).cursor
const eventsSince = (from, taskId) =>
  feed.listBoardEvents(BOARD, { since: from, limit: 500 }).events.filter((e) => e.taskId === taskId)

/** Free the coder again, so the next case starts from a quiet board. */
function finish(taskId) {
  store.clearNeedsOwner(taskId)
  for (const run of store.listRuns(taskId)) {
    if (run.status === "queued") store.cancelRun(run.id)
    else if (run.status === "running") store.finishRun(run.id, { status: "done" })
  }
  store.updateTask(taskId, { archived: true })
}

describe("an agent asks for the owner", () => {
  it("sets the flag on the card, leaves it where it is and writes needs_owner", () => {
    const taskId = workingCard("A card that needs money spent")
    const column = store.getTask(taskId).columnId
    const at = cursor()

    const { needsOwner } = store.setNeedsOwner(taskId, {
      actorId: "coder",
      reason: "paid_call",
      text: "200 calls to the model — that is money",
    })
    assert.deepEqual(needsOwner, { reason: "paid_call", text: "200 calls to the model — that is money" })

    const task = store.getTask(taskId)
    assert.deepEqual(task.needsOwner, needsOwner)
    assert.equal(task.columnId, column, "the card does not move")

    const event = eventsSince(at, taskId).find((e) => e.type === "needs_owner")
    assert.ok(event, "the feed gets a needs_owner line")
    assert.equal(event.data.reason, "paid_call")
    assert.equal(event.actor, "coder")
    assert.match(event.summary, /waiting for the owner/)
    // The chat says it too — the badge is not the only place this is visible.
    const last = store.listMessages(taskId).at(-1)
    assert.equal(last.kind, "system")
    assert.match(last.text, /200 calls to the model/)
    finish(taskId)
  })

  it("only an agent on the board can set it, and only with one of the four reasons", () => {
    const taskId = workingCard("A card somebody else wants to park")
    assert.throws(
      () => store.setNeedsOwner(taskId, { actorId: "owner", reason: "question", text: "?" }),
      /Only an agent/
    )
    assert.throws(() => store.setNeedsOwner(taskId, { actorId: "coder", reason: "money", text: "?" }), /reason must be/)
    assert.equal(store.getTask(taskId).needsOwner, null)
    finish(taskId)
  })

  it("a missing text falls back to the reason, so the badge is never empty", () => {
    const taskId = workingCard("A card parked without a word")
    store.setNeedsOwner(taskId, { actorId: "coder", reason: "deploy", text: "" })
    assert.equal(store.getTask(taskId).needsOwner.text, "a deploy")
    finish(taskId)
  })
})

describe("while the flag is on", () => {
  it("an agent's mention wakes nobody and does not drag the card anywhere", () => {
    const taskId = workingCard("A card the architect pokes at")
    store.setNeedsOwner(taskId, { actorId: "coder", reason: "question", text: "Which of the two shapes?" })

    store.addMessage({ taskId, authorId: "architect", text: "@coder let's go with the first option after all" })
    assert.deepEqual(queuedRuns(taskId), [], "no run is queued for the coder")
    assert.ok(store.getTask(taskId).needsOwner, "and the flag stays on")
    finish(taskId)
  })

  it("the runs that were already waiting on the card are cancelled", () => {
    const taskId = workingCard("A card with a run waiting on it")
    store.addMessage({ taskId, authorId: "owner", text: "@coder one more clarification" })
    assert.equal(queuedRuns(taskId).length, 1)

    store.setNeedsOwner(taskId, { actorId: "coder", reason: "corpus_write", text: "Write to the corpus or not" })
    assert.deepEqual(queuedRuns(taskId), [], "the waiting run would have woken the agent that is asking")
    finish(taskId)
  })

  it("a flagged card in the queue is not pulled into In progress", () => {
    // The coder is busy, so the second card stays in Ready and can be flagged there.
    const busy = workingCard("A card the coder already has")
    const parked = store.createTask({
      boardId: BOARD,
      columnId: `${BOARD}:ready`,
      title: "A queued card waiting for the owner",
      assigneeIds: ["coder"],
    }).id
    assert.equal(store.getTask(parked).columnId, `${BOARD}:ready`)
    store.setNeedsOwner(parked, { actorId: "coder", reason: "deploy", text: "Deploy this or not" })

    // The coder is free now: the only thing keeping this card in Ready is the flag.
    finish(busy)
    assert.equal(store.getTask(parked).columnId, `${BOARD}:ready`)
    assert.equal(store.queueWaitNote(BOARD, parked), "waiting for the owner")
    finish(parked)
  })

  it("the flagged card holds no coder: the next Ready card is pulled while the answer waits", () => {
    // With one card at a time on, any card in In progress holds Ready (store-one-card.test.mjs).
    store.updateBoard(BOARD, { oneCardAtATime: false })
    const parked = workingCard("A card parked on a question")
    const next = store.createTask({
      boardId: BOARD,
      columnId: `${BOARD}:backlog`,
      title: "The card the coder takes meanwhile",
      assigneeIds: ["coder"],
    }).id
    store.setNeedsOwner(parked, { actorId: "coder", reason: "question", text: "This way or that?" })

    store.updateTask(next, { columnRole: "ready" })
    assert.equal(store.getTask(next).columnId, `${BOARD}:in_progress`, "the coder is free and takes it")
    assert.equal(store.getTask(parked).columnId, `${BOARD}:in_progress`, "the parked card stays where it is")
    assert.ok(store.getTask(parked).needsOwner, "with its flag on")

    // The owner's answer just joins the coder's run queue behind the card it took.
    store.addMessage({ taskId: parked, authorId: "owner", text: "@coder the first option" })
    assert.equal(store.getTask(parked).needsOwner, null)
    assert.equal(queuedRuns(parked).length, 1)
    finish(next)
    finish(parked)
    store.updateBoard(BOARD, { oneCardAtATime: true })
  })
})

describe("taking the flag off", () => {
  it("a human's message clears it, and their mention wakes the coder as usual", () => {
    const taskId = workingCard("A card the owner answers")
    store.setNeedsOwner(taskId, { actorId: "coder", reason: "question", text: "Which of the two options?" })
    const at = cursor()

    store.addMessage({ taskId, authorId: "owner", text: "@coder take the first option" })
    assert.equal(store.getTask(taskId).needsOwner, null)
    assert.equal(queuedRuns(taskId).length, 1, "the mention in the answer starts the run")

    const cleared = eventsSince(at, taskId).find((e) => e.type === "needs_owner")
    assert.ok(cleared)
    assert.equal(cleared.data.cleared, true)
    finish(taskId)
  })

  it("an agent's message does not clear it", () => {
    const taskId = workingCard("A card an agent talks over")
    store.setNeedsOwner(taskId, { actorId: "coder", reason: "question", text: "This way or that?" })
    store.addMessage({ taskId, authorId: "architect", text: "I'd say the first option" })
    assert.ok(store.getTask(taskId).needsOwner)
    finish(taskId)
  })

  it("the badge's button clears it, and says nothing when there was nothing to clear", () => {
    const taskId = workingCard("A card the owner un-parks by hand")
    store.setNeedsOwner(taskId, { actorId: "coder", reason: "paid_call", text: "Spend the quota or not" })

    assert.deepEqual(store.clearNeedsOwner(taskId), { cleared: true })
    assert.equal(store.getTask(taskId).needsOwner, null)
    assert.deepEqual(store.clearNeedsOwner(taskId), { cleared: false })
    finish(taskId)
  })
})
