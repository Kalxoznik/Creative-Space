// The other direction of the Telegram bot: what the owner writes to it comes back into the board.
//
// `agents/notify.mjs` sends; this module listens. Away from the machine the board runs on, a
// notification is all the owner gets — the link in it points at localhost and does not open on a
// phone. So the bot is the remote control: write to it and the text lands in a card's chat as a
// message from the owner, which is exactly the message they would have typed on the board.
// Everything after that is the board's own logic (src/server/store.ts): untagged goes to the
// architect, a tag wakes whoever it names.
//
// Which card, in this order: the notification the message is a reply to; a card number in the
// text ("BI-69 to Done"); otherwise the card of the last notification the bot sent, while it is
// fresh.
//
// The bot says nothing when a message is delivered. The confirmation is the agent's own
// answer, which comes back into this chat as a reply to the message that asked for it
// (`agent_answered` in `agents/notify.mjs`) — a line from the bot on top of it would be noise,
// and a wrong guess at the card shows up in the answer not matching what was asked. It writes
// only when something went wrong, plus the one case where nothing is going to answer: the
// message is filed and nobody was woken (`woke` is empty — this board's architect is off and
// no agent was tagged).
//
// A reaction is the other way to answer, and the shorter one: 👍 on a notification becomes a 👍
// on the message on the board that notification was about, and from there the board's rule takes
// over — the owner's 👍 on a card in Review closes it. Telegram does not deliver reaction updates
// in every private chat, so a reply that is 👍 and nothing else counts as the same thing. The
// board moved the card and the owner can see it; a card that is not in Review is the one thing
// the bot has to say out loud, because nothing happened and nothing is going to.
//
// How it listens: `getUpdates` long polling. No webhook, no tunnel, no port open on this machine —
// the worker calls out to Telegram and the call sits there until something arrives or the timeout
// is up. It runs as its own loop rather than on the worker's tick, because a poll blocks for half
// a minute at a time and the worker has runs to claim meanwhile.
//
// What it accepts: messages from TELEGRAM_CHAT_ID and nothing else. Someone who finds the bot gets
// no answer and leaves no trace in the log beyond one line saying a foreign chat wrote — not what
// it wrote. The token is never logged: every error that could quote the API URL goes through
// `scrub` first.

import { scrub } from "./notify.mjs"
import { taskRef } from "./lib.mjs"

/** How long one `getUpdates` call waits for something to happen, in seconds. */
const POLL_TIMEOUT_S = 25
/**
 * What the bot asks Telegram for. `message_reaction` has to be named: it is not in the default
 * set, and without it a 👍 on a notification never reaches us.
 */
const ALLOWED_UPDATES = ["message", "edited_message", "message_reaction"]
/**
 * The reactions the board acts on — one of them. The same list as `REACTIONS` in
 * `src/lib/types.ts`: the worker runs plain `.mjs` and cannot import the TypeScript, the way
 * `taskRef` is kept in two places. What it means is the board's business, not the bot's.
 */
export const REACTIONS = ["👍"]
/** After a network error: wait, then poll again. Telegram being down is not worth a crash. */
const RETRY_MS = 5000
/** How much of a card's title /status prints. */
const TITLE_MAX = 60
/**
 * How long the last notification stays the default address for a message with no reply and no
 * card number. A day later the board has moved on and the owner means something else.
 */
export const LAST_NOTE_MS = 24 * 60 * 60 * 1000

// --- the Telegram API --------------------------------------------------------

/**
 * One Bot API call. Throws with the token scrubbed out — the URL carries it, and both `fetch`
 * and Telegram like to quote the URL back at you.
 */
export async function callBot(method, body, { token, fetchImpl = fetch, timeoutMs, signal } = {}) {
  const signals = [timeoutMs ? AbortSignal.timeout(timeoutMs) : null, signal].filter(Boolean)
  let response
  try {
    response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
      ...(signals.length > 0 ? { signal: AbortSignal.any(signals) } : {}),
    })
  } catch (error) {
    throw new Error(`Telegram unreachable: ${scrub(error?.message ?? error, token)}`)
  }
  if (!response.ok) throw new Error(`Telegram refused ${method} (HTTP ${response.status})`)
  const data = await response.json()
  if (data?.ok !== true) throw new Error(`Telegram refused ${method}`)
  return data.result
}

// --- what an update is -------------------------------------------------------

/**
 * A card number inside a sentence: `BI-69`, `ug-3`, "fix the title in BI-69". Two to six letters and a
 * number, so an ordinary hyphenated word is not mistaken for a card. The first one wins — the
 * owner is writing to one card, and the others are just mentioned in the text.
 */
export function findRef(text) {
  const match = String(text ?? "").match(/(?:^|[^\p{L}\p{N}_-])([A-Za-z]{2,6})-(\d{1,6})(?![\p{L}\p{N}_-])/u)
  return match ? `${match[1].toUpperCase()}-${Number(match[2])}` : null
}

/** The reactions of a Telegram reaction list the board knows about, in the order they came. */
function knownEmojis(list) {
  return (list ?? []).filter((item) => item?.type === "emoji" && REACTIONS.includes(item.emoji)).map((i) => i.emoji)
}

/**
 * What changed in a `message_reaction` update: Telegram sends the whole set before and after, so
 * the one reaction the owner just put on (or took off) is the difference. Null when nothing the
 * board knows about moved — somebody's 🤡 is not an answer.
 */
function reactionChange(update) {
  const before = knownEmojis(update?.old_reaction)
  const after = knownEmojis(update?.new_reaction)
  const added = after.find((emoji) => !before.includes(emoji))
  if (added) return { emoji: added, removed: false }
  const gone = before.find((emoji) => !after.includes(emoji))
  return gone ? { emoji: gone, removed: true } : null
}

/**
 * What the bot should do about one update, and nothing more: no network, no board. The reply case
 * comes first on purpose — a reply is the owner answering a card, whatever its text looks like,
 * so `/status` typed as a reply is still a message for that card.
 *
 * `{ kind }` is one of:
 *   `ignored`  — not a text message, or not from the owner's chat
 *   `reaction` — `{ emoji, replyTo, removed }`: the owner reacted to that notification, so the
 *                same reaction goes on the message on the board it was about
 *   `reply`    — `{ replyTo, text, messageId }`: a message for the card that notification was about
 *   `status`   — `/status`
 *   `ref`      — `{ ref, text, messageId }`: a message for the card the text names by number
 *   `loose`    — `{ text, messageId }`: a message for the card of the last notification bot sent
 *   `hint`     — a command the bot does not know: the owner is told what it understands
 *
 * `messageId` is the owner's own message — what the agent's answer comes back as a reply to.
 */
export function readUpdate(update, { chatId }) {
  const reacted = update?.message_reaction
  if (reacted) {
    if (String(reacted?.chat?.id ?? "") !== String(chatId)) return { kind: "ignored", reason: "another chat" }
    const change = reactionChange(reacted)
    if (!change) return { kind: "ignored", reason: "not one of the board's reactions" }
    return { kind: "reaction", ...change, replyTo: reacted.message_id }
  }
  const message = update?.message ?? update?.edited_message
  const text = typeof message?.text === "string" ? message.text.trim() : ""
  if (!text) return { kind: "ignored", reason: "no text" }
  if (String(message?.chat?.id ?? "") !== String(chatId)) return { kind: "ignored", reason: "another chat" }
  const messageId = message.message_id
  const replyTo = message.reply_to_message?.message_id
  if (replyTo) {
    // Telegram does not deliver reaction updates in every private chat. A reply that is the one
    // emoji and nothing else is the same thing said another way: a reaction, not a line of text
    // in the card's chat.
    if (REACTIONS.includes(text)) return { kind: "reaction", emoji: text, replyTo, removed: false }
    return { kind: "reply", replyTo, text, messageId }
  }
  if (/^\/status(?:@\S+)?$/i.test(text)) return { kind: "status" }
  // Anything else starting with a slash is a command this bot does not have, not a message for
  // a card: sending `/start` into someone's chat would only confuse the architect.
  if (text.startsWith("/")) return { kind: "hint" }
  const ref = findRef(text)
  if (ref) return { kind: "ref", ref, text, messageId }
  return { kind: "loose", text, messageId }
}

// --- /status -----------------------------------------------------------------

function shorten(title) {
  const line = String(title ?? "").replace(/\s+/g, " ").trim()
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line
}

/**
 * The board in one message: per board, what is being worked on, what is waiting to be reviewed
 * and what is stuck on the owner. Numbers and titles only — the texts of the messages that made a
 * card wait stay on the board, the same rule the notifications follow.
 */
export function statusText(state) {
  const boards = (state?.boards ?? []).filter((board) => !board.archived)
  if (boards.length === 0) return "No boards."
  const blocks = []
  for (const board of boards) {
    const columns = board.columns ?? []
    const cards = columns.flatMap((column) => (column.tasks ?? []).map((task) => ({ task, role: column.role })))
    const label = (task) => {
      const ref = taskRef(board.key, task.number)
      return `• ${[ref, shorten(task.title)].filter(Boolean).join(" ")}`
    }
    const section = (heading, list) =>
      list.length === 0 ? `${heading}: —` : [`${heading}:`, ...list.map(label)].join("\n")
    blocks.push(
      [
        board.name,
        section(
          "In progress",
          cards.filter((c) => c.role === "in_progress").map((c) => c.task)
        ),
        section(
          "Review",
          cards.filter((c) => c.role === "review").map((c) => c.task)
        ),
        section(
          "Waiting for the owner",
          cards.filter((c) => c.task.needsOwner).map((c) => c.task)
        ),
      ].join("\n")
    )
  }
  return blocks.join("\n\n")
}

export const HINT_TEXT =
  'Write a card number — "BI-69 to Done" — or reply to a notification, and the text goes into that card\'s chat. Or send /status.'

/**
 * The message is in the card's chat and nobody was woken by it: this board's architect is off
 * and no agent was tagged, so no answer is coming and the owner has to hear that much.
 */
export function nobodyText(link) {
  return `Saved to ${link?.ref ?? link?.taskId}. Agents on this board don't answer on their own.`
}

/** The owner's 👍 on a card that is not in Review: nothing moved, and nothing will. */
export function notInReviewText(link) {
  return `${link?.ref ?? link?.taskId} is not in Review yet, so it is not moved to Done. Say it in words.`
}

// --- the loop ----------------------------------------------------------------

/**
 * The bot's inbox. `call(method, path, body)` is the worker's own HTTP helper for the board;
 * `fetchImpl` is only there for the tests.
 *
 * Returns null when the channel is off (no token or no chat id) — the same two variables
 * `openChannels` reads, so the bot talks both ways or neither.
 */
export function createTelegramInbox({
  call,
  env = process.env,
  log = console.log,
  fetchImpl = fetch,
  now = () => Date.now(),
  pollTimeoutS = POLL_TIMEOUT_S,
  retryMs = RETRY_MS,
}) {
  const token = (env.TELEGRAM_BOT_TOKEN ?? "").trim()
  const chatId = (env.TELEGRAM_CHAT_ID ?? "").trim()
  if (!token || !chatId) return null

  // Stopping must not wait out a long poll: the worker leaves when its runs are done, and an
  // open `getUpdates` would hold the process for another half minute.
  const stopping = new AbortController()
  const bot = (method, body, options) =>
    callBot(method, body, { token, fetchImpl, signal: stopping.signal, ...options })
  /** A short answer in the owner's chat. Never carries a detail of what went wrong. */
  const say = async (text) => {
    try {
      await bot("sendMessage", { chat_id: chatId, text, disable_web_page_preview: true })
    } catch (error) {
      log(`[telegram] could not answer: ${scrub(error?.message ?? error, token)}`)
    }
  }

  /**
   * Which card the board says this is about. `null` = no such card; `undefined` = the board did
   * not answer, which is not the same thing and must not read as "no card".
   */
  const lookup = async (query, what) => {
    try {
      const found = await call("GET", `/api/telegram/notifications?${query}`)
      return found?.link ?? null
    } catch (error) {
      log(`[telegram] the board did not answer about ${what}: ${scrub(error?.message ?? error, token)}`)
      await say("The board is not responding. Try again later.")
      return undefined
    }
  }

  /**
   * The text into that card's chat, as the owner. Silent when it worked: the answer of whoever
   * was woken is the confirmation, and it comes back here by itself. The exception is a board
   * where nothing was woken — then nobody is going to answer and the bot says so once.
   */
  const deliver = async (link, { text, messageId }) => {
    let posted
    try {
      // No authorId: the board files a message with no author as the owner's, which is what this
      // is. `source` is how the card's chat shows it came in from the bot, and
      // `telegramMessageId` is what the answer to it is sent as a reply to.
      posted = await call("POST", `/api/tasks/${encodeURIComponent(link.taskId)}/messages`, {
        text,
        source: "telegram",
        telegramMessageId: messageId,
      })
    } catch (error) {
      log(`[telegram] the board refused a message for ${link.taskId}: ${scrub(error?.message ?? error, token)}`)
      await say("Couldn't save.")
      return
    }
    // A board that does not say who it woke (an older one) is left alone: silence is the rule.
    if (Array.isArray(posted?.woke) && posted.woke.length === 0) await say(nobodyText(link))
  }

  /** The owner replied to a notification: the text goes into that card's chat. */
  const onReply = async ({ replyTo, text, messageId }) => {
    const link = await lookup(`message=${encodeURIComponent(replyTo)}`, `message ${replyTo}`)
    if (link === undefined) return
    if (!link?.taskId) {
      await say("No card found for this message.")
      return
    }
    await deliver(link, { text, messageId })
  }

  /**
   * The owner reacted to a notification: the same reaction goes on the message on the board that
   * notification was about — or on the card, when the notification was about no single message.
   * What it means is the board's rule, not the bot's: the board answers with what it did
   * (`effect`), and the bot only speaks when that is nothing — a 👍 on a card that is not in
   * Review moved nothing, and silence would read as "done".
   */
  const onReaction = async ({ emoji, replyTo, removed }) => {
    const link = await lookup(`message=${encodeURIComponent(replyTo)}`, `message ${replyTo}`)
    if (link === undefined) return
    if (!link?.taskId) {
      await say("No card found for this message.")
      return
    }
    try {
      const result = await call(
        removed ? "DELETE" : "POST",
        `/api/tasks/${encodeURIComponent(link.taskId)}/reactions`,
        { emoji, ...(link.boardMessageId ? { messageId: link.boardMessageId } : {}) }
      )
      // Taking a reaction off undoes nothing on the board, so there is nothing to report either.
      if (!removed && result?.effect !== "done") await say(notInReviewText(link))
    } catch (error) {
      log(`[telegram] the board refused a reaction for ${link.taskId}: ${scrub(error?.message ?? error, token)}`)
      await say("Couldn't save.")
    }
  }

  /** The owner named a card by number: "BI-69 to Done". */
  const onRef = async ({ ref, text, messageId }) => {
    const link = await lookup(`ref=${encodeURIComponent(ref)}`, `card ${ref}`)
    if (link === undefined) return
    if (!link?.taskId) {
      await say(`Card ${ref} not found. Check the number or reply to a notification.`)
      return
    }
    await deliver(link, { text, messageId })
  }

  /**
   * Neither a reply nor a number: the owner is carrying on about the card they were just told
   * about. Older than a day and that is a guess, not a continuation — so they get the hint.
   */
  const onLoose = async ({ text, messageId }) => {
    const link = await lookup("last=1", "the last notification")
    if (link === undefined) return
    const sentAt = Date.parse(link?.createdAt ?? "")
    if (!link?.taskId || !Number.isFinite(sentAt) || now() - sentAt > LAST_NOTE_MS) {
      await say(HINT_TEXT)
      return
    }
    await deliver(link, { text, messageId })
  }

  const onStatus = async () => {
    try {
      const state = await call("GET", "/api/state")
      await say(statusText(state))
    } catch (error) {
      log(`[telegram] /status failed: ${scrub(error?.message ?? error, token)}`)
      await say("The board is not responding. Try again later.")
    }
  }

  /** One update, after `readUpdate` has decided what it is. Exported through `handle` for tests. */
  const handle = async (update) => {
    const action = readUpdate(update, { chatId })
    if (action.kind === "ignored") {
      // One line, and not a word of what was written: a stranger's message is not board data.
      if (action.reason === "another chat") log("[telegram] ignored a message from another chat")
      return action
    }
    if (action.kind === "reaction") await onReaction(action)
    else if (action.kind === "reply") await onReply(action)
    else if (action.kind === "status") await onStatus()
    else if (action.kind === "ref") await onRef(action)
    else if (action.kind === "loose") await onLoose(action)
    else await say(HINT_TEXT)
    return action
  }

  /**
   * Updates waiting from before this worker started are confirmed and dropped. A reply from
   * yesterday is history, not a request — the notifier draws the same line at its own start.
   */
  let offset = 0
  const drainBacklog = async () => {
    const stale = await bot("getUpdates", { timeout: 0, offset: -1, allowed_updates: ALLOWED_UPDATES })
    const last = stale?.[stale.length - 1]
    if (last) {
      offset = last.update_id + 1
      log("[telegram] skipped the messages that were waiting from before this worker started")
    }
  }

  let stopped = false
  /** One long poll and whatever came with it. Returns the updates it handled. */
  const poll = async () => {
    const updates = await bot(
      "getUpdates",
      { timeout: pollTimeoutS, allowed_updates: ALLOWED_UPDATES, ...(offset ? { offset } : {}) },
      // The HTTP call must outlive the long poll it is waiting on, or it kills every poll.
      { timeoutMs: (pollTimeoutS + 15) * 1000 }
    )
    for (const update of updates ?? []) {
      offset = Math.max(offset, update.update_id + 1)
      await handle(update)
    }
    return updates ?? []
  }

  /** Poll until stopped. Never throws: a failed poll is logged and tried again. */
  const start = async () => {
    try {
      await drainBacklog()
    } catch (error) {
      log(`[telegram] could not reach the bot: ${scrub(error?.message ?? error, token)}`)
    }
    log("[telegram] replies: on (long polling)")
    while (!stopped) {
      try {
        await poll()
      } catch (error) {
        if (stopped) return
        log(`[telegram] ${scrub(error?.message ?? error, token)}`)
        await new Promise((resolve) => setTimeout(resolve, retryMs))
      }
    }
  }

  const stop = () => {
    stopped = true
    stopping.abort()
  }

  return { start, stop, poll, handle, drainBacklog }
}
