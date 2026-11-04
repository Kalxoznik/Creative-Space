// An agent asks another agent on a card, the answer wakes the asker (`wakeAsker` in
// src/server/store.ts) — even when the answer does not tag it, which is how a coder once sat
// 40 minutes next to the architect's answer. Not when the answer goes up to a human, not twice
// for one question, and not past three rounds an hour: then the card waits for the owner.
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, before, describe, it } from "node:test"

const BOARD = "creative-space"
let store
let dir

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-reply-wake-"))
  process.env.CS_DB_PATH = path.join(dir, "board.db")
  store = await import("../src/server/store.ts")
  store.createPerson({ name: "Outside Claude", handle: "claude" })
})

after(() => fs.rmSync(dir, { recursive: true, force: true }))

const nameOf = (id) => store.listMembers().find((m) => m.id === id).name
const replyRuns = (taskId) => store.listRuns(taskId).filter((run) => run.trigger.startsWith("reply:"))
const systemLines = (taskId) =>
  store
    .listMessages(taskId)
    .filter((m) => m.kind === "system")
    .map((m) => m.text)

/** A card in In progress whose coder run has been claimed and finished. */
function cardAtWork(title) {
  const taskId = store.createTask({
    boardId: BOARD,
    columnId: `${BOARD}:backlog`,
    title,
    assigneeIds: ["coder"],
  }).id
  store.updateTask(taskId, { columnRole: "in_progress" })
  finishClaimed("coder", taskId)
  unsupervised(taskId)
  return taskId
}

/**
 * A coder run that ends with nothing after it wakes the Architect on the card (`supervise:`,
 * tests/store-supervise.test.mjs). Not what these cases are about: that run is dropped, or the
 * coder's question below would fold into it.
 */
function unsupervised(taskId) {
  for (const run of store.listRuns(taskId)) {
    if (run.status === "queued" && run.trigger.startsWith("supervise:")) store.cancelRun(run.id)
  }
}

function finishClaimed(agentId, taskId) {
  const claimed = store.claimRun(agentId)
  assert.equal(claimed?.task.id, taskId)
  store.finishRun(claimed.run.id, { status: "done" })
  return claimed
}

/** The coder asks the architect; the architect's run is claimed and left running. */
function coderAsks(taskId, text = "@architect which of the two shapes?") {
  store.addMessage({ taskId, authorId: "coder", text })
  const claimed = store.claimRun("architect")
  assert.equal(claimed?.task.id, taskId)
  assert.match(claimed.run.trigger, /^mention:\d+$/)
  return claimed.run
}

/** Free the card for the next case. */
function done(taskId) {
  for (const run of store.listRuns(taskId)) {
    if (run.status === "queued") store.cancelRun(run.id)
    else if (run.status === "running") store.finishRun(run.id, { status: "done" })
  }
  store.updateTask(taskId, { archived: true })
}

describe("an answer to an agent's question", () => {
  it("wakes the asker without a tag, and says so in the thread", () => {
    const taskId = cardAtWork("The coder asks the architect")
    const asked = coderAsks(taskId)
    const answer = store.addMessage({ taskId, authorId: "architect", text: "Take the first shape." })
    assert.deepEqual(answer.woke, ["coder"])
    assert.equal(answer.text, "Take the first shape.", "the answer's text stays as written")

    const [wake] = replyRuns(taskId)
    assert.equal(wake.agentId, "coder")
    assert.equal(wake.trigger, `reply:${answer.id}`)
    assert.equal(wake.status, "queued")
    assert.ok(systemLines(taskId).includes(`${nameOf("architect")} answered — ${nameOf("coder")} continues.`))

    // One wake-up per question: a second message of the same run wakes nobody again.
    store.addMessage({ taskId, authorId: "architect", text: "And mind the migration." })
    assert.equal(replyRuns(taskId).length, 1)

    // The woken run gets the answer as its trigger message.
    store.finishRun(asked.id, { status: "done" })
    const woken = store.claimRun("coder")
    assert.equal(woken?.run.trigger, `reply:${answer.id}`)
    assert.equal(woken?.triggerMessage?.id, answer.id)
    done(taskId)
  })

  it("is left to the mention when the answer tags the asker itself", () => {
    const taskId = cardAtWork("The architect tags the coder back")
    coderAsks(taskId)
    store.addMessage({ taskId, authorId: "architect", text: "@coder take the first shape." })
    assert.equal(replyRuns(taskId).length, 0)
    assert.equal(store.listRuns(taskId).filter((r) => r.agentId === "coder" && r.status === "queued").length, 1)
    done(taskId)
  })

  it("going up to a human wakes nobody and stops the card for a human", () => {
    const taskId = cardAtWork("The architect escalates")
    coderAsks(taskId)
    const answer = store.addMessage({ taskId, authorId: "architect", text: "@claude this one is yours to decide." })
    assert.deepEqual(answer.woke, [])
    assert.equal(replyRuns(taskId).length, 0)
    assert.equal(store.getTask(taskId).needsOwner?.reason, "question")

    // The human's answer takes the flag off and their tag wakes the coder as usual.
    const human = store.listMembers().find((m) => m.handle === "claude")
    store.addMessage({ taskId, authorId: human.id, text: "@coder the first shape." })
    assert.equal(store.getTask(taskId).needsOwner, null)
    done(taskId)
  })

  it("past three rounds an hour stops the card on an agents loop", () => {
    const taskId = cardAtWork("Two agents keep asking each other")
    const human = store.listMembers().find((m) => m.handle === "claude")
    for (let round = 1; round <= 3; round += 1) {
      const asked = coderAsks(taskId, `@architect question ${round}?`)
      store.addMessage({ taskId, authorId: "architect", text: `Answer ${round}.` })
      store.finishRun(asked.id, { status: "done" })
      finishClaimed("coder", taskId)
      unsupervised(taskId)
      // A human remark in between resets the six-messages-in-a-row guard, which is a different
      // one: this cap counts rounds an hour, whoever spoke between them.
      store.addMessage({ taskId, authorId: human.id, text: "Watching." })
    }
    assert.equal(replyRuns(taskId).length, 3)

    coderAsks(taskId, "@architect question 4?")
    const answer = store.addMessage({ taskId, authorId: "architect", text: "Answer 4." })
    assert.deepEqual(answer.woke, [])
    assert.equal(replyRuns(taskId).length, 3)
    assert.equal(store.getTask(taskId).needsOwner?.reason, "agents_loop")
    done(taskId)
  })

  it("a question from a human is not the board's to follow up", () => {
    const taskId = cardAtWork("The owner asks the architect")
    store.addMessage({ taskId, text: "@architect which shape?" })
    store.claimRun("architect")
    store.addMessage({ taskId, authorId: "architect", text: "The first one." })
    assert.equal(replyRuns(taskId).length, 0)
    done(taskId)
  })
})
