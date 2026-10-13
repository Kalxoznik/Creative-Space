// A coder that ran out of turns (`continueAfterTurnLimit` in src/server/store.ts, BI-80). The
// rules under test: a failed run that left work in the checkout gets one more run on the same
// card, exactly one per stint in In progress — and the owner is told about the second limit,
// not the first one, which the board is already handling.
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-turn-limit-"))
  process.env.CS_DB_PATH = path.join(dir, "board.db")
  store = await import("../src/server/store.ts")
  feed = await import("../src/server/feed.ts")
})

after(() => fs.rmSync(dir, { recursive: true, force: true }))

/** A card in In progress with the coder's run claimed and running — where a limit is hit. */
function working(title) {
  const taskId = store.createTask({
    boardId: BOARD,
    columnId: `${BOARD}:backlog`,
    title,
    assigneeIds: ["coder"],
  }).id
  store.updateTask(taskId, { columnRole: "in_progress" })
  const claimed = store.claimRun("coder")
  assert.ok(claimed, "the coder claimed no run on the card")
  return { taskId, runId: claimed.run.id }
}

const cursor = () => feed.listBoardEvents(BOARD, { limit: 500 }).cursor
const eventsSince = (from, taskId) =>
  feed.listBoardEvents(BOARD, { since: from, limit: 500 }).events.filter((e) => e.taskId === taskId)
const triggers = (taskId) => store.listRuns(taskId).map((r) => r.trigger)
const queued = (taskId) => store.listRuns(taskId).filter((r) => r.status === "queued")

/** Leave the board quiet for the next case. */
function finish(taskId) {
  for (const run of store.listRuns(taskId)) {
    if (run.status === "queued") store.cancelRun(run.id)
    else if (run.status === "running") store.finishRun(run.id, { status: "done" })
  }
  store.updateTask(taskId, { archived: true })
}

/** The failed run the worker reports when the CLI ran out of turns with work on disk. */
const outOfTurns = (runId) =>
  store.finishRun(runId, {
    status: "failed",
    summary: "Claude Code: Hit the turn limit (80). The work is left in the working tree.",
    plain: "Hit the turn limit (80). The work is left in the working tree.",
    turnLimit: true,
  })

describe("one automatic continuation", () => {
  it("queues one more run for the same coder on the same card", () => {
    const { taskId, runId } = working("A card the coder ran out of turns on")
    const at = cursor()

    outOfTurns(runId)

    const waiting = queued(taskId)
    assert.equal(waiting.length, 1, "no continuation was queued")
    assert.match(waiting[0].trigger, /^continue:\d+$/)
    assert.equal(waiting[0].agentId, "coder")
    assert.equal(store.getTask(taskId).columnId, `${BOARD}:in_progress`, "the card does not move")
    // The chat says why the card is running again, and the trigger points at that message.
    const note = store.listMessages(taskId).at(-1)
    assert.equal(note.kind, "system")
    assert.match(note.text, /ran out of turns/)
    assert.equal(waiting[0].trigger, `continue:${note.id}`)
    // The owner is not told: the board is handling it.
    const failed = eventsSince(at, taskId).find((e) => e.type === "run_failed")
    assert.equal(failed.data.continued, true)
    finish(taskId)
  })

  it("does not queue a second one — the next limit is a plain failure", () => {
    const { taskId, runId } = working("A card the coder ran out of turns on twice")
    outOfTurns(runId)
    const again = store.claimRun("coder")
    assert.match(again.run.trigger, /^continue:\d+$/)
    const at = cursor()

    outOfTurns(again.run.id)

    assert.deepEqual(queued(taskId), [], "a second continuation was queued")
    assert.equal(triggers(taskId).filter((t) => t.startsWith("continue:")).length, 1)
    const failed = eventsSince(at, taskId).find((e) => e.type === "run_failed")
    assert.equal(failed.data.continued, undefined, "the owner was not told about the second limit")
    assert.match(failed.plain, /turn limit/)
    finish(taskId)
  })

  it("gives the card another continuation on its next stint in In progress", () => {
    const { taskId, runId } = working("A card that comes back to In progress")
    outOfTurns(runId)
    for (const run of queued(taskId)) store.cancelRun(run.id)
    // Out of In progress and back again: a fresh stint, a fresh continuation.
    store.updateTask(taskId, { columnRole: "review" })
    store.updateTask(taskId, { columnRole: "in_progress" })
    const claimed = store.claimRun("coder")
    assert.equal(claimed.run.trigger, "column:in_progress")

    outOfTurns(claimed.run.id)

    assert.equal(queued(taskId).length, 1, "the card got no continuation on its second stint")
    finish(taskId)
  })

  it("leaves an ordinary failure alone", () => {
    const { taskId, runId } = working("A card whose run simply broke")
    store.finishRun(runId, { status: "failed", summary: "claude exited with 1" })
    assert.deepEqual(queued(taskId), [])
    finish(taskId)
  })

  it("stays out of the way of a card waiting for the owner", () => {
    const { taskId, runId } = working("A card that stopped for the owner")
    store.setNeedsOwner(taskId, { actorId: "coder", reason: "question", text: "which shape?" })
    outOfTurns(runId)
    assert.deepEqual(queued(taskId), [])
    store.clearNeedsOwner(taskId)
    finish(taskId)
  })
})
