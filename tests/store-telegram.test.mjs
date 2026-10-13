// The board's half of the two-way bot: which card a Telegram notification was about (so a reply
// to it can be routed back), and the `source` a message carries when it came in from the bot.
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-telegram-"))
  process.env.CS_DB_PATH = path.join(dir, "board.db")
  store = await import("../src/server/store.ts")
  feed = await import("../src/server/feed.ts")
})

after(() => fs.rmSync(dir, { recursive: true, force: true }))

const card = (title) =>
  store.createTask({ boardId: BOARD, columnId: `${BOARD}:backlog`, title, assigneeIds: [] })

describe("a notification remembered against its card", () => {
  it("answers with the card and the ref a reply is confirmed with", () => {
    const task = card("A card the owner is told about")
    store.rememberTelegramNotification({ messageId: 4242, taskId: task.id })
    const link = store.taskOfTelegramNotification(4242)
    assert.equal(link.taskId, task.id)
    assert.equal(link.ref, `CS-${task.number}`)
  })

  it("is nothing for a message the board never sent", () => {
    assert.equal(store.taskOfTelegramNotification(999999), null)
    assert.equal(store.taskOfTelegramNotification(Number.NaN), null)
  })

  it("survives being written twice — a retry is not an error", () => {
    const task = card("A card notified about twice")
    store.rememberTelegramNotification({ messageId: 4243, taskId: task.id })
    store.rememberTelegramNotification({ messageId: 4243, taskId: task.id })
    assert.equal(store.taskOfTelegramNotification(4243).taskId, task.id)
  })

  it("refuses a message id that is not one, and a card that does not exist", () => {
    const task = card("A card")
    assert.throws(() => store.rememberTelegramNotification({ messageId: "nope", taskId: task.id }))
    assert.throws(() => store.rememberTelegramNotification({ messageId: 7, taskId: "t_nothing" }))
  })

  it("goes away with the card it was about", () => {
    const task = card("A card that gets deleted")
    store.rememberTelegramNotification({ messageId: 4244, taskId: task.id })
    store.deleteTask(task.id)
    assert.equal(store.taskOfTelegramNotification(4244), null)
  })
})

describe("which message on the board a notification was about", () => {
  it("remembers the one it was told about — the agent's question", () => {
    const task = card("A card with a question on it")
    const messageId = store.addMessage({ taskId: task.id, authorId: "coder", text: "@owner do we break the boards?" }).id
    store.rememberTelegramNotification({ messageId: 4300, taskId: task.id, boardMessageId: messageId })
    assert.equal(store.taskOfTelegramNotification(4300).boardMessageId, messageId)
  })

  it("takes the card's last In short line when it was told none — what a Review notification quotes", () => {
    const task = card("A card handed off with a short line")
    store.addMessage({ taskId: task.id, authorId: "coder", text: "first pass" })
    const short = store.addMessage({ taskId: task.id, authorId: "coder", text: "done\n\nIn short: Done." }).id
    store.rememberTelegramNotification({ messageId: 4301, taskId: task.id })
    assert.equal(store.taskOfTelegramNotification(4301).boardMessageId, short)
  })

  it("is nothing when the card has no such message: the reaction then belongs to the card", () => {
    const task = card("A card nobody wrote a short line on")
    store.rememberTelegramNotification({ messageId: 4302, taskId: task.id })
    assert.equal(store.taskOfTelegramNotification(4302).boardMessageId, null)
  })
})

describe("the two other ways the bot finds a card", () => {
  it("looks a card up by its number, in any case, and says its title", () => {
    const task = card("A card the owner names by number")
    const link = store.taskByRef(`cs-${task.number}`)
    assert.equal(link.taskId, task.id)
    assert.equal(link.ref, `CS-${task.number}`)
    assert.equal(link.title, "A card the owner names by number")
  })

  it("is nothing for a number no card has, and for anything that is not a number", () => {
    assert.equal(store.taskByRef("CS-999999"), null)
    assert.equal(store.taskByRef("ZZ-1"), null)
    assert.equal(store.taskByRef("off-key"), null)
    assert.equal(store.taskByRef(null), null)
  })

  it("answers with the last notification it sent, and when it was sent", () => {
    const task = card("The card of the latest notification")
    store.rememberTelegramNotification({ messageId: 5001, taskId: task.id })
    const link = store.lastTelegramNotification()
    assert.equal(link.taskId, task.id)
    assert.equal(link.title, "The card of the latest notification")
    // The bot decides how old is too old, so the time has to come back with it.
    assert.ok(Number.isFinite(Date.parse(link.createdAt)))
  })
})

describe("a message that came in from the bot", () => {
  it("carries source = telegram and is the owner's own, like one typed on the board", () => {
    const task = card("A card answered from the phone")
    const message = store.addMessage({ taskId: task.id, text: "move it to ready", source: "telegram" })
    assert.equal(message.source, "telegram")
    assert.equal(message.authorId, store.ownerId())
    // Untagged from the owner, so the architect is woken — the bot adds no logic of its own.
    assert.deepEqual(
      store.listRuns(task.id).map((run) => run.trigger),
      [`owner:${message.id}`]
    )
    assert.equal(store.listMessages(task.id).find((m) => m.id === message.id).source, "telegram")
  })

  it("is the only source the board stores: anything else is a message with none", () => {
    const task = card("A card with a made-up source")
    assert.equal(store.addMessage({ taskId: task.id, text: "one", source: "sms" }).source, null)
    assert.equal(store.addMessage({ taskId: task.id, text: "two" }).source, null)
  })

  it("says which agents it woke, so the bot knows whether anybody will answer", () => {
    const task = card("A card whose message woke the architect")
    const message = store.addMessage({ taskId: task.id, text: "take a look", source: "telegram" })
    assert.deepEqual(message.woke, ["architect"])
    // A tag nobody on this board answers to wakes nobody, and the bot has to say so.
    const other = card("A card with a tag for nobody")
    assert.deepEqual(store.addMessage({ taskId: other.id, text: "@nobody have a look", source: "telegram" }).woke, [])
  })
})

// --- the agent's answer back to Telegram -------------------------------------

/** The owner's message as the bot files it: its own Telegram message id comes along with it. */
function fromTelegram(taskId, text = "take a look, please", telegramMessageId = 4242) {
  return store.addMessage({ taskId, text, source: "telegram", telegramMessageId })
}

/** The `agent_answered` lines on a board since `since`. */
function answers(since) {
  return feed
    .listBoardEvents(BOARD, { since, limit: 500 })
    .events.filter((e) => e.type === "agent_answered")
}

describe("an agent answering a message that came in from the bot", () => {
  it("puts the answer in the feed, with the owner's Telegram message to reply to", () => {
    const task = card("A card the architect answers from the board")
    const asked = fromTelegram(task.id, "what's up with the bot?", 7001)
    const since = feed.listBoardEvents(BOARD, { limit: 500 }).cursor
    const reply = store.addMessage({
      taskId: task.id,
      authorId: "architect",
      text: "Went through the card.\n\nIn short: The bot stays quiet on delivery, the agent's answer goes out as a reply.",
    })
    const [line] = answers(since)
    assert.equal(line.taskId, task.id)
    assert.equal(line.data.replyTo, 7001)
    assert.equal(line.data.messageId, reply.id)
    assert.equal(line.data.author, "architect")
    // The agent's own `In short:` line and nothing else — no paths, no code, no run log.
    assert.equal(line.data.answer, "The bot stays quiet on delivery, the agent's answer goes out as a reply.")
    assert.equal(asked.source, "telegram")
  })

  it("answers once: the agents' further talk on the card stays on the board", () => {
    const task = card("A card the architect goes on talking about")
    fromTelegram(task.id, "have a look", 7002)
    const since = feed.listBoardEvents(BOARD, { limit: 500 }).cursor
    store.addMessage({ taskId: task.id, authorId: "architect", text: "In short: Looked at it." })
    store.addMessage({ taskId: task.id, authorId: "architect", text: "In short: Looked at it once more." })
    assert.equal(answers(since).length, 1)
  })

  it("does not answer a message typed on the board", () => {
    const task = card("A card written on from the board itself")
    store.addMessage({ taskId: task.id, text: "take a look" })
    const since = feed.listBoardEvents(BOARD, { limit: 500 }).cursor
    store.addMessage({ taskId: task.id, authorId: "architect", text: "In short: Looked at it." })
    assert.deepEqual(answers(since), [])
  })

  it("does not answer the owner's own message, or one from an agent nobody woke", () => {
    const task = card("A card nobody was woken on")
    const since = feed.listBoardEvents(BOARD, { limit: 500 }).cursor
    fromTelegram(task.id, "@nobody have a look", 7003)
    // The owner writing again is not an answer to themselves.
    store.addMessage({ taskId: task.id, text: "well?" })
    assert.deepEqual(answers(since), [])
  })
})
