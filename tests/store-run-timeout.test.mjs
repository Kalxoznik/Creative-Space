// The agent's own run timeout (`runTimeoutMinutes`, src/server/store.ts). The rules under test:
// the setting is stored per agent within 5–180 min, unset means the old 20 min; a run closed as
// `timeout` keeps that status and still tells the owner; and the board's watchdog does not sweep a
// run before its agent's own limit is up.
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, before, describe, it } from "node:test"

const BOARD = "creative-space"
let store
let feed
let db
let dir

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-timeout-"))
  process.env.CS_DB_PATH = path.join(dir, "board.db")
  store = await import("../src/server/store.ts")
  feed = await import("../src/server/feed.ts")
  db = await import("../src/server/db.ts")
})

after(() => fs.rmSync(dir, { recursive: true, force: true }))

const coder = () => store.listMembers().find((m) => m.id === "coder")

/** A card in In progress for the coder, its run claimed. */
function claimedRun(title) {
  const task = store.createTask({ boardId: BOARD, columnId: `${BOARD}:backlog`, title, assigneeIds: ["coder"] })
  store.updateTask(task.id, { columnRole: "in_progress" })
  const claimed = store.claimRun("coder")
  assert.equal(claimed?.task.id, task.id)
  return { taskId: task.id, runId: claimed.run.id }
}

/** Pretend the worker last reported on this run `minutes` ago. */
function silentFor(runId, minutes) {
  const at = new Date(Date.now() - minutes * 60 * 1000).toISOString()
  db.getDb().prepare("UPDATE agent_runs SET heartbeat_at = ? WHERE id = ?").run(at, runId)
}

describe("runTimeoutMinutes on an agent", () => {
  it("is unset for agents from before, and is stored when set", () => {
    assert.equal(coder().agent.runTimeoutMinutes, null)
    store.updateAgent("coder", { runTimeoutMinutes: 60 })
    assert.equal(coder().agent.runTimeoutMinutes, 60)
    store.updateAgent("coder", { runTimeoutMinutes: "" })
    assert.equal(coder().agent.runTimeoutMinutes, null)
  })

  it("accepts whole minutes from 5 to 180 only", () => {
    for (const bad of [4, 181, 12.5, "soon"]) {
      assert.throws(() => store.updateAgent("coder", { runTimeoutMinutes: bad }), /from 5 to 180/)
    }
    const created = store.createAgent({ name: "Slow coder", role: "coder", engine: "codex", runTimeoutMinutes: 180 })
    assert.equal(created.agent.runTimeoutMinutes, 180)
  })
})

describe("a run closed as timeout", () => {
  it("keeps the status and tells the owner it timed out", () => {
    const { taskId, runId } = claimedRun("A card whose run hit the limit")
    const at = feed.listBoardEvents(BOARD, { limit: 500 }).cursor
    store.finishRun(runId, { status: "timeout", summary: "Stopped by the run timeout (60 min)." })

    assert.equal(store.getRun(runId).status, "timeout")
    const { events } = feed.listBoardEvents(BOARD, { since: at, limit: 500 })
    const event = events.find((e) => e.taskId === taskId && e.type === "run_failed")
    assert.ok(event, "the owner's feed does not hear about the timeout")
    assert.equal(event.data.timeout, true)
    assert.match(event.summary, /timed out/)
    // The coder is free again: nothing is left running.
    assert.equal(store.listRuns(taskId).some((r) => r.status === "running"), false)
  })
})

describe("the watchdog and an agent's own timeout", () => {
  it("waits out the agent's limit plus the margin before calling the run lost", () => {
    store.updateAgent("coder", { runTimeoutMinutes: 60 })
    const { runId } = claimedRun("A long quiet run")

    // Silent past the default 20 + 5 min, but well inside 60 + 5: still the worker's.
    silentFor(runId, 30)
    assert.equal(store.sweepLostRuns(), 0)
    assert.equal(store.getRun(runId).status, "running")

    silentFor(runId, 70)
    assert.equal(store.sweepLostRuns(), 1)
    assert.equal(store.getRun(runId).status, "failed")
    store.updateAgent("coder", { runTimeoutMinutes: null })
  })

  it("keeps the default for an agent that sets none", () => {
    const { runId } = claimedRun("A run of an agent with no limit of its own")
    silentFor(runId, 30)
    assert.equal(store.sweepLostRuns(), 1)
  })
})
