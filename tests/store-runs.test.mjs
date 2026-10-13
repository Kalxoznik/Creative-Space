// What may queue a run on a card (`enqueueRun` in src/server/store.ts). The rule under test:
// an agent reads the whole card at the start of a run, so one run per agent per card is
// enough — a second trigger arriving while the first run is queued or in flight is dropped.
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, before, beforeEach, describe, it } from "node:test"

const BOARD = "creative-space"
let store
let dir
/** Cards made so far: their runs are cleared between cases — the coder claims board-wide, FIFO. */
const made = []

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-store-"))
  process.env.CS_DB_PATH = path.join(dir, "board.db")
  store = await import("../src/server/store.ts")
})

after(() => fs.rmSync(dir, { recursive: true, force: true }))

function card(title) {
  const task = store.createTask({
    boardId: BOARD,
    columnId: `${BOARD}:backlog`,
    title,
    assigneeIds: ["coder"],
  })
  made.push(task.id)
  return task.id
}

/** A card in In progress, tagged for the coder, with its column run already queued. */
function cardInProgress(title) {
  const taskId = card(title)
  store.updateTask(taskId, { columnRole: "in_progress" })
  return taskId
}

const triggers = (taskId) => store.listRuns(taskId).map((run) => run.trigger)
const mentions = (taskId) => triggers(taskId).filter((trigger) => trigger.startsWith("mention:"))

describe("enqueueRun: one run per agent per card", () => {
  beforeEach(() => {
    for (const taskId of made) {
      for (const run of store.listRuns(taskId)) {
        if (run.status === "queued") store.cancelRun(run.id)
        else if (run.status === "running") store.finishRun(run.id, { status: "done" })
      }
    }
    made.length = 0
  })

  it("a card moved to In progress queues exactly one run for its coder", () => {
    const taskId = cardInProgress("A card to run on")
    assert.deepEqual(triggers(taskId), ["column:in_progress"])
  })

  it("the column run and a mention right after it stay one run", () => {
    const taskId = cardInProgress("A card mentioned right after the move")
    store.addMessage({ taskId, text: "@coder and please start with the tests" })
    assert.deepEqual(triggers(taskId), ["column:in_progress"])
  })

  it("a mention in a dispatch note queues nothing", () => {
    const taskId = card("A card the dispatch note lands on")
    store.addMessage({
      taskId,
      authorId: "architect",
      text: "Queue sorted: BI-1 goes to @coder, BI-2 waits for it.",
      participant: false,
    })
    assert.deepEqual(triggers(taskId), [])
  })

  it("an agent mentioning a busy agent queues nothing; a human gets one follow-up", () => {
    const taskId = cardInProgress("A card mentioned while its run is going")
    const claimed = store.claimRun("coder")
    assert.equal(claimed?.task.id, taskId)
    assert.equal(claimed?.run.trigger, "column:in_progress")

    store.addMessage({ taskId, authorId: "architect", text: "@coder note the edge case" })
    assert.deepEqual(triggers(taskId), ["column:in_progress"])

    store.addMessage({ taskId, text: "@coder drop it, do the other thing" })
    assert.equal(mentions(taskId).length, 1)

    // And the one follow-up is the limit: it is queued now, so the next message folds into it.
    store.addMessage({ taskId, text: "@coder one more thing" })
    assert.equal(mentions(taskId).length, 1)
  })

  it("a handle inside code, a fence or a quote wakes nobody", () => {
    const taskId = card("A card whose review quotes a handle")
    store.addMessage({
      taskId,
      authorId: "architect",
      text: [
        "The description says `@coder` and that is the whole trigger:",
        "```",
        "@coder do the thing",
        "```",
        "> @coder do the thing",
      ].join("\n"),
    })
    assert.deepEqual(triggers(taskId), [])

    // The same message with the handle spoken plainly still wakes the coder.
    store.addMessage({ taskId, authorId: "architect", text: "@coder do the thing" })
    assert.equal(mentions(taskId).length, 1)
  })

  it("an agent mentioning an agent on a reviewed card queues nothing; a human still wakes it", () => {
    const taskId = card("A card already reviewed")
    store.updateTask(taskId, { columnRole: "review" })
    store.addMessage({ taskId, authorId: "architect", text: "@coder the commit is in" })
    assert.deepEqual(triggers(taskId), [])

    store.addMessage({ taskId, text: "@coder please take another look" })
    assert.equal(mentions(taskId).length, 1)
  })
})
