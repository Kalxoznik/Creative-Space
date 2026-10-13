// The board's event feed — the stored half of src/server/events.ts.
//
// The in-process bus says "something on this board changed, refetch": it is not stored, it does
// not say what happened, and it is gone the moment a browser has it. A client that is not a
// browser — an architect reading the board from a chat with the owner, the notifications — needs
// the other half: one numbered line per thing that happened, so it can ask "what happened since
// N" and get an answer whether or not it was connected at the time.
//
// Rows are written next to the emitChange calls in store.ts, plus the two things only the worker
// knows (the check and the commit), which it reports through the API. Everything outside the
// server only reads: GET /api/events?board=<key|id>&since=<id>&limit=<n>.

import { getDb, nowIso } from "./db"
import { stripAnsi } from "@/lib/plain-text"
import { taskRef } from "@/lib/task-ref"
import type { BoardEvent, BoardEventType, EventFeed } from "@/lib/types"

/** A summary is a label, not a report: anything longer is a log tail that does not belong here. */
const SUMMARY_MAX = 200
/**
 * The agent's own line about what happened, in the owner's language (`In short: …`, parsed out of
 * the reply in `agents/lib.mjs`). It is the one thing in the feed that was written *for* the
 * owner, and the only part of an event a notification is allowed to quote — so it is kept apart
 * from `summary`, which is the board talking about itself and may carry a path or a CLI's words.
 */
const PLAIN_MAX = 300
/** Characters of the card's title a line carries — a notification is a glance, not a read. */
const TITLE_MAX = 60
const LIMIT_DEFAULT = 50
const LIMIT_MAX = 500

/**
 * One line of plain text. Escape sequences and newlines come in through whatever a CLI wrote
 * (a run's error, a check's output), and a client shows a summary as-is — so they are taken
 * out here, at the only place every event passes through.
 */
export function oneLine(text: string): string {
  const plain = stripAnsi(text).replace(/\s+/g, " ").trim()
  return plain.length > SUMMARY_MAX ? `${plain.slice(0, SUMMARY_MAX - 1)}…` : plain
}

/**
 * One line of plain words for the owner, or null: whitespace collapsed, cut to 300 characters.
 * Anything that is not a non-empty string is null — an event without such a line is the normal
 * case, and the notification then says what it always said.
 */
export function plainNote(value: unknown): string | null {
  if (typeof value !== "string") return null
  const plain = stripAnsi(value).replace(/\s+/g, " ").trim()
  if (!plain) return null
  return plain.length > PLAIN_MAX ? `${plain.slice(0, PLAIN_MAX - 1)}…` : plain
}

export type EventInput = {
  boardId: string
  /** The card it happened on; omit for something about the board itself. */
  taskId?: string | null
  type: BoardEventType
  /** Member id of whoever caused it. */
  actorId?: string | null
  summary: string
  /** The agent's `In short:` line, for the events the owner is notified about; see `plainNote`. */
  plain?: unknown
  data?: Record<string, unknown>
}

/**
 * Append a line to the board's feed.
 *
 * Never throws: the feed is a side channel, and a board write (a card moving, a run finishing)
 * must not fail because its event could not be stored. Called inside the caller's transaction
 * where there is one, so a rolled-back change leaves no line behind.
 */
export function recordEvent(event: EventInput): void {
  try {
    const plain = plainNote(event.plain)
    getDb()
      .prepare(
        "INSERT INTO events (at, board_id, task_id, type, actor_id, summary, data) VALUES (?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        nowIso(),
        event.boardId,
        event.taskId ?? null,
        event.type,
        event.actorId ?? null,
        oneLine(event.summary),
        // `plain` rides in `data`: the events table needs no column of its own for a field only
        // the notifications read, and an older board's rows simply have none.
        JSON.stringify({ ...(event.data ?? {}), ...(plain ? { plain } : {}) })
      )
  } catch (error) {
    console.error(`[feed] could not record ${event.type}: ${error instanceof Error ? error.message : error}`)
  }
}

type EventRow = {
  id: number
  at: string
  board_id: string
  task_id: string | null
  type: string
  actor_id: string | null
  summary: string
  data: string
  /** From the join: the card's number, and the board's key — together the `BI-12` a client shows. */
  number: number | null
  key: string | null
  /** From the join: the card's title as it is now, for a client that names the card. */
  title: string | null
}

/** The card's title in one short line — what a notification has room for. */
function shortTitle(title: string | null): string | null {
  if (title === null) return null
  const plain = title.replace(/\s+/g, " ").trim()
  if (!plain) return null
  return plain.length > TITLE_MAX ? `${plain.slice(0, TITLE_MAX - 1)}…` : plain
}

function parseData(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw)
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** A board by its id or by its key (`BI`) — the feed is asked for by whichever the client has. */
export function boardIdByRef(ref: string): string | null {
  const db = getDb()
  const value = ref.trim()
  if (!value) return null
  const byId = db.prepare("SELECT id FROM boards WHERE id = ?").get(value) as { id: string } | undefined
  if (byId) return byId.id
  const byKey = db
    .prepare(`SELECT id FROM boards WHERE UPPER("key") = ? ORDER BY position, rowid LIMIT 1`)
    .get(value.toUpperCase()) as { id: string } | undefined
  return byKey?.id ?? null
}

/**
 * The board's feed after event `since`, oldest first — `null` when the board ref matches nothing.
 * `cursor` is what the next call passes as `since`: the last id handed out, so a client that
 * keeps asking sees every line exactly once (and `since` back again when there was nothing new).
 */
export function listBoardEvents(
  boardRef: string,
  options: { since?: number; limit?: number } = {}
): EventFeed | null {
  const boardId = boardIdByRef(boardRef)
  if (!boardId) return null
  const db = getDb()
  const since = Number.isFinite(options.since) && (options.since as number) > 0 ? Math.floor(options.since as number) : 0
  const wanted = Number.isFinite(options.limit) ? Math.floor(options.limit as number) : LIMIT_DEFAULT
  const limit = Math.min(Math.max(wanted, 1), LIMIT_MAX)

  const rows = db
    .prepare(
      `SELECT e.*, t.number AS number, t.title AS title, b."key" AS key
       FROM events e
       LEFT JOIN tasks t ON t.id = e.task_id
       JOIN boards b ON b.id = e.board_id
       WHERE e.board_id = ? AND e.id > ?
       ORDER BY e.id
       LIMIT ?`
    )
    .all(boardId, since, limit) as EventRow[]
  const handleOf = new Map(
    (db.prepare("SELECT id, handle FROM members").all() as Array<{ id: string; handle: string }>).map((m) => [
      m.id,
      m.handle,
    ])
  )

  const events: BoardEvent[] = rows.map((row) => {
    const data = parseData(row.data)
    return {
      id: row.id,
      at: row.at,
      boardId: row.board_id,
      taskId: row.task_id,
      ref: taskRef(row.key, row.number),
      title: shortTitle(row.title),
      type: row.type as BoardEventType,
      actor: row.actor_id ? (handleOf.get(row.actor_id) ?? null) : null,
      summary: row.summary,
      plain: plainNote(data.plain),
      data,
    }
  })
  return { events, cursor: events.length > 0 ? events[events.length - 1].id : since }
}
