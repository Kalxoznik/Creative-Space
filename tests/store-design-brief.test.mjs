// A design brief — a card whose title starts with "[Design]" — belongs to the designer and the
// owner. The board wakes no agent on it by itself: no dispatch when it enters Ready, no column
// trigger, no review, not the owner's untagged message (`isDesignBrief` / `enqueueRun` in
// src/server/store.ts). Only an explicit @mention in its chat reaches the agent named. The
// Architect's dispatch does not see such cards in the queue, coders step over them, and one in
// In progress does not hold the coders' queue.
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, before, describe, it } from "node:test"

const BOARD = "creative-space"
let store
let dir

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-design-brief-"))
  process.env.CS_DB_PATH = path.join(dir, "board.db")
  store = await import("../src/server/store.ts")
})

after(() => fs.rmSync(dir, { recursive: true, force: true }))

const triggers = (taskId) => store.listRuns(taskId).map((run) => `${run.agentId}/${run.trigger}/${run.status}`)
const systemLines = (taskId) => store.listMessages(taskId).filter((m) => m.kind === "system").map((m) => m.text)
const roleOf = (taskId) => {
  const task = store.getTask(taskId)
  return store.getState().boards.find((b) => b.id === task.boardId).columns.find((c) => c.id === task.columnId).role
}
function card(title, assigneeIds = []) {
  return store.createTask({ boardId: BOARD, columnId: `${BOARD}:backlog`, title, assigneeIds }).id
}
function finish(taskId) {
  for (const run of store.listRuns(taskId)) {
    if (run.status === "queued") store.cancelRun(run.id)
    else if (run.status === "running") store.finishRun(run.id, { status: "done" })
  }
  store.updateTask(taskId, { archived: true })
}

describe("a [Design] card", () => {
  it("is recognised by its title, whatever the case or spacing", () => {
    for (const title of ["[Design] Right panel", "  [design] spacing", "[DESIGN]: icons"]) {
      const id = card(title)
      assert.equal(store.isDesignBrief(id), true, title)
      finish(id)
    }
    for (const title of ["Design the panel", "Right panel [Design]", "[Designer] notes"]) {
      const id = card(title)
      assert.equal(store.isDesignBrief(id), false, title)
      finish(id)
    }
  })

  it("wakes nobody when it enters Ready or In progress, and nothing is written about agents", () => {
    const id = card("[Design] Right panel: the effects list", [store.ownerId(), "architect"])
    store.updateTask(id, { columnRole: "ready" })
    assert.deepEqual(triggers(id), [])
    assert.ok(!systemLines(id).some((t) => /sorts the queue/.test(t)), "no dispatch line")
    store.updateTask(id, { columnRole: "in_progress" })
    assert.deepEqual(triggers(id), [])
    assert.ok(!systemLines(id).some((t) => /picks it up/.test(t)), "no pick-up line")
    store.updateTask(id, { columnRole: "review" })
    assert.deepEqual(triggers(id), [], "no review either")
    finish(id)
  })

  it("the owner's untagged message and a 'Designer:' answer start no run", () => {
    const id = card("[Design] Export dialog", [store.ownerId()])
    store.updateTask(id, { columnRole: "ready" })
    store.addMessage({ taskId: id, text: "What do you think about the second option?" })
    store.addMessage({ taskId: id, text: "Designer: the second one, with the wider gutter." })
    assert.deepEqual(triggers(id), [])
    finish(id)
  })

  it("an explicit @mention still reaches the agent named", () => {
    const id = card("[Design] Export dialog, with a question", [store.ownerId()])
    store.addMessage({ taskId: id, text: "@architect is this feasible in the current export?" })
    assert.deepEqual(triggers(id), ["architect/mention:" + store.listMessages(id).at(-1).id + "/queued"])
    finish(id)
  })

  it("the Architect's dispatch does not see it, and the coders step over it", () => {
    const brief = card("[Design] Hover states", [])
    store.updateTask(brief, { columnRole: "ready", position: 0 })
    const work = card("Hover color fix", [])
    store.updateTask(work, { columnRole: "ready" })
    const dispatch = store.listRuns(work).find((run) => run.trigger === "dispatch")
    assert.ok(dispatch, "the ordinary card is dispatched")
    const context = store.claimRun("architect")
    assert.ok(context && context.run.id === dispatch.id)
    assert.deepEqual(context.queue.ready.map((c) => c.title), ["Hover color fix"], "the brief is not in the queue the Architect sorts")
    store.finishRun(context.run.id, { status: "done" })
    assert.equal(roleOf(brief), "ready", "no coder pulled the brief")
    finish(brief)
    finish(work)
  })
})
