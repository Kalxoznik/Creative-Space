// Shared helpers for the worker and its adapters. No dependencies.

import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

export const AGENTS_DIR = path.dirname(fileURLToPath(import.meta.url))
export const PROJECT_ROOT = path.resolve(AGENTS_DIR, "..")

const MOVE_TARGETS = new Set(["backlog", "ready", "in_progress", "review", "done"])
/** Why a card stops on the owner's word; the board validates the same four. */
const NEEDS_REASONS = new Set(["paid_call", "corpus_write", "deploy", "question"])
/** Cards one reply may ask the board to create; the board enforces the same limit. */
const CREATE_LIMIT = 3
/** A commit subject longer than this is not used — the worker falls back to the card's title. */
export const COMMIT_SUBJECT_MAX = 72
/** How much of the agent's own one-liner travels to the owner; the board clamps to the same. */
const PLAIN_MAX = 300
/**
 * The line an agent ends a hand-off, a question or a failure with: one or two sentences in the
 * owner's language, which is all a notification carries of what happened. The prompts ask for
 * `In short:`; `Briefly:` and its Russian twin (spelled as escapes, so the source stays Latin)
 * are accepted too, because an agent writing in the owner's language translates the marker
 * along with the line.
 */
const PLAIN_MARKER =
  /^\s*(?:[-*>]\s*)?(?:\*\*|__)?\s*(?:In short|Briefly|\u{41A}\u{43E}\u{440}\u{43E}\u{442}\u{43A}\u{43E})(?:\*\*|__)?\s*[:：]\s*(.+)$/iu

/** Role prompt from agents/prompts/<role>.md */
export async function loadRolePrompt(role) {
  return fs.readFile(path.join(AGENTS_DIR, "prompts", `${role}.md`), "utf8")
}

function memberLine(member) {
  if (member.kind !== "agent") return `- @${member.handle} — ${member.name} (human)`
  const config = member.agent ?? {}
  const about = [config.description, config.engine, config.model, config.effort && `effort ${config.effort}`]
    .filter(Boolean)
    .join("; ")
  return `- @${member.handle} — ${member.name} (agent, ${member.agentRole}${about ? `: ${about}` : ""})`
}

/**
 * `BI` + 12 → `BI-12`: the card number people and agents say out loud. The same rule as
 * src/lib/task-ref.ts — the worker runs plain .mjs and cannot import the TypeScript one.
 */
export function taskRef(boardKey, number) {
  if (!boardKey || !number) return null
  return `${boardKey}-${number}`
}

/** `BI-12 (t_…)` — readable first, but the id the API needs is right there too. */
function cardName(ref, id) {
  // A card with no number yet comes back with its id as the ref — don't print it twice.
  return ref && ref !== id ? `${ref} (${id})` : `#${id}`
}

function queueLine(card, refOf) {
  const bits = []
  if (card.assignees.length > 0) bits.push(`tagged ${card.assignees.map((h) => `@${h}`).join(" ")}`)
  else bits.push("untagged")
  // Blockers are card ids; show them the way the Architect is expected to write them back.
  if (card.blockedBy.length > 0) bits.push(`waits for ${card.blockedBy.map((id) => refOf(id)).join(", ")}`)
  const description = (card.description || "").replace(/\s+/g, " ").trim()
  return `- ${cardName(card.ref, card.id)} “${card.title}” (${bits.join(", ")})${description ? `\n    ${description}` : ""}`
}

/** Pasted images are stored as /api/uploads/<name>; the model needs a file it can open. */
function withImagePaths(text) {
  const dir = process.env.CS_UPLOADS_DIR ?? path.join(PROJECT_ROOT, "uploads")
  return text.replace(/!\[([^\]]*)\]\(\/api\/uploads\/([a-z0-9]+\.(?:png|jpg|gif|webp))\)/g, (_match, alt, name) =>
    `[${alt || "image"}: ${path.join(dir, name)}]`
  )
}

function formatThread(thread, members, limit = 40) {
  const byId = new Map(members.map((m) => [m.id, m]))
  const recent = thread.slice(-limit)
  if (recent.length === 0) return "(no messages yet)"
  return recent
    .map((message) => {
      const author = byId.get(message.authorId)
      const who = message.kind === "system" ? "system" : `@${author?.handle ?? message.authorId}`
      return `[${message.createdAt.slice(0, 16).replace("T", " ")}] ${who}: ${withImagePaths(message.text)}`
    })
    .join("\n")
}

/** Everything the model gets: role rules + the agent's own instructions + board situation + the trigger. */
export async function buildPrompt(role, context) {
  const { task, board, members, thread, run, triggerMessage, agent, queue } = context
  const owner = members.find((m) => m.isOwner) ?? members.find((m) => m.kind === "human") ?? { name: "the owner", handle: "owner" }
  const fill = (text) =>
    text
      .replaceAll("{{owner}}", owner.name || "the owner")
      .replaceAll("{{ownerHandle}}", owner.handle)
      .replaceAll("{{agent}}", agent?.name ?? role)
      .replaceAll("{{agentHandle}}", agent?.handle ?? role)
  const rolePrompt = fill(await loadRolePrompt(role))
  const column = board.columns.find((c) => c.id === task.columnId)
  const lines = []

  lines.push(rolePrompt.trim())
  const instructions = (agent?.agent?.instructions ?? "").trim()
  if (instructions) {
    lines.push("")
    lines.push(`Additional instructions from ${owner.name || "the owner"} for you specifically:`)
    lines.push(instructions)
  }
  if (run.trigger === "dispatch") {
    lines.push("")
    lines.push(fill(await loadRolePrompt("dispatch")).trim())
  }
  lines.push("")
  lines.push("---")
  lines.push(`Board: ${board.name}`)
  lines.push(`Columns: ${board.columns.map((c) => `${c.title} [${c.role}]`).join(" → ")}`)
  lines.push(`Repository: ${board.repoPath ?? PROJECT_ROOT}`)
  lines.push("Participants:")
  for (const member of members) lines.push(memberLine(member))
  lines.push("")
  const ref = taskRef(board.key, task.number)
  lines.push(`Task ${cardName(ref, task.id)}: ${task.title}`)
  lines.push(`Column: ${column?.title ?? task.columnId}`)
  lines.push("Description:")
  lines.push(withImagePaths(task.description || "(empty)"))
  lines.push("")
  lines.push("Task chat so far:")
  lines.push(formatThread(thread, members))
  lines.push("")

  if (run.trigger === "dispatch" && queue) {
    // A blocker may sit in either list (or be archived by now) — fall back to the raw id.
    const refs = new Map([...queue.ready, ...queue.inProgress].map((card) => [card.id, card.ref]))
    const refOf = (id) => cardName(refs.get(id) ?? null, id)
    const line = (card) => queueLine(card, refOf)
    lines.push("Ready — the queue, top first:")
    lines.push(queue.ready.length > 0 ? queue.ready.map(line).join("\n") : "(empty)")
    lines.push("")
    lines.push("In progress right now:")
    lines.push(queue.inProgress.length > 0 ? queue.inProgress.map(line).join("\n") : "(nothing)")
    lines.push("")
    lines.push(
      `Task ${cardName(ref, task.id)} above is the card that just entered Ready. Dispatch the whole Ready queue now: for every Ready card decide which coder takes it, put the cards in the order they should be done, and mark which cards must wait for which. Then write the reply for this card's chat.`
    )
  } else if (run.trigger.startsWith("check:")) {
    lines.push(
      "You moved this card to Review, but the board's check command failed — see the last system message in the chat for the command and its output. The card stayed in In progress. Fix the problem, run the check yourself, and move the card to Review again. If the failure is not caused by your change, say so and stop."
    )
  } else if (run.trigger.startsWith("continue:")) {
    lines.push(
      "Your previous run on this card ran out of turns before it could hand the card off, and everything it wrote is still in the working tree. Continue from there: read what is already changed (git status, git diff) before anything else, revert nothing, finish what is left and hand the card to Review. This is the one continuation the board gives — running out of turns again is a plain failure, so go straight for what is missing."
    )
  } else if (run.trigger.startsWith("owner:")) {
    lines.push(
      `${owner.name || "The owner"} wrote the last message in this chat without tagging anybody — on this board that means it is for you. Do what is asked for this card, or answer shortly. A direct request to move the card is yours to carry out, Done included.`
    )
  } else if (run.trigger.startsWith("mention:") && triggerMessage) {
    const byId = new Map(members.map((m) => [m.id, m]))
    const author = byId.get(triggerMessage.authorId)
    lines.push(`You were mentioned by @${author?.handle ?? triggerMessage.authorId}. Respond to that message.`)
  } else if (run.trigger === "column:in_progress") {
    if (role === "architect") {
      lines.push(
        `The task was moved to In progress and you are tagged on it. Do your part: make the task unambiguous — scope, files, acceptance criteria — and post it here. If implementation is needed, end by mentioning @coder with clear instructions; if the task is really a question for the owner, ask @${owner.handle} instead.`
      )
    } else {
      lines.push("The task was moved to In progress. Implement it now, as described above and in the chat.")
    }
  } else if (run.trigger === "review") {
    lines.push(
      "The Coder says the work is done and the card is waiting for your review in In progress — it stays there while you read it. Review the changes in the repository (git log / git diff, the files themselves) and give your verdict: send the card back to the Coder by mentioning it (the card does not move), or, when the work is good, end with `ACTIONS: {\"move\": \"review\"}` — Review is the owner's final look and nothing runs there."
    )
  } else {
    lines.push(`Trigger: ${run.trigger}`)
  }
  lines.push("")
  lines.push("Write your reply for the task chat now.")
  return lines.join("\n")
}

/**
 * The JSON object that starts at `start` in `text`, found by brace matching (strings and
 * their escapes are skipped). Returns null when the braces never balance.
 */
function jsonObjectAt(text, start) {
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === "\\") escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === "{") depth += 1
    else if (ch === "}") {
      depth -= 1
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

/**
 * The `{` that opens the ACTIONS object, starting at `from`. Everything models put between
 * the marker and its object is stepped over: the colon, markdown emphasis (`**ACTIONS:**`),
 * a quote or list marker, a line break, a ```json fence. Anything else means this `ACTIONS`
 * was prose, not a protocol line — then −1.
 */
function braceAfter(text, from, limit = 48) {
  const end = Math.min(text.length, from + limit)
  for (let i = from; i < end; i += 1) {
    if (text[i] === "{") return i
    if (" \t\r\n*_`:>#-".includes(text[i])) continue
    if (text.startsWith("json", i)) {
      i += 3
      continue
    }
    return -1
  }
  return -1
}

/** Byte offset of the start of every line, so a match index can be turned back into a line. */
function lineOffsets(lines) {
  const offsets = []
  let at = 0
  for (const line of lines) {
    offsets.push(at)
    at += line.length + 1
  }
  return offsets
}

/**
 * Every place in the reply that may hold an ACTIONS payload, **last first** — the last one
 * the model wrote is the real decision, anything earlier is the format being quoted back.
 *
 * Each candidate is `{ json, cut }`, `cut` being the line its payload starts on (the text
 * above it is the chat reply). The caller parses them in order and keeps the first that
 * yields an action, so a stray `{…}` in prose costs nothing.
 */
function findPayloads(text, lines) {
  const offsets = lineOffsets(lines)
  const lineOf = (index) => {
    let line = 0
    while (line + 1 < offsets.length && offsets[line + 1] <= index) line += 1
    return line
  }
  const candidates = []
  const marker = /ACTIONS/g
  for (let match = marker.exec(text); match; match = marker.exec(text)) {
    const brace = braceAfter(text, match.index + match[0].length)
    if (brace < 0) continue
    // A null `json` is a candidate too: "the braces never close" is a reason worth logging.
    candidates.push({ json: jsonObjectAt(text, brace), cut: lineOf(match.index) })
  }
  candidates.reverse()

  // No marker at all (or none with an object): a bare JSON object as the last thing in the
  // reply — a fenced block, or pretty-printed under a dropped "ACTIONS:" — still counts.
  // Only when it ends the reply; JSON in the middle of one is the model explaining itself.
  let seen = 0
  for (let i = lines.length - 1; i >= 0 && seen < 20; i -= 1) {
    const line = lines[i].trim()
    if (!line) continue
    seen += 1
    if (!line.startsWith("{")) continue
    const brace = offsets[i] + lines[i].indexOf("{")
    const json = jsonObjectAt(text, brace)
    // Nothing but blank lines and a closing fence may follow it. A `{` that is only the
    // inside of a pretty-printed object fails that and the scan keeps looking above it.
    if (!json || !/^[\s`]*$/.test(text.slice(brace + json.length))) continue
    // `bare`: nobody wrote ACTIONS here, so this is a guess — the caller trusts it only for
    // a dispatch decision, and never reports it as a broken actions line (it may well be
    // plain JSON the agent wanted to show).
    candidates.push({ json, cut: i, bare: true })
    break
  }
  return candidates
}

/**
 * The reply's `In short: …` line, in plain words and without the marker — or null when the agent
 * wrote none. The last such line wins: an agent that quotes the rule before following it ends
 * with the real one.
 *
 * Nothing else of the reply is ever read for it. That is the whole point of the line: the owner
 * is told what happened in a sentence the agent wrote for them, instead of the board guessing a
 * summary out of a chat message that may hold paths, a diff or a log tail.
 */
export function plainLine(text) {
  let found = null
  for (const line of String(text ?? "").split("\n")) {
    const match = line.match(PLAIN_MARKER)
    if (match) found = match[1]
  }
  if (!found) return null
  // Markdown decoration and code ticks are noise in a notification; whitespace becomes one space.
  const plain = found
    .replace(/[`*_]/g, "")
    .replace(/\s+/g, " ")
    .trim()
  if (!plain) return null
  return plain.length > PLAIN_MAX ? `${plain.slice(0, PLAIN_MAX - 1)}…` : plain
}

/** `“…”` for quotes and a trailing comma: prose punctuation in JSON. A retry, never the first try. */
function repairJson(json) {
  return json.replace(/[“”„‟]/g, '"').replace(/,(\s*[}\]])/g, "$1")
}

/** `{ value }` or `{ error }` — the message says what JSON.parse choked on. */
function parseJson(json) {
  try {
    return { value: JSON.parse(json) }
  } catch (error) {
    const repaired = repairJson(json)
    if (repaired !== json) {
      try {
        return { value: JSON.parse(repaired) }
      } catch {
        // fall through with the original error — it describes the model's own text
      }
    }
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * The `create` key: follow-up cards the agent wants. Anything without a title is dropped,
 * the rest is trimmed to the fields the board accepts.
 *
 * `column` and `parallel` are about the batch, not one card, and are read from the ACTIONS
 * object — but a model that puts them on a card means the same thing, so those count too.
 * The board has the last word on both (Ready is the Architect's only).
 */
function parseCreate(parsed) {
  const value = parsed.create
  if (!Array.isArray(value)) return null
  const cards = []
  let column = typeof parsed.column === "string" ? parsed.column.trim().toLowerCase() : ""
  let parallel = parsed.parallel === true
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue
    const title = typeof entry.title === "string" ? entry.title.trim() : ""
    if (!title) continue
    const card = { title }
    const description = typeof entry.description === "string" ? entry.description.trim() : ""
    if (description) card.description = description
    const assignee = typeof entry.assignee === "string" ? entry.assignee.trim().replace(/^@/, "") : ""
    if (assignee) card.assignee = assignee
    if (!column && typeof entry.column === "string") column = entry.column.trim().toLowerCase()
    if (entry.parallel === true) parallel = true
    cards.push(card)
    if (cards.length === CREATE_LIMIT) break
  }
  if (cards.length === 0) return null
  return { cards, ...(column ? { column } : {}), ...(parallel ? { parallel: true } : {}) }
}

/**
 * The `needs` key: `{"needs": "owner", "reason": "paid_call", "text": "one line"}` — the card
 * stops until a human says go. The reason and the text may also sit inside `needs`, which is
 * the other shape a model reaches for; an unknown or missing reason becomes "question", because
 * losing the whole stop over its label would be worse than labelling it loosely.
 *
 * Returns `{ reason, text }`, or null when `needs` says something other than "owner".
 */
function parseNeeds(object) {
  const raw = object.needs
  const inner = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}
  if (typeof raw === "string" && raw.trim().toLowerCase() !== "owner") return null
  if (typeof raw !== "string" && !(raw === true || Object.keys(inner).length > 0)) return null
  const pickText = (...values) => {
    for (const value of values) {
      if (typeof value === "string" && value.trim()) return value.trim()
    }
    return ""
  }
  const wanted = pickText(inner.reason, object.reason).toLowerCase()
  return {
    reason: NEEDS_REASONS.has(wanted) ? wanted : "question",
    text: pickText(inner.text, object.text, inner.question, object.question, inner.why, object.why),
  }
}

/**
 * The `commit` key: the subject line the coder wants the board's commit to carry. Whitespace
 * (a stray newline included) collapses to single spaces; an empty or over-long subject is
 * refused rather than cut, because a subject cut mid-word is worse than the card's title.
 */
function parseCommit(value) {
  if (typeof value !== "string") return null
  const subject = value.replace(/\s+/g, " ").trim()
  if (!subject || subject.length > COMMIT_SUBJECT_MAX) return null
  return subject
}

/** The keys of a queue decision, with the names models reach for instead. */
const ASSIGN_KEYS = ["assign", "assignments", "assigned"]
const ORDER_KEYS = ["order", "sequence"]
const BLOCKED_KEYS = ["blocked_by", "blockedBy", "waits_for", "waitsFor"]
/** `ACTIONS: {"dispatch": {…}}` — one wrapper around the real payload is unwrapped. */
const WRAPPER_KEYS = ["dispatch", "decision", "queue", "payload"]

function pick(object, keys) {
  for (const key of keys) if (object[key] !== undefined) return object[key]
  return undefined
}

function hasAction(object) {
  if (object.move !== undefined || object.create !== undefined || object.needs !== undefined) return true
  return [...ASSIGN_KEYS, ...ORDER_KEYS, ...BLOCKED_KEYS].some((key) => object[key] !== undefined)
}

/** A card id as the board knows it. The prompt shows cards as `#t_x`, the board stores `t_x`. */
function cardId(value) {
  if (typeof value !== "string") return ""
  return value.trim().replace(/^#/, "")
}

/** A coder handle as the board knows it: no `@`, lower case (the board is case-insensitive too). */
function coderHandle(value) {
  if (typeof value !== "string") return ""
  return value.trim().replace(/^@/, "").toLowerCase()
}

/** `{"t_1": "coder"}`, or a list of `{"id": "t_1", "coder": "coder"}` — both mean the same. */
function parseAssign(value) {
  const assign = {}
  const add = (id, handle) => {
    const card = cardId(id)
    const who = coderHandle(handle)
    if (card && who) assign[card] = who
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (!entry || typeof entry !== "object") continue
      add(entry.id ?? entry.task ?? entry.taskId ?? entry.card ?? entry.cardId, entry.coder ?? entry.handle ?? entry.assignee ?? entry.agent ?? entry.to)
    }
  } else if (value && typeof value === "object") {
    for (const [id, handle] of Object.entries(value)) add(id, handle)
  }
  return assign
}

function parseOrder(value) {
  if (!Array.isArray(value)) return []
  return value
    .map((entry) => (entry && typeof entry === "object" ? cardId(entry.id ?? entry.task ?? entry.card) : cardId(entry)))
    .filter(Boolean)
}

function parseBlockedBy(value) {
  const blockedBy = {}
  const add = (id, ids) => {
    const card = cardId(id)
    const waits = (Array.isArray(ids) ? ids : [ids]).map(cardId).filter(Boolean)
    if (card && waits.length > 0) blockedBy[card] = waits
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (!entry || typeof entry !== "object") continue
      add(entry.id ?? entry.task ?? entry.card, pick(entry, BLOCKED_KEYS) ?? entry.waits ?? entry.after)
    }
  } else if (value && typeof value === "object") {
    for (const [id, ids] of Object.entries(value)) add(id, ids)
  }
  return blockedBy
}

/**
 * May this run put the card into Done? Closing a card is the owner's call: the Architect does
 * it only as the owner's hand, in the run its own untagged message started (`owner:<id>`).
 */
function mayClose(role, trigger) {
  return role !== "architect" || trigger.startsWith("owner:")
}

/**
 * One parsed ACTIONS object → what the board should do: `{ actions, decision, problem }`.
 * `problem` says in words what was wrong with it, so a miss can be logged instead of guessed at.
 */
function interpret(parsed, { role = "", trigger = "" } = {}) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { actions: [], decision: null, problem: "the ACTIONS payload is not a JSON object" }
  }
  let object = parsed
  if (!hasAction(object)) {
    for (const key of WRAPPER_KEYS) {
      const inner = object[key]
      if (inner && typeof inner === "object" && !Array.isArray(inner) && hasAction(inner)) {
        object = inner
        break
      }
    }
  }

  const actions = []
  const problems = []
  // Creating comes before moving: the follow-up cards belong to this card's thread.
  const create = parseCreate(object)
  if (create) actions.push({ type: "create", ...create })
  else if (object.create !== undefined) problems.push(`"create" held no card with a title`)

  // Before the move: the card stops where it is, and the worker drops the move when both are there.
  if (object.needs !== undefined) {
    const needs = parseNeeds(object)
    if (needs) actions.push({ type: "needs_owner", ...needs })
    else problems.push(`"needs": ${JSON.stringify(object.needs)} — the only thing a card can need is "owner"`)
  }

  const move = typeof object.move === "string" ? object.move.trim().toLowerCase() : ""
  if (move === "done" && !mayClose(role, trigger)) {
    problems.push(`"move": "done" — a card is closed by the owner, or by the Architect when the owner asks it to`)
  } else if (move && MOVE_TARGETS.has(move)) actions.push({ type: "move", to: move })
  else if (object.move !== undefined) {
    problems.push(`"move": ${JSON.stringify(object.move)} is not one of ${[...MOVE_TARGETS].join(", ")}`)
  }

  // Only the worker's commit step reads it; everything else skips an action it does not know.
  if (object.commit !== undefined) {
    const subject = parseCommit(object.commit)
    if (subject) actions.push({ type: "commit", subject })
    else problems.push(`"commit" must be one non-empty line of at most ${COMMIT_SUBJECT_MAX} characters — the card's title is used instead`)
  }

  let decision = null
  const assign = pick(object, ASSIGN_KEYS)
  const order = pick(object, ORDER_KEYS)
  const blocked = pick(object, BLOCKED_KEYS)
  if (assign !== undefined || order !== undefined || blocked !== undefined) {
    const candidate = { assign: parseAssign(assign), order: parseOrder(order), blockedBy: parseBlockedBy(blocked) }
    if (Object.keys(candidate.assign).length === 0 && candidate.order.length === 0 && Object.keys(candidate.blockedBy).length === 0) {
      problems.push(`"assign", "order" and "blocked_by" were all empty after parsing — card ids and coder handles are expected as strings`)
    } else decision = candidate
  }

  if (actions.length === 0 && !decision && problems.length === 0) {
    // `object`, not `parsed`: after unwrapping, the keys worth naming are the inner ones.
    problems.push(`nothing the board understands in the ACTIONS object (keys: ${Object.keys(object).join(", ") || "none"})`)
  }
  return { actions, decision, problem: problems.length > 0 ? problems.join("; ") : null }
}

/**
 * Split a model reply into the chat text, board actions and (for dispatch runs) the
 * queue decision. The protocol: an optional last line
 *   `ACTIONS: {"move": "review"}`
 *   `ACTIONS: {"move": "review", "commit": "Add …"}`
 *   `ACTIONS: {"needs": "owner", "reason": "paid_call", "text": "…"}`
 *   `ACTIONS: {"create": [{"title": "…", "description": "…", "assignee": "coder"}], "column": "ready"}`
 *   `ACTIONS: {"assign": {"t_1": "coder"}, "order": ["t_1", "t_2"], "blocked_by": {"t_2": ["t_1"]}}`
 * Blank lines, code fences, markdown around the marker and stray prose are tolerated.
 *
 * `problem` is set when a payload was there but gave the board nothing — the caller logs it;
 * it stays null when the reply simply has no ACTIONS line (most replies don't need one).
 *
 * `plain` is the reply's `In short:` line (`plainLine`) — the one sentence the owner's
 * notification carries, null when the agent wrote none.
 *
 * `trigger` is the run's trigger: it decides how much an unmarked JSON object at the end of
 * the reply is allowed to do (see below). `role` plus the trigger decide whether a `move` to
 * Done is the agent's to make (`mayClose`).
 */
export function parseReply(raw, { trigger = "", role = "" } = {}) {
  const text = (raw ?? "").trim()
  const lines = text.split("\n")
  let actions = []
  let decision = null
  let problem = null
  let cut = lines.length

  // Last payload first; the first one that gives the board something wins, so an ACTIONS
  // line quoted in the prose above the real one cannot shadow it.
  for (const candidate of findPayloads(text, lines)) {
    if (!candidate.json) {
      problem ??= "the ACTIONS object never closes — a `}` is missing"
      continue
    }
    const { value, error } = parseJson(candidate.json)
    if (error) {
      if (!candidate.bare) problem ??= `the ACTIONS payload is not valid JSON (${error})`
      continue
    }
    const read = interpret(value, { role, trigger })
    if (candidate.bare) {
      // Nobody wrote the marker here — this is a guess at a dropped `ACTIONS:`, so it may
      // only do the one thing that cannot be a quoted example: a queue decision on a
      // dispatch run. `move` and `create` need the literal marker, otherwise a reply that
      // merely shows `{"move": "review"}` in a fenced block would move the card.
      if (trigger !== "dispatch" || !read.decision) continue
      actions = []
      decision = read.decision
      cut = candidate.cut
      break
    }
    problem ??= read.problem
    if (read.actions.length === 0 && !read.decision) continue
    actions = read.actions
    decision = read.decision
    problem = read.problem
    cut = candidate.cut
    break
  }

  // Drop a code fence that only wrapped the ACTIONS line.
  let reply = lines.slice(0, cut).join("\n").trim()
  if (cut < lines.length && /^`{3,}\w*$/.test(reply.split("\n").pop() ?? "")) {
    reply = reply.split("\n").slice(0, -1).join("\n").trim()
  }
  return { reply, actions, decision, problem, plain: plainLine(reply) }
}

/** Sleep; rejects with "stopped" when `signal` (an AbortSignal) fires first. */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("stopped"))
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    function onAbort() {
      clearTimeout(timer)
      reject(new Error("stopped"))
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

export function firstName(member) {
  return (member?.name ?? "Agent").replace(/\s*\(.*\)\s*$/, "")
}
