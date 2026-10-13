// The bot read backwards (agents/telegram.mjs): which updates it accepts, where a reply goes,
// what /status says and what it answers to everything else. The token must stay out of every
// line the loop logs — the last case here is the one that would catch it leaking.

import test from "node:test"
import assert from "node:assert/strict"
import { HINT_TEXT, createTelegramInbox, findRef, readUpdate, statusText } from "./telegram.mjs"

const TOKEN = "123456:TOP-SECRET"
const CHAT = "555"
const ENV = { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: CHAT }

/** An update the way getUpdates hands it out. */
function update(text, { chat = CHAT, replyTo = null, id = 1 } = {}) {
  return {
    update_id: id,
    message: {
      message_id: 900 + id,
      chat: { id: Number(chat) },
      text,
      ...(replyTo ? { reply_to_message: { message_id: replyTo } } : {}),
    },
  }
}

/**
 * An inbox with both sides faked: `board` answers the worker's HTTP helper, `bot` collects what
 * went to Telegram. One poll returns `updates` and then nothing.
 */
function harness({ updates = [], board = () => null, now = () => Date.now() } = {}) {
  const sent = []
  const logs = []
  const calls = []
  let served = false
  const fetchImpl = async (url, init) => {
    const method = url.split("/").pop()
    const body = JSON.parse(init.body)
    if (method === "sendMessage") sent.push(body.text)
    const result =
      method === "getUpdates" ? (served ? [] : ((served = true), updates)) : { message_id: 1 }
    return { ok: true, json: async () => ({ ok: true, result }) }
  }
  const call = async (verb, path, payload) => {
    calls.push({ verb, path, payload })
    return board(verb, path, payload)
  }
  const inbox = createTelegramInbox({ call, env: ENV, fetchImpl, now, log: (line) => logs.push(line) })
  return { inbox, sent, logs, calls }
}

test("the channel is off without a token or a chat id", () => {
  assert.equal(createTelegramInbox({ call: async () => null, env: {} }), null)
  assert.equal(createTelegramInbox({ call: async () => null, env: { TELEGRAM_BOT_TOKEN: TOKEN } }), null)
  assert.notEqual(createTelegramInbox({ call: async () => null, env: ENV }), null)
})

test("what an update is", () => {
  const read = (u) => readUpdate(u, { chatId: CHAT })
  // `messageId` is the owner's own message — what the agent's answer comes back as a reply to.
  assert.deepEqual(read(update("hello", { replyTo: 42 })), {
    kind: "reply",
    replyTo: 42,
    text: "hello",
    messageId: 901,
  })
  assert.equal(read(update("/status")).kind, "status")
  assert.equal(read(update("/status@board_bot")).kind, "status")
  assert.deepEqual(read(update("BI-69 to Done")), {
    kind: "ref",
    ref: "BI-69",
    text: "BI-69 to Done",
    messageId: 901,
  })
  assert.equal(read(update("BI-69 done")).ref, "BI-69")
  assert.equal(read(update("in ug-3 fix the title")).ref, "UG-3")
  assert.deepEqual(read(update("what's up")), { kind: "loose", text: "what's up", messageId: 901 })
  // Non-Latin input on purpose: the Russian "BI-69 в Done" still addresses the card.
  assert.equal(read(update("BI-69 в Done")).ref, "BI-69")
  // A command the bot does not know is not a message for a card.
  assert.equal(read(update("/start")).kind, "hint")
  // A reply is the owner answering a card, whatever the text looks like.
  assert.equal(read(update("/status", { replyTo: 42 })).kind, "reply")
  // Not from the owner's chat, and not a text message at all.
  assert.deepEqual(read(update("hello", { chat: "999" })), { kind: "ignored", reason: "another chat" })
  assert.deepEqual(read({ update_id: 1, message: { chat: { id: 555 } } }), { kind: "ignored", reason: "no text" })
  assert.equal(read({ update_id: 1, channel_post: { text: "hi" } }).kind, "ignored")
})

test("a reply to a notification goes into that card's chat, from the owner, marked telegram", async () => {
  const { inbox, sent, calls } = harness({
    updates: [update("take this on", { replyTo: 4242 })],
    board: (verb) =>
      verb === "GET" ? { link: { taskId: "t_abc", ref: "BI-63", title: "Bot" } } : { id: 1, woke: ["coder"] },
  })
  await inbox.poll()
  const posted = calls.find((c) => c.verb === "POST")
  assert.equal(posted.path, "/api/tasks/t_abc/messages")
  assert.equal(posted.payload.text, "take this on")
  assert.equal(posted.payload.source, "telegram")
  // The owner's own message, so the answer to it can come back as a reply.
  assert.equal(posted.payload.telegramMessageId, 901)
  // No author: the board files an authorless message as the owner's.
  assert.equal(posted.payload.authorId, undefined)
  // Delivery is not news: the confirmation is the agent's own answer coming back here.
  assert.deepEqual(sent, [])
})

test("a card number in the text sends the message to that card, and the bot stays quiet", async () => {
  const { inbox, sent, calls } = harness({
    updates: [update("bi-69 to Done")],
    board: (verb, path) =>
      verb === "GET"
        ? (assert.equal(path, "/api/telegram/notifications?ref=BI-69"),
          { link: { taskId: "t_69", ref: "BI-69", title: "Card" } })
        : { id: 1, woke: ["architect"] },
  })
  await inbox.poll()
  const posted = calls.find((c) => c.verb === "POST")
  assert.equal(posted.path, "/api/tasks/t_69/messages")
  assert.equal(posted.payload.text, "bi-69 to Done")
  assert.equal(posted.payload.source, "telegram")
  assert.deepEqual(sent, [])
})

test("a board where nothing was woken says so, because nothing is going to answer", async () => {
  const { inbox, sent } = harness({
    updates: [update("ug-3 fix the title")],
    board: (verb) => (verb === "GET" ? { link: { taskId: "t_ug", ref: "UG-3", title: "Corpus" } } : { id: 1, woke: [] }),
  })
  await inbox.poll()
  assert.deepEqual(sent, ["Saved to UG-3. Agents on this board don't answer on their own."])
})

test("an older board that does not say who it woke is left alone", async () => {
  const { inbox, sent } = harness({
    updates: [update("ug-3 fix the title")],
    board: (verb) => (verb === "GET" ? { link: { taskId: "t_ug", ref: "UG-3" } } : { id: 1 }),
  })
  await inbox.poll()
  assert.deepEqual(sent, [])
})

/** A `message_reaction` update: the owner's set on that message before and after. */
function reaction({ chat = CHAT, messageId = 4242, before = [], after = ["👍"], id = 1 } = {}) {
  const list = (emojis) => emojis.map((emoji) => ({ type: "emoji", emoji }))
  return {
    update_id: id,
    message_reaction: {
      chat: { id: Number(chat) },
      message_id: messageId,
      old_reaction: list(before),
      new_reaction: list(after),
    },
  }
}

test("a reaction update is read as the one reaction that changed", () => {
  const read = (u) => readUpdate(u, { chatId: CHAT })
  assert.deepEqual(read(reaction()), { kind: "reaction", emoji: "👍", removed: false, replyTo: 4242 })
  // The whole set comes with every update, so the new one is the difference.
  assert.deepEqual(read(reaction({ before: ["🤡"], after: ["🤡", "👍"] })), {
    kind: "reaction",
    emoji: "👍",
    removed: false,
    replyTo: 4242,
  })
  assert.deepEqual(read(reaction({ before: ["👍"], after: [] })), {
    kind: "reaction",
    emoji: "👍",
    removed: true,
    replyTo: 4242,
  })
  // Not the one reaction the board knows, nothing changed, another chat: none of them is an answer.
  assert.equal(read(reaction({ after: ["🤡"] })).kind, "ignored")
  assert.equal(read(reaction({ after: ["✅"] })).kind, "ignored")
  assert.equal(read(reaction({ after: ["👎"] })).kind, "ignored")
  assert.equal(read(reaction({ before: ["👍"], after: ["👍"] })).kind, "ignored")
  assert.deepEqual(read(reaction({ chat: "999" })), { kind: "ignored", reason: "another chat" })
})

test("a reply that is just 👍 is a reaction, not a message", () => {
  const read = (u) => readUpdate(u, { chatId: CHAT })
  assert.deepEqual(read(update("👍", { replyTo: 4242 })), {
    kind: "reaction",
    emoji: "👍",
    removed: false,
    replyTo: 4242,
  })
  // With anything else in it, it is a sentence for the card's chat again.
  assert.equal(read(update("👍 done", { replyTo: 4242 })).kind, "reply")
  assert.equal(read(update("✅", { replyTo: 4242 })).kind, "reply")
  assert.equal(read(update("🤡", { replyTo: 4242 })).kind, "reply")
  // And a 👍 with nothing to react to is just a message.
  assert.equal(read(update("👍")).kind, "loose")
})

test("the owner's 👍 goes on the message on the board, and a card it closed is not announced", async () => {
  const { inbox, sent, calls } = harness({
    updates: [reaction({ messageId: 4242, after: ["👍"] })],
    board: (verb, path) =>
      verb === "GET"
        ? (assert.equal(path, "/api/telegram/notifications?message=4242"),
          { link: { taskId: "t_abc", ref: "BI-63", title: "Bot", boardMessageId: 17 } })
        : { effect: "done" },
  })
  await inbox.poll()
  const posted = calls.find((c) => c.verb === "POST")
  assert.equal(posted.path, "/api/tasks/t_abc/reactions")
  assert.deepEqual(posted.payload, { emoji: "👍", messageId: 17 })
  // The card moved and the owner can see it: nothing to write back.
  assert.deepEqual(sent, [])
})

test("a 👍 on a card that is not in Review moved nothing, and that is said out loud", async () => {
  const { inbox, sent } = harness({
    updates: [reaction({ after: ["👍"] })],
    board: (verb) =>
      verb === "GET" ? { link: { taskId: "t_abc", ref: "BI-70", boardMessageId: 17 } } : { effect: "none" },
  })
  await inbox.poll()
  assert.deepEqual(sent, ["BI-70 is not in Review yet, so it is not moved to Done. Say it in words."])
})

test("a reaction taken off is taken off the board too, and one with no message is on the card", async () => {
  const removing = harness({
    updates: [reaction({ before: ["👍"], after: [] })],
    board: (verb) => (verb === "GET" ? { link: { taskId: "t_abc", title: "Bot", boardMessageId: 17 } } : {}),
  })
  await removing.inbox.poll()
  const dropped = removing.calls.find((c) => c.verb === "DELETE")
  assert.equal(dropped.path, "/api/tasks/t_abc/reactions")
  assert.deepEqual(dropped.payload, { emoji: "👍", messageId: 17 })
  // Taking one off undoes nothing on the board, so there is nothing to report either.
  assert.deepEqual(removing.sent, [])

  const onCard = harness({
    updates: [reaction({ after: ["👍"] })],
    board: (verb) =>
      verb === "GET" ? { link: { taskId: "t_abc", title: "Bot", boardMessageId: null } } : { effect: "done" },
  })
  await onCard.inbox.poll()
  assert.deepEqual(onCard.calls.find((c) => c.verb === "POST").payload, { emoji: "👍" })
})

test("a reaction on a notification the board knows no card for is refused in one line", async () => {
  const { inbox, sent, calls } = harness({ updates: [reaction()], board: () => ({ link: null }) })
  await inbox.poll()
  assert.equal(calls.filter((c) => c.verb === "POST").length, 0)
  assert.deepEqual(sent, ["No card found for this message."])
})

test("the bot asks Telegram for reactions as well as messages", async () => {
  const asked = []
  const inbox = createTelegramInbox({
    call: async () => null,
    env: ENV,
    log: () => {},
    fetchImpl: async (url, init) => {
      asked.push({ method: url.split("/").pop(), body: JSON.parse(init.body) })
      return { ok: true, json: async () => ({ ok: true, result: [] }) }
    },
  })
  await inbox.drainBacklog()
  await inbox.poll()
  for (const { body } of asked) {
    assert.ok(body.allowed_updates.includes("message_reaction"), "message_reaction is not in the default set")
    assert.ok(body.allowed_updates.includes("message"))
  }
})

test("a board that refuses the message is the one failure the bot reports, without the token", async () => {
  const { inbox, sent, logs } = harness({
    updates: [update("take this on", { replyTo: 4242 })],
    board: (verb) => {
      if (verb === "GET") return { link: { taskId: "t_abc", ref: "BI-63", title: "Bot" } }
      throw new Error(`HTTP 400 for https://api.telegram.org/bot${TOKEN}/x`)
    },
  })
  await inbox.poll()
  assert.deepEqual(sent, ["Couldn't save."])
  assert.equal(logs.join("\n").includes(TOKEN), false)
})

test("a number of a card that does not exist is answered, not guessed", async () => {
  const { inbox, sent, calls } = harness({ updates: [update("BI-999 to Done")], board: () => ({ link: null }) })
  await inbox.poll()
  assert.equal(calls.filter((c) => c.verb === "POST").length, 0)
  assert.deepEqual(sent, ["Card BI-999 not found. Check the number or reply to a notification."])
})

test("no reply and no number: the message goes to the card of the last notification", async () => {
  const sentAt = new Date("2026-10-08T09:00:00.000Z")
  const { inbox, sent, calls } = harness({
    updates: [update("ok, go ahead")],
    now: () => sentAt.getTime() + 60_000,
    board: (verb, path) =>
      verb === "GET"
        ? (assert.equal(path, "/api/telegram/notifications?last=1"),
          { link: { taskId: "t_last", ref: "BI-73", title: "Silent bot", createdAt: sentAt.toISOString() } })
        : { id: 1, woke: ["coder"] },
  })
  await inbox.poll()
  assert.equal(calls.find((c) => c.verb === "POST").path, "/api/tasks/t_last/messages")
  // Even a guessed card is not spelled out: a wrong guess shows up in the answer that comes back.
  assert.deepEqual(sent, [])
})

test("the last notification stops being the address after a day, and so does no notification at all", async () => {
  const sentAt = new Date("2026-10-07T09:00:00.000Z")
  const stale = harness({
    updates: [update("ok, go ahead")],
    now: () => sentAt.getTime() + 25 * 60 * 60 * 1000,
    board: () => ({ link: { taskId: "t_last", ref: "BI-73", title: "Bot", createdAt: sentAt.toISOString() } }),
  })
  await stale.inbox.poll()
  assert.equal(stale.calls.filter((c) => c.verb === "POST").length, 0)
  assert.deepEqual(stale.sent, [HINT_TEXT])

  const empty = harness({ updates: [update("ok, go ahead")], board: () => ({ link: null }) })
  await empty.inbox.poll()
  assert.equal(empty.calls.filter((c) => c.verb === "POST").length, 0)
  assert.deepEqual(empty.sent, [HINT_TEXT])
})

test("a card number is a number, not any hyphenated word", () => {
  assert.equal(findRef("BI-69 to Done"), "BI-69")
  assert.equal(findRef("look at ug-3, please"), "UG-3")
  assert.equal(findRef("(BI-7)"), "BI-7")
  assert.equal(findRef("something is off-key"), null)
  assert.equal(findRef("file utf-8-sig"), null)
  // Non-Latin input on purpose: a card number inside a Russian sentence, and a Russian hyphenated
  // word that must not be mistaken for one.
  assert.equal(findRef("посмотри ug-3, пожалуйста"), "UG-3")
  assert.equal(findRef("что-то не так"), null)
  assert.equal(findRef("Co-Authored-By"), null)
  assert.equal(findRef("e-2"), null)
  assert.equal(findRef(""), null)
})

test("the board not answering is not the same as there being no card", async () => {
  const { inbox, sent, calls } = harness({
    updates: [update("ok, go ahead")],
    board: () => {
      throw new Error("ECONNREFUSED")
    },
  })
  await inbox.poll()
  assert.equal(calls.filter((c) => c.verb === "POST").length, 0)
  assert.deepEqual(sent, ["The board is not responding. Try again later."])
})

test("a reply the board knows no card for is refused in one line", async () => {
  const { inbox, sent, calls } = harness({
    updates: [update("ok", { replyTo: 1 })],
    board: () => ({ link: null }),
  })
  await inbox.poll()
  assert.equal(calls.filter((c) => c.verb === "POST").length, 0)
  assert.deepEqual(sent, ["No card found for this message."])
})

test("a message from another chat is answered with nothing and logged without its text", async () => {
  const { inbox, sent, logs, calls } = harness({
    updates: [update("give me /status", { chat: "999" })],
  })
  await inbox.poll()
  assert.deepEqual(sent, [])
  assert.deepEqual(calls, [])
  assert.deepEqual(logs, ["[telegram] ignored a message from another chat"])
  assert.equal(logs.join("\n").includes("/status"), false)
})

test("a command the bot does not know gets the hint and touches no card", async () => {
  const { inbox, sent, calls } = harness({ updates: [update("/start")] })
  await inbox.poll()
  assert.deepEqual(calls, [])
  assert.deepEqual(sent, [HINT_TEXT])
})

test("/status reads the board's state and sends it", async () => {
  const { inbox, sent, calls } = harness({ updates: [update("/status")], board: () => STATE })
  await inbox.poll()
  assert.deepEqual(
    calls.map((c) => c.path),
    ["/api/state"]
  )
  assert.equal(sent.length, 1)
  assert.match(sent[0], /BI-72/)
})

const STATE = {
  boards: [
    {
      id: "b1",
      name: "Backend Infra",
      key: "BI",
      archived: false,
      columns: [
        { role: "ready", tasks: [{ number: 80, title: "Queued", needsOwner: null }] },
        { role: "in_progress", tasks: [{ number: 72, title: "Two-way Telegram bot", needsOwner: null }] },
        { role: "review", tasks: [] },
        {
          role: "done",
          tasks: [{ number: 60, title: "Migrations", needsOwner: { reason: "question", text: "which schema?" } }],
        },
      ],
    },
    { id: "b2", name: "Archived", key: "AR", archived: true, columns: [] },
  ],
}

test("/status lists the cards by number and title, and nothing that was written on them", () => {
  const text = statusText(STATE)
  assert.equal(text.includes("Archived"), false)
  assert.match(text, /^Backend Infra$/m)
  assert.match(text, /In progress:\n• BI-72 Two-way Telegram bot/)
  assert.match(text, /Review: —/)
  assert.match(text, /Waiting for the owner:\n• BI-60 Migrations/)
  // A card in the queue is neither of the three, and no message text ever leaves the board.
  assert.equal(text.includes("BI-80"), false)
  assert.equal(text.includes("which schema?"), false)
})

test("/status with no boards still says something", () => {
  assert.equal(statusText({ boards: [] }), "No boards.")
  assert.equal(statusText(null), "No boards.")
})

test("the token never reaches the log, not through a refusal and not through a fetch error", async () => {
  const logs = []
  const inbox = createTelegramInbox({
    call: async () => null,
    env: ENV,
    log: (line) => logs.push(line),
    fetchImpl: async (url) => {
      throw new Error(`connect ECONNREFUSED for ${url}`)
    },
  })
  await assert.rejects(() => inbox.poll(), /<token>/)
  // And the same through the loop's own logging, which is what a running worker prints.
  const refusing = createTelegramInbox({
    call: async () => {
      throw new Error("boom")
    },
    env: ENV,
    log: (line) => logs.push(line),
    fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ ok: false }) }),
  })
  await refusing.handle(update("/status"))
  assert.ok(logs.length > 0)
  assert.equal(logs.join("\n").includes(TOKEN), false)
})
