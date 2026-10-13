// The board's watchdog (`sweepLostRuns` in src/server/store.ts). The rule under test: a run
// stays `running` only while its worker reports; one that went silent is failed by the board
// itself, so the agent it was holding is free again and the card says what happened.
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, before, describe, it } from "node:test"

const BOARD = "creative-space"
let store
let dir

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-lost-"))
  process.env.CS_DB_PATH = path.join(dir, "board.db")
  store = await import("../src/server/store.ts")
})

after(() => fs.rmSync(dir, { recursive: true, force: true }))

/** A card in In progress, tagged for the coder: moving it there queues the coder's run. */
function cardInProgress(title) {
  const task = store.createTask({
    boardId: BOARD,
    columnId: `${BOARD}:backlog`,
    title,
    assigneeIds: ["coder"],
  })
  store.updateTask(task.id, { columnRole: "in_progress" })
  return task.id
}

describe("sweepLostRuns: a run nobody reports on is failed by the board", () => {
  it("leaves a run that is being worked on alone, and closes it once it goes silent", () => {
    const taskId = cardInProgress("A card whose worker dies")
    const claimed = store.claimRun("coder")
    assert.equal(claimed?.task.id, taskId)
    const runId = claimed.run.id

    // The run just reported (it was claimed): the real grace period keeps it running…
    assert.equal(store.sweepLostRuns(), 0)
    assert.equal(store.getRun(runId).status, "running")

    // …and with no grace at all — the worker has been silent "too long" — the board gives up.
    assert.equal(store.sweepLostRuns(0), 1)
    const run = store.getRun(runId)
    assert.equal(run.status, "failed")
    assert.match(run.summary, /lost the run/)
    assert.ok(run.finishedAt)

    // The card is told, and it stays where it was.
    const last = store.listMessages(taskId).at(-1)
    assert.equal(last.kind, "system")
    assert.match(last.text, /The board lost this run/)
    assert.equal(store.getTask(taskId).columnId, `${BOARD}:in_progress`)

    // Nothing is left to sweep, and the coder is free: it can claim again.
    assert.equal(store.sweepLostRuns(0), 0)
  })

  it("frees the agent, so the next card in the queue starts", () => {
    const first = cardInProgress("The card the lost run was on")
    const claimed = store.claimRun("coder")
    assert.equal(claimed?.task.id, first)
    const next = cardInProgress("The card waiting behind it")
    // The coder is busy with the lost run: nothing can be claimed for it.
    assert.equal(store.claimRun("coder"), null)

    store.sweepLostRuns(0)

    const after = store.claimRun("coder")
    assert.equal(after?.task.id, next)
    // And a run the worker is really executing is not swept out from under it.
    assert.equal(store.sweepLostRuns(), 0)
    store.finishRun(after.run.id, { status: "done" })
  })
})
