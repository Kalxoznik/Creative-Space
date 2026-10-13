// The owner writes in a card's chat and forgets the tag: that message is addressed to the
// board's architect (`triggerMentions` in src/server/store.ts). A tagged message is unchanged —
// only the agents it names wake up — and on a board whose architect is switched off nothing
// runs at all: the feed gets an `owner_message` line for the architect outside the board.
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, before, describe, it } from "node:test"

const BOARD = "creative-space"
let store
let feed
let dir
/** The board with no architect of its own. */
let off

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-owner-msg-"))
  process.env.CS_DB_PATH = path.join(dir, "board.db")
  store = await import("../src/server/store.ts")
  feed = await import("../src/server/feed.ts")
  off = store.createBoard({ name: "No architect", repoPath: dir, architectEnabled: false })
})

after(() => fs.rmSync(dir, { recursive: true, force: true }))

const column = (board, role) => board.columns.find((c) => c.role === role).id
const triggers = (taskId) => store.listRuns(taskId).map((run) => run.trigger)
const agentOf = (taskId, trigger) => store.listRuns(taskId).find((run) => run.trigger === trigger)?.agentId

/** A card in Backlog on the seeded board, tagged for nobody. */
function card(title) {
  return store.createTask({ boardId: BOARD, columnId: `${BOARD}:backlog`, title, assigneeIds: [] }).id
}

/** Free whoever this card holds, so the next case starts from a quiet board. */
function finish(taskId) {
  for (const run of store.listRuns(taskId)) {
    if (run.status === "queued") store.cancelRun(run.id)
    else if (run.status === "running") store.finishRun(run.id, { status: "done" })
  }
  store.updateTask(taskId, { archived: true })
}

describe("an untagged message of the owner", () => {
  it("queues exactly one architect run, with an owner trigger", () => {
    const taskId = card("A card the owner writes on")
    const message = store.addMessage({ taskId, text: "move this to ready" })
    assert.deepEqual(triggers(taskId), [`owner:${message.id}`])
    assert.equal(agentOf(taskId, `owner:${message.id}`), "architect")
    finish(taskId)
  })

  it("wakes only the agents a tagged message names", () => {
    const taskId = card("A card the owner tags the coder on")
    const message = store.addMessage({ taskId, text: "@coder take this" })
    assert.deepEqual(triggers(taskId), [`mention:${message.id}`])
    finish(taskId)
  })

  it("is a handle in the addressed part that counts, not one inside a code span", () => {
    const taskId = card("A card whose message quotes a handle")
    const message = store.addMessage({ taskId, text: "the description says `@coder`, fix it" })
    assert.deepEqual(triggers(taskId), [`owner:${message.id}`])
    finish(taskId)
  })

  it("from somebody who is not the owner wakes nobody", () => {
    const person = store.createPerson({ name: "Claude (chat)", handle: "claude" })
    const taskId = card("A card an outside human comments on")
    store.addMessage({ taskId, authorId: person.id, text: "looks clear to me" })
    assert.deepEqual(triggers(taskId), [])
    finish(taskId)
  })
})

describe("a board whose architect is switched off", () => {
  it("records owner_message and starts nothing", () => {
    const taskId = store.createTask({
      boardId: off.id,
      columnId: column(off, "backlog"),
      title: "A card on a board planned from the outside",
      assigneeIds: [],
    }).id
    const before = feed.listBoardEvents(off.id, { limit: 500 }).cursor
    const message = store.addMessage({ taskId, text: "this one can be closed" })
    assert.deepEqual(triggers(taskId), [])

    const events = feed.listBoardEvents(off.id, { since: before, limit: 500 }).events
    const line = events.find((event) => event.type === "owner_message")
    assert.ok(line, "the feed has an owner_message line")
    assert.equal(line.taskId, taskId)
    assert.ok(line.ref, "the line names the card")
    assert.equal(line.actor, "owner")
    assert.equal(line.data.messageId, message.id)
    // The text of the message is in the chat, not in the feed.
    assert.ok(!JSON.stringify(line).includes("this one can be closed"))
    finish(taskId)
  })
})
