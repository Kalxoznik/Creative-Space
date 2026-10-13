// An agent asks the owner something in a card's chat by tagging them: that is one of the four
// things the owner is notified about, so the feed gets an `owner_mentioned` line
// (`triggerMentions` in src/server/store.ts). The tag has to be addressed — the owner's name
// without an @, or a handle quoted in backticks or in a ``` block, is talk, not a question.
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-owner-tag-"))
  process.env.CS_DB_PATH = path.join(dir, "board.db")
  store = await import("../src/server/store.ts")
  feed = await import("../src/server/feed.ts")
})

after(() => fs.rmSync(dir, { recursive: true, force: true }))

function card(title) {
  return store.createTask({ boardId: BOARD, columnId: `${BOARD}:backlog`, title, assigneeIds: [] }).id
}

/** The `owner_mentioned` lines a message added to the feed. */
function tagLines(taskId, text, authorId = "coder") {
  const since = feed.listBoardEvents(BOARD, { limit: 500 }).cursor
  store.addMessage({ taskId, authorId, text })
  return feed
    .listBoardEvents(BOARD, { since, limit: 500 })
    .events.filter((event) => event.type === "owner_mentioned")
}

/** Free whoever this card holds, so the next case starts from a quiet board. */
function finish(taskId) {
  for (const run of store.listRuns(taskId)) {
    if (run.status === "queued") store.cancelRun(run.id)
    else if (run.status === "running") store.finishRun(run.id, { status: "done" })
  }
  store.updateTask(taskId, { archived: true })
}

describe("an agent tagging the owner", () => {
  it("records one owner_mentioned line with the agent's own line for the owner", () => {
    const taskId = card("A card the coder asks about")
    const lines = tagLines(
      taskId,
      ["@owner do we break the old boards or leave them as they are?", "", "In short: Need to decide whether we break the old boards."]
        .join("\n")
    )
    assert.equal(lines.length, 1)
    assert.equal(lines[0].taskId, taskId)
    assert.equal(lines[0].actor, "coder")
    assert.equal(lines[0].plain, "Need to decide whether we break the old boards.")
    finish(taskId)
  })

  it("falls back to the first words of the message when there is no In short line", () => {
    const taskId = card("A card with a question and no short line")
    const lines = tagLines(taskId, "@owner need your answer: this breaks the old boards.\n\n```\nconst x = 1\n```")
    assert.equal(lines.length, 1)
    assert.equal(lines[0].plain, "@owner need your answer: this breaks the old boards.")
    assert.ok(!lines[0].plain.includes("const x"), "code is not what the owner is told")
    finish(taskId)
  })

  it("says nothing when the owner is named without an @", () => {
    const taskId = card("A card that only talks about the owner")
    assert.deepEqual(tagLines(taskId, "As Max asked, rewrote the notifications."), [])
    finish(taskId)
  })

  it("says nothing about a handle inside code, a fence or a quoted line", () => {
    const taskId = card("A card that quotes the owner's handle")
    assert.deepEqual(tagLines(taskId, "the description says `@owner`, fixed it"), [])
    assert.deepEqual(tagLines(taskId, "> @owner do we break the boards?\n\nalready decided, we break nothing"), [])
    assert.deepEqual(tagLines(taskId, "the prompt is now:\n\n```\n@owner decide, please\n```"), [])
    finish(taskId)
  })

  it("says nothing when the owner writes the tag themselves", () => {
    const taskId = card("A card the owner writes on")
    assert.deepEqual(tagLines(taskId, "@owner writing to myself", store.ownerId()), [])
    finish(taskId)
  })
})
