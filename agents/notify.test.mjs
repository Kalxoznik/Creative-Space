// What the owner is told, and what never leaves the board (agents/notify.mjs): which feed
// events are worth a notification, the two-minute glue, a Telegram channel with no token, and
// the composition of the text — a notification carries a card number, a label and a title, and
// nothing that was written in a chat, a log or a diff.

import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  ANSWER_LABEL,
  ANSWER_QUIET,
  cardLink,
  classify,
  createNotifications,
  createNotifier,
  fanOut,
  loadDotEnv,
  macScript,
  notificationText,
  openChannels,
  scrub,
  telegramChannel,
} from "./notify.mjs"

const BOARD = "b_1"
const TASK = "t_1"
/** A folder with no `.env` in it: the owner's own file must not reach the tests. */
const NO_ENV_FILE = fs.mkdtempSync(path.join(os.tmpdir(), "cs-notify-root-"))

/** A feed event the way GET /api/events hands it out. */
function event(type, data = {}, extra = {}) {
  return {
    id: 1,
    at: "2026-10-08T12:00:00.000Z",
    boardId: BOARD,
    taskId: TASK,
    ref: "BI-63",
    title: "Notifications for the owner",
    type,
    actor: "coder",
    summary: `${type} on BI-63`,
    data,
    ...extra,
  }
}

/** A notifier with the clock and the sending in hand. */
function harness({ windowMs = 120_000 } = {}) {
  const sent = []
  let clock = 1_000_000
  const notifier = createNotifier({
    send: (note) => {
      sent.push(note)
    },
    boardUrl: "http://localhost:43123",
    now: () => clock,
    windowMs,
  })
  return { sent, notifier, tick: (ms) => (clock += ms), labels: () => sent.map((n) => notificationText(n).headline) }
}

// --- the rules ---------------------------------------------------------------

test("the things worth a notification, and nothing else", () => {
  const state = { checkFails: new Map() }
  assert.equal(classify(event("agent_answered", { replyTo: 4242, answer: "Done." }), state), ANSWER_LABEL)
  assert.equal(classify(event("card_moved", { from: "in_progress", to: "review" }), state), "Review")
  assert.equal(classify(event("card_moved", { from: "review", to: "done" }), state), "Done")
  assert.equal(classify(event("needs_owner", { reason: "question", text: "which shape?" }), state), "Needs owner")
  assert.equal(classify(event("owner_mentioned", { author: "coder" }), state), "Question")
  assert.equal(classify(event("run_failed", { error: "claude exited 1" }), state), "Run failed")
  assert.equal(classify(event("agents_paused", { messages: 6 }), state), "Agents paused")
  assert.equal(classify(event("commit_skipped", { reason: "commit failed" }), state), "No commit")

  // The quiet half of the feed: a board working normally says nothing to the owner.
  assert.equal(classify(event("run_started", { agent: "coder" }), state), null)
  assert.equal(classify(event("run_finished", { status: "done" }), state), null)
  assert.equal(classify(event("owner_message", { author: "owner" }), state), null)
  assert.equal(classify(event("check_passed", { exitCode: 0 }), state), null)
  assert.equal(classify(event("commit_made", { sha: "abc1234" }), state), null)
  // A hand-off with no file changes goes on to the review; the owner hears of it at Review.
  assert.equal(classify(event("commit_skipped", { reason: "nothing to commit" }), state), null)
  assert.equal(classify(event("card_moved", { from: "ready", to: "in_progress" }), state), null)
  assert.equal(classify(event("card_moved", { from: "backlog", to: "ready" }), state), null)
  // A coder that ran out of turns and is already running again on the same card: routine, like
  // the first failed check. The second limit queues nothing and says so.
  assert.equal(classify(event("run_failed", { error: "turn limit", continued: true }), state), null)
  assert.equal(classify(event("run_failed", { error: "turn limit" }), state), "Run failed")
})

// A card reaches Done by many hands: dragged in the UI, moved by the bot, by the architect after
// a review, or by an outside client over the API. The feed line is the same for all of them —
// only `actor` differs — so the owner hears about it once, whoever did it.
test("a card reaching Done notifies once, whoever moved it", async () => {
  for (const actor of ["coder", "architect", null]) {
    const { sent, notifier } = harness()
    await notifier.offer(event("card_moved", { from: "review", to: "done" }, { actor }))
    assert.equal(sent.length, 1)
    assert.equal(notificationText(sent[0]).text, "BI-63 moved to Done")
  }
})

// Done is a fact, not a bulletin: one line in Telegram, no title, no `In short:` line, no
// link — the owner has just seen the card finished, by their own 👍 or on the board.
test("Done in Telegram is one standard line and nothing else", async () => {
  const { sent, notifier } = harness()
  await notifier.offer(
    event("card_moved", { from: "review", to: "done" }, { plain: "Finished: the Done notification." }),
    { key: "BI", notificationsDetailed: true }
  )
  const { text } = notificationText(sent[0])
  assert.equal(text, "BI-63 moved to Done")
  assert.equal(text.split("\n").length, 1)
  for (const gone of ["Notifications for the owner", "Finished", "localhost"]) {
    assert.ok(!text.includes(gone), `the Done line must not carry ${gone}`)
  }
  // Whatever else was glued into the window, the line stays the same.
  assert.equal(notificationText({ ...sent[0], glued: 2 }).text, "BI-63 moved to Done")
})

// The agent's line still rides on the note — macOS puts it in the body — and the board's switch
// still decides whether it leaves the board at all.
test("a Done note carries the agent's line when the board asks for detail, and not when it does not", async () => {
  const moved = event("card_moved", { from: "review", to: "done" }, { plain: "Finished: the Done notification." })
  const detailed = harness()
  await detailed.notifier.offer(moved, { key: "BI", notificationsDetailed: true })
  assert.equal(notificationText(detailed.sent[0]).plain, "Finished: the Done notification.")

  const glance = harness()
  await glance.notifier.offer(moved, { key: "BI", notificationsDetailed: false })
  assert.equal(notificationText(glance.sent[0]).plain, "")
})

test("a Done move glues into the card's window like anything else", async () => {
  const { sent, notifier, tick, labels } = harness()
  await notifier.offer(event("card_moved", { to: "review" }))
  tick(30_000)
  await notifier.offer(event("card_moved", { to: "done" }))
  assert.equal(sent.length, 1, "inside the window the Done move is held, not sent")

  tick(90_001)
  await notifier.flush()
  assert.deepEqual(labels(), ["BI-63 — Review", "BI-63 — Done"])
})

// An agent that tags the owner is asking them something — one notification, with the question
// itself as its second line, and nothing else from the message.
test("an agent tagging the owner is one notification saying it is a question", async () => {
  const { sent, notifier } = harness()
  await notifier.offer(
    event("owner_mentioned", { author: "coder", messageId: 12 }, { plain: "Do we break old boards or not?" }),
    { key: "BI", notificationsDetailed: true }
  )
  assert.equal(sent.length, 1)
  assert.equal(
    notificationText(sent[0]).text,
    "BI-63 — Question: Notifications for the owner\nDo we break old boards or not?"
  )
})

// The owner wrote to a card from the bot and an agent answered: that answer goes back to them as
// a reply to their own message, and it reads as a reply — no label, no title, no link.
test("an agent's answer to a Telegram message is the card number and the agent's words", async () => {
  const { sent, notifier } = harness()
  await notifier.offer(
    event("agent_answered", { author: "coder", messageId: 12, replyTo: 4242, answer: "The bot is quiet now." }),
    { key: "BI", notificationsDetailed: true }
  )
  assert.equal(sent.length, 1)
  assert.equal(notificationText(sent[0]).text, "BI-63 · The bot is quiet now.")
  // And it is sent as a reply to the owner's own message, with the card kept for a reply back.
  assert.equal(sent[0].replyTo, 4242)
  assert.equal(sent[0].taskId, TASK)
  assert.equal(sent[0].boardMessageId, 12)
})

test("a board with detailed notifications off says there is an answer, not what it says", async () => {
  const { sent, notifier } = harness()
  await notifier.offer(
    event("agent_answered", { author: "coder", messageId: 12, replyTo: 4242, answer: "corpus: 412 lines" }),
    { key: "UG", notificationsDetailed: false }
  )
  assert.equal(notificationText(sent[0]).text, `BI-63 · ${ANSWER_QUIET}`)
})

test("an answer is never held and never glued: somebody is waiting for it", async () => {
  const { sent, notifier, tick } = harness()
  await notifier.offer(event("card_moved", { to: "review" }))
  tick(1000)
  await notifier.offer(
    event("agent_answered", { messageId: 12, replyTo: 4242, answer: "Done." }, { id: 2 }),
    { key: "BI" }
  )
  assert.equal(sent.length, 2, "the answer goes out inside the card's window")
  assert.equal(notificationText(sent[1]).text, "BI-63 · Done.")
  // And it does not take up the window either — the next move is still held and glued.
  tick(1000)
  await notifier.offer(event("card_moved", { to: "done" }, { id: 3 }))
  assert.equal(sent.length, 2)
})

test("Telegram sends an answer as a reply to the owner's own message", async () => {
  const calls = []
  const send = telegramChannel({
    token: "123:SECRET",
    chatId: "42",
    fetchImpl: async (url, init) => {
      calls.push(JSON.parse(init.body))
      return { ok: true, status: 200 }
    },
  })
  await send({ ref: "BI-63", label: ANSWER_LABEL, plain: "Done.", replyTo: 4242, glued: 0 })
  assert.deepEqual(calls[0], {
    chat_id: "42",
    text: "BI-63 · Done.",
    disable_web_page_preview: true,
    reply_to_message_id: 4242,
    allow_sending_without_reply: true,
  })
})

test("a tag and a move to Review within two minutes are one notification", async () => {
  const { sent, notifier, tick, labels } = harness()
  await notifier.offer(event("owner_mentioned", { author: "coder" }), { key: "BI" })
  tick(30_000)
  await notifier.offer(event("card_moved", { to: "review" }), { key: "BI" })
  await notifier.flush()
  assert.equal(sent.length, 1, "the move is glued into the question's window")
  assert.deepEqual(labels(), ["BI-63 — Question"])
})

test("the owner letting a card go on is not news", () => {
  const state = { checkFails: new Map() }
  assert.equal(classify(event("needs_owner", { reason: "question", cleared: true }), state), null)
})

test("a failed check notifies the second time in a row, not the first", () => {
  const state = { checkFails: new Map() }
  // The first failure buys the coder an automatic retry — routine.
  assert.equal(classify(event("check_failed", { exitCode: 1 }), state), null)
  assert.equal(classify(event("check_failed", { exitCode: 1 }), state), "Check failed again")
  // A green check in between means the next failure is a first one again.
  assert.equal(classify(event("check_passed", { exitCode: 0 }), state), null)
  assert.equal(classify(event("check_failed", { exitCode: 1 }), state), null)
  assert.equal(classify(event("check_failed", { exitCode: 1 }), state), "Check failed again")
})

test("failing checks on two cards are counted apart", () => {
  const state = { checkFails: new Map() }
  assert.equal(classify(event("check_failed", {}, { taskId: "t_a" }), state), null)
  assert.equal(classify(event("check_failed", {}, { taskId: "t_b" }), state), null)
  assert.equal(classify(event("check_failed", {}, { taskId: "t_a" }), state), "Check failed again")
})

// --- the text ----------------------------------------------------------------

test("the text is a number, a label and a title — nothing else", async () => {
  const { sent, notifier } = harness()
  await notifier.offer(
    event("needs_owner", {
      reason: "question",
      // Everything below is in the feed and must stay there.
      text: "the password is hunter2",
    }),
    { key: "BI" }
  )
  const { text, headline } = notificationText(sent[0])
  assert.equal(headline, "BI-63 — Needs owner")
  assert.equal(text, "BI-63 — Needs owner: Notifications for the owner")
  for (const secret of ["hunter2", "needs_owner on BI-63", "coder", "src/server", "exit 1"]) {
    assert.ok(!text.includes(secret), `the notification must not quote ${secret}`)
  }
})

test("nothing from a feed line's summary or data reaches the text", async () => {
  const { sent, notifier } = harness()
  await notifier.offer(
    event(
      "run_failed",
      { error: "Error: ENOENT /Users/max/secret/path.ts:14", agent: "coder" },
      { summary: "Board Claude failed on BI-63: Error: ENOENT /Users/max/secret/path.ts:14" }
    )
  )
  const { text } = notificationText(sent[0])
  assert.equal(text, "BI-63 — Run failed: Notifications for the owner")
  assert.ok(!text.includes("/Users/max"))
  assert.ok(!text.includes("ENOENT"))
})

test("the AppleScript carries the same three parts, quoted and on one line", () => {
  const script = macScript({
    ref: "BI-63",
    label: "Review",
    title: 'A card with "quotes" and\na newline',
    link: "http://localhost:43123/?task=t_1",
    glued: 0,
  })
  assert.equal(
    script,
    'display notification "http://localhost:43123/?task=t_1" with title "BI-63 — Review" ' +
      'subtitle "A card with \\"quotes\\" and a newline"'
  )
  assert.ok(!script.includes("\n"))
})

test("a card with no number and no board key still says something", () => {
  const text = notificationText({ ref: "Board", label: "Agents paused", title: "", link: "", glued: 0 })
  assert.equal(text.text, "Board — Agents paused")
})

test("the agent's own line is the second line of the notification", async () => {
  const { sent, notifier } = harness()
  await notifier.offer(
    event(
      "card_moved",
      { from: "in_progress", to: "review" },
      { plain: "Rewrote the notifications: now they say what was done." }
    ),
    { key: "BI", notificationsDetailed: true }
  )
  const { text, plain } = notificationText(sent[0])
  assert.equal(plain, "Rewrote the notifications: now they say what was done.")
  assert.equal(
    text,
    "BI-63 — Review: Notifications for the owner\nRewrote the notifications: now they say what was done."
  )
  // On macOS the line is the body — the link is what is shown when there is none.
  assert.ok(macScript(sent[0]).includes('display notification "Rewrote the notifications'))
})

test("detailed notifications off: the glance only, even though the event has the line", async () => {
  const { sent, notifier } = harness()
  await notifier.offer(
    event("needs_owner", { reason: "question" }, { plain: "We need to decide whether to break old boards." }),
    { key: "BI", notificationsDetailed: false }
  )
  const { text } = notificationText(sent[0])
  assert.equal(text, "BI-63 — Needs owner: Notifications for the owner")
  assert.ok(!text.includes("old boards"))
})

test("a board that never heard of the switch is detailed: that is the point of a notification", async () => {
  const { sent, notifier } = harness()
  await notifier.offer(event("run_failed", {}, { plain: "The run failed; the card stays in progress." }), { key: "BI" })
  assert.ok(notificationText(sent[0]).text.includes("The run failed; the card stays in progress."))
})

test("the link opens the card on the board", () => {
  assert.equal(cardLink("http://localhost:43123/", "t_1"), "http://localhost:43123/?task=t_1")
  assert.equal(cardLink("http://localhost:43123", null), "http://localhost:43123")
  assert.equal(cardLink("", "t_1"), "")
})

// --- the two-minute window ---------------------------------------------------

test("one notification per card per window, the rest glued into it", async () => {
  const { sent, notifier, tick, labels } = harness()
  await notifier.offer(event("card_moved", { to: "review" }))
  assert.equal(sent.length, 1, "the first one goes out at once")

  tick(30_000)
  await notifier.offer(event("run_failed", {}))
  tick(30_000)
  await notifier.offer(event("needs_owner", {}))
  assert.equal(sent.length, 1, "inside the window nothing more is sent")
  await notifier.flush()
  assert.equal(sent.length, 1, "and the window is not over yet")
  assert.equal(notifier.pending.length, 1)

  // Two minutes after the one that went out, the glue is sent: the latest thing that
  // happened, and how many others came with it.
  tick(61_000)
  await notifier.flush()
  assert.equal(sent.length, 2)
  assert.deepEqual(labels(), ["BI-63 — Review", "BI-63 — Needs owner +1"])
  assert.equal(notifier.pending.length, 0)
})

test("two cards do not mute each other", async () => {
  const { sent, notifier } = harness()
  await notifier.offer(event("card_moved", { to: "review" }, { taskId: "t_a", ref: "BI-1" }))
  await notifier.offer(event("card_moved", { to: "review" }, { taskId: "t_b", ref: "BI-2" }))
  assert.equal(sent.length, 2)
})

test("after the window a card notifies again right away", async () => {
  const { sent, notifier, tick } = harness()
  await notifier.offer(event("card_moved", { to: "review" }))
  tick(120_001)
  await notifier.offer(event("run_failed", {}))
  assert.equal(sent.length, 2)
  assert.equal(notificationText(sent[1]).headline, "BI-63 — Run failed")
})

test("an event nobody is notified about does not take up the window", async () => {
  const { sent, notifier } = harness()
  await notifier.offer(event("run_started", {}))
  await notifier.offer(event("card_moved", { to: "review" }))
  assert.equal(sent.length, 1)
  assert.equal(notificationText(sent[0]).headline, "BI-63 — Review")
})

// --- channels ----------------------------------------------------------------

test("no token: Telegram is off, with one line about it and no error", () => {
  const lines = []
  const channels = openChannels({ env: {}, platform: "linux", log: (line) => lines.push(line) })
  assert.deepEqual(channels, [])
  assert.equal(lines.length, 2)
  assert.ok(lines.some((line) => line.includes("Telegram: off")))
  assert.ok(lines.some((line) => line.includes("TELEGRAM_BOT_TOKEN")))
})

test("half a token is no token", () => {
  const off = (env) => openChannels({ env, platform: "linux", log: () => {} })
  assert.deepEqual(off({ TELEGRAM_BOT_TOKEN: "123:abc" }), [])
  assert.deepEqual(off({ TELEGRAM_CHAT_ID: "42" }), [])
  assert.deepEqual(off({ TELEGRAM_BOT_TOKEN: "  ", TELEGRAM_CHAT_ID: "42" }), [])
})

test("both variables: Telegram is on and the token is not in the log", () => {
  const lines = []
  const channels = openChannels({
    env: { TELEGRAM_BOT_TOKEN: "123456:SECRET", TELEGRAM_CHAT_ID: "42" },
    platform: "linux",
    log: (line) => lines.push(line),
  })
  assert.equal(channels.length, 1)
  assert.equal(channels[0].name, "Telegram")
  assert.ok(!lines.join("\n").includes("SECRET"))
})

test("macOS is a channel on a Mac and not anywhere else", () => {
  const names = (platform) => openChannels({ env: {}, platform, log: () => {} }).map((c) => c.name)
  assert.deepEqual(names("darwin"), ["macOS"])
  assert.deepEqual(names("win32"), [])
})

test("Telegram sends the text and only the text", async () => {
  const calls = []
  const send = telegramChannel({
    token: "123:SECRET",
    chatId: "42",
    fetchImpl: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) })
      return { ok: true, status: 200 }
    },
  })
  await send({ ref: "BI-63", label: "Review", title: "A card", link: "http://localhost:43123/?task=t_1", glued: 0 })
  assert.equal(calls[0].url, "https://api.telegram.org/bot123:SECRET/sendMessage")
  assert.deepEqual(calls[0].body, {
    chat_id: "42",
    text: "BI-63 — Review: A card",
    disable_web_page_preview: true,
  })
})

// Nothing the bot sends has a link in it: on a phone `localhost` is a dead end.
test("no Telegram text carries the board's link, whatever happened", async () => {
  const { sent, notifier, tick } = harness()
  const kinds = [
    event("card_moved", { to: "review" }, { plain: "Done." }),
    event("card_moved", { to: "done" }, { plain: "Done." }),
    event("needs_owner", { reason: "question" }, { plain: "A paid call?" }),
    event("owner_mentioned", { author: "coder" }, { plain: "Do we break old boards?" }),
    event("run_failed", {}, { plain: "The run failed." }),
    event("agents_paused", {}),
    event("commit_skipped", {}),
    event("agent_answered", { replyTo: 4242, answer: "Done." }),
  ]
  for (const [index, kind] of kinds.entries()) {
    await notifier.offer({ ...kind, id: index + 1 }, { key: "BI", notificationsDetailed: true })
    tick(120_001)
  }
  await notifier.flush()
  assert.equal(sent.length, kinds.length)
  for (const note of sent) {
    const { text } = notificationText(note)
    assert.ok(!text.includes("localhost"), `«${text}» still carries the link`)
    assert.ok(!text.includes("http"), `«${text}» still carries a link`)
  }
})

// The link is still the macOS channel's, where it opens the card next to the board.
test("the macOS notification is what it always was, link and all", async () => {
  const { sent, notifier, tick } = harness()
  await notifier.offer(event("needs_owner", { reason: "question" }), { key: "BI" })
  assert.equal(
    macScript(sent[0]),
    'display notification "http://localhost:43123/?task=t_1" with title "BI-63 — Needs owner" ' +
      'subtitle "Notifications for the owner"'
  )
  // A card reaching Done reads on the Mac as it always did: the label, the title, the line.
  tick(120_001)
  await notifier.offer(event("card_moved", { to: "done" }, { plain: "Done." }), {
    key: "BI",
    notificationsDetailed: true,
  })
  assert.equal(
    macScript(sent[1]),
    'display notification "Done." with title "BI-63 — Done" subtitle "Notifications for the owner"'
  )
})

test("a notification about a card is remembered by its Telegram message id, so a reply can find it", async () => {
  const remembered = []
  const lines = []
  const channel = () =>
    telegramChannel({
      token: "123:SECRET",
      chatId: "42",
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 4242 } }) }),
      remember: (messageId, note) => remembered.push({ messageId, taskId: note.taskId }),
      log: (line) => lines.push(line),
    })
  const note = { ref: "BI-63", label: "Review", title: "A card", link: "", glued: 0 }
  await channel()({ ...note, taskId: "t_1" })
  assert.deepEqual(remembered, [{ messageId: 4242, taskId: "t_1" }])
  // The one-line Done notification is remembered the same way: a reply to it lands in that
  // card's chat, short text or not.
  await channel()({ ...note, label: "Done", taskId: "t_1" })
  assert.deepEqual(remembered.at(-1), { messageId: 4242, taskId: "t_1" })
  assert.equal(remembered.length, 2)
  // A note about the board as a whole answers to nothing: there is no card to route a reply to.
  await channel()({ ...note, taskId: null })
  assert.equal(remembered.length, 2)
  // And a board that will not store the link does not swallow the notification itself.
  const flaky = telegramChannel({
    token: "123:SECRET",
    chatId: "42",
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 7 } }) }),
    remember: async () => {
      throw new Error("POST /api/telegram/notifications → 500")
    },
    log: (line) => lines.push(line),
  })
  await flaky({ ...note, taskId: "t_2" })
  assert.equal(lines.length, 1)
  assert.equal(lines[0].includes("SECRET"), false)
})

test("the notifier carries the card id on every note, and nothing on a board-wide one", async () => {
  const { notifier, sent } = harness()
  await notifier.offer(event("card_moved", { to: "review" }))
  await notifier.offer(event("agents_paused", {}, { taskId: null, id: 2 }))
  assert.deepEqual(
    sent.map((n) => n.taskId),
    [TASK, null]
  )
})

test("a channel that fails is logged without the token, and the others still get the note", async () => {
  const lines = []
  const got = []
  const send = fanOut(
    [
      { name: "Telegram", token: "123:SECRET", send: async () => {
        throw new Error("connect ECONNREFUSED https://api.telegram.org/bot123:SECRET/sendMessage")
      } },
      { name: "macOS", send: async (note) => got.push(note) },
    ],
    (line) => lines.push(line)
  )
  await send({ ref: "BI-63", label: "Review", title: "A card", link: "", glued: 0 })
  assert.equal(got.length, 1, "the second channel is not taken down by the first")
  assert.equal(lines.length, 1)
  assert.ok(!lines[0].includes("SECRET"))
  assert.ok(lines[0].includes("<token>"))
})

test("scrub leaves a message alone when there is no token to hide", () => {
  assert.equal(scrub("HTTP 400", undefined), "HTTP 400")
  assert.equal(scrub("bot123:SECRET said no", "123:SECRET"), "bot<token> said no")
})

// --- the loop over the feed --------------------------------------------------

/** A stand-in for the worker's HTTP helper: one board, one feed, read with since/cursor. */
function board(events, { notificationsEnabled = true } = {}) {
  const texts = []
  const notifications = createNotifications({
    call: async (_method, route) => {
      if (route === "/api/boards") {
        return { boards: [{ id: BOARD, name: "Board", key: "BI", archived: false, notificationsEnabled }] }
      }
      const since = Number(new URL(route, "http://x").searchParams.get("since"))
      const fresh = events.filter((e) => e.id > since)
      return { events: fresh, cursor: fresh.length > 0 ? fresh[fresh.length - 1].id : since }
    },
    boardUrl: "http://localhost:43123",
    root: NO_ENV_FILE,
    env: { TELEGRAM_BOT_TOKEN: "123:SECRET", TELEGRAM_CHAT_ID: "42" },
    platform: "linux",
    log: () => {},
    startedAt: "2026-10-08T12:00:00.000Z",
    pollMs: 0,
    fetchImpl: async (_url, init) => {
      texts.push(JSON.parse(init.body).text)
      return { ok: true, status: 200 }
    },
  })
  return { notifications, texts }
}

test("the feed read from where it left off: each line notifies once", async () => {
  const events = [
    { ...event("run_started"), id: 1 },
    { ...event("card_moved", { to: "review" }), id: 2 },
  ]
  const { notifications, texts } = board(events)
  await notifications.tick()
  assert.deepEqual(texts, ["BI-63 — Review: Notifications for the owner"])
  // Nothing new in the feed, and the line already sent is behind the cursor.
  await notifications.tick()
  assert.equal(texts.length, 1)
})

test("what happened before the worker started is history, not news", async () => {
  const events = [{ ...event("needs_owner", {}, { at: "2026-10-08T11:59:59.000Z" }), id: 1 }]
  const { notifications, texts } = board(events)
  await notifications.tick()
  assert.deepEqual(texts, [])
})

test("notifications off on the board: the feed is read, nobody is told", async () => {
  const events = [{ ...event("card_moved", { to: "review" }), id: 1 }]
  const { notifications, texts } = board(events, { notificationsEnabled: false })
  await notifications.tick()
  assert.deepEqual(texts, [])
})

test("a card reaching Done goes out over the feed, and not when the board is off", async () => {
  const events = [{ ...event("card_moved", { from: "review", to: "done" }), id: 1 }]
  const on = board(events)
  await on.notifications.tick()
  assert.deepEqual(on.texts, ["BI-63 moved to Done"])

  const off = board(events, { notificationsEnabled: false })
  await off.notifications.tick()
  assert.deepEqual(off.texts, [])
})

test("a board that cannot be read does not throw at the worker", async () => {
  const lines = []
  const notifications = createNotifications({
    call: async () => {
      throw new Error("GET /api/boards → 503")
    },
    root: NO_ENV_FILE,
    env: { TELEGRAM_BOT_TOKEN: "123:SECRET", TELEGRAM_CHAT_ID: "42" },
    platform: "linux",
    log: (line) => lines.push(line),
    pollMs: 0,
  })
  await notifications.tick()
  assert.ok(lines.some((line) => line.includes("503")))
})

test("no channel at all: the feed is not even read", async () => {
  let calls = 0
  const notifications = createNotifications({
    call: async () => {
      calls++
      return { boards: [] }
    },
    root: NO_ENV_FILE,
    env: {},
    platform: "linux",
    log: () => {},
    pollMs: 0,
  })
  await notifications.tick()
  assert.equal(calls, 0)
})

// --- .env --------------------------------------------------------------------

test(".env fills what the environment does not already say", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-notify-"))
  try {
    fs.writeFileSync(
      path.join(dir, ".env"),
      [
        "# the owner's own file, never committed",
        "TELEGRAM_BOT_TOKEN=123456:from-the-file",
        'TELEGRAM_CHAT_ID="42"',
        "export CS_BOARD_URL=http://localhost:43123 # with a comment",
        "nonsense line",
        "",
      ].join("\n")
    )
    const env = { TELEGRAM_CHAT_ID: "already-set" }
    const names = loadDotEnv(dir, env)
    assert.deepEqual(names, ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "CS_BOARD_URL"])
    assert.equal(env.TELEGRAM_BOT_TOKEN, "123456:from-the-file")
    assert.equal(env.TELEGRAM_CHAT_ID, "already-set", "the environment wins over the file")
    assert.equal(env.CS_BOARD_URL, "http://localhost:43123")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("no .env at all is not a problem", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-notify-"))
  try {
    const env = {}
    assert.deepEqual(loadDotEnv(dir, env), [])
    assert.deepEqual(env, {})
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
