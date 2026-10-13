// Telling the owner the few things that are worth a buzz when the board is not open.
//
// The board's event feed (`src/server/feed.ts`) is the source: this module reads it the way any
// outside client would — GET /api/events?board=…&since=… — and turns the handful of lines that
// need a human into a notification. It runs inside the worker because the worker is the one
// process that is always up, already talks to the board over HTTP, and can spawn `osascript`.
//
// Two channels, both optional:
//   macOS   — `osascript -e 'display notification …'`, whenever the worker runs on a Mac
//   Telegram — when TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are in the environment (or in the
//              project's .env, which is git-ignored). No variables: the channel is simply off,
//              one line about it at start. The token is never logged, not even in an error.
//
// What a notification is allowed to say is the point of this module: the card's number, a label
// for what happened, the card's title and — when the agent wrote one — its own `In short:` line
// (`plain` on the feed event). Nothing else. No message text, no run log, no diff, no file
// paths: those live on the board. A board whose owner does not want even that one line leaving
// the machine turns "Detailed notifications" off (`notificationsDetailed`).
//
// The two channels do not say the same thing: macOS notifies next to the board
// and keeps the link to the card, Telegram is read on a phone where `localhost` opens nothing,
// so its text has no link at all and a card reaching Done is a single line there.
//
// One of the five is not news but an answer: the owner writes to a card from the bot, an agent
// answers it on the board, and that answer goes back to Telegram as a reply to their own message
// (`agent_answered`). The same rule about what may leave the board holds — the words the
// agent wrote for them, and nothing else.

import { execFile } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { PROJECT_ROOT } from "./lib.mjs"

/**
 * The label of the one notification that is an answer and not news: an agent replying to the
 * message the owner sent in from Telegram. It reads differently — `BI-79 · <the agent's
 * words>`, as a reply to their own message — and it is never held back by the window below:
 * somebody who just wrote is waiting for it.
 */
export const ANSWER_LABEL = "Answer"
/**
 * The label of the move the owner hears about as a fact and not as a bulletin: a card
 * reaching Done is one line in Telegram — `BI-79 moved to Done` — whoever moved it there, with
 * no title, no `In short:` line and no link. By then the owner knows what the card was.
 */
export const DONE_LABEL = "Done"
/** What the owner is told when their board keeps the agents' words off the phone. */
export const ANSWER_QUIET = "Agent replied in the card chat"
/** At most one notification per card per this window; what happens meanwhile is glued into it. */
export const NOTIFY_WINDOW_MS = 2 * 60 * 1000
/** How often the feed is read. A notification is not a race — the board's own UI is live. */
const POLL_MS = 5000
/** How often the list of boards (and their notification switches) is re-read. */
const BOARDS_MS = 15_000
/** Feed page size, and how many pages one tick drains before leaving the rest for the next. */
const PAGE = 200
const PAGES_PER_TICK = 20

/**
 * What happened, in the two or three words a notification has room for. One label per thing the
 * owner wants to hear about; everything else in the feed is the board working normally.
 *
 * `state.checkFails` counts a card's check failures in a row, because the first one is routine
 * (the coder gets an automatic retry) and only the second means the card is stuck. The count
 * starts empty with the worker: a failure from before it started is history, not news.
 */
export function classify(event, state) {
  const data = event?.data ?? {}
  const taskKey = event?.taskId ?? ""
  switch (event?.type) {
    case "card_moved":
      // Review and Done are the two columns the owner wants to hear about, whoever moved the
      // card there — a person in the UI, the bot, an architect, an outside client over the API.
      // The board records the move the same way for all of them (`recordMove`), so one rule
      // covers them all.
      if (data.to === "review") return "Review"
      return data.to === "done" ? "Done" : null
    case "needs_owner":
      // The same type says "no longer waiting" — that is the owner's own doing, not news.
      return data.cleared === true ? null : "Needs owner"
    case "agent_answered":
      // The owner wrote to a card from Telegram and an agent answered: that answer goes back to
      // them. The fifth thing worth a buzz, and the only one that is a reply rather than news.
      return ANSWER_LABEL
    case "owner_mentioned":
      // The other half of "the owner has to answer": `needs_owner` is the card stopping on their
      // word, this is an agent asking them in the chat. The question itself is the `In short:`
      // line right under the label.
      return "Question"
    case "run_failed":
      // A coder that ran out of turns with work in the checkout gets one more run on the card
      // (`continueAfterTurnLimit`) — routine, like the first failed check below. The second
      // limit in a row queues nothing and is told about.
      return data.continued === true ? null : "Run failed"
    case "agents_paused":
      return "Agents paused"
    case "commit_skipped":
      // Nothing to commit no longer holds the card: it goes on to the review, and the
      // owner hears about it when it reaches Review. Only a commit git refused leaves it stuck.
      return data.reason === "nothing to commit" ? null : "No commit"
    case "check_passed":
      state.checkFails.delete(taskKey)
      return null
    case "check_failed": {
      const times = (state.checkFails.get(taskKey) ?? 0) + 1
      state.checkFails.set(taskKey, times)
      return times >= 2 ? "Check failed again" : null
    }
    case "reaction_added":
    case "reaction_removed":
      // A reaction is the owner's own doing; telling them about it is telling them what they
      // just did. What the board *does* about one arrives as its own line (a card moved).
      return null
    default:
      return null
  }
}

/**
 * The parts of a notification, and the only place they are composed. `text` is what goes out
 * over Telegram — read on a phone, where a `localhost` link opens nothing, so there is none:
 *
 *   BI-63 — Review: Notifications for the owner
 *   Added the owner's one-line summary to the notifications.
 *
 * The first line is the card's number, the label and the card's title (the feed already cuts it
 * to 60 characters); the second is the agent's own `In short:` line, and is simply missing when
 * there is none. Nothing here reads `summary` or `data` — a feed summary can quote a CLI's
 * first line.
 *
 * Two labels read differently. An answer to the owner's own message (`ANSWER_LABEL`) is a reply,
 * not a bulletin:
 *
 *   BI-79 · The bot is quiet on delivery now; the agent's answer comes back as a reply.
 *
 * And a card reaching Done is one standard line — the card is finished, the title and the
 * agent's line were in the notification about Review:
 *
 *   BI-79 moved to Done
 *
 * `headline`, `title`, `plain` and `link` are the pieces the macOS channel assembles for itself
 * (`macScript`), where a link does open the card and nothing changed.
 */
export function notificationText(note) {
  const label = note.glued > 0 ? `${note.label} +${note.glued}` : note.label
  const headline = `${note.ref} — ${label}`
  const title = (note.title ?? "").replace(/\s+/g, " ").trim()
  const plain = (note.plain ?? "").replace(/\s+/g, " ").trim()
  let text
  if (note.label === ANSWER_LABEL) text = `${note.ref} · ${plain || ANSWER_QUIET}`
  // Whatever else was glued into the window, the owner is told the card is done and no more.
  else if (note.label === DONE_LABEL) text = `${note.ref} moved to Done`
  else text = [[headline, title].filter(Boolean).join(": "), plain].filter(Boolean).join("\n")
  return { headline, title, plain, link: note.link ?? "", text }
}

// --- channels ----------------------------------------------------------------

/** An AppleScript string literal: it holds no raw newlines, and quotes are escaped. */
function quote(text) {
  return `"${String(text).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]+/g, " ")}"`
}

/**
 * The one-liner Notification Centre gets: the label as the title, the card under it, and in the
 * body the agent's line — the link when there is none, as it always was.
 */
export function macScript(note) {
  const { headline, title, plain, link } = notificationText(note)
  const body = plain || link || title || headline
  return `display notification ${quote(body)} with title ${quote(headline)}${title ? ` subtitle ${quote(title)}` : ""}`
}

function osascript(script) {
  return new Promise((resolve, reject) => {
    execFile("osascript", ["-e", script], { timeout: 10_000 }, (error) => (error ? reject(error) : resolve()))
  })
}

/** Everything that looks like the bot token, out of a string that is about to be logged. */
export function scrub(text, token) {
  const plain = String(text ?? "")
  return token ? plain.split(token).join("<token>") : plain
}

/**
 * `remember(messageId, note)` is how a notification about a card becomes answerable: Telegram
 * hands back the id of the message it just posted, and the board stores which card it was about,
 * so a reply to it can be routed back into that card's chat (`agents/telegram.mjs`). Failing to
 * store the link does not fail the notification — the owner was still told.
 */
export function telegramChannel({ token, chatId, fetchImpl = fetch, remember, log = console.error }) {
  return async (note) => {
    const { text } = notificationText(note)
    let response
    try {
      response = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          disable_web_page_preview: true,
          // An answer is a reply to the owner's own message, so it reads under what they asked.
          // `allow_sending_without_reply`: a message they have deleted since must not swallow
          // the answer to it.
          ...(note.replyTo
            ? { reply_to_message_id: note.replyTo, allow_sending_without_reply: true }
            : {}),
        }),
      })
    } catch (error) {
      // The URL carries the token, and a fetch failure likes to quote the URL.
      throw new Error(`Telegram unreachable: ${scrub(error?.message ?? error, token)}`)
    }
    if (!response.ok) throw new Error(`Telegram refused the message (HTTP ${response.status})`)
    if (!remember || !note.taskId) return
    try {
      const body = await response.json()
      const messageId = body?.result?.message_id
      if (messageId) await remember(messageId, note)
    } catch (error) {
      log(`[notify] could not make the notification answerable: ${scrub(error?.message ?? error, token)}`)
    }
  }
}

/**
 * Which channels are open, said out loud once. A channel that is off is not an error: a board
 * on a Linux box with no bot token simply notifies nobody.
 */
export function openChannels({
  env = process.env,
  platform = process.platform,
  log = console.log,
  fetchImpl,
  remember,
} = {}) {
  const channels = []
  if (platform === "darwin") {
    channels.push({ name: "macOS", send: (note) => osascript(macScript(note)) })
    log("[notify] macOS notifications: on")
  } else {
    log(`[notify] macOS notifications: off (${platform} is not a Mac)`)
  }
  const token = (env.TELEGRAM_BOT_TOKEN ?? "").trim()
  const chatId = (env.TELEGRAM_CHAT_ID ?? "").trim()
  if (token && chatId) {
    channels.push({ name: "Telegram", send: telegramChannel({ token, chatId, fetchImpl, remember }), token })
    log("[notify] Telegram: on")
  } else {
    log("[notify] Telegram: off (set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env to turn it on)")
  }
  return channels
}

/** One note to every open channel; a channel that fails takes none of the others with it. */
export function fanOut(channels, log = console.error) {
  return async (note) => {
    for (const channel of channels) {
      try {
        await channel.send(note)
      } catch (error) {
        log(`[notify] ${channel.name} failed: ${scrub(error?.message ?? error, channel.token)}`)
      }
    }
  }
}

// --- rules + coalescing ------------------------------------------------------

/** `http://localhost:43123/?task=t_…` — the board opens the card the notification is about. */
export function cardLink(boardUrl, taskId) {
  const base = String(boardUrl ?? "").replace(/\/$/, "")
  if (!base) return ""
  return taskId ? `${base}/?task=${encodeURIComponent(taskId)}` : base
}

/**
 * The rules and the two-minute window, with the sending injected — this is what the tests drive.
 *
 * `offer` takes feed events in the order the feed hands them out and sends what deserves a
 * notification, at most one per card per window. Anything that happens on a card inside its
 * window is held and glued into one notification, which `flush` sends when the window is over:
 * three failures in a row are one buzz saying how many, not three buzzes.
 */
export function createNotifier({ send, boardUrl = "", now = () => Date.now(), windowMs = NOTIFY_WINDOW_MS }) {
  const state = { checkFails: new Map() }
  const lastSentAt = new Map()
  const pending = new Map()

  const emit = async (note) => {
    lastSentAt.set(note.key, now())
    pending.delete(note.key)
    await send(note)
    return note
  }

  const offer = async (event, board = {}) => {
    const label = classify(event, state)
    if (!label) return null
    const key = event.taskId ?? `board:${event.boardId}`
    const note = {
      key,
      // The card the notification is about, so a reply to it in Telegram can find its way back;
      // null for a note about the board as a whole, which answers to nothing.
      taskId: event.taskId ?? null,
      // The message on the board this is about, so a reaction on the notification can be put on
      // that message: the agent's question for a "Question". For everything else the board picks
      // the card's last message with an `In short:` line — the one the notification quotes.
      boardMessageId: Number.isFinite(event.data?.messageId) ? event.data.messageId : null,
      ref: event.ref ?? board.key ?? "Board",
      label,
      title: event.title ?? "",
      // The agent's own line about what happened, and the only thing in a notification that
      // was written rather than assembled — for an answer, the words it wrote for the owner
      // (`data.answer`, up to 600 characters: the feed's `plain` is a 300-character glance and
      // an answer is read as a message). Off on the board = the owner gets the glance only, and
      // an answer then says that there is one and nothing of what it says.
      plain:
        board.notificationsDetailed === false
          ? ""
          : (label === ANSWER_LABEL ? event.data?.answer : event.plain) ?? "",
      // The owner's own message in Telegram this answers — a notification replies to it.
      replyTo: label === ANSWER_LABEL && Number.isFinite(event.data?.replyTo) ? event.data.replyTo : null,
      link: label === ANSWER_LABEL ? "" : cardLink(boardUrl, event.taskId),
      glued: 0,
    }
    // An answer is never held and never glued: it answers a message the owner wrote a moment
    // ago, and gluing it into the next card_moved would drop both its text and what it replies
    // to. It does not take up the card's window either — what the board goes on to do about that
    // message is news of its own.
    if (label === ANSWER_LABEL) {
      await send(note)
      return note
    }
    const quiet = now() - (lastSentAt.get(key) ?? -Infinity) >= windowMs
    if (quiet) return emit(note)
    const held = pending.get(key)
    // The latest thing that happened is what the owner is told; the earlier ones are the count.
    pending.set(key, { ...note, glued: (held?.glued ?? -1) + 1 })
    return null
  }

  /** Send the held notifications whose window has passed. Called on every tick. */
  const flush = async () => {
    const sent = []
    for (const [key, note] of [...pending]) {
      if (now() - (lastSentAt.get(key) ?? 0) < windowMs) continue
      sent.push(await emit(note))
    }
    return sent
  }

  return { offer, flush, get pending() { return [...pending.values()] } }
}

// --- .env --------------------------------------------------------------------

/**
 * The project's `.env` into `process.env`, without a dependency and without overriding anything
 * that is already set. It is where the Telegram token lives: git-ignored, typed in by the owner,
 * never read by anything but this module.
 */
export function loadDotEnv(root = PROJECT_ROOT, env = process.env) {
  let text
  try {
    text = fs.readFileSync(path.join(root, ".env"), "utf8")
  } catch {
    return []
  }
  const names = []
  for (const line of text.split("\n")) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!match || line.trimStart().startsWith("#")) continue
    const [, name, rest] = match
    let value = rest.trim()
    if (/^"(.*)"$/s.test(value) || /^'(.*)'$/s.test(value)) value = value.slice(1, -1)
    else value = value.replace(/\s+#.*$/, "").trim()
    names.push(name)
    if (env[name] === undefined) env[name] = value
  }
  return names
}

// --- the loop ----------------------------------------------------------------

/**
 * The worker's notifier: reads every board's feed from where it left off and notifies about what
 * the rules pick out. `call(method, path)` is the worker's own HTTP helper.
 *
 * Events from before `startedAt` are read but never notified about — a worker that starts after
 * a day away would otherwise buzz about the whole day. A board with notifications off is drained
 * the same way for the same reason: turning the switch back on should say what happens next, not
 * what already happened.
 */
export function createNotifications({
  call,
  boardUrl = "",
  /** Where the `.env` with the Telegram token is looked for. */
  root = PROJECT_ROOT,
  env = process.env,
  platform = process.platform,
  log = console.log,
  now = () => Date.now(),
  startedAt = new Date().toISOString(),
  windowMs,
  pollMs = POLL_MS,
  fetchImpl,
}) {
  loadDotEnv(root, env)
  // Which card each Telegram notification was about, kept in the board's file: the owner answers
  // a notification hours later, long after this worker was last restarted.
  const remember = (messageId, note) =>
    call("POST", "/api/telegram/notifications", {
      messageId,
      taskId: note.taskId,
      // And which message on the board it is about, so a reaction on the notification lands on
      // that message rather than on the card as a whole (`agents/telegram.mjs`).
      boardMessageId: note.boardMessageId ?? null,
    })
  const channels = openChannels({ env, platform, log, fetchImpl, remember })
  const notifier = createNotifier({ send: fanOut(channels, log), boardUrl, now, windowMs })
  const cursors = new Map()
  let boards = []
  let boardsAt = 0
  let lastPoll = 0

  const boardList = async () => {
    const { boards: list } = await call("GET", "/api/boards")
    return Array.isArray(list) ? list.filter((board) => !board.archived) : []
  }

  const drain = async (board) => {
    for (let page = 0; page < PAGES_PER_TICK; page++) {
      const since = cursors.get(board.id) ?? 0
      const feed = await call("GET", `/api/events?board=${encodeURIComponent(board.id)}&since=${since}&limit=${PAGE}`)
      const events = feed?.events ?? []
      for (const event of events) {
        if (board.notificationsEnabled === false || event.at < startedAt) continue
        await notifier.offer(event, board)
      }
      cursors.set(board.id, feed?.cursor ?? since)
      if (events.length < PAGE) return
    }
  }

  const tick = async () => {
    if (channels.length === 0) return
    const at = now()
    if (at - lastPoll < pollMs) return
    lastPoll = at
    try {
      if (at - boardsAt >= BOARDS_MS || boards.length === 0) {
        boards = await boardList()
        boardsAt = at
      }
      for (const board of boards) await drain(board)
      await notifier.flush()
    } catch (error) {
      // A notification is never worth stopping the worker over.
      log(`[notify] ${scrub(error?.message ?? error)}`)
    }
  }

  return { tick, channels, notifier }
}
