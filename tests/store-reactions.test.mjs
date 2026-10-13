// Reactions: what is stored, and what the owner's one reaction means (`addReaction` in
// src/server/store.ts). 👍 on a card in Review closes it without a run; everything else — anybody
// else's 👍, and the owner's on a card outside Review — is a mark on a message.
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-reactions-"))
  process.env.CS_DB_PATH = path.join(dir, "board.db")
  store = await import("../src/server/store.ts")
  feed = await import("../src/server/feed.ts")
  store.updateMe({ name: "Max" })
})

after(() => fs.rmSync(dir, { recursive: true, force: true }))

const card = (title, column = "backlog") =>
  store.createTask({ boardId: BOARD, columnId: `${BOARD}:${column}`, title, assigneeIds: [] }).id

/** The coder asks the owner something on this card, and that message is what gets reacted to. */
function question(taskId, text = "@owner do we break the old boards?\n\nIn short: Should the old boards break?") {
  return store.addMessage({ taskId, authorId: "coder", text }).id
}

const runs = (taskId) => store.listRuns(taskId)

/** Free whoever this card holds, so the next case starts from a quiet board. */
function finish(taskId) {
  for (const run of store.listRuns(taskId)) {
    if (run.status === "queued") store.cancelRun(run.id)
    else if (run.status === "running") store.finishRun(run.id, { status: "done" })
  }
  store.updateTask(taskId, { archived: true })
}

describe("storing a reaction", () => {
  it("puts one on, takes it off and puts it on again", () => {
    const taskId = card("A card with a reaction on a message")
    const messageId = store.addMessage({ taskId, authorId: "coder", text: "ready" }).id

    const added = store.addReaction({ taskId, messageId, emoji: "👍" })
    assert.equal(added.reaction.emoji, "👍")
    assert.equal(added.reaction.memberId, store.ownerId())
    assert.equal(added.effect, "none")
    assert.equal(store.listReactions(taskId).length, 1)

    // The same one twice is the same reaction — one row, not two.
    store.addReaction({ taskId, messageId, emoji: "👍" })
    assert.equal(store.listReactions(taskId).length, 1)

    assert.deepEqual(store.removeReaction({ taskId, messageId, emoji: "👍" }), { removed: true })
    assert.deepEqual(store.listReactions(taskId), [])
    // Taking off what is not there is not an error.
    assert.deepEqual(store.removeReaction({ taskId, messageId, emoji: "👍" }), { removed: false })

    store.addReaction({ taskId, messageId, emoji: "👍" })
    assert.equal(store.listReactions(taskId).length, 1)
    assert.deepEqual(store.getThread(taskId).reactions.map((r) => r.emoji), ["👍"])
    finish(taskId)
  })

  it("refuses an emoji the board has no meaning for, and a message on another card", () => {
    const taskId = card("A card with a made-up reaction")
    const messageId = store.addMessage({ taskId, authorId: "coder", text: "ready" }).id
    const other = card("Another card")
    assert.throws(() => store.addReaction({ taskId, messageId, emoji: "🤡" }))
    assert.throws(() => store.addReaction({ taskId, messageId, emoji: "" }))
    // The four the board used to know say nothing now: the owner answers a question in words.
    for (const emoji of ["👎", "✅", "👀", "❓"]) {
      assert.throws(() => store.addReaction({ taskId, messageId, emoji }), /👍/)
    }
    assert.throws(() => store.addReaction({ taskId: other, messageId, emoji: "👍" }))
    assert.throws(() => store.addReaction({ taskId, messageId: 999999, emoji: "👍" }))
    finish(taskId)
    finish(other)
  })

  it("is in the feed, as a line nobody is notified about", () => {
    const taskId = card("A card whose reaction shows up in the feed")
    const messageId = store.addMessage({ taskId, authorId: "coder", text: "ready" }).id
    const since = feed.listBoardEvents(BOARD, { limit: 500 }).cursor
    store.addReaction({ taskId, messageId, emoji: "👍" })
    store.removeReaction({ taskId, messageId, emoji: "👍" })
    const lines = feed
      .listBoardEvents(BOARD, { since, limit: 500 })
      .events.filter((e) => e.type.startsWith("reaction_"))
    assert.deepEqual(lines.map((e) => e.type), ["reaction_added", "reaction_removed"])
    assert.equal(lines[0].data.emoji, "👍")
    assert.equal(lines[0].data.messageId, messageId)
    assert.equal(lines[0].data.effect, "none")
    finish(taskId)
  })
})

describe("a 👍 that means nothing", () => {
  it("wakes nobody on an ordinary message", () => {
    const taskId = card("A card with an ordinary message")
    const messageId = store.addMessage({ taskId, authorId: "coder", text: "cleaned up the notifications" }).id
    store.addReaction({ taskId, messageId, emoji: "👍" })
    assert.deepEqual(runs(taskId), [])
    finish(taskId)
  })

  it("is not an answer to an agent's question — nothing is woken and nothing is written", () => {
    const taskId = card("A card the coder asked about")
    const messageId = question(taskId)
    const before = store.listMessages(taskId).length
    assert.equal(store.addReaction({ taskId, messageId, emoji: "👍" }).effect, "none")
    assert.deepEqual(runs(taskId), [])
    assert.equal(store.listMessages(taskId).length, before)
    finish(taskId)
  })

  it("does nothing when it is not the owner reacting", () => {
    const taskId = card("A card another agent reacts on", "review")
    const messageId = store.addMessage({ taskId, authorId: "coder", text: "done" }).id
    const result = store.addReaction({ taskId, messageId, emoji: "👍", memberId: "architect" })
    assert.equal(result.effect, "none")
    assert.equal(result.reaction.memberId, "architect")
    assert.equal(store.getTask(taskId).columnId, `${BOARD}:review`)
    assert.deepEqual(runs(taskId), [])
    finish(taskId)
  })
})

describe("the owner's 👍", () => {
  it("moves a card in Review to Done, without waking an agent", () => {
    const taskId = card("A card the owner signs off", "review")
    const messageId = store.addMessage({ taskId, authorId: "coder", text: "done\n\nIn short: Done." }).id
    assert.equal(store.addReaction({ taskId, messageId, emoji: "👍" }).effect, "done")
    assert.equal(store.getTask(taskId).columnId, `${BOARD}:done`)
    assert.deepEqual(runs(taskId), [])
    finish(taskId)
  })

  it("closes the card even when there is no message to put it on", () => {
    const taskId = card("A card signed off from a notification with no message", "review")
    assert.deepEqual(store.addReaction({ taskId, emoji: "👍" }), { reaction: null, effect: "done" })
    assert.equal(store.getTask(taskId).columnId, `${BOARD}:done`)
    finish(taskId)
  })

  it("does nothing on a card that is not in Review", () => {
    const taskId = card("A card still being worked on", "in_progress")
    const messageId = store.addMessage({ taskId, authorId: "coder", text: "still writing" }).id
    assert.equal(store.addReaction({ taskId, messageId, emoji: "👍" }).effect, "none")
    assert.equal(store.getTask(taskId).columnId, `${BOARD}:in_progress`)
    finish(taskId)
  })
})
