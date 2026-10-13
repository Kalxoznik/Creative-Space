import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { normalizeBoardKey, suggestBoardKey } from "./board-key"
import { getDb, newId, nowIso, transaction } from "./db"
import { emitChange } from "./events"
import { recordEvent } from "./feed"
import { WORK_COLUMNS } from "./seed"
import { getWorkerStatus } from "./worker-status"
import type {
  AgentConfig,
  AgentEffort,
  AgentEngine,
  AgentRole,
  AgentStatus,
  AvatarTone,
  Board,
  BoardState,
  BoardSummary,
  Column,
  ColumnRole,
  DispatchDecision,
  Member,
  Message,
  MessageKind,
  MessageSource,
  NeedsOwner,
  NeedsOwnerReason,
  QueueCard,
  Reaction,
  ReactionEffect,
  ReactionEmoji,
  ReactionResult,
  RepoCheck,
  Run,
  RunContext,
  RunStatus,
  Task,
  TaskThread,
} from "@/lib/types"
import {
  AGENT_EFFORTS,
  AGENT_ENGINES,
  AVATAR_TONES,
  COLUMN_ROLES,
  MESSAGE_SOURCES,
  NEEDS_OWNER_REASONS,
  REACTIONS,
} from "@/lib/types"
import { countImages } from "@/lib/attachments"
import { askedLine, shortLine, stripAnsi } from "@/lib/plain-text"
import { taskRef } from "@/lib/task-ref"

// All reads and writes go through here. Rules that make the board an agent
// tool (mention → run, column → run, agent chain guard) live here too, so the
// API routes stay thin.

/** The workspace owner: the human set up on first launch. Cached per process. */
let ownerIdCache: string | null = null
export function ownerId(): string {
  if (ownerIdCache) return ownerIdCache
  const row = getDb().prepare("SELECT id FROM members WHERE is_owner = 1 ORDER BY rowid LIMIT 1").get() as
    | { id: string }
    | undefined
  if (!row) throw new NotFoundError("Workspace has no owner")
  ownerIdCache = row.id
  return row.id
}

/**
 * The owner's handle in lower case — the `@max` an agent writes when it needs an answer. Not
 * cached: a handle is editable, and this is read once per chat message.
 */
function ownerHandle(): string {
  const row = getDb().prepare("SELECT handle FROM members WHERE id = ?").get(ownerId()) as
    | { handle: string }
    | undefined
  return (row?.handle ?? "").toLowerCase()
}

/**
 * Members every board keeps, in this order: the owner, then the architects. The owner
 * runs the workspace and an architect plans, dispatches and reviews everywhere — neither
 * can be taken off a board.
 */
function pinnedMemberIds(members: Member[]): string[] {
  const architects = members.filter((m) => !m.archived && m.agentRole === "architect" && m.id !== ownerId())
  return [ownerId(), ...architects.map((m) => m.id)]
}

/** Consecutive agent messages allowed before agents pause and wait for a human. */
const MAX_AGENT_CHAIN = 6

/**
 * How long a running run may say nothing before the board gives up on it: the worker's own run
 * timeout plus a margin for it to report the timeout itself. The same `CS_RUN_TIMEOUT_MS` the
 * worker reads, so `npm run up` keeps the two in step.
 */
const LOST_RUN_MS = Number(process.env.CS_RUN_TIMEOUT_MS ?? 20 * 60 * 1000) + 5 * 60 * 1000

/**
 * The Architect's review of a coder's hand-off. Review is the owner's column — the last look,
 * nothing runs there — so a coder that finishes leaves its card in In progress and this run
 * reviews it on the spot: a card is in Review only once the work on it is over. The trigger is
 * not a `column:` one for that reason, but it is cancelled with them when the card moves.
 */
const REVIEW_TRIGGER = "review"

// ---------------------------------------------------------------------------
// Row types and mappers

type MemberRow = {
  id: string
  name: string
  handle: string
  initials: string
  tone: string
  kind: string
  agent_role: string | null
  is_owner: number
  archived: number
  engine: string | null
  model: string | null
  effort: string | null
  max_turns: number | null
  description: string | null
  instructions: string | null
}

type BoardRow = {
  id: string
  name: string
  key: string | null
  task_seq: number
  icon: string
  kind: string
  repo_path: string | null
  position: number
  archived: number
  check_command: string | null
  architect_enabled: number
  notifications_enabled: number
  notifications_detailed: number
  one_card_at_a_time: number
}

type ColumnRow = {
  id: string
  board_id: string
  title: string
  role: string
  position: number
}

type TaskRow = {
  id: string
  board_id: string
  column_id: string
  position: number
  number: number | null
  title: string
  description: string
  attachments: number
  archived: number
  created_by: string | null
  parent_id: string | null
  needs_owner_reason: string | null
  needs_owner_text: string | null
  created_at: string
  updated_at: string
}

type MessageRow = {
  id: number
  task_id: string
  author_id: string
  kind: string
  source: string | null
  text: string
  created_at: string
}

type RunRow = {
  id: number
  task_id: string
  agent_id: string
  trigger: string
  status: string
  cancel_requested: number
  log: string
  summary: string | null
  created_at: string
  started_at: string | null
  heartbeat_at: string | null
  finished_at: string | null
}

function toMember(row: MemberRow): Member {
  return {
    id: row.id,
    name: row.name,
    handle: row.handle,
    initials: row.initials,
    tone: row.tone as Member["tone"],
    kind: row.kind as Member["kind"],
    agentRole: (row.agent_role as Member["agentRole"]) ?? null,
    isOwner: row.is_owner === 1,
    archived: row.archived === 1,
    agent:
      row.kind === "agent"
        ? {
            engine: AGENT_ENGINES.includes(row.engine as AgentEngine) ? (row.engine as AgentEngine) : "claude",
            model: row.model || null,
            effort: AGENT_EFFORTS.includes(row.effort as AgentEffort) ? (row.effort as AgentEffort) : null,
            maxTurns: row.max_turns ?? null,
            description: row.description ?? "",
            instructions: row.instructions ?? "",
          }
        : null,
  }
}

function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    taskId: row.task_id,
    authorId: row.author_id,
    kind: row.kind as MessageKind,
    source: MESSAGE_SOURCES.includes(row.source as MessageSource) ? (row.source as MessageSource) : null,
    text: row.text,
    createdAt: row.created_at,
  }
}

function toRun(row: RunRow): Run {
  return {
    id: row.id,
    taskId: row.task_id,
    agentId: row.agent_id,
    trigger: row.trigger,
    status: row.status as RunStatus,
    cancelRequested: row.cancel_requested === 1,
    log: row.log,
    summary: row.summary,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  }
}

function toTask(
  row: TaskRow,
  assigneeIds: string[],
  blockedBy: string[],
  commentCount: number,
  agentStatus: AgentStatus | null,
  /** Pasted images in the task chat; the description's own images are counted here. */
  chatImages: number
): Task {
  return {
    id: row.id,
    boardId: row.board_id,
    columnId: row.column_id,
    position: row.position,
    number: row.number ?? 0,
    title: row.title,
    description: row.description,
    attachments: countImages(row.description) + chatImages,
    archived: row.archived === 1,
    createdBy: row.created_by,
    parentId: row.parent_id,
    assigneeIds,
    blockedBy,
    commentCount,
    agentStatus,
    needsOwner: NEEDS_OWNER_REASONS.includes(row.needs_owner_reason as NeedsOwnerReason)
      ? { reason: row.needs_owner_reason as NeedsOwnerReason, text: row.needs_owner_text ?? "" }
      : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export class NotFoundError extends Error {}
export class ValidationError extends Error {}

// ---------------------------------------------------------------------------
// Reads

export function listMembers(): Member[] {
  const rows = getDb().prepare("SELECT * FROM members ORDER BY rowid").all() as MemberRow[]
  return rows.map(toMember)
}

/** The agents that exist right now — what the worker runs and what boards can pick. */
export function listAgents(): Member[] {
  const rows = getDb()
    .prepare("SELECT * FROM members WHERE kind = 'agent' AND archived = 0 ORDER BY rowid")
    .all() as MemberRow[]
  return rows.map(toMember)
}

function blockersByTask(): Map<string, string[]> {
  const rows = getDb()
    .prepare("SELECT task_id, blocked_by FROM task_blockers ORDER BY task_id, rowid")
    .all() as Array<{ task_id: string; blocked_by: string }>
  const map = new Map<string, string[]>()
  for (const row of rows) {
    const list = map.get(row.task_id) ?? []
    list.push(row.blocked_by)
    map.set(row.task_id, list)
  }
  return map
}

function blockersOf(taskId: string): string[] {
  return (
    getDb().prepare("SELECT blocked_by FROM task_blockers WHERE task_id = ? ORDER BY rowid").all(taskId) as Array<{
      blocked_by: string
    }>
  ).map((r) => r.blocked_by)
}

function assigneesByTask(): Map<string, string[]> {
  const rows = getDb()
    .prepare("SELECT task_id, member_id FROM task_assignees ORDER BY task_id, position")
    .all() as Array<{ task_id: string; member_id: string }>
  const map = new Map<string, string[]>()
  for (const row of rows) {
    const list = map.get(row.task_id) ?? []
    list.push(row.member_id)
    map.set(row.task_id, list)
  }
  return map
}

function commentCounts(): Map<string, number> {
  const rows = getDb()
    .prepare("SELECT task_id, COUNT(*) AS n FROM messages WHERE kind = 'chat' GROUP BY task_id")
    .all() as Array<{ task_id: string; n: number }>
  return new Map(rows.map((row) => [row.task_id, row.n]))
}

/** Pasted images per task chat — the other half of the card's paperclip counter. */
function chatImageCounts(): Map<string, number> {
  const rows = getDb()
    .prepare("SELECT task_id, text FROM messages WHERE kind = 'chat'")
    .all() as Array<{ task_id: string; text: string }>
  const map = new Map<string, number>()
  for (const row of rows) {
    const n = countImages(row.text)
    if (n > 0) map.set(row.task_id, (map.get(row.task_id) ?? 0) + n)
  }
  return map
}

function activeRunsByTask(): Map<string, AgentStatus> {
  const rows = getDb()
    .prepare(
      "SELECT id, task_id, agent_id, status, trigger FROM agent_runs WHERE status IN ('queued','running') ORDER BY CASE status WHEN 'running' THEN 0 ELSE 1 END, id"
    )
    .all() as Array<{ id: number; task_id: string; agent_id: string; status: string; trigger: string }>
  const map = new Map<string, AgentStatus>()
  for (const row of rows) {
    if (map.has(row.task_id)) continue
    map.set(row.task_id, {
      runId: row.id,
      agentId: row.agent_id,
      status: row.status as AgentStatus["status"],
      trigger: row.trigger,
    })
  }
  return map
}

export function getTask(taskId: string): Task {
  const row = getDb().prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as TaskRow | undefined
  if (!row) throw new NotFoundError(`Task ${taskId} not found`)
  const assignees = (
    getDb()
      .prepare("SELECT member_id FROM task_assignees WHERE task_id = ? ORDER BY position")
      .all(taskId) as Array<{ member_id: string }>
  ).map((r) => r.member_id)
  const count = getDb()
    .prepare("SELECT COUNT(*) AS n FROM messages WHERE task_id = ? AND kind = 'chat'")
    .get(taskId) as { n: number }
  const chatImages = (
    getDb().prepare("SELECT text FROM messages WHERE task_id = ? AND kind = 'chat'").all(taskId) as Array<{
      text: string
    }>
  ).reduce((sum, r) => sum + countImages(r.text), 0)
  const active = getDb()
    .prepare(
      "SELECT id, agent_id, status, trigger FROM agent_runs WHERE task_id = ? AND status IN ('queued','running') ORDER BY CASE status WHEN 'running' THEN 0 ELSE 1 END, id LIMIT 1"
    )
    .get(taskId) as { id: number; agent_id: string; status: string; trigger: string } | undefined
  return toTask(
    row,
    assignees,
    blockersOf(taskId),
    count.n,
    active
      ? {
          runId: active.id,
          agentId: active.agent_id,
          status: active.status as AgentStatus["status"],
          trigger: active.trigger,
        }
      : null,
    chatImages
  )
}

export function getState(): BoardState {
  const db = getDb()
  // The board is also read without a worker polling (the worker is what died, in the case this
  // guards against), so the UI's own read closes a lost run too.
  sweepLostRuns()
  const members = listMembers()
  const me = members.find((m) => m.isOwner) ?? members[0]
  const boardRows = db.prepare("SELECT * FROM boards ORDER BY position, rowid").all() as BoardRow[]
  const columnRows = db
    .prepare("SELECT * FROM columns ORDER BY board_id, position, rowid")
    .all() as ColumnRow[]
  const taskRows = db
    .prepare("SELECT * FROM tasks WHERE archived = 0 ORDER BY column_id, position, rowid")
    .all() as TaskRow[]
  const archivedCounts = new Map(
    (
      db.prepare("SELECT board_id, COUNT(*) AS n FROM tasks WHERE archived = 1 GROUP BY board_id").all() as Array<{
        board_id: string
        n: number
      }>
    ).map((r) => [r.board_id, r.n])
  )
  const boardMemberRows = db
    .prepare("SELECT board_id, member_id FROM board_members ORDER BY board_id, position")
    .all() as Array<{ board_id: string; member_id: string }>

  const assignees = assigneesByTask()
  const blockers = blockersByTask()
  const counts = commentCounts()
  const chatImages = chatImageCounts()
  const active = activeRunsByTask()

  const tasksByColumn = new Map<string, Task[]>()
  for (const row of taskRows) {
    const list = tasksByColumn.get(row.column_id) ?? []
    list.push(
      toTask(
        row,
        assignees.get(row.id) ?? [],
        blockers.get(row.id) ?? [],
        counts.get(row.id) ?? 0,
        active.get(row.id) ?? null,
        chatImages.get(row.id) ?? 0
      )
    )
    tasksByColumn.set(row.column_id, list)
  }

  const columnsByBoard = new Map<string, Column[]>()
  for (const row of columnRows) {
    const list = columnsByBoard.get(row.board_id) ?? []
    list.push({
      id: row.id,
      boardId: row.board_id,
      title: row.title,
      role: row.role as ColumnRole,
      position: row.position,
      tasks: tasksByColumn.get(row.id) ?? [],
    })
    columnsByBoard.set(row.board_id, list)
  }

  const membersByBoard = new Map<string, string[]>()
  for (const row of boardMemberRows) {
    const list = membersByBoard.get(row.board_id) ?? []
    list.push(row.member_id)
    membersByBoard.set(row.board_id, list)
  }

  const boards: Board[] = boardRows.map((row) => ({
    id: row.id,
    name: row.name,
    key: row.key ?? "",
    icon: row.icon,
    kind: row.kind as Board["kind"],
    repoPath: row.repo_path,
    archived: row.archived === 1,
    checkCommand: row.check_command || null,
    architectEnabled: row.architect_enabled !== 0,
    notificationsEnabled: row.notifications_enabled !== 0,
    notificationsDetailed: row.notifications_detailed !== 0,
    oneCardAtATime: row.one_card_at_a_time !== 0,
    memberIds: membersByBoard.get(row.id) ?? [],
    columns: columnsByBoard.get(row.id) ?? [],
    archivedCount: archivedCounts.get(row.id) ?? 0,
  }))

  return { me, members, boards, worker: getWorkerStatus() }
}

export function listMessages(taskId: string): Message[] {
  const rows = getDb()
    .prepare("SELECT * FROM messages WHERE task_id = ? ORDER BY id")
    .all(taskId) as MessageRow[]
  return rows.map(toMessage)
}

export function listRuns(taskId: string): Run[] {
  const rows = getDb()
    .prepare("SELECT * FROM agent_runs WHERE task_id = ? ORDER BY id DESC")
    .all(taskId) as RunRow[]
  return rows.map(toRun)
}

/** Every reaction on a card's messages, oldest first. Goes out with the messages themselves. */
export function listReactions(taskId: string): Reaction[] {
  const rows = getDb()
    .prepare(
      `SELECT r.message_id AS messageId, r.member_id AS memberId, r.emoji AS emoji, r.created_at AS createdAt
       FROM message_reactions r JOIN messages m ON m.id = r.message_id
       WHERE m.task_id = ? ORDER BY r.created_at, r.message_id`
    )
    .all(taskId) as Array<{ messageId: number; memberId: string; emoji: string; createdAt: string }>
  return rows
    .filter((row) => REACTIONS.includes(row.emoji as ReactionEmoji))
    .map((row) => ({ ...row, taskId, emoji: row.emoji as ReactionEmoji }))
}

export function getThread(taskId: string): TaskThread {
  return {
    task: getTask(taskId),
    messages: listMessages(taskId),
    runs: listRuns(taskId),
    reactions: listReactions(taskId),
  }
}

export function getRun(runId: number): Run {
  const row = getDb().prepare("SELECT * FROM agent_runs WHERE id = ?").get(runId) as RunRow | undefined
  if (!row) throw new NotFoundError(`Run ${runId} not found`)
  return toRun(row)
}

// ---------------------------------------------------------------------------
// Helpers

function boardOfTask(taskId: string): string {
  const row = getDb().prepare("SELECT board_id FROM tasks WHERE id = ?").get(taskId) as
    | { board_id: string }
    | undefined
  if (!row) throw new NotFoundError(`Task ${taskId} not found`)
  return row.board_id
}

function columnRole(columnId: string): ColumnRole {
  const row = getDb().prepare("SELECT role FROM columns WHERE id = ?").get(columnId) as
    | { role: string }
    | undefined
  if (!row) throw new NotFoundError(`Column ${columnId} not found`)
  return row.role as ColumnRole
}

function columnByRole(boardId: string, role: ColumnRole): string | null {
  const row = getDb()
    .prepare("SELECT id FROM columns WHERE board_id = ? AND role = ? ORDER BY position LIMIT 1")
    .get(boardId, role) as { id: string } | undefined
  return row?.id ?? null
}

/**
 * Is the board's own architect switched on? Off means somebody plans and reviews this board
 * from the outside (a chat with the owner), so the board's architect agent must not run here.
 */
function architectEnabled(boardId: string): boolean {
  const row = getDb().prepare("SELECT architect_enabled AS enabled FROM boards WHERE id = ?").get(boardId) as
    | { enabled: number }
    | undefined
  return !row || row.enabled !== 0
}

/**
 * The live agents on a board, in board order — the first coder is the board's default coder.
 *
 * With the architect switched off the architects drop out of this list, and that one omission
 * is the whole feature: no dispatch on Ready (`triggerColumnRuns`), no reviewer to hand a
 * finished card to (`updateTask` — the card goes to Review itself), untagged Ready cards taken
 * by the default coder instead of waiting for a dispatch (`pullNextForCoders`), and an
 * `@architect` mention that matches nobody (`triggerMentions`). The architect stays a *member*
 * of the board: its old messages keep their author and it is still on the card.
 */
function boardAgents(boardId: string): Member[] {
  const rows = getDb()
    .prepare(
      "SELECT m.* FROM members m JOIN board_members bm ON bm.member_id = m.id WHERE bm.board_id = ? AND m.kind = 'agent' AND m.archived = 0 ORDER BY bm.position"
    )
    .all(boardId) as MemberRow[]
  const agents = rows.map(toMember)
  return architectEnabled(boardId) ? agents : agents.filter((a) => a.agentRole !== "architect")
}

/** Boards that work in the same folder share one checkout — and therefore one coder at a time. */
function repoKey(repoPath: string | null): string {
  const text = (repoPath ?? "").trim()
  if (!text) return path.resolve(process.cwd())
  const expanded = text.startsWith("~") ? path.join(process.env.HOME ?? "", text.slice(1)) : text
  return path.resolve(expanded)
}

function sameRepoBoardIds(boardId: string): string[] {
  const rows = getDb().prepare("SELECT id, repo_path FROM boards").all() as Array<{ id: string; repo_path: string | null }>
  const me = rows.find((r) => r.id === boardId)
  if (!me) return [boardId]
  const key = repoKey(me.repo_path)
  return rows.filter((r) => repoKey(r.repo_path) === key).map((r) => r.id)
}

/**
 * A card waits while any of its blockers is still open (not in Review / Done, not archived).
 * A blocker whose coder is done and whose review is with the Architect counts as closed: the
 * work the dependent card waits for is written, it just has not been accepted yet.
 */
function isBlocked(taskId: string): boolean {
  const rows = getDb()
    .prepare(
      "SELECT t.id, t.archived, c.role FROM task_blockers b JOIN tasks t ON t.id = b.blocked_by JOIN columns c ON c.id = t.column_id WHERE b.task_id = ?"
    )
    .all(taskId) as Array<{ id: string; archived: number; role: string }>
  return rows.some(
    (r) => r.archived === 0 && r.role !== "review" && r.role !== "done" && !awaitingReview(r.id)
  )
}

/** Replace a card's blockers. Only cards on the same board; no self; edges that would close a cycle are dropped. */
function setBlockers(taskId: string, boardId: string, blockerIds: string[]): string[] {
  const db = getDb()
  const onBoard = new Set(
    (db.prepare("SELECT id FROM tasks WHERE board_id = ?").all(boardId) as Array<{ id: string }>).map((r) => r.id)
  )
  const edges = new Map<string, string[]>()
  for (const row of db
    .prepare("SELECT b.task_id, b.blocked_by FROM task_blockers b JOIN tasks t ON t.id = b.task_id WHERE t.board_id = ? AND b.task_id != ?")
    .all(boardId, taskId) as Array<{ task_id: string; blocked_by: string }>) {
    edges.set(row.task_id, [...(edges.get(row.task_id) ?? []), row.blocked_by])
  }
  const reaches = (from: string, target: string, seen = new Set<string>()): boolean => {
    if (from === target) return true
    if (seen.has(from)) return false
    seen.add(from)
    return (edges.get(from) ?? []).some((next) => reaches(next, target, seen))
  }
  const accepted: string[] = []
  for (const id of blockerIds) {
    if (id === taskId || !onBoard.has(id) || accepted.includes(id)) continue
    // taskId waits for id; if id (transitively) waits for taskId, that is a cycle.
    if (reaches(id, taskId)) continue
    accepted.push(id)
  }
  db.prepare("DELETE FROM task_blockers WHERE task_id = ?").run(taskId)
  const insert = db.prepare("INSERT INTO task_blockers (task_id, blocked_by) VALUES (?, ?)")
  for (const id of accepted) insert.run(taskId, id)
  return accepted
}

function renumber(columnId: string): void {
  const db = getDb()
  const rows = db
    .prepare("SELECT id FROM tasks WHERE column_id = ? AND archived = 0 ORDER BY position, updated_at")
    .all(columnId) as Array<{ id: string }>
  const update = db.prepare("UPDATE tasks SET position = ? WHERE id = ?")
  rows.forEach((row, index) => update.run(index, row.id))
}

function cleanText(value: unknown, field: string, { required = false, max = 4000 } = {}): string {
  const text = typeof value === "string" ? value.trim() : ""
  if (required && !text) throw new ValidationError(`${field} is required`)
  if (text.length > max) throw new ValidationError(`${field} is too long`)
  return text
}

function setAssignees(taskId: string, memberIds: string[]): void {
  const db = getDb()
  db.prepare("DELETE FROM task_assignees WHERE task_id = ?").run(taskId)
  const insert = db.prepare(
    "INSERT OR IGNORE INTO task_assignees (task_id, member_id, position) VALUES (?, ?, ?)"
  )
  memberIds.forEach((memberId, index) => insert.run(taskId, memberId, index))
}

// ---------------------------------------------------------------------------
// The event feed
//
// The stored feed (src/server/feed.ts) is written here, next to the emitChange it belongs to:
// the bus tells a browser to refetch, the feed answers "what happened since N" for a client
// that was not watching. A line written inside a transaction goes away with it if it rolls back.

/** How much of a card's title a feed line carries — enough to recognise the card. */
const FEED_TITLE_MAX = 60

/** `BI-12 “Title”` — how a card is named in a feed line; a board with no key gets the title alone. */
function cardLabel(taskId: string): string {
  const row = getDb()
    .prepare(
      `SELECT t.title AS title, t.number AS number, b."key" AS key FROM tasks t JOIN boards b ON b.id = t.board_id WHERE t.id = ?`
    )
    .get(taskId) as { title: string; number: number | null; key: string | null } | undefined
  if (!row) return taskId
  const title =
    row.title.length > FEED_TITLE_MAX ? `${row.title.slice(0, FEED_TITLE_MAX - 1)}…` : row.title
  const ref = taskRef(row.key, row.number)
  return ref ? `${ref} “${title}”` : `“${title}”`
}

/**
 * A card changed column. `actor` is null when a person dragged it — nobody signs that.
 *
 * `plain` is the moving agent's own line about what it did (`In short: …`), which is what the
 * owner's notification about a card reaching Review says; a person dragging a card writes none.
 */
function recordMove(
  boardId: string,
  taskId: string,
  from: ColumnRole,
  to: ColumnRole,
  actor: { id: string; name: string } | null,
  plain?: unknown
): void {
  if (from === to) return
  recordEvent({
    boardId,
    taskId,
    type: "card_moved",
    actorId: actor?.id ?? null,
    summary: `${actor ? `${actor.name} moved` : "Moved"} ${cardLabel(taskId)}: ${from} → ${to}`,
    plain,
    data: { from, to },
  })
}

/** The first line of what a CLI wrote, escape sequences out: a failure in one phrase. */
function firstLine(text: string | null | undefined): string {
  const lines = stripAnsi(text ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
  return lines[0] ?? ""
}

function insertSystemMessage(taskId: string, text: string): void {
  getDb()
    .prepare("INSERT INTO messages (task_id, author_id, kind, text, created_at) VALUES (?, ?, 'system', ?, ?)")
    .run(taskId, ownerId(), text, nowIso())
}

/**
 * What to do when the agent already has a run on this card — an agent reads the whole card
 * and the whole thread at the start of a run, so a second run on the same card is usually
 * the same work done twice (a dispatch note tagging the coder used to stack one behind the
 * column run that was already going).
 *
 * - `skip` — the run it already has, queued or in flight, covers this too. The default.
 * - `follow` — a human asked for something while the agent was busy: queue one run behind
 *   the one in flight (that one will never see the message), but still fold into a queued
 *   run, which has not read anything yet.
 * - `always` — the board needs this exact run: a hand-off review (`awaitingReview` reads the
 *   card's last run) and the one automatic check retry, which is queued while the coder's
 *   own run is still finishing.
 */
type WhenBusy = "skip" | "follow" | "always"

/** Is this card stopped on the owner's word? See `setNeedsOwner`. */
function needsOwner(taskId: string): boolean {
  const row = getDb().prepare("SELECT needs_owner_reason AS reason FROM tasks WHERE id = ?").get(taskId) as
    | { reason: string | null }
    | undefined
  return !!row?.reason
}

function enqueueRun(
  taskId: string,
  agentId: string,
  trigger: string,
  busy: WhenBusy = "skip"
): number | null {
  const db = getDb()
  // Waiting for the owner means waiting: nothing an agent does — a column move, another
  // agent's mention, the one check retry, a review — queues a run here. A human writing in
  // the chat clears the flag first (`addMessage`), so their mention goes through as usual.
  if (needsOwner(taskId)) return null
  const waiting = (
    busy === "always"
      ? db
          .prepare(
            "SELECT id FROM agent_runs WHERE task_id = ? AND agent_id = ? AND trigger = ? AND status = 'queued' ORDER BY id LIMIT 1"
          )
          .get(taskId, agentId, trigger)
      : db
          .prepare(
            "SELECT id FROM agent_runs WHERE task_id = ? AND agent_id = ? AND status = 'queued' ORDER BY id LIMIT 1"
          )
          .get(taskId, agentId)
  ) as { id: number } | undefined
  if (waiting) return waiting.id
  if (busy === "skip") {
    const running = db
      .prepare("SELECT id FROM agent_runs WHERE task_id = ? AND agent_id = ? AND status = 'running' LIMIT 1")
      .get(taskId, agentId)
    if (running) return null
  }
  const result = db
    .prepare(
      "INSERT INTO agent_runs (task_id, agent_id, trigger, status, created_at) VALUES (?, ?, ?, 'queued', ?)"
    )
    .run(taskId, agentId, trigger, nowIso())
  return Number(result.lastInsertRowid)
}

/**
 * Runs a card's position asked for, cancelled because it moved again before they started:
 * the column triggers and the Architect's review of a hand-off (`REVIEW_TRIGGER`), which is
 * about the card sitting in In progress, finished.
 */
function cancelQueuedColumnRuns(taskId: string): void {
  getDb()
    .prepare(
      `UPDATE agent_runs SET status = 'cancelled', finished_at = ? WHERE task_id = ? AND status = 'queued' AND (trigger LIKE 'column:%' OR trigger = '${REVIEW_TRIGGER}')`
    )
    .run(nowIso(), taskId)
}

/**
 * The architect was switched off on this board: the runs it had waiting here are nobody's job
 * any more. A queued dispatch simply goes; a queued hand-off review would leave its card stuck
 * in In progress (nothing moves it on, and `awaitingReview` stops holding for its coder), so
 * that card goes to Review — which is where the coder was sending it when it finished.
 */
function cancelArchitectRuns(boardId: string): void {
  const db = getDb()
  const waiting = db
    .prepare(
      `SELECT r.id, r.task_id, r.trigger FROM agent_runs r
       JOIN tasks t ON t.id = r.task_id
       JOIN members m ON m.id = r.agent_id
       WHERE t.board_id = ? AND r.status = 'queued' AND m.agent_role = 'architect' ORDER BY r.id`
    )
    .all(boardId) as Array<{ id: number; task_id: string; trigger: string }>
  if (waiting.length === 0) return
  const review = columnByRole(boardId, "review")
  transaction(db, () => {
    for (const run of waiting) {
      db.prepare("UPDATE agent_runs SET status = 'cancelled', finished_at = ? WHERE id = ?").run(nowIso(), run.id)
      if (run.trigger !== REVIEW_TRIGGER || !review) continue
      const from = (db.prepare("SELECT column_id FROM tasks WHERE id = ?").get(run.task_id) as { column_id: string })
        .column_id
      if (from === review) continue
      placeTask(run.task_id, review, null)
      renumber(from)
      clearWorkSnapshot(run.task_id)
      insertSystemMessage(run.task_id, "The architect is off on this board — the finished card goes to Review.")
      recordMove(boardId, run.task_id, columnRole(from), "review", null)
    }
  })
}

/**
 * A card entered Ready → the Architect sorts the board's queue. One dispatch waits per
 * board at most: a queued one will see this card too. (A running one may miss it, so a
 * second is allowed to queue behind it.) Returns whether a run was queued.
 */
function enqueueDispatch(taskId: string, boardId: string, architect: Member): boolean {
  const waiting = getDb()
    .prepare(
      "SELECT r.id FROM agent_runs r JOIN tasks t ON t.id = r.task_id WHERE t.board_id = ? AND r.trigger = 'dispatch' AND r.status = 'queued' LIMIT 1"
    )
    .get(boardId)
  if (waiting) return false
  enqueueRun(taskId, architect.id, "dispatch")
  return true
}

/**
 * One card at a time (`Board.oneCardAtATime`): while any card is in In progress or Review the
 * queue stands still — no coder takes a Ready card and no dispatch is queued for one. A card in
 * Review holds it too, so the owner sees one card in work and the next starts after Done.
 */
function queueHeld(boardId: string): boolean {
  const db = getDb()
  const board = db.prepare("SELECT one_card_at_a_time AS on_ FROM boards WHERE id = ?").get(boardId) as
    | { on_: number }
    | undefined
  if (!board || board.on_ === 0) return false
  return !!db
    .prepare(
      "SELECT 1 FROM tasks t JOIN columns c ON c.id = t.column_id WHERE t.board_id = ? AND t.archived = 0 AND c.role IN ('in_progress', 'review') LIMIT 1"
    )
    .get(boardId)
}

/** Why a held queue came free when this card moved — the first line of the next card's chat. */
function freedReason(taskId: string): string {
  const row = getDb()
    .prepare("SELECT t.archived AS archived, c.role AS role, c.title AS title FROM tasks t JOIN columns c ON c.id = t.column_id WHERE t.id = ?")
    .get(taskId) as { archived: number; role: string; title: string } | undefined
  if (!row) return "The previous card is gone"
  if (row.archived) return "The previous card was archived"
  if (row.role === "done") return "Previous card is done"
  return `The previous card went to ${row.title}`
}

/**
 * The queue just came free and nothing in Ready could be pulled straight away: the cards that
 * entered Ready while it was held got no dispatch then, so the Architect sorts them now. Only
 * when there is a card that waits for exactly that — unblocked, and no coder's yet.
 */
function dispatchWaitingReady(boardId: string, reason: string): void {
  if (queueHeld(boardId)) return
  const architect = boardAgents(boardId).find((a) => a.agentRole === "architect")
  const views = coderViews(boardId)
  const ready = columnByRole(boardId, "ready")
  if (!architect || views.length === 0 || !ready) return
  const cards = getDb()
    .prepare("SELECT id FROM tasks WHERE column_id = ? AND archived = 0 ORDER BY position, updated_at")
    .all(ready) as Array<{ id: string }>
  const next = cards.find(
    (t) => !isBlocked(t.id) && !needsOwner(t.id) && !views.some((view) => cardIsFor(t.id, view, { pulling: true }))
  )
  if (next && enqueueDispatch(next.id, boardId, architect)) {
    insertSystemMessage(next.id, `${reason} — ${architect.name} sorts the queue.`)
  }
}

// ---------------------------------------------------------------------------
// Writes: boards and tasks

/** Title + description of the card that gets a fresh project described for the agents. */
const STARTER_CARD = {
  title: "Write CLAUDE.md for this project",
  description:
    "Describe this project for the agents that will work in it: what it is, the stack, the folder structure, how to run it, how to type-check / lint / test, and any conventions you can see in the code. Write it to CLAUDE.md in the repository root (and copy it to AGENTS.md so Codex reads it too). Keep it short and factual — a page at most. Commit it.",
}

/** The same card for a folder the board just created: the files are already there, empty. */
const STARTER_CARD_CREATED = {
  title: "Fill in CLAUDE.md for this project",
  description:
    "CLAUDE.md and AGENTS.md are already in the repository root with empty sections. Fill them in from what is actually in the folder: what this project is, the stack, how to run it, how to type-check / lint / test, and any conventions you can see in the code. Keep both files identical (Codex reads AGENTS.md) and short — a page at most. Commit them.",
}

/**
 * Keys in use, including the archived boards': their cards are still referred to by
 * number in old chats, so handing the same prefix to a new board would make `BI-12`
 * mean two different cards.
 */
function boardKeysInUse(exceptBoardId?: string): string[] {
  const rows = getDb()
    .prepare(`SELECT id, "key" AS key FROM boards WHERE "key" IS NOT NULL`)
    .all() as Array<{ id: string; key: string }>
  return rows.filter((row) => row.id !== exceptBoardId).map((row) => row.key)
}

/** The key a new board gets from its name — generated, and editable later in the settings. */
function freeBoardKey(name: string): string {
  return suggestBoardKey(name, boardKeysInUse())
}

function boardKeyOf(boardId: string): string {
  const row = getDb().prepare(`SELECT "key" AS key FROM boards WHERE id = ?`).get(boardId) as
    | { key: string | null }
    | undefined
  return row?.key ?? ""
}

/**
 * The boards and how they are set up, without their cards — GET /api/boards.
 *
 * `getState()` is the browser's read: every column, every card, every member of every board.
 * A client that only needs to know which boards exist (the notifier, deciding whose feed to
 * read) would pull all of that every few seconds for two flags.
 */
export function listBoardSummaries(): BoardSummary[] {
  return (
    getDb()
      .prepare(
        `SELECT id, name, "key", archived, architect_enabled, notifications_enabled, notifications_detailed FROM boards ORDER BY position, rowid`
      )
      .all() as Array<
      Pick<
        BoardRow,
        | "id"
        | "name"
        | "key"
        | "archived"
        | "architect_enabled"
        | "notifications_enabled"
        | "notifications_detailed"
      >
    >
  ).map((row) => ({
    id: row.id,
    name: row.name,
    key: row.key ?? "",
    archived: row.archived === 1,
    architectEnabled: row.architect_enabled !== 0,
    notificationsEnabled: row.notifications_enabled !== 0,
    notificationsDetailed: row.notifications_detailed !== 0,
  }))
}

export function createBoard(input: {
  name: unknown
  repoPath?: unknown
  /** No folder given: make one under the workspace root and git init it. */
  createRepo?: unknown
  memberIds?: unknown
  checkCommand?: unknown
  starterCard?: unknown
  /** false = a board planned and reviewed from the outside; see `Board.architectEnabled`. */
  architectEnabled?: unknown
  /** false = the owner is not told what happens here; see `Board.notificationsEnabled`. */
  notificationsEnabled?: unknown
  /** false = notifications from here carry no agent text; see `Board.notificationsDetailed`. */
  notificationsDetailed?: unknown
  /** false = Ready does not wait for the card in Review; see `Board.oneCardAtATime`. */
  oneCardAtATime?: unknown
}): Board {
  const db = getDb()
  const name = cleanText(input.name, "name", { required: true, max: 80 })
  const createRepo = input.createRepo === true
  const repoPath = createRepo ? plannedRepoPath(name) : cleanText(input.repoPath, "repoPath", { max: 500 }) || null
  const checkCommand = cleanText(input.checkCommand, "checkCommand", { max: 500 }) || null
  const members = listMembers().filter((m) => !m.archived)
  const known = new Set(members.map((m) => m.id))
  // Members: the owner and the architects always; the other agents as chosen (every one by default).
  const wanted = Array.isArray(input.memberIds)
    ? input.memberIds.filter((v): v is string => typeof v === "string" && known.has(v))
    : members.filter((m) => m.kind === "agent").map((m) => m.id)
  const pinned = pinnedMemberIds(members)
  const memberIds = [...pinned, ...wanted.filter((id) => !pinned.includes(id))]
  const firstCoder = memberIds.find((id) => members.find((m) => m.id === id)?.agentRole === "coder") ?? null
  const id = newId("b")
  // Folder first: if it cannot be made, no board is created at all.
  if (createRepo && repoPath) createProjectFolder(repoPath, name)
  transaction(db, () => {
    const pos = db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM boards").get() as { p: number }
    db.prepare(
      `INSERT INTO boards (id, name, "key", icon, kind, repo_path, position, check_command, architect_enabled, notifications_enabled, notifications_detailed, one_card_at_a_time) VALUES (?, ?, ?, '/icons/layout-grid.svg', 'work', ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      name,
      freeBoardKey(name),
      repoPath,
      pos.p,
      checkCommand,
      input.architectEnabled === false ? 0 : 1,
      input.notificationsEnabled === false ? 0 : 1,
      input.notificationsDetailed === false ? 0 : 1,
      input.oneCardAtATime === false ? 0 : 1
    )
    WORK_COLUMNS.forEach((column, index) => {
      db.prepare("INSERT INTO columns (id, board_id, title, role, position) VALUES (?, ?, ?, ?, ?)").run(
        `${id}:${column.id}`,
        id,
        column.title,
        column.role,
        index
      )
    })
    memberIds.forEach((memberId, index) => {
      db.prepare("INSERT OR IGNORE INTO board_members (board_id, member_id, position) VALUES (?, ?, ?)").run(
        id,
        memberId,
        index
      )
    })
  })
  emitChange({ scope: "board", boardId: id })
  if (input.starterCard === true && firstCoder) {
    // In Ready, tagged for the Coder — the conveyor starts it as soon as the Coder is free.
    createTask({
      boardId: id,
      columnId: `${id}:ready`,
      ...(createRepo ? STARTER_CARD_CREATED : STARTER_CARD),
      assigneeIds: [firstCoder],
    })
  }
  const board = getState().boards.find((b) => b.id === id)
  if (!board) throw new NotFoundError("Board vanished after insert")
  return board
}

/** The owner's profile: name and @handle (the welcome screen and Settings → Profile). */
export function updateMe(patch: { name?: unknown; handle?: unknown }): Member {
  const db = getDb()
  const id = ownerId()
  const fields: string[] = []
  const values: string[] = []
  if (patch.name !== undefined) {
    const name = cleanText(patch.name, "name", { required: true, max: 80 })
    fields.push("name = ?", "initials = ?")
    values.push(name, initialsOf(name))
  }
  if (patch.handle !== undefined) {
    const handle = cleanText(patch.handle, "handle", { required: true, max: 32 }).replace(/^@/, "").toLowerCase()
    if (!/^[a-z0-9_]+$/.test(handle)) {
      throw new ValidationError("Handle can only use latin letters, digits and _")
    }
    const taken = db.prepare("SELECT id FROM members WHERE handle = ? AND id != ?").get(handle, id)
    if (taken) throw new ValidationError(`@${handle} is already taken`)
    fields.push("handle = ?")
    values.push(handle)
  }
  if (fields.length > 0) {
    db.prepare(`UPDATE members SET ${fields.join(", ")} WHERE id = ?`).run(...values, id)
  }
  emitChange({ scope: "board" })
  const me = listMembers().find((m) => m.id === id)
  if (!me) throw new NotFoundError("Owner vanished after update")
  return me
}

/** "Max Shakurov" → "MS", "Coder (fast)" → "CF", "Architect" → "AR". */
function initialsOf(name: string): string {
  const parts = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  const letters = parts.length >= 2 ? parts[0][0] + parts[parts.length - 1][0] : (parts[0] ?? name.trim()).slice(0, 2)
  return letters.toUpperCase()
}

/** A handle for an agent from its whole name: "Coder (fast)" → "coder_fast". Empty when nothing latin is left. */
function slugHandle(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[^\x00-\x7F]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32)
}

/** Suggest a handle from a name: "Ada Lovelace" → "ada"; non-latin names fall back to "owner". */
export function suggestHandle(name: string): string {
  const first = name.trim().split(/\s+/)[0] ?? ""
  const ascii = first
    .normalize("NFKD")
    .replace(/[^\x00-\x7F]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "")
  return ascii || "owner"
}

/**
 * A second person in the workspace: someone who takes part over the API rather than through
 * this UI — a Claude in the owner's own chat, say, that plans a board from the outside.
 *
 * It is a human member, not an agent: the worker never runs it, and its messages wake the
 * agents they mention exactly like the owner's, because `triggerMentions` only ever asks
 * whether the author is human (a human's mention also interrupts a busy agent and resets the
 * agent chain, an agent's does not). Not the owner: `ownerId()` stays the one person this
 * workspace belongs to. Add it to a board with `memberIds` in PATCH /api/boards/:id.
 */
export function createPerson(input: { name?: unknown; handle?: unknown; tone?: unknown }): Member {
  const db = getDb()
  const name = cleanText(input.name, "name", { required: true, max: 80 })
  const handle = cleanHandle(input.handle ?? (slugHandle(name) || "person"), null)
  const count = (db.prepare("SELECT COUNT(*) AS n FROM members").get() as { n: number }).n
  const tone =
    typeof input.tone === "string" && AVATAR_TONES.includes(input.tone as AvatarTone)
      ? input.tone
      : AVATAR_TONES[count % AVATAR_TONES.length]
  const id = newId("p")
  db.prepare(
    "INSERT INTO members (id, name, handle, initials, tone, kind, agent_role, is_owner) VALUES (?, ?, ?, ?, ?, 'human', NULL, 0)"
  ).run(id, name, handle, initialsOf(name), tone)
  emitChange({ scope: "board" })
  const person = listMembers().find((m) => m.id === id)
  if (!person) throw new NotFoundError("Member vanished after insert")
  return person
}

// ---------------------------------------------------------------------------
// Agents. Each one is a member with a role (architect / coder) and a configuration
// the worker reads: which CLI runs it, model, effort, turn limit, extra instructions.

const ROLE_HINT: Record<AgentRole, string> = {
  architect: "plans, dispatches the queue, reviews",
  coder: "implements cards",
}

function cleanHandle(value: unknown, exceptId: string | null): string {
  const handle = cleanText(value, "handle", { required: true, max: 32 }).replace(/^@/, "").toLowerCase()
  if (!/^[a-z0-9_]+$/.test(handle)) throw new ValidationError("Handle can only use latin letters, digits and _")
  const taken = getDb().prepare("SELECT id FROM members WHERE handle = ? AND id != ?").get(handle, exceptId ?? "")
  if (taken) throw new ValidationError(`@${handle} is already taken`)
  return handle
}

/** Validate the configuration fields of an agent; `undefined` fields are left as they are. */
function cleanAgentConfig(patch: Record<string, unknown>): Partial<Record<keyof AgentConfig, string | number | null>> {
  const out: Partial<Record<keyof AgentConfig, string | number | null>> = {}
  if (patch.engine !== undefined) {
    if (typeof patch.engine !== "string" || !AGENT_ENGINES.includes(patch.engine as AgentEngine)) {
      throw new ValidationError(`Invalid engine: ${String(patch.engine)}`)
    }
    out.engine = patch.engine
  }
  if (patch.model !== undefined) out.model = cleanText(patch.model, "model", { max: 80 }) || null
  if (patch.effort !== undefined) {
    if (patch.effort != null && patch.effort !== "") {
      if (typeof patch.effort !== "string" || !AGENT_EFFORTS.includes(patch.effort as AgentEffort)) {
        throw new ValidationError(`Invalid effort: ${String(patch.effort)}`)
      }
      out.effort = patch.effort
    } else {
      out.effort = null
    }
  }
  if (patch.maxTurns !== undefined) {
    if (patch.maxTurns == null || patch.maxTurns === "") out.maxTurns = null
    else {
      const n = Number(patch.maxTurns)
      if (!Number.isInteger(n) || n < 1 || n > 1000) throw new ValidationError("Max turns must be a whole number from 1 to 1000")
      out.maxTurns = n
    }
  }
  if (patch.description !== undefined) out.description = cleanText(patch.description, "description", { max: 200 })
  if (patch.instructions !== undefined) out.instructions = cleanText(patch.instructions, "instructions", { max: 8000 })
  return out
}

const CONFIG_COLUMNS: Record<keyof AgentConfig, string> = {
  engine: "engine",
  model: "model",
  effort: "effort",
  maxTurns: "max_turns",
  description: "description",
  instructions: "instructions",
}

export function createAgent(input: Record<string, unknown>): Member {
  const db = getDb()
  const name = cleanText(input.name, "name", { required: true, max: 80 })
  if (input.role !== "architect" && input.role !== "coder") throw new ValidationError("Role must be architect or coder")
  const role = input.role as AgentRole
  const config = cleanAgentConfig(input)
  const engine = (config.engine as AgentEngine | undefined) ?? "claude"
  const count = (db.prepare("SELECT COUNT(*) AS n FROM members WHERE kind = 'agent'").get() as { n: number }).n
  const handle = cleanHandle(input.handle ?? (slugHandle(name) || `${role}${count + 1}`), null)
  const tone =
    typeof input.tone === "string" && AVATAR_TONES.includes(input.tone as AvatarTone)
      ? input.tone
      : AVATAR_TONES[(count + 1) % AVATAR_TONES.length]
  const id = newId("a")
  db.prepare(
    "INSERT INTO members (id, name, handle, initials, tone, kind, agent_role, is_owner, engine, model, effort, max_turns, description, instructions) VALUES (?, ?, ?, ?, ?, 'agent', ?, 0, ?, ?, ?, ?, ?, ?)"
  ).run(
    id,
    name,
    handle,
    initialsOf(name),
    tone,
    role,
    engine,
    (config.model as string | null | undefined) ?? null,
    (config.effort as string | null | undefined) ?? null,
    (config.maxTurns as number | null | undefined) ?? null,
    (config.description as string | undefined) ?? ROLE_HINT[role],
    (config.instructions as string | undefined) ?? ""
  )
  if (role === "architect") {
    // An architect belongs on every board — put it on the existing ones right away.
    db.prepare(
      "INSERT OR IGNORE INTO board_members (board_id, member_id, position) SELECT id, ?, (SELECT COALESCE(MAX(position), -1) + 1 FROM board_members WHERE board_id = boards.id) FROM boards"
    ).run(id)
  }
  emitChange({ scope: "board" })
  const agent = listMembers().find((m) => m.id === id)
  if (!agent) throw new NotFoundError("Agent vanished after insert")
  return agent
}

export function updateAgent(agentId: string, patch: Record<string, unknown>): Member {
  const db = getDb()
  const current = db.prepare("SELECT * FROM members WHERE id = ? AND kind = 'agent'").get(agentId) as MemberRow | undefined
  if (!current) throw new NotFoundError(`Agent ${agentId} not found`)
  const fields: string[] = []
  const values: Array<string | number | null> = []
  if (patch.name !== undefined) {
    const name = cleanText(patch.name, "name", { required: true, max: 80 })
    fields.push("name = ?", "initials = ?")
    values.push(name, initialsOf(name))
  }
  if (patch.handle !== undefined) {
    fields.push("handle = ?")
    values.push(cleanHandle(patch.handle, agentId))
  }
  if (patch.role !== undefined) {
    if (patch.role !== "architect" && patch.role !== "coder") throw new ValidationError("Role must be architect or coder")
    fields.push("agent_role = ?")
    values.push(patch.role)
  }
  if (patch.tone !== undefined) {
    if (typeof patch.tone !== "string" || !AVATAR_TONES.includes(patch.tone as AvatarTone)) {
      throw new ValidationError("Invalid color")
    }
    fields.push("tone = ?")
    values.push(patch.tone)
  }
  const config = cleanAgentConfig(patch)
  for (const key of Object.keys(config) as Array<keyof AgentConfig>) {
    fields.push(`${CONFIG_COLUMNS[key]} = ?`)
    values.push(config[key] ?? null)
  }
  if (fields.length > 0) {
    db.prepare(`UPDATE members SET ${fields.join(", ")} WHERE id = ?`).run(...values, agentId)
  }
  emitChange({ scope: "board" })
  const agent = listMembers().find((m) => m.id === agentId)
  if (!agent) throw new NotFoundError("Agent vanished after update")
  return agent
}

/**
 * Remove an agent: it leaves every board, its waiting runs are cancelled and its tags come
 * off the cards. The member row stays (archived) so its old messages keep their author.
 */
export function removeAgent(agentId: string): void {
  const db = getDb()
  const current = db.prepare("SELECT * FROM members WHERE id = ? AND kind = 'agent'").get(agentId) as MemberRow | undefined
  if (!current) throw new NotFoundError(`Agent ${agentId} not found`)
  const running = db.prepare("SELECT id FROM agent_runs WHERE agent_id = ? AND status = 'running' LIMIT 1").get(agentId)
  if (running) throw new ValidationError(`${current.name} is in the middle of a run — wait for it to finish (or stop the worker) first`)
  transaction(db, () => {
    db.prepare("UPDATE agent_runs SET status = 'cancelled', finished_at = ? WHERE agent_id = ? AND status = 'queued'").run(nowIso(), agentId)
    db.prepare("DELETE FROM board_members WHERE member_id = ?").run(agentId)
    db.prepare("DELETE FROM task_assignees WHERE member_id = ?").run(agentId)
    db.prepare("UPDATE members SET archived = 1 WHERE id = ?").run(agentId)
  })
  emitChange({ scope: "board" })
  emitChange({ scope: "runs" })
}

/** What a project folder looks like from here — shown in the New board dialog. */
export function checkRepo(rawPath: unknown): RepoCheck {
  const text = cleanText(rawPath, "path", { max: 500 })
  const expanded = text.startsWith("~") ? path.join(process.env.HOME ?? "", text.slice(1)) : text
  const resolved = expanded ? path.resolve(expanded) : ""
  const exists = !!resolved && fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()
  return {
    path: resolved,
    exists,
    isGit: exists && fs.existsSync(path.join(resolved, ".git")),
    hasAgentNotes:
      exists && (fs.existsSync(path.join(resolved, "CLAUDE.md")) || fs.existsSync(path.join(resolved, "AGENTS.md"))),
  }
}

/** Where "create a new project" puts the folder: $CREATIVE_SPACE_PROJECTS_DIR, else ~/CreativeSpaceProjects. */
function workspaceRoot(): string {
  const configured = (process.env.CREATIVE_SPACE_PROJECTS_DIR ?? "").trim()
  const raw = configured || path.join(process.env.HOME ?? "", "CreativeSpaceProjects")
  return path.resolve(raw.startsWith("~") ? path.join(process.env.HOME ?? "", raw.slice(1)) : raw)
}

/** "Merge game UI" → "merge-game-ui". Names with nothing latin in them fall back to "board". */
function slugFolder(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[^\x00-\x7F]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 60)
    .replace(/^-+|-+$/g, "")
  return slug || "board"
}

/** The folder a new board would get: <workspace root>/<slug>, with -2, -3… when the name is taken. */
export function plannedRepoPath(rawName: unknown): string {
  const name = cleanText(rawName, "name", { required: true, max: 80 })
  const root = workspaceRoot()
  const slug = slugFolder(name)
  let candidate = path.join(root, slug)
  for (let n = 2; fs.existsSync(candidate); n++) {
    if (n > 99) throw new ValidationError(`Too many folders named ${slug}-… in ${root} — pick another board name`)
    candidate = path.join(root, `${slug}-${n}`)
  }
  return candidate
}

/** The CLAUDE.md / AGENTS.md a fresh project starts with — headings for the owner (or the Coder) to fill in. */
function starterNotes(boardName: string): string {
  return `# ${boardName}

## What this is

## Stack

## How to run

## How to check
`
}

/**
 * Make the folder for a brand new project: git repo with CLAUDE.md and AGENTS.md in the first
 * commit. Throws (as a plain message for the dialog) if anything fails — the board is not created.
 */
function createProjectFolder(dir: string, boardName: string): void {
  if (fs.existsSync(dir)) {
    throw new ValidationError(`${dir} already exists — rename the board or pick the folder yourself`)
  }
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" })
  try {
    fs.mkdirSync(dir, { recursive: true })
    const notes = starterNotes(boardName)
    fs.writeFileSync(path.join(dir, "CLAUDE.md"), notes)
    fs.writeFileSync(path.join(dir, "AGENTS.md"), notes)
    git("init")
    git("add", "CLAUDE.md", "AGENTS.md")
    // Fall back to a neutral author only when git has no identity of its own to use here.
    const identity = hasGitIdentity(dir)
      ? []
      : ["-c", "user.name=Creative Space", "-c", "user.email=creative-space@localhost"]
    git(...identity, "commit", "-m", "Add agent notes")
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new ValidationError(`Could not set up ${dir}: ${reason}`)
  }
}

function hasGitIdentity(dir: string): boolean {
  try {
    return execFileSync("git", ["config", "user.email"], { cwd: dir, stdio: "pipe" }).toString().trim().length > 0
  } catch {
    return false
  }
}

export function updateBoard(
  boardId: string,
  patch: {
    name?: unknown
    key?: unknown
    repoPath?: unknown
    archived?: unknown
    memberIds?: unknown
    checkCommand?: unknown
    architectEnabled?: unknown
    notificationsEnabled?: unknown
    notificationsDetailed?: unknown
    oneCardAtATime?: unknown
  }
): Board {
  const db = getDb()
  const current = db.prepare("SELECT id FROM boards WHERE id = ?").get(boardId) as { id: string } | undefined
  if (!current) throw new NotFoundError(`Board ${boardId} not found`)
  if (Array.isArray(patch.memberIds)) {
    // Which people and agents take part in this board. The owner and the architects always stay.
    const wanted = new Set(patch.memberIds.filter((v): v is string => typeof v === "string"))
    const live = listMembers().filter((m) => !m.archived)
    const pinned = pinnedMemberIds(live)
    const known = new Set(live.map((m) => m.id))
    transaction(db, () => {
      db.prepare("DELETE FROM board_members WHERE board_id = ?").run(boardId)
      let position = 0
      for (const memberId of [...pinned, ...Array.from(wanted).filter((id) => !pinned.includes(id))]) {
        if (!known.has(memberId)) continue
        db.prepare("INSERT INTO board_members (board_id, member_id, position) VALUES (?, ?, ?)").run(
          boardId,
          memberId,
          position++
        )
      }
    })
  }
  const fields: string[] = []
  const values: Array<string | number | null> = []
  if (patch.name !== undefined) {
    fields.push("name = ?")
    values.push(cleanText(patch.name, "name", { required: true, max: 80 }))
  }
  // Renaming the board leaves the key alone: the numbers already written down keep working.
  // Changing the key changes only how the numbers are displayed, never the numbers.
  if (patch.key !== undefined) {
    let key: string
    try {
      key = normalizeBoardKey(cleanText(patch.key, "key", { required: true, max: 16 }))
    } catch (error) {
      throw new ValidationError(error instanceof Error ? error.message : "Invalid board key")
    }
    if (boardKeysInUse(boardId).some((used) => used === key)) {
      throw new ValidationError(`Board key ${key} is already used by another board`)
    }
    fields.push(`"key" = ?`)
    values.push(key)
  }
  if (patch.repoPath !== undefined) {
    fields.push("repo_path = ?")
    values.push(cleanText(patch.repoPath, "repoPath", { max: 500 }) || null)
  }
  if (patch.archived !== undefined) {
    fields.push("archived = ?")
    values.push(patch.archived ? 1 : 0)
  }
  if (patch.checkCommand !== undefined) {
    fields.push("check_command = ?")
    values.push(cleanText(patch.checkCommand, "checkCommand", { max: 500 }) || null)
  }
  if (patch.architectEnabled !== undefined) {
    fields.push("architect_enabled = ?")
    values.push(patch.architectEnabled === false ? 0 : 1)
  }
  if (patch.notificationsEnabled !== undefined) {
    fields.push("notifications_enabled = ?")
    values.push(patch.notificationsEnabled === false ? 0 : 1)
  }
  if (patch.notificationsDetailed !== undefined) {
    fields.push("notifications_detailed = ?")
    values.push(patch.notificationsDetailed === false ? 0 : 1)
  }
  if (patch.oneCardAtATime !== undefined) {
    fields.push("one_card_at_a_time = ?")
    values.push(patch.oneCardAtATime === false ? 0 : 1)
  }
  const heldBefore = queueHeld(boardId)
  if (fields.length > 0) {
    db.prepare(`UPDATE boards SET ${fields.join(", ")} WHERE id = ?`).run(...values, boardId)
  }
  // Switched off while a dispatch or a review was waiting: those runs are now nobody's job.
  if (patch.architectEnabled === false) cancelArchitectRuns(boardId)
  // A coder that just joined the board — or no longer waits for a dispatch — may find Ready
  // waiting for it.
  const pulled = transaction(db, () => {
    const taken = pullNextForCoders(boardId, null, null)
    // One card at a time switched off: the Ready cards it held back were never dispatched.
    if (heldBefore) dispatchWaitingReady(boardId, "One card at a time is off")
    return taken
  })
  emitChange({ scope: "board", boardId })
  for (const taskId of pulled) emitChange({ scope: "thread", boardId, taskId })
  const board = getState().boards.find((b) => b.id === boardId)
  if (!board) throw new NotFoundError("Board vanished after update")
  return board
}

/** Removes the board with all its columns, tasks, chat and runs. */
export function deleteBoard(boardId: string): void {
  const db = getDb()
  const result = db.prepare("DELETE FROM boards WHERE id = ?").run(boardId)
  if (Number(result.changes) === 0) throw new NotFoundError(`Board ${boardId} not found`)
  emitChange({ scope: "board", boardId })
}

// ---------------------------------------------------------------------------
// Writes: columns

/** Titles that clearly mean a workflow stage get that stage's role (agents react to roles). */
function inferColumnRole(title: string): ColumnRole {
  const t = title.trim().toLowerCase()
  if (/^(backlog|ideas|icebox)$/.test(t)) return "backlog"
  if (/^(ready|to ?do|todo|next|queue|up next)$/.test(t)) return "ready"
  if (/^(in ?progress|doing|building|wip)$/.test(t)) return "in_progress"
  if (/^(review|in review|qa|testing)$/.test(t)) return "review"
  if (/^(done|complete|completed|shipped|finished)$/.test(t)) return "done"
  return "other"
}

export function createColumn(boardId: string, input: { title: unknown; role?: unknown }): Column {
  const db = getDb()
  const board = db.prepare("SELECT id FROM boards WHERE id = ?").get(boardId) as { id: string } | undefined
  if (!board) throw new NotFoundError(`Board ${boardId} not found`)
  const title = cleanText(input.title, "title", { required: true, max: 60 })
  const role =
    typeof input.role === "string" && COLUMN_ROLES.includes(input.role as ColumnRole)
      ? (input.role as ColumnRole)
      : inferColumnRole(title)
  const id = newId("c")
  const pos = db
    .prepare("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM columns WHERE board_id = ?")
    .get(boardId) as { p: number }
  db.prepare("INSERT INTO columns (id, board_id, title, role, position) VALUES (?, ?, ?, ?, ?)").run(
    id,
    boardId,
    title,
    role,
    pos.p
  )
  emitChange({ scope: "board", boardId })
  return { id, boardId, title, role, position: pos.p, tasks: [] }
}

export function updateColumn(
  columnId: string,
  patch: { title?: unknown; role?: unknown; position?: unknown }
): Column {
  const db = getDb()
  const row = db.prepare("SELECT * FROM columns WHERE id = ?").get(columnId) as ColumnRow | undefined
  if (!row) throw new NotFoundError(`Column ${columnId} not found`)
  const fields: string[] = []
  const values: string[] = []
  if (patch.title !== undefined) {
    const title = cleanText(patch.title, "title", { required: true, max: 60 })
    fields.push("title = ?")
    values.push(title)
    // Renaming a list to "Ready", "Review"… gives it that role; other names keep the old one.
    const inferred = inferColumnRole(title)
    if (typeof patch.role !== "string" && inferred !== "other" && inferred !== row.role) {
      fields.push("role = ?")
      values.push(inferred)
    }
  }
  if (typeof patch.role === "string") {
    if (!COLUMN_ROLES.includes(patch.role as ColumnRole)) throw new ValidationError(`Invalid role: ${patch.role}`)
    fields.push("role = ?")
    values.push(patch.role)
  }
  if (patch.position !== undefined && (typeof patch.position !== "number" || patch.position < 0)) {
    throw new ValidationError("position must be a non-negative number")
  }
  let pulled: string[] = []
  transaction(db, () => {
    if (fields.length > 0) {
      db.prepare(`UPDATE columns SET ${fields.join(", ")} WHERE id = ?`).run(...values, columnId)
    }
    if (typeof patch.position === "number") placeColumn(row.board_id, columnId, Math.floor(patch.position))
    pulled = pullNextForCoders(row.board_id, null, null)
  })
  emitChange({ scope: "board", boardId: row.board_id })
  for (const taskId of pulled) emitChange({ scope: "thread", boardId: row.board_id, taskId })
  const board = getState().boards.find((b) => b.id === row.board_id)
  const column = board?.columns.find((c) => c.id === columnId)
  if (!column) throw new NotFoundError("Column vanished after update")
  return column
}

/** Put a column at `position` among its board's columns and renumber them. */
function placeColumn(boardId: string, columnId: string, position: number): void {
  const db = getDb()
  const others = (
    db
      .prepare("SELECT id FROM columns WHERE board_id = ? AND id != ? ORDER BY position, rowid")
      .all(boardId, columnId) as { id: string }[]
  ).map((r) => r.id)
  others.splice(Math.min(position, others.length), 0, columnId)
  const update = db.prepare("UPDATE columns SET position = ? WHERE id = ?")
  others.forEach((id, index) => update.run(index, id))
}

/**
 * A column with live cards only goes when the caller says what happens to them:
 * "delete" removes them, "archive" archives them. Archived cards (old and new) are
 * moved to another list first — tasks cascade with their column.
 */
export function deleteColumn(columnId: string, cards?: unknown): void {
  const db = getDb()
  const row = db.prepare("SELECT board_id FROM columns WHERE id = ?").get(columnId) as
    | { board_id: string }
    | undefined
  if (!row) throw new NotFoundError(`Column ${columnId} not found`)
  const mode = cards === "delete" || cards === "archive" ? cards : null
  const live = (
    db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE column_id = ? AND archived = 0").get(columnId) as { n: number }
  ).n
  if (live > 0 && !mode) throw new ValidationError("This list has cards — choose to delete or archive them")
  const archived = (
    db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE column_id = ? AND archived = 1").get(columnId) as { n: number }
  ).n
  const keepArchived = archived > 0 || (live > 0 && mode === "archive")
  const target = (
    db
      .prepare("SELECT id FROM columns WHERE board_id = ? AND id != ? ORDER BY position, rowid LIMIT 1")
      .get(row.board_id, columnId) as { id: string } | undefined
  )?.id
  if (keepArchived && !target) {
    throw new ValidationError("Archived cards need another list on this board — add one first")
  }
  let pulled: string[] = []
  transaction(db, () => {
    if (mode === "delete") {
      db.prepare("DELETE FROM tasks WHERE column_id = ? AND archived = 0").run(columnId)
    } else if (mode === "archive") {
      const at = nowIso()
      const ids = db.prepare("SELECT id FROM tasks WHERE column_id = ? AND archived = 0").all(columnId) as Array<{
        id: string
      }>
      for (const { id } of ids) {
        cancelQueuedColumnRuns(id)
        db.prepare("UPDATE tasks SET archived = 1, updated_at = ? WHERE id = ?").run(at, id)
      }
    }
    if (target) db.prepare("UPDATE tasks SET column_id = ? WHERE column_id = ? AND archived = 1").run(target, columnId)
    db.prepare("DELETE FROM columns WHERE id = ?").run(columnId)
    if (live > 0) pulled = pullNextForCoders(row.board_id, null, null)
  })
  emitChange({ scope: "board", boardId: row.board_id })
  for (const taskId of pulled) emitChange({ scope: "thread", boardId: row.board_id, taskId })
}

export function createTask(input: {
  boardId: unknown
  columnId?: unknown
  title: unknown
  description?: unknown
  assigneeIds?: unknown
  /** Id of the agent creating the card (see createAgentTasks); a person's card leaves it empty. */
  createdBy?: unknown
  /** Card this one is split off from (see createAgentTasks); empty for a card on its own. */
  parentId?: unknown
}): Task {
  const db = getDb()
  const boardId = cleanText(input.boardId, "boardId", { required: true })
  const board = db.prepare("SELECT id FROM boards WHERE id = ?").get(boardId) as { id: string } | undefined
  if (!board) throw new NotFoundError(`Board ${boardId} not found`)

  const createdBy = cleanText(input.createdBy, "createdBy") || null
  const parentId = cleanText(input.parentId, "parentId") || null
  if (parentId) {
    const parent = db.prepare("SELECT board_id FROM tasks WHERE id = ?").get(parentId) as
      | { board_id: string }
      | undefined
    if (!parent) throw new NotFoundError(`Task ${parentId} not found`)
    if (parent.board_id !== boardId) throw new ValidationError("Parent card belongs to another board")
  }
  let columnId = cleanText(input.columnId, "columnId")
  if (!columnId) {
    columnId =
      columnByRole(boardId, "backlog") ??
      ((db.prepare("SELECT id FROM columns WHERE board_id = ? ORDER BY position LIMIT 1").get(boardId) as
        | { id: string }
        | undefined)?.id ??
        "")
  }
  const column = db.prepare("SELECT id, board_id FROM columns WHERE id = ?").get(columnId) as
    | { id: string; board_id: string }
    | undefined
  if (!column || column.board_id !== boardId) throw new ValidationError("Column does not belong to board")

  const title = cleanText(input.title, "title", { required: true, max: 200 })
  const description = cleanText(input.description, "description")
  // No assignees given → the board's architect and the owner get the card, so a new card
  // always has someone who plans it and the person who asked for it.
  const assigneeIds = Array.isArray(input.assigneeIds)
    ? input.assigneeIds.filter((v): v is string => typeof v === "string")
    : [boardAgents(boardId).find((a) => a.agentRole === "architect")?.id, ownerId()].filter(
        (v): v is string => !!v
      )

  const id = newId("t")
  const at = nowIso()
  let pulled: string[] = []
  transaction(db, () => {
    const pos = db
      .prepare("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM tasks WHERE column_id = ?")
      .get(columnId) as { p: number }
    // The board's counter, not MAX(number): deleting a card must not give its number away
    // again — the chats that mention it would start pointing at a different card.
    db.prepare("UPDATE boards SET task_seq = task_seq + 1 WHERE id = ?").run(boardId)
    const seq = db.prepare("SELECT task_seq FROM boards WHERE id = ?").get(boardId) as { task_seq: number }
    db.prepare(
      "INSERT INTO tasks (id, board_id, column_id, position, number, title, description, attachments, created_by, parent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)"
    ).run(id, boardId, columnId, pos.p, seq.task_seq, title, description, createdBy, parentId, at, at)
    setAssignees(id, assigneeIds)
    // An agent's card is wired up by createAgentTasks (chain first, only then start): a run
    // triggered here could pull card N before it knows it waits for N−1.
    if (!createdBy) {
      const role = columnRole(columnId)
      triggerColumnRuns(id, boardId, null, role)
      if (role === "ready") pulled = pullNextForCoders(boardId, null, null)
    }
  })
  emitChange({ scope: "board", boardId, taskId: id })
  for (const taskId of pulled) emitChange({ scope: "thread", boardId, taskId })
  return getTask(id)
}

/** How many cards one agent run may create. A split, not a card factory. */
export const MAX_AGENT_CREATED_TASKS = 3

/**
 * The `create` action of a reply: an agent splits its card into follow-up cards (the
 * Architect breaking a big task down, a coder filing what it found on the way).
 *
 * Default is **Backlog**: the card wakes nobody and only the owner puts it into the queue.
 * `column: "ready"` is a deliberate split and only the Architect may ask for it — a coder's
 * follow-up is a note, not an order. Ready cards are chained in array order (card N waits
 * for N−1), so the queue starts the first one and the rest wait their turn; `parallel`
 * drops the chain for cards that really are independent.
 *
 * What keeps this from running away: a card that an agent created cannot create more — the
 * chain ends after one step.
 */
export function createAgentTasks(
  sourceTaskId: string,
  input: { actorId: unknown; cards: unknown; column?: unknown; parallel?: unknown }
): { tasks: Task[] } {
  const db = getDb()
  const source = db.prepare("SELECT * FROM tasks WHERE id = ?").get(sourceTaskId) as TaskRow | undefined
  if (!source) throw new NotFoundError(`Task ${sourceTaskId} not found`)
  const actor = boardAgents(source.board_id).find((a) => a.id === input.actorId)
  if (!actor) throw new ValidationError("Only an agent on this board can create cards")
  if (source.created_by) {
    throw new ValidationError("This card was itself created by an agent — it cannot create more")
  }

  // Normalised here rather than card by card: a single over-long title must not fail the
  // call halfway through, with some of the cards already on the board.
  const text = (value: unknown, max: number) => (typeof value === "string" ? value.trim().slice(0, max) : "")
  const drafts = (Array.isArray(input.cards) ? input.cards : [])
    .filter((card): card is Record<string, unknown> => !!card && typeof card === "object")
    .map((card) => ({
      title: text(card.title, 200),
      description: text(card.description, 4000),
      assignee: text(card.assignee, 60).replace(/^@/, "").toLowerCase(),
    }))
    .filter((card) => card.title !== "")
    .slice(0, MAX_AGENT_CREATED_TASKS)
  if (drafts.length === 0) throw new ValidationError("cards must hold at least one card with a title")

  // Ready is the Architect's call only, and only for a split it has thought through.
  const wantsReady = text(input.column, 20).toLowerCase() === "ready"
  const readyColumn = wantsReady && actor.agentRole === "architect" ? columnByRole(source.board_id, "ready") : null
  // Subtasks of one big task are usually sequential, and two coders in one file is worse
  // than a queue — so chain them unless the Architect says they are independent.
  const chain = actor.agentRole === "architect" && input.parallel !== true

  const byHandle = new Map(
    (
      db
        .prepare(
          "SELECT m.id, m.handle FROM members m JOIN board_members bm ON bm.member_id = m.id WHERE bm.board_id = ? AND m.archived = 0"
        )
        .all(source.board_id) as Array<{ id: string; handle: string }>
    ).map((m) => [m.handle.toLowerCase(), m.id])
  )

  const tasks = drafts.map((draft) => {
    // An unknown handle is not worth losing the card over: it falls back to the default tags.
    const assignee = draft.assignee ? byHandle.get(draft.assignee) : undefined
    return createTask({
      boardId: source.board_id,
      columnId: readyColumn ?? undefined,
      title: draft.title,
      description: draft.description,
      assigneeIds: assignee ? [assignee] : undefined,
      createdBy: actor.id,
      // The card the run was on: the new cards are parts of it, and the panel shows the
      // link both ways.
      parentId: source.id,
    })
  })

  let pulled: string[] = []
  transaction(db, () => {
    if (chain) {
      tasks.forEach((task, index) => {
        if (index > 0) setBlockers(task.id, source.board_id, [tasks[index - 1].id])
      })
    }
    // createTask left the new cards alone so the chain could be built first; now let Ready
    // do its usual thing — the first card starts, the blocked ones wait.
    if (readyColumn) {
      // The card was created in Ready, not moved there — the default "moved it to Ready"
      // note would read wrong on a card that has no history at all.
      for (const task of tasks) {
        triggerColumnRuns(task.id, source.board_id, null, "ready", {
          note: `${actor.name} created this card in Ready — sorting the queue.`,
        })
      }
      pulled = pullNextForCoders(source.board_id, null, null)
    }
  })

  const where = readyColumn ? "Ready" : "Backlog"
  const titles = tasks.map((t) => `“${t.title}”`).join(", ")
  insertSystemMessage(
    sourceTaskId,
    `${actor.name} created ${titles} in ${where}${chain && tasks.length > 1 ? ", one after another" : ""}.`
  )
  const sourceRef = taskRef(boardKeyOf(source.board_id), source.number) ?? `#${source.id}`
  tasks.forEach((task, index) => {
    const parent = `${actor.name} created this card while working on “${source.title}” (${sourceRef}).`
    const waits = chain && index > 0 ? ` It waits for “${tasks[index - 1].title}”.` : ""
    insertSystemMessage(task.id, `${parent}${waits}`)
  })
  emitChange({ scope: "board", boardId: source.board_id })
  emitChange({ scope: "thread", boardId: source.board_id, taskId: sourceTaskId })
  for (const taskId of pulled) emitChange({ scope: "thread", boardId: source.board_id, taskId })
  // Re-read: the chain and the queue may have moved the cards since createTask returned them.
  return { tasks: tasks.map((task) => getTask(task.id)) }
}

export function updateTask(
  taskId: string,
  patch: {
    title?: unknown
    description?: unknown
    assigneeIds?: unknown
    columnId?: unknown
    columnRole?: unknown
    position?: unknown
    archived?: unknown
    /** Ids of cards this one waits for. */
    blockedBy?: unknown
    /** Who moved the card (an agent id, set by the worker). Humans move from the UI and leave it empty. */
    actorId?: unknown
    /** The agent's `In short:` line, for the owner's notification; see `recordMove`. */
    plain?: unknown
  }
): Task {
  const db = getDb()
  const current = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as TaskRow | undefined
  if (!current) throw new NotFoundError(`Task ${taskId} not found`)

  const fields: string[] = []
  const values: Array<string | number> = []
  if (patch.archived !== undefined) {
    fields.push("archived = ?")
    values.push(patch.archived ? 1 : 0)
    if (patch.archived) cancelQueuedColumnRuns(taskId)
  }
  if (patch.title !== undefined) {
    fields.push("title = ?")
    values.push(cleanText(patch.title, "title", { required: true, max: 200 }))
  }
  if (patch.description !== undefined) {
    fields.push("description = ?")
    values.push(cleanText(patch.description, "description"))
  }

  let targetColumnId: string | null = null
  if (typeof patch.columnRole === "string") {
    if (!COLUMN_ROLES.includes(patch.columnRole as ColumnRole)) {
      throw new ValidationError(`Invalid column role: ${patch.columnRole}`)
    }
    targetColumnId = columnByRole(current.board_id, patch.columnRole as ColumnRole)
    if (!targetColumnId) throw new ValidationError(`Board has no '${patch.columnRole}' column`)
  } else if (typeof patch.columnId === "string") {
    const column = db.prepare("SELECT id, board_id FROM columns WHERE id = ?").get(patch.columnId) as
      | { id: string; board_id: string }
      | undefined
    if (!column || column.board_id !== current.board_id) {
      throw new ValidationError("Column does not belong to the task's board")
    }
    targetColumnId = column.id
  }
  const boardAgentList = boardAgents(current.board_id)
  const actor = typeof patch.actorId === "string" ? boardAgentList.find((a) => a.id === patch.actorId) ?? null : null
  // A coder saying "to Review" means it is done, not that the card changes column: the
  // Architect reviews it where it is, and only its verdict can put the card in Review.
  const reviewer =
    actor?.agentRole === "coder" &&
    targetColumnId != null &&
    columnRole(targetColumnId) === "review" &&
    columnRole(current.column_id) === "in_progress"
      ? boardAgentList.find((a) => a.agentRole === "architect") ?? null
      : null
  if (reviewer) targetColumnId = null
  const position = typeof patch.position === "number" && patch.position >= 0 ? Math.floor(patch.position) : null
  const moving = targetColumnId != null || position != null

  let pulled: string[] = []
  transaction(db, () => {
    const heldBefore = queueHeld(current.board_id)
    if (fields.length > 0) {
      fields.push("updated_at = ?")
      values.push(nowIso())
      db.prepare(`UPDATE tasks SET ${fields.join(", ")} WHERE id = ?`).run(...values, taskId)
    }
    if (Array.isArray(patch.assigneeIds)) {
      setAssignees(
        taskId,
        patch.assigneeIds.filter((v): v is string => typeof v === "string")
      )
    }
    if (Array.isArray(patch.blockedBy)) {
      setBlockers(taskId, current.board_id, patch.blockedBy.filter((v): v is string => typeof v === "string"))
    }
    if (patch.archived !== undefined && !moving) {
      renumber(current.column_id)
    }
    let handedOff = false
    if (reviewer) {
      // The card stays put; the coder is free as soon as the review is queued (`coderIsFree`).
      handedOff = true
      enqueueRun(taskId, reviewer.id, REVIEW_TRIGGER, "always")
      insertSystemMessage(taskId, `${actor?.name} finished the work — ${reviewer.name} reviews it here.`)
      pulled = pullNextForCoders(current.board_id, current, actor?.id ?? null)
    }
    if (moving) {
      const fromColumn = current.column_id
      const toColumn = targetColumnId ?? fromColumn
      placeTask(taskId, toColumn, position)
      if (fromColumn !== toColumn) {
        renumber(fromColumn)
        const fromRole = columnRole(fromColumn)
        const toRole = columnRole(toColumn)
        cancelQueuedColumnRuns(taskId)
        // A new column is a new round of work: the next coder run takes its own "before".
        clearWorkSnapshot(taskId)
        recordMove(current.board_id, taskId, fromRole, toRole, actor, patch.plain)
        triggerColumnRuns(taskId, current.board_id, fromRole, toRole, { actorName: actor?.name })
        // The coder handed its card off → it takes the next one right away.
        if (actor?.agentRole === "coder" && (toRole === "review" || toRole === "done")) {
          handedOff = true
          pulled = pullNextForCoders(current.board_id, current, actor.id)
        }
      }
    }
    // Anything else that can free a coder or feed Ready (a card into Ready, a card out of
    // In progress, a tag or blocker change, an archive) → let the queue advance.
    // The last card in In progress / Review left them: a held queue starts its next card.
    const freedBy = heldBefore && !queueHeld(current.board_id) ? freedReason(taskId) : undefined
    if (
      !handedOff &&
      (moving || patch.archived !== undefined || Array.isArray(patch.assigneeIds) || Array.isArray(patch.blockedBy))
    ) {
      pulled = pullNextForCoders(current.board_id, null, null, freedBy)
    }
    if (freedBy) dispatchWaitingReady(current.board_id, freedBy)
  })
  emitChange({ scope: "board", boardId: current.board_id, taskId })
  if (moving && targetColumnId && targetColumnId !== current.column_id) {
    emitChange({ scope: "thread", boardId: current.board_id, taskId })
  }
  for (const id of pulled) emitChange({ scope: "thread", boardId: current.board_id, taskId: id })
  return getTask(taskId)
}

/** Put a card into a column at `position` (end when null) and renumber that column. */
function placeTask(taskId: string, toColumn: string, position: number | null): void {
  const db = getDb()
  const others = (
    db
      .prepare("SELECT id FROM tasks WHERE column_id = ? AND id != ? AND archived = 0 ORDER BY position, updated_at")
      .all(toColumn, taskId) as Array<{ id: string }>
  ).map((r) => r.id)
  const index = position == null ? others.length : Math.min(position, others.length)
  others.splice(index, 0, taskId)
  const update = db.prepare("UPDATE tasks SET column_id = ?, position = ?, updated_at = ? WHERE id = ?")
  const at = nowIso()
  others.forEach((id, i) => update.run(toColumn, i, at, id))
}

// ---------------------------------------------------------------------------
// The conveyor. Ready is the coders' queue: whenever a coder is free, the top Ready
// card that is its (tagged with it, or untagged on a board without an Architect) and
// not waiting for another card moves to In progress by itself, which queues the run.
// On a board with an Architect, untagged cards wait in Ready until the Architect's
// dispatch tags them. On a board without a Ready list the coder only continues through
// Backlog after handing a card off — nothing starts by itself there.
//
// Several coders can each hold a card in In progress, but only one coder run executes
// per repository at a time (see claimRun): they share one checkout. A card whose coder is
// done and whose review is with the Architect stays in In progress but releases its coder
// (`awaitingReview`) — otherwise the queue would wait for the Architect to read the diff.
// A card stopped on the owner's word (`needsOwner`) releases its coder for the same reason:
// the wait is on a human, and it can be hours.

type CoderView = {
  coder: Member
  /** Every live agent on the board. */
  agentIds: Set<string>
  /** The board's first coder takes untagged cards. */
  isDefault: boolean
  hasArchitect: boolean
}

/** Is this card the coder's? `pulling` = deciding whether to take it from the queue. */
function cardIsFor(taskId: string, view: CoderView, { pulling }: { pulling: boolean }): boolean {
  const assigned = (
    getDb().prepare("SELECT member_id FROM task_assignees WHERE task_id = ?").all(taskId) as Array<{
      member_id: string
    }>
  ).map((r) => r.member_id)
  if (assigned.length === 0) return view.isDefault && !(pulling && view.hasArchitect)
  const agents = assigned.filter((id) => view.agentIds.has(id))
  return agents.includes(view.coder.id)
}

/**
 * The coder is done with this card and the Architect's review is the last thing that happened
 * on it, so it no longer occupies its coder even though it is still in In progress. Read off
 * the runs rather than stored on the card: a verdict the Architect never acted on then cannot
 * pin the coder forever, and the moment the card is handed back (a mention run on the coder)
 * it counts again.
 */
function awaitingReview(taskId: string): boolean {
  const row = getDb()
    .prepare("SELECT trigger FROM agent_runs WHERE task_id = ? AND status != 'cancelled' ORDER BY id DESC LIMIT 1")
    .get(taskId) as { trigger: string } | undefined
  return row?.trigger === REVIEW_TRIGGER
}

/**
 * Why this coder cannot take another card right now — `null` when it is free.
 * Busy = a run queued or running for it on this board, or one of its cards in In progress
 * that is still its turn to act on — a card waiting for the Architect's review
 * (`awaitingReview`) or for the owner's word (`needsOwner`) is not.
 * The sentence is what the board shows on a card that is stuck in the queue, so the reason
 * never has to be guessed from the run list (`waitNote`).
 */
function coderBusyReason(boardId: string, view: CoderView, ignoreTaskId: string | null): string | null {
  const db = getDb()
  const active = db
    .prepare(
      "SELECT r.status AS status, t.title AS title FROM agent_runs r JOIN tasks t ON t.id = r.task_id WHERE r.agent_id = ? AND t.board_id = ? AND r.status IN ('queued','running') AND r.task_id != ? ORDER BY CASE r.status WHEN 'running' THEN 0 ELSE 1 END, r.id LIMIT 1"
    )
    .get(view.coder.id, boardId, ignoreTaskId ?? "") as { status: string; title: string } | undefined
  if (active) {
    const verb = active.status === "running" ? "is running on" : "has a run waiting on"
    return `${view.coder.name} ${verb} “${active.title}”`
  }
  const workColumn = columnByRole(boardId, "in_progress")
  if (!workColumn) return "this board has no In progress column"
  const inWork = db
    .prepare("SELECT id, title FROM tasks WHERE column_id = ? AND archived = 0 AND id != ?")
    .all(workColumn, ignoreTaskId ?? "") as Array<{ id: string; title: string }>
  const held = inWork.find(
    (t) => cardIsFor(t.id, view, { pulling: false }) && !awaitingReview(t.id) && !needsOwner(t.id)
  )
  return held ? `${view.coder.name} still has “${held.title}” in progress` : null
}

function coderIsFree(boardId: string, view: CoderView, ignoreTaskId: string | null): boolean {
  return coderBusyReason(boardId, view, ignoreTaskId) === null
}

/** The coders of a board, in board order, as the queue sees them. */
function coderViews(boardId: string): CoderView[] {
  const agents = boardAgents(boardId)
  const agentIds = new Set(agents.map((a) => a.id))
  const hasArchitect = agents.some((a) => a.agentRole === "architect")
  return agents
    .filter((a) => a.agentRole === "coder")
    .map((coder, index) => ({ coder, agentIds, isDefault: index === 0, hasArchitect }))
}

/**
 * A card is sitting in the queue and not moving — why? Shown on the card itself, because a
 * busy coder is otherwise invisible: the card just stays in Ready with nothing in its chat.
 * `null` when there is nothing to explain (the card is blocked — the board already shows its
 * blockers — or it is about to be pulled).
 */
export function queueWaitNote(boardId: string, taskId: string, views = coderViews(boardId)): string | null {
  if (needsOwner(taskId)) return "waiting for the owner"
  if (views.length === 0 || isBlocked(taskId)) return null
  if (queueHeld(boardId)) return "waiting for the current card"
  const mine = views.filter((view) => cardIsFor(taskId, view, { pulling: true }))
  if (mine.length === 0) {
    return views[0].hasArchitect ? "waiting for the Architect to hand it to a coder" : null
  }
  const reasons = mine.map((view) => coderBusyReason(boardId, view, null))
  if (reasons.some((reason) => reason === null)) return null
  return reasons.join(" · ")
}

/**
 * Give every free coder on the board its next card from the queue.
 * `handedOff` is the card `actorId` just finished (its run is still marked running, and
 * Backlog counts as the queue when the board has no Ready list).
 * `freedBy` says why a held queue just came free (`queueHeld`) — the new card's chat opens with it.
 * Returns the ids of the cards that moved to In progress.
 */
function pullNextForCoders(
  boardId: string,
  handedOff: TaskRow | null,
  actorId: string | null,
  freedBy?: string
): string[] {
  if (queueHeld(boardId)) return []
  const db = getDb()
  const agents = boardAgents(boardId)
  const coders = agents.filter((a) => a.agentRole === "coder")
  if (coders.length === 0) return []
  const agentIds = new Set(agents.map((a) => a.id))
  const hasArchitect = agents.some((a) => a.agentRole === "architect")
  const queue = columnByRole(boardId, "ready") ?? (handedOff ? columnByRole(boardId, "backlog") : null)
  const workColumn = columnByRole(boardId, "in_progress")
  if (!queue || !workColumn) return []
  const queueTitle = (db.prepare("SELECT title FROM columns WHERE id = ?").get(queue) as { title: string }).title

  const pulled: string[] = []
  coders.forEach((coder, index) => {
    const view: CoderView = { coder, agentIds, isDefault: index === 0, hasArchitect }
    // The actor's still-running run on the card it handed off does not make it busy.
    if (!coderIsFree(boardId, view, coder.id === actorId ? (handedOff?.id ?? null) : null)) return
    const candidates = db
      .prepare("SELECT id, title FROM tasks WHERE column_id = ? AND archived = 0 ORDER BY position, updated_at")
      .all(queue) as Array<{ id: string; title: string }>
    const next = candidates.find(
      (task) =>
        !pulled.includes(task.id) &&
        cardIsFor(task.id, view, { pulling: true }) &&
        !isBlocked(task.id) &&
        // A card waiting for the owner would start no run in In progress — leave it in the queue.
        !needsOwner(task.id)
    )
    if (!next) return
    placeTask(next.id, workColumn, null)
    renumber(queue)
    cancelQueuedColumnRuns(next.id)
    // The conveyor moved it, not a person: the coder taking it is the actor.
    recordMove(boardId, next.id, columnRole(queue), "in_progress", coder)
    triggerColumnRuns(next.id, boardId, columnRole(queue), "in_progress", {
      note:
        handedOff && coder.id === actorId
          ? `${coder.name} finished “${handedOff.title}” and takes this card next.`
          : freedBy
            ? `${freedBy} — ${coder.name} takes this one.`
            : `${coder.name} is free — takes it from ${queueTitle}.`,
    })
    pulled.push(next.id)
  })
  return pulled
}

export function deleteTask(taskId: string): void {
  const boardId = boardOfTask(taskId)
  const db = getDb()
  const columnId = (db.prepare("SELECT column_id FROM tasks WHERE id = ?").get(taskId) as { column_id: string })
    .column_id
  let pulled: string[] = []
  transaction(db, () => {
    const heldBefore = queueHeld(boardId)
    db.prepare("DELETE FROM tasks WHERE id = ?").run(taskId)
    renumber(columnId)
    const freedBy = heldBefore && !queueHeld(boardId) ? "The current card was deleted" : undefined
    pulled = pullNextForCoders(boardId, null, null, freedBy)
    if (freedBy) dispatchWaitingReady(boardId, freedBy)
  })
  emitChange({ scope: "board", boardId, taskId })
  for (const id of pulled) emitChange({ scope: "thread", boardId, taskId: id })
}

export function listArchived(boardId: string): Task[] {
  const db = getDb()
  const rows = db
    .prepare("SELECT * FROM tasks WHERE board_id = ? AND archived = 1 ORDER BY updated_at DESC")
    .all(boardId) as TaskRow[]
  const assignees = assigneesByTask()
  const blockers = blockersByTask()
  const counts = commentCounts()
  const chatImages = chatImageCounts()
  return rows.map((row) =>
    toTask(
      row,
      assignees.get(row.id) ?? [],
      blockers.get(row.id) ?? [],
      counts.get(row.id) ?? 0,
      null,
      chatImages.get(row.id) ?? 0
    )
  )
}

/** Archive every live card in a column (Done → out of sight). Returns how many. */
export function archiveColumnTasks(columnId: string): number {
  const db = getDb()
  const row = db.prepare("SELECT board_id FROM columns WHERE id = ?").get(columnId) as
    | { board_id: string }
    | undefined
  if (!row) throw new NotFoundError(`Column ${columnId} not found`)
  const ids = (
    db.prepare("SELECT id FROM tasks WHERE column_id = ? AND archived = 0").all(columnId) as Array<{ id: string }>
  ).map((r) => r.id)
  transaction(db, () => {
    const at = nowIso()
    for (const id of ids) {
      cancelQueuedColumnRuns(id)
      db.prepare("UPDATE tasks SET archived = 1, updated_at = ? WHERE id = ?").run(at, id)
    }
  })
  emitChange({ scope: "board", boardId: row.board_id })
  return ids.length
}

/**
 * Column transitions that wake an agent.
 * Ready → the architect dispatches the queue (when the board has an architect and a coder).
 * In progress → the agents tagged on the card; an untagged card goes to the board's first
 *   coder; a card tagged with people only wakes nobody.
 * Review → nobody: the work is over by the time a card gets there (see `REVIEW_TRIGGER`).
 */
function triggerColumnRuns(
  taskId: string,
  boardId: string,
  fromRole: ColumnRole | null,
  toRole: ColumnRole,
  { actorName, note }: { actorName?: string; note?: string } = {}
): void {
  if (fromRole === toRole) return
  const agents = boardAgents(boardId)
  if (agents.length === 0) return
  const coder = agents.find((a) => a.agentRole === "coder")
  const architect = agents.find((a) => a.agentRole === "architect")
  const moved = (column: string) => (actorName ? `${actorName} moved it to ${column}` : `Moved to ${column}`)
  if (toRole === "ready") {
    // A held queue (`queueHeld`) dispatches nothing: `dispatchWaitingReady` does it once it is free.
    if (architect && coder && !queueHeld(boardId) && enqueueDispatch(taskId, boardId, architect)) {
      insertSystemMessage(taskId, note ?? `${moved("Ready")} — ${architect.name} sorts the queue.`)
    }
  } else if (toRole === "in_progress") {
    const assigned = new Set(
      (
        getDb().prepare("SELECT member_id FROM task_assignees WHERE task_id = ?").all(taskId) as Array<{
          member_id: string
        }>
      ).map((r) => r.member_id)
    )
    let targets = agents.filter((a) => assigned.has(a.id))
    // Untagged card → the coder. Tagged with people only → it's theirs, no agent.
    if (targets.length === 0 && assigned.size === 0 && coder) targets = [coder]
    for (const agent of targets) {
      enqueueRun(taskId, agent.id, "column:in_progress")
    }
    if (targets.length > 0) {
      insertSystemMessage(
        taskId,
        note ?? `${moved("In progress")} — ${targets.map((a) => a.name).join(" and ")} picks it up.`
      )
    }
  } else if (toRole === "review" && actorName) {
    insertSystemMessage(taskId, note ?? `${moved("Review")}.`)
  } else if (toRole === "done" && actorName) {
    insertSystemMessage(taskId, note ?? `${moved("Done")}.`)
  }
}

// ---------------------------------------------------------------------------
// Writes: chat

const MENTION_RE = /@([a-z0-9_]+)/gi

/**
 * How much of an agent's answer goes back to Telegram. Longer than the feed's glance line: the
 * owner reads this one as a message in a chat, not as a buzz on a lock screen.
 */
const ANSWER_MAX = 600

/**
 * The part of a message where a handle is addressed to somebody, as opposed to talked about.
 * A review that quotes `@coder` inside backticks, pastes a prompt in a ``` block or cites an
 * earlier message with `>` is describing the handle, not calling the agent — and a mention run
 * on a card that is already finished is pure damage.
 */
function addressedText(text: string): string {
  const lines: string[] = []
  let inFence = false
  for (const line of text.split("\n")) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    if (/^\s*>/.test(line)) continue
    lines.push(line.replace(/`[^`]*`/g, " "))
  }
  return lines.join("\n")
}

/**
 * A message as the caller that wrote it gets it back, with the one thing it cannot see from the
 * message itself: `woke` — the handles of the agents this message put a run in the queue for.
 * The Telegram bot reads it to know whether anybody on this board is going to answer at all
 * (`agents/telegram.mjs`): empty means the text is filed and nobody was woken.
 */
export type PostedMessage = Message & { woke: string[] }

export function addMessage(input: {
  taskId: string
  authorId?: unknown
  text: unknown
  kind?: unknown
  /**
   * false = an agent's note that is not about this card (a dispatch reply lands on the card
   * that opened the queue). It neither makes the author a participant nor wakes the agents it
   * names: a dispatch note talks about the coders it hands cards to, and those handles are not
   * a request to anybody.
   */
  participant?: unknown
  /**
   * Where the message came in from, when it was not the board's own UI — `telegram` for a reply
   * to a notification in the bot. Anything the board does not know is stored as nothing: a
   * source is a label in the UI, never a reason to refuse a message the owner has written.
   */
  source?: unknown
  /**
   * The owner's own message in Telegram, when the bot is the one bringing this in: the answer of
   * whoever this message wakes goes back to Telegram as a reply to it (`answerToTelegram`).
   */
  telegramMessageId?: unknown
}): PostedMessage {
  const db = getDb()
  const taskId = input.taskId
  const boardId = boardOfTask(taskId)
  const authorId = typeof input.authorId === "string" && input.authorId ? input.authorId : ownerId()
  const author = db.prepare("SELECT * FROM members WHERE id = ?").get(authorId) as MemberRow | undefined
  if (!author) throw new ValidationError(`Unknown author ${authorId}`)
  const kind: MessageKind = input.kind === "system" ? "system" : "chat"
  const source = MESSAGE_SOURCES.includes(input.source as MessageSource) ? (input.source as MessageSource) : null
  const text = cleanText(input.text, "text", { required: true, max: 20000 })
  const fromTelegram = Math.trunc(Number(input.telegramMessageId))
  const telegramMessageId = Number.isSafeInteger(fromTelegram) && fromTelegram > 0 ? fromTelegram : null

  let messageId = 0
  // The message took the card off "waiting for the owner" — the queue may have work for it.
  let freed = false
  let pulled: string[] = []
  let woke: string[] = []
  transaction(db, () => {
    const result = db
      .prepare(
        "INSERT INTO messages (task_id, author_id, kind, source, telegram_message_id, text, created_at)" +
          " VALUES (?, ?, ?, ?, ?, ?, ?)"
      )
      .run(taskId, authorId, kind, source, telegramMessageId, text, nowIso())
    messageId = Number(result.lastInsertRowid)
    if (kind === "chat" && input.participant !== false) {
      // A human weighing in is exactly what a card waiting for the owner was waiting for —
      // the flag comes off before the mentions are read, so their @agent wakes it as usual.
      if (author.kind === "human" && releaseNeedsOwner(taskId, boardId, toMember(author))) {
        insertSystemMessage(taskId, `${author.name} answered — the card no longer waits for the owner.`)
        freed = true
      }
      // Once an agent posts, its assigned task shows it as a participant.
      if (author.kind === "agent") {
        db.prepare(
          "INSERT OR IGNORE INTO task_assignees (task_id, member_id, position) VALUES (?, ?, (SELECT COALESCE(MAX(position), -1) + 1 FROM task_assignees WHERE task_id = ?))"
        ).run(taskId, authorId, taskId)
      }
      woke = triggerMentions(taskId, boardId, toMember(author), text, messageId)
      if (author.kind === "agent") answerToTelegram(boardId, taskId, toMember(author), text, messageId)
      if (freed) pulled = pullNextForCoders(boardId, null, null)
    }
  })
  emitChange({ scope: "thread", boardId, taskId })
  emitChange({ scope: "board", boardId, taskId })
  for (const id of pulled) emitChange({ scope: "thread", boardId, taskId: id })
  const row = db.prepare("SELECT * FROM messages WHERE id = ?").get(messageId) as MessageRow
  return { ...toMessage(row), woke }
}

/**
 * The owner wrote to a card from Telegram, an agent answered it here: that answer goes back to
 * Telegram as a reply to their own message (`agents/notify.mjs` sends it).
 *
 * Which message an answer answers is the run's own trigger — `owner:<id>` / `mention:<id>` name
 * the message that woke the agent, and that message knows whether the bot brought it in. Exactly
 * one answer per message of theirs: `telegram_answered_at` is stamped here, so a second run on
 * the same trigger, and everything the agents go on to say on the card, stay on the board.
 */
function answerToTelegram(
  boardId: string,
  taskId: string,
  author: Member,
  text: string,
  messageId: number
): void {
  const db = getDb()
  const run = db
    .prepare("SELECT trigger FROM agent_runs WHERE task_id = ? AND agent_id = ? ORDER BY id DESC LIMIT 1")
    .get(taskId, author.id) as { trigger: string } | undefined
  const trigger = run?.trigger.match(/^(?:owner|mention):(\d+)$/)
  if (!trigger) return
  const asked = db
    .prepare(
      "SELECT id, telegram_message_id AS telegramMessageId FROM messages" +
        " WHERE id = ? AND task_id = ? AND telegram_message_id IS NOT NULL AND telegram_answered_at IS NULL"
    )
    .get(Number(trigger[1]), taskId) as { id: number; telegramMessageId: number } | undefined
  if (!asked) return
  db.prepare("UPDATE messages SET telegram_answered_at = ? WHERE id = ?").run(nowIso(), asked.id)
  recordEvent({
    boardId,
    taskId,
    type: "agent_answered",
    actorId: author.id,
    summary: `${author.name || author.handle} answered the owner's Telegram message on ${cardLabel(taskId)}`,
    data: {
      author: author.handle,
      messageId,
      replyTo: asked.telegramMessageId,
      // The agent's own words for the owner, and the whole of what leaves the board: its
      // `In short:` line, or its prose with the code, the fences and the paths taken out. Kept in
      // `data` rather than in the feed's `plain`, which is a glance (300 characters) — an answer
      // is read as a message, so it gets the room a message needs.
      answer: askedLine(text, ANSWER_MAX),
    },
  })
}

/** The handles of the agents this message put a run in the queue for — see `PostedMessage`. */
function triggerMentions(
  taskId: string,
  boardId: string,
  author: Member,
  text: string,
  messageId: number
): string[] {
  const agents = boardAgents(boardId)
  const handles = new Set(Array.from(addressedText(text).matchAll(MENTION_RE), (m) => m[1].toLowerCase()))
  // Somebody tagged the owner by handle. The prompts allow that tag for one thing only — a
  // question only the owner can answer — so it is worth a notification, the same way a card
  // reaching Review is. The owner's own messages are not news, and neither is a handle outside
  // the addressed part: `@max` in backticks or in a quoted line is talk about the owner.
  if (!author.isOwner && handles.has(ownerHandle())) {
    recordEvent({
      boardId,
      taskId,
      type: "owner_mentioned",
      actorId: author.id,
      summary: `${author.name || author.handle} asked the owner on ${cardLabel(taskId)}`,
      // What the notification quotes: the author's own line for the owner. The rest of the
      // message stays in the chat.
      plain: askedLine(text),
      data: { author: author.handle, messageId },
    })
  }
  // The owner writes in a card's chat and forgets the tag — and the message sits there with
  // nobody woken by it. Untagged (not one handle in the addressed part) it is addressed to the
  // board's own architect; a tag is still a tag and wakes only the agents it names.
  const untaggedOwner = author.kind === "human" && author.isOwner && handles.size === 0
  if (untaggedOwner && !architectEnabled(boardId)) {
    // This board is planned from the outside (a chat with the owner): no run here, but the
    // message must not be lost either — the feed is how that architect hears about it. The
    // text itself stays in the card's chat, where it can be read in full.
    recordEvent({
      boardId,
      taskId,
      type: "owner_message",
      actorId: author.id,
      summary: `${author.name || "The owner"} wrote on ${cardLabel(taskId)} without tagging anybody`,
      data: { author: author.handle, messageId },
    })
    return []
  }
  if (agents.length === 0) return []
  const mentioned = untaggedOwner
    ? agents.filter((a) => a.agentRole === "architect")
    : agents.filter((a) => handles.has(a.handle.toLowerCase()) && a.id !== author.id)
  if (mentioned.length === 0) return []
  // The card waits for the owner, and the message that got here was not a human's (those
  // clear the flag before this runs): no run, and no dragging the card into In progress.
  if (needsOwner(taskId)) return []
  // The work on this card is over. A human can still reopen it by name; between agents, a
  // handle on a reviewed or closed card is talk about the card, not a new job on it.
  if (author.kind === "agent" && isFinishedCard(taskId)) return []

  if (author.kind === "agent" && agentChainLength(taskId) >= MAX_AGENT_CHAIN) {
    insertSystemMessage(
      taskId,
      `Agents paused after ${MAX_AGENT_CHAIN} messages in a row — waiting for a human to weigh in.`
    )
    recordEvent({
      boardId,
      taskId,
      type: "agents_paused",
      actorId: author.id,
      summary: `Agents paused on ${cardLabel(taskId)} after ${MAX_AGENT_CHAIN} messages in a row — waiting for a human`,
      data: { messages: MAX_AGENT_CHAIN },
    })
    return []
  }
  moveMentionedCardToWork(taskId, boardId, mentioned)
  // An agent already working on the card is interrupted only by a human: an agent tagging
  // another agent mid-run is a remark in the thread, not a reason for a second run.
  const busy: WhenBusy = author.kind === "human" ? "follow" : "skip"
  // `owner:<id>` is the untagged message of the owner: the architect reads it as a request of
  // its own (and only there may it put a card into Done), not as somebody's mention.
  const trigger = untaggedOwner ? `owner:${messageId}` : `mention:${messageId}`
  for (const agent of mentioned) {
    enqueueRun(taskId, agent.id, trigger, busy)
  }
  return mentioned.map((agent) => agent.handle)
}

/**
 * A coder mentioned on a card that still sits in the queue starts working on it right away,
 * so the card has to follow it into In progress: otherwise it keeps the “working” badge in
 * the queue while In progress stays empty, and the queue stalls for that coder — `coderIsFree`
 * counts it busy for as long as the mention run lives. Only out of the queue column: a mention
 * in Review or Done must not drag a card backwards.
 */
function moveMentionedCardToWork(taskId: string, boardId: string, mentioned: Member[]): void {
  const coder = mentioned.find((a) => a.agentRole === "coder")
  if (!coder) return
  const db = getDb()
  const columnId = (db.prepare("SELECT column_id FROM tasks WHERE id = ?").get(taskId) as { column_id: string })
    .column_id
  const queue = columnByRole(boardId, "ready") ?? columnByRole(boardId, "backlog")
  const workColumn = columnByRole(boardId, "in_progress")
  if (!queue || !workColumn || columnId !== queue) return
  // Before the mention run is queued, so this cannot cancel the run that causes the move.
  cancelQueuedColumnRuns(taskId)
  placeTask(taskId, workColumn, null)
  renumber(queue)
  insertSystemMessage(taskId, `${coder.name} was mentioned — takes it to In progress.`)
  recordMove(boardId, taskId, columnRole(columnId), "in_progress", coder)
}

/** Is the card past the work — in Review or Done? */
function isFinishedCard(taskId: string): boolean {
  const row = getDb().prepare("SELECT column_id FROM tasks WHERE id = ?").get(taskId) as
    | { column_id: string }
    | undefined
  if (!row) return false
  const role = columnRole(row.column_id)
  return role === "review" || role === "done"
}

/** How many chat messages at the tail of the thread were written by agents. */
function agentChainLength(taskId: string): number {
  const rows = getDb()
    .prepare(
      "SELECT m.author_id, mem.kind FROM messages m JOIN members mem ON mem.id = m.author_id WHERE m.task_id = ? AND m.kind = 'chat' ORDER BY m.id DESC LIMIT ?"
    )
    .all(taskId, MAX_AGENT_CHAIN + 1) as Array<{ author_id: string; kind: string }>
  let n = 0
  for (const row of rows) {
    if (row.kind !== "agent") break
    n += 1
  }
  return n
}

// ---------------------------------------------------------------------------
// Writes: reactions
//
// A reaction is the owner saying one thing without typing it: 👍 = «the work is done, move the
// card to Done». One reaction and one meaning (`REACTIONS`) — the board acts on what a reaction
// means, and a gesture carries one meaning well and five badly. A question of an agent's
// they answer in words; nothing else an emoji could say is worth guessing at.
//
// Only the owner's 👍 does anything, and only on a card in **Review**: the board moves it to Done
// itself, no agent run. Anybody else's, and the owner's anywhere else, is a mark on the message.
// Nothing here is notified about: the owner hears about a question, a Review, a Done and a
// failure, and a reaction is their own doing.
//
// A reaction carries the authority of a message from Telegram — enough to move a card, never
// enough for a paid call, a write to the corpus or a deploy. That rule lives in the prompts
// (`agents/prompts/*.md`), because it is the agents that have to keep it.

type ReactionInput = {
  taskId: string
  /**
   * The card's message the reaction is on. Nothing = on the card itself, which is what a
   * reaction on a Telegram notification with no board message behind it comes in as.
   */
  messageId?: unknown
  emoji: unknown
  /** Who reacted; the owner when the caller does not say — the bot speaks for them. */
  memberId?: unknown
}

/** 👍, or a ValidationError: the board has no meaning for anything else. */
function cleanEmoji(value: unknown): ReactionEmoji {
  const emoji = typeof value === "string" ? value.trim() : ""
  if (!REACTIONS.includes(emoji as ReactionEmoji)) {
    throw new ValidationError(`emoji must be one of ${REACTIONS.join(" ")}`)
  }
  return emoji as ReactionEmoji
}

function reactionMember(memberId: unknown): Member {
  const id = typeof memberId === "string" && memberId ? memberId : ownerId()
  const row = getDb().prepare("SELECT * FROM members WHERE id = ?").get(id) as MemberRow | undefined
  if (!row) throw new NotFoundError(`Unknown member ${id}`)
  return toMember(row)
}

/** The message the reaction is on — null when there is none, and it is the card's own. */
function reactionMessage(taskId: string, messageId: unknown): MessageRow | null {
  if (messageId === undefined || messageId === null || messageId === "") return null
  const id = Math.trunc(Number(messageId))
  if (!Number.isSafeInteger(id) || id <= 0) throw new ValidationError("messageId must be a positive integer")
  const row = getDb().prepare("SELECT * FROM messages WHERE id = ?").get(id) as MessageRow | undefined
  if (!row) throw new NotFoundError(`Message ${id} not found`)
  if (row.task_id !== taskId) throw new ValidationError(`Message ${id} is not on ${taskId}`)
  return row
}

/** The owner's 👍 on a card in Review is their last look passing: the board closes it itself. */
function closeReviewedCard(taskId: string, owner: Member): boolean {
  const row = getDb().prepare("SELECT column_id FROM tasks WHERE id = ?").get(taskId) as
    | { column_id: string }
    | undefined
  if (!row || columnRole(row.column_id) !== "review") return false
  insertSystemMessage(taskId, `${owner.name || owner.handle} reacted 👍 — the card goes to Done.`)
  // The move writes the feed's `card_moved` line itself, which is what the owner is notified
  // about; `actorId` is for agents only, so the line reads as a move nobody signed, like a drag.
  updateTask(taskId, { columnRole: "done" })
  return true
}

/** What the board does about a reaction, beyond storing it. See the section comment. */
function applyReaction(taskId: string, member: Member, emoji: ReactionEmoji): ReactionEffect {
  if (!member.isOwner) return "none"
  return emoji === "👍" && closeReviewedCard(taskId, member) ? "done" : "none"
}

/**
 * Put a reaction on a card's message (or on the card, when there is no message to put it on) and
 * do whatever it means. Putting the same one twice is the same reaction — the row is already
 * there — but it is still read as what it says: the owner reacting again on a card that did not
 * move must not be silence.
 */
export function addReaction(input: ReactionInput): ReactionResult {
  const db = getDb()
  const emoji = cleanEmoji(input.emoji)
  const member = reactionMember(input.memberId)
  const boardId = boardOfTask(input.taskId)
  const message = reactionMessage(input.taskId, input.messageId)

  let reaction: Reaction | null = null
  if (message) {
    db.prepare(
      "INSERT OR IGNORE INTO message_reactions (message_id, member_id, emoji, created_at) VALUES (?, ?, ?, ?)"
    ).run(message.id, member.id, emoji, nowIso())
    const row = db
      .prepare("SELECT created_at AS createdAt FROM message_reactions WHERE message_id = ? AND member_id = ? AND emoji = ?")
      .get(message.id, member.id, emoji) as { createdAt: string }
    reaction = { messageId: message.id, taskId: input.taskId, memberId: member.id, emoji, createdAt: row.createdAt }
  }
  const effect = applyReaction(input.taskId, member, emoji)
  recordEvent({
    boardId,
    taskId: input.taskId,
    type: "reaction_added",
    actorId: member.id,
    summary: `${member.name} reacted ${emoji} on ${cardLabel(input.taskId)}`,
    data: { emoji, messageId: message?.id ?? null, effect },
  })
  emitChange({ scope: "thread", boardId, taskId: input.taskId })
  emitChange({ scope: "board", boardId, taskId: input.taskId })
  return { reaction, effect }
}

/** Take a reaction off. Taking one off means nothing to the board — it undoes nothing. */
export function removeReaction(input: ReactionInput): { removed: boolean } {
  const db = getDb()
  const emoji = cleanEmoji(input.emoji)
  const member = reactionMember(input.memberId)
  const boardId = boardOfTask(input.taskId)
  const message = reactionMessage(input.taskId, input.messageId)
  if (!message) return { removed: false }
  const result = db
    .prepare("DELETE FROM message_reactions WHERE message_id = ? AND member_id = ? AND emoji = ?")
    .run(message.id, member.id, emoji)
  const removed = Number(result.changes) > 0
  if (!removed) return { removed: false }
  recordEvent({
    boardId,
    taskId: input.taskId,
    type: "reaction_removed",
    actorId: member.id,
    summary: `${member.name} took ${emoji} off a message on ${cardLabel(input.taskId)}`,
    data: { emoji, messageId: message.id, effect: "none" },
  })
  emitChange({ scope: "thread", boardId, taskId: input.taskId })
  emitChange({ scope: "board", boardId, taskId: input.taskId })
  return { removed }
}

// ---------------------------------------------------------------------------
// Agent runs

/** Is another coder's run executing in this board's repository right now? */
function repoHasRunningCoder(boardId: string, exceptAgentId: string): boolean {
  const boardIds = sameRepoBoardIds(boardId)
  const marks = boardIds.map(() => "?").join(",")
  const row = getDb()
    .prepare(
      `SELECT 1 FROM agent_runs r JOIN tasks t ON t.id = r.task_id JOIN members m ON m.id = r.agent_id WHERE r.status = 'running' AND m.agent_role = 'coder' AND r.agent_id != ? AND t.board_id IN (${marks}) LIMIT 1`
    )
    .get(exceptAgentId, ...boardIds)
  return !!row
}

function queueCard(row: TaskRow, handleOf: Map<string, string>, boardKey: string): QueueCard {
  const assignees = (
    getDb().prepare("SELECT member_id FROM task_assignees WHERE task_id = ? ORDER BY position").all(row.id) as Array<{
      member_id: string
    }>
  )
    .map((r) => handleOf.get(r.member_id))
    .filter((h): h is string => !!h)
  return {
    id: row.id,
    ref: taskRef(boardKey, row.number) ?? row.id,
    title: row.title,
    description: row.description.length > 800 ? `${row.description.slice(0, 800)}…` : row.description,
    column: columnRole(row.column_id),
    assignees,
    blockedBy: blockersOf(row.id),
    parentId: row.parent_id,
  }
}

/**
 * Hand the oldest queued run for this agent to the worker — one at a time per agent.
 * Coders share one checkout per repository, so a coder run waits while another coder's
 * run is executing there (a run on a board with a different folder can still go).
 */
export function claimRun(agentId: string): RunContext | null {
  const db = getDb()
  const agent = db.prepare("SELECT * FROM members WHERE id = ? AND kind = 'agent'").get(agentId) as
    | MemberRow
    | undefined
  if (!agent) throw new ValidationError(`Unknown agent ${agentId}`)
  // Before looking for work: a run nobody is executing any more must not keep this agent busy.
  sweepLostRuns()

  const claimed = transaction(db, () => {
    const running = db
      .prepare("SELECT id FROM agent_runs WHERE agent_id = ? AND status = 'running' LIMIT 1")
      .get(agentId) as { id: number } | undefined
    if (running) return null
    const waiting = db
      .prepare("SELECT * FROM agent_runs WHERE agent_id = ? AND status = 'queued' ORDER BY id")
      .all(agentId) as RunRow[]
    const next =
      agent.agent_role === "coder"
        ? waiting.find((run) => !repoHasRunningCoder(boardOfTask(run.task_id), agentId))
        : waiting[0]
    if (!next) return null
    db.prepare("UPDATE agent_runs SET status = 'running', started_at = ?, heartbeat_at = ? WHERE id = ?").run(
      nowIso(),
      nowIso(),
      next.id
    )
    return next.id
  })
  if (claimed == null) return null

  const run = getRun(claimed)
  const task = getTask(run.taskId)
  const boardRow = db.prepare("SELECT * FROM boards WHERE id = ?").get(task.boardId) as BoardRow
  const columns = (
    db.prepare("SELECT id, title, role FROM columns WHERE board_id = ? ORDER BY position").all(task.boardId) as Array<{
      id: string
      title: string
      role: string
    }>
  ).map((c) => ({ id: c.id, title: c.title, role: c.role as ColumnRole }))
  const memberRows = db
    .prepare(
      "SELECT m.* FROM members m JOIN board_members bm ON bm.member_id = m.id WHERE bm.board_id = ? ORDER BY bm.position"
    )
    .all(task.boardId) as MemberRow[]
  const thread = listMessages(run.taskId)
  const triggerMatch = run.trigger.match(/^(?:mention|check|owner|continue):(\d+)$/)
  const triggerMessage = triggerMatch ? (thread.find((m) => m.id === Number(triggerMatch[1])) ?? null) : null

  let queue: RunContext["queue"] = null
  if (run.trigger === "dispatch") {
    const handleOf = new Map(memberRows.map((m) => [m.id, m.handle]))
    const cardsIn = (role: ColumnRole): QueueCard[] => {
      const columnId = columnByRole(task.boardId, role)
      if (!columnId) return []
      const rows = db
        .prepare("SELECT * FROM tasks WHERE column_id = ? AND archived = 0 ORDER BY position, updated_at")
        .all(columnId) as TaskRow[]
      return rows.map((row) => queueCard(row, handleOf, boardRow.key ?? ""))
    }
    queue = { ready: cardsIn("ready"), inProgress: cardsIn("in_progress") }
  }

  recordEvent({
    boardId: task.boardId,
    taskId: task.id,
    type: "run_started",
    actorId: agent.id,
    summary: `${agent.name} started on ${cardLabel(task.id)} (${run.trigger})`,
    data: { agent: agent.handle, trigger: run.trigger },
  })
  emitChange({ scope: "runs", boardId: task.boardId, taskId: task.id })
  emitChange({ scope: "board", boardId: task.boardId, taskId: task.id })
  return {
    run,
    task,
    agent: toMember(agent),
    board: {
      id: boardRow.id,
      name: boardRow.name,
      key: boardRow.key ?? "",
      repoPath: boardRow.repo_path,
      checkCommand: boardRow.check_command || null,
      columns,
    },
    members: memberRows.map(toMember),
    thread,
    triggerMessage,
    queue,
  }
}

/**
 * Stop a run. Queued → cancelled right away. Running → flagged; the worker sees the flag
 * on its next poll, kills the CLI and finishes the run as cancelled. The card stays put.
 */
export function cancelRun(runId: number): Run {
  const db = getDb()
  const run = getRun(runId)
  if (run.status === "queued") {
    db.prepare("UPDATE agent_runs SET status = 'cancelled', finished_at = ?, summary = 'Stopped before it started' WHERE id = ? AND status = 'queued'").run(nowIso(), runId)
    insertSystemMessage(run.taskId, "Run stopped before it started.")
  } else if (run.status === "running") {
    db.prepare("UPDATE agent_runs SET cancel_requested = 1 WHERE id = ?").run(runId)
  } else {
    throw new ValidationError("This run has already finished")
  }
  const boardId = boardOfTask(run.taskId)
  emitChange({ scope: "runs", boardId, taskId: run.taskId })
  emitChange({ scope: "board", boardId, taskId: run.taskId })
  emitChange({ scope: "thread", boardId, taskId: run.taskId })
  return getRun(runId)
}

/** A tree snapshot is one line per dirty path — a big working tree makes a big one. */
const WORK_SNAPSHOT_MAX = 2_000_000

/**
 * The state of the repository when work on this card started, kept here so the commit after a
 * hand-off covers the whole card and not just the run that happened to say "done": the work and
 * the hand-off are usually two different runs (a chat message starts a new one).
 *
 * First caller wins — the worker offers what it sees at the start of every coder run, and gets
 * back whatever the card already had. Cleared when the card changes column and when a commit
 * lands, so the next round of work starts from where that commit left the tree.
 *
 * Only a card being worked on keeps one: elsewhere there is no "start of the work" to point at,
 * and a snapshot nothing clears would let an edit the owner makes much later count as the
 * agent's. Answers `{ snapshot: null }` then — the run commits against its own start, as before.
 */
export function keepWorkSnapshot(taskId: string, snapshot: unknown): { snapshot: string | null } {
  const db = getDb()
  const offered = typeof snapshot === "string" ? snapshot : ""
  if (offered.length > WORK_SNAPSHOT_MAX) throw new ValidationError("snapshot is too long")
  return transaction(db, () => {
    const row = db.prepare("SELECT column_id, work_snapshot AS s FROM tasks WHERE id = ?").get(taskId) as
      | { column_id: string; s: string | null }
      | undefined
    if (!row) throw new NotFoundError(`Task ${taskId} not found`)
    if (row.s) return { snapshot: row.s }
    if (columnRole(row.column_id) !== "in_progress") return { snapshot: null }
    if (!offered) return { snapshot: null }
    db.prepare("UPDATE tasks SET work_snapshot = ? WHERE id = ?").run(offered, taskId)
    return { snapshot: offered }
  })
}

/** Forget the card's "before" snapshot: the work it covered is committed, or the card moved on. */
export function clearWorkSnapshot(taskId: string): void {
  getDb().prepare("UPDATE tasks SET work_snapshot = NULL WHERE id = ?").run(taskId)
}

// ---------------------------------------------------------------------------
// Waiting for the owner
//
// Some things an agent must not decide alone: spending money on a model call, writing to the
// corpus, deploying — and a question nothing in the repository answers. Until now a coder
// could only write that into the card's chat and stop, which from the board looks exactly like
// a run that went quiet. The flag makes it a state of the card: a badge, a feed line, and no
// agent run queued here until a human says go.

/** What each reason is called in the chat and in the feed. */
const NEEDS_OWNER_LABEL: Record<NeedsOwnerReason, string> = {
  paid_call: "a paid model call",
  corpus_write: "writing to the corpus",
  deploy: "a deploy",
  question: "a question only a human can answer",
}

/** How much of the agent's one line the flag keeps. */
const NEEDS_OWNER_TEXT_MAX = 300

/**
 * An agent stops the card on the owner's word (`ACTIONS: {"needs": "owner", …}`).
 *
 * The card does not move: it stays where it is with the flag on it. Everything queued on it
 * is cancelled and nothing new is queued (`enqueueRun`) until a human writes in its chat or
 * clears the flag by hand — otherwise the agent would be woken by the very move or mention
 * that its question is about.
 */
export function setNeedsOwner(
  taskId: string,
  input: { actorId: unknown; reason: unknown; text: unknown; plain?: unknown }
): { needsOwner: NeedsOwner } {
  const db = getDb()
  const boardId = boardOfTask(taskId)
  const actor = boardAgents(boardId).find((a) => a.id === input.actorId)
  if (!actor) throw new ValidationError("Only an agent on this board can ask for the owner")
  const reason = typeof input.reason === "string" ? (input.reason.trim().toLowerCase() as NeedsOwnerReason) : null
  if (!reason || !NEEDS_OWNER_REASONS.includes(reason)) {
    throw new ValidationError(`reason must be one of ${NEEDS_OWNER_REASONS.join(", ")}`)
  }
  const text = cleanText(input.text, "text", { max: NEEDS_OWNER_TEXT_MAX }) || NEEDS_OWNER_LABEL[reason]
  const owner = listMembers().find((m) => m.isOwner)

  transaction(db, () => {
    db.prepare("UPDATE tasks SET needs_owner_reason = ?, needs_owner_text = ?, updated_at = ? WHERE id = ?").run(
      reason,
      text,
      nowIso(),
      taskId
    )
    // Runs already waiting here were asked for before the card stopped; letting them start
    // would wake exactly the agent that is waiting for an answer.
    db.prepare(
      "UPDATE agent_runs SET status = 'cancelled', finished_at = ?, summary = 'The card is waiting for the owner' WHERE task_id = ? AND status = 'queued'"
    ).run(nowIso(), taskId)
    insertSystemMessage(
      taskId,
      `${actor.name} needs ${owner?.name ?? "the owner"} before going on (${NEEDS_OWNER_LABEL[reason]}): ${text}` +
        `\n\nThe card stays where it is and wakes no agent until a human answers here.`
    )
    recordEvent({
      boardId,
      taskId,
      type: "needs_owner",
      actorId: actor.id,
      summary: `${actor.name} is waiting for the owner on ${cardLabel(taskId)} (${reason}): ${text}`,
      // The agent's line for the owner, not `text`: that one is the question as the agent put it
      // to the board, and may name a file or a value. What travels is what was written to travel.
      plain: input.plain,
      data: { reason, text, agent: actor.handle },
    })
  })
  emitChange({ scope: "board", boardId, taskId })
  emitChange({ scope: "thread", boardId, taskId })
  emitChange({ scope: "runs", boardId, taskId })
  const needs = getTask(taskId).needsOwner
  if (!needs) throw new NotFoundError("The flag vanished after it was set")
  return { needsOwner: needs }
}

/**
 * Take the flag off: inside `addMessage` when a human writes on the card, and from the badge.
 * Called inside the caller's transaction; returns whether there was anything to clear.
 */
function releaseNeedsOwner(taskId: string, boardId: string, by: Member | null): boolean {
  const db = getDb()
  const row = db
    .prepare("SELECT needs_owner_reason AS reason, needs_owner_text AS text FROM tasks WHERE id = ?")
    .get(taskId) as { reason: string | null; text: string | null } | undefined
  if (!row?.reason) return false
  db.prepare("UPDATE tasks SET needs_owner_reason = NULL, needs_owner_text = '' WHERE id = ?").run(taskId)
  recordEvent({
    boardId,
    taskId,
    type: "needs_owner",
    actorId: by?.id ?? null,
    summary: `${by?.name ?? "Somebody"} let ${cardLabel(taskId)} go on — it no longer waits for the owner`,
    data: { reason: row.reason, text: row.text ?? "", cleared: true },
  })
  return true
}

/** The button on the badge: the card is no longer waiting, whatever the owner decided. */
export function clearNeedsOwner(taskId: string, input: { actorId?: unknown } = {}): { cleared: boolean } {
  const db = getDb()
  const boardId = boardOfTask(taskId)
  const by =
    listMembers().find((m) => m.id === input.actorId && m.kind === "human") ??
    listMembers().find((m) => m.isOwner) ??
    null
  let cleared = false
  let pulled: string[] = []
  transaction(db, () => {
    cleared = releaseNeedsOwner(taskId, boardId, by)
    if (!cleared) return
    insertSystemMessage(taskId, `${by?.name ?? "Somebody"} took the “waiting for the owner” flag off.`)
    // The card may have been sitting in the queue only because of the flag.
    pulled = pullNextForCoders(boardId, null, null)
  })
  if (cleared) {
    emitChange({ scope: "board", boardId, taskId })
    emitChange({ scope: "thread", boardId, taskId })
    for (const id of pulled) emitChange({ scope: "thread", boardId, taskId: id })
  }
  return { cleared }
}

/** How many characters of a failed check's output go into the card's chat. */
const CHECK_OUTPUT_MAX = 2500

/**
 * The board's check command ran after a coder's hand-off (reported by the worker).
 *
 * Exit 0 — nothing to do but say so in the feed; the card goes on to the commit. Anything else
 * and the card stays in In progress, the output lands in the chat, and the coder gets one
 * automatic retry run (`check:<messageId>`); after that it is up to a human.
 */
export function reportCheck(
  taskId: string,
  input: { actorId: unknown; command: unknown; exitCode: unknown; output: unknown }
): { retry: boolean } {
  const db = getDb()
  const boardId = boardOfTask(taskId)
  const coder = boardAgents(boardId).find((a) => a.id === input.actorId && a.agentRole === "coder")
  if (!coder) throw new ValidationError("Only a coder on this board can report a check")
  const command = cleanText(input.command, "command", { required: true, max: 500 })
  const code = Number.isInteger(input.exitCode) ? Number(input.exitCode) : null
  let output = typeof input.output === "string" ? input.output.trim() : ""
  if (output.length > CHECK_OUTPUT_MAX) output = `…${output.slice(-CHECK_OUTPUT_MAX)}`

  if (code === 0) {
    recordEvent({
      boardId,
      taskId,
      type: "check_passed",
      actorId: coder.id,
      summary: `Check passed on ${cardLabel(taskId)}: ${command}`,
      data: { command, exitCode: 0 },
    })
    return { retry: false }
  }
  recordEvent({
    boardId,
    taskId,
    type: "check_failed",
    actorId: coder.id,
    // The command and the exit code only — the output is in the chat and in the run log.
    summary: `Check failed${code != null ? ` (exit ${code})` : ""} on ${cardLabel(taskId)}: ${command}`,
    data: { command, exitCode: code },
  })

  // One automatic retry: if the coder's last finished run on this card was already a
  // check retry, stop here and let a human look.
  const last = db
    .prepare(
      "SELECT trigger FROM agent_runs WHERE task_id = ? AND agent_id = ? AND status IN ('done','failed') ORDER BY id DESC LIMIT 1"
    )
    .get(taskId, coder.id) as { trigger: string } | undefined
  const retry = !(last && last.trigger.startsWith("check:"))

  let messageId = 0
  transaction(db, () => {
    const text =
      `Check failed${code != null ? ` (exit ${code})` : ""}: \`${command}\` — the card stays in In progress.` +
      (output ? `\n\n\`\`\`\n${output}\n\`\`\`` : "") +
      (retry ? `\n\n${coder.name} gets one more go at it.` : `\n\nAlready retried once — a human needs to look.`)
    const result = db
      .prepare("INSERT INTO messages (task_id, author_id, kind, text, created_at) VALUES (?, ?, 'system', ?, ?)")
      .run(taskId, ownerId(), text, nowIso())
    messageId = Number(result.lastInsertRowid)
    if (retry) enqueueRun(taskId, coder.id, `check:${messageId}`, "always")
  })
  emitChange({ scope: "thread", boardId, taskId })
  emitChange({ scope: "board", boardId, taskId })
  return { retry }
}

/** How many of a commit's paths the feed line names before it stops counting them out. */
const COMMIT_FILES_IN_SUMMARY = 3

/**
 * The commit the board made for a card, or why it made none (reported by the worker — the sha
 * and the paths exist nowhere else on this side). Writes a feed line and nothing else: the
 * chat already gets the worker's own "Committed …" / "No file changes …" / "Commit failed …" message.
 */
export function reportCommit(
  taskId: string,
  input: { actorId: unknown; sha?: unknown; files?: unknown; skipped?: unknown }
): { recorded: boolean } {
  const boardId = boardOfTask(taskId)
  const coder = boardAgents(boardId).find((a) => a.id === input.actorId && a.agentRole === "coder")
  if (!coder) throw new ValidationError("Only a coder on this board can report a commit")
  const label = cardLabel(taskId)

  const reason = cleanText(input.skipped, "skipped", { max: 300 })
  if (reason) {
    recordEvent({
      boardId,
      taskId,
      type: "commit_skipped",
      actorId: coder.id,
      summary: `No commit for ${label}: ${reason}`,
      data: { reason },
    })
    return { recorded: true }
  }
  const sha = cleanText(input.sha, "sha", { max: 64 }) || null
  const files = Array.isArray(input.files)
    ? input.files.filter((f): f is string => typeof f === "string" && f.trim().length > 0).map((f) => f.trim())
    : []
  const shown = files.slice(0, COMMIT_FILES_IN_SUMMARY).join(", ")
  recordEvent({
    boardId,
    taskId,
    type: "commit_made",
    actorId: coder.id,
    summary:
      `Committed${sha ? ` ${sha}` : ""} for ${label} — ${files.length} file(s)` +
      (shown ? `: ${shown}${files.length > COMMIT_FILES_IN_SUMMARY ? ", …" : ""}` : ""),
    data: { sha, files },
  })
  return { recorded: true }
}

/**
 * The Architect's verdict on the queue: who takes which Ready card, in what order, and
 * what waits for what. Applied in one transaction, then the conveyor runs. Cards the
 * decision does not mention keep their tags, blockers and relative order.
 */
export function applyDispatch(
  boardId: string,
  input: { actorId: unknown; assign?: unknown; order?: unknown; blockedBy?: unknown }
): { assigned: number; pulled: string[]; unresolved: string[] } {
  const db = getDb()
  const board = db.prepare("SELECT id, key FROM boards WHERE id = ?").get(boardId) as
    | { id: string; key: string | null }
    | undefined
  if (!board) throw new NotFoundError(`Board ${boardId} not found`)
  const agents = boardAgents(boardId)
  const actor = agents.find((a) => a.id === input.actorId && a.agentRole === "architect")
  if (!actor) throw new ValidationError("Only an Architect on this board can dispatch its queue")
  const readyColumn = columnByRole(boardId, "ready")
  if (!readyColumn) throw new ValidationError("Board has no Ready list")

  // The Architect sees cards as `BI-12 (t_…)` and may name either side in ACTIONS, so a
  // `KEY-N` ref is translated to the card's real id before anything is applied. Whatever
  // cannot be matched is collected for the run log instead of being dropped in silence.
  const unresolved: string[] = []
  const byNumber = db.prepare("SELECT id FROM tasks WHERE board_id = ? AND number = ?")
  const resolveRef = (raw: string): string | null => {
    const value = raw.trim().replace(/^#/, "")
    if (!value) return null
    const ref = /^([A-Za-z][A-Za-z0-9]{1,3})-(\d+)$/.exec(value)
    if (!ref) return value
    if (!board.key || ref[1].toUpperCase() !== board.key.toUpperCase()) return null
    const row = byNumber.get(boardId, Number(ref[2])) as { id: string } | undefined
    return row?.id ?? null
  }
  /** Keeps the form the Architect wrote, so the log says `BI-999` and not an empty slot. */
  const wording = new Map<string, string>()
  const resolve = (raw: string): string | null => {
    const id = resolveRef(raw)
    if (!id) unresolved.push(raw.trim())
    else wording.set(id, raw.trim())
    return id
  }

  const decision: DispatchDecision = { assign: {}, order: [], blockedBy: {} }
  if (input.assign && typeof input.assign === "object") {
    for (const [taskId, handle] of Object.entries(input.assign as Record<string, unknown>)) {
      if (typeof handle !== "string") continue
      const id = resolve(taskId)
      if (id) decision.assign[id] = handle.replace(/^@/, "").toLowerCase()
    }
  }
  if (Array.isArray(input.order)) {
    decision.order = input.order
      .filter((v): v is string => typeof v === "string")
      .map((v) => resolve(v))
      .filter((v): v is string => v != null)
  }
  if (input.blockedBy && typeof input.blockedBy === "object") {
    for (const [taskId, ids] of Object.entries(input.blockedBy as Record<string, unknown>)) {
      if (!Array.isArray(ids)) continue
      const id = resolve(taskId)
      if (!id) continue
      decision.blockedBy[id] = ids
        .filter((v): v is string => typeof v === "string")
        .map((v) => resolve(v))
        .filter((v): v is string => v != null)
    }
  }

  const coders = new Map(agents.filter((a) => a.agentRole === "coder").map((a) => [a.handle.toLowerCase(), a]))
  const titles = new Map(
    (db.prepare("SELECT id, title FROM tasks WHERE board_id = ?").all(boardId) as Array<{ id: string; title: string }>).map(
      (r) => [r.id, r.title]
    )
  )
  let assigned = 0
  let pulled: string[] = []
  transaction(db, () => {
    const ready = (
      db
        .prepare("SELECT id FROM tasks WHERE column_id = ? AND archived = 0 ORDER BY position, updated_at")
        .all(readyColumn) as Array<{ id: string }>
    ).map((r) => r.id)
    const readySet = new Set(ready)
    const notes = new Map<string, string[]>()
    const note = (taskId: string, text: string) => notes.set(taskId, [...(notes.get(taskId) ?? []), text])

    for (const [taskId, handle] of Object.entries(decision.assign)) {
      const coder = coders.get(handle)
      if (!readySet.has(taskId)) {
        unresolved.push(wording.get(taskId) ?? taskId)
        continue
      }
      if (!coder) continue
      // Replace the agent tags; people tagged on the card stay.
      const humans = (
        db.prepare("SELECT member_id FROM task_assignees WHERE task_id = ? ORDER BY position").all(taskId) as Array<{
          member_id: string
        }>
      )
        .map((r) => r.member_id)
        .filter((id) => !agents.some((a) => a.id === id))
      setAssignees(taskId, [...humans, coder.id])
      assigned += 1
      note(taskId, `${actor.name} assigned this to ${coder.name}`)
    }
    for (const [taskId, ids] of Object.entries(decision.blockedBy)) {
      if (!readySet.has(taskId)) {
        unresolved.push(wording.get(taskId) ?? taskId)
        continue
      }
      const accepted = setBlockers(taskId, boardId, ids)
      if (accepted.length > 0) {
        note(taskId, `waits for ${accepted.map((id) => `“${titles.get(id) ?? id}”`).join(", ")}`)
      }
    }
    for (const id of decision.order) if (!readySet.has(id)) unresolved.push(wording.get(id) ?? id)
    const wanted = decision.order.filter((id) => readySet.has(id))
    if (wanted.length > 0) {
      const rest = ready.filter((id) => !wanted.includes(id))
      const update = db.prepare("UPDATE tasks SET position = ? WHERE id = ?")
      ;[...wanted, ...rest].forEach((id, index) => update.run(index, id))
    }
    for (const [taskId, parts] of notes) insertSystemMessage(taskId, `${parts.join(" · ")}.`)
    pulled = pullNextForCoders(boardId, null, null)
  })
  emitChange({ scope: "board", boardId })
  for (const taskId of pulled) emitChange({ scope: "thread", boardId, taskId })
  return { assigned, pulled, unresolved: [...new Set(unresolved)] }
}

export function appendRunLog(runId: number, chunk: string): Run {
  const db = getDb()
  const text = typeof chunk === "string" ? chunk : ""
  const result = db
    .prepare("UPDATE agent_runs SET log = log || ?, heartbeat_at = ? WHERE id = ? AND status = 'running'")
    .run(text, nowIso(), runId)
  if (Number(result.changes) === 0) throw new NotFoundError(`Run ${runId} is not running`)
  const run = getRun(runId)
  emitChange({ scope: "runs", taskId: run.taskId })
  return run
}

/**
 * A coder's run is over and nothing follows it on the card: no review queued, no automatic
 * check retry, no next run — and the card is still in In progress. The coder asked a question
 * or got stuck, which from the outside looks exactly like silence (`agent_waiting`).
 */
function coderIsWaiting(taskId: string, agentRole: string | null, status: RunStatus): boolean {
  if (agentRole !== "coder" || status !== "done") return false
  const db = getDb()
  const row = db.prepare("SELECT column_id FROM tasks WHERE id = ?").get(taskId) as
    | { column_id: string }
    | undefined
  if (!row || columnRole(row.column_id) !== "in_progress") return false
  const pending = db
    .prepare("SELECT 1 FROM agent_runs WHERE task_id = ? AND status IN ('queued','running') LIMIT 1")
    .get(taskId)
  return !pending
}

/**
 * The feed lines a finished run leaves: how it ended, and whether the card is now stuck.
 *
 * `plain` is the agent's own line about what happened, when the run got far enough to have one —
 * a failure the owner is notified about then says so in words instead of only "Run failed".
 */
/**
 * A coder's run died on its turn limit with the work still in the checkout (the worker says so:
 * `turnLimit`). Nothing is lost — so the board gives the same agent one more run on the same
 * card instead of waiting for a human to say "carry on".
 *
 * Once per card per stint in In progress, counted from the run the move into In progress queued:
 * a second limit in a row is a failure like any other, and the owner hears about that one. The
 * card itself must still be in In progress, and a card waiting for the owner waits.
 *
 * Returns whether the continuation was queued — `finishRun` puts that on the `run_failed` event
 * so the notifier can stay quiet about a failure the board is already handling (notify.mjs).
 */
function continueAfterTurnLimit(taskId: string, agentId: string): boolean {
  const db = getDb()
  const agent = db.prepare("SELECT name, agent_role FROM members WHERE id = ?").get(agentId) as
    | { name: string; agent_role: string | null }
    | undefined
  if (agent?.agent_role !== "coder") return false
  const row = db.prepare("SELECT column_id FROM tasks WHERE id = ?").get(taskId) as
    | { column_id: string }
    | undefined
  if (!row || columnRole(row.column_id) !== "in_progress") return false
  if (needsOwner(taskId)) return false
  const already = db
    .prepare(
      `SELECT 1 FROM agent_runs WHERE task_id = ? AND trigger LIKE 'continue:%'
         AND id > COALESCE((SELECT MAX(id) FROM agent_runs WHERE task_id = ? AND trigger = 'column:in_progress'), 0)
       LIMIT 1`
    )
    .get(taskId, taskId)
  if (already) return false
  transaction(db, () => {
    const result = db
      .prepare("INSERT INTO messages (task_id, author_id, kind, text, created_at) VALUES (?, ?, 'system', ?, ?)")
      .run(
        taskId,
        ownerId(),
        `${agent.name} ran out of turns before handing this card off, and the work is still in the working tree — ` +
          "it gets one more run to finish it. Running out of turns again is a plain failure.",
        nowIso()
      )
    // `always`: queued while the run that hit the limit is still being closed.
    enqueueRun(taskId, agentId, `continue:${Number(result.lastInsertRowid)}`, "always")
  })
  return true
}

function recordRunEnd(boardId: string, run: Run, plain?: unknown, continued = false): void {
  const agent = getDb()
    .prepare("SELECT name, handle, agent_role FROM members WHERE id = ?")
    .get(run.agentId) as { name: string; handle: string; agent_role: string | null } | undefined
  const who = agent?.name ?? run.agentId
  const label = cardLabel(run.taskId)
  const common = { boardId, taskId: run.taskId, actorId: run.agentId }
  if (run.status === "failed") {
    const error = firstLine(run.summary)
    recordEvent({
      ...common,
      type: "run_failed",
      summary:
        `${who} failed on ${label}${error ? `: ${error}` : ""}` +
        (continued ? " — one more run on it" : ""),
      plain,
      // `continued` = the board already put another run on this card, so the owner is not told.
      data: { agent: agent?.handle ?? null, trigger: run.trigger, error, ...(continued ? { continued: true } : {}) },
    })
  } else {
    recordEvent({
      ...common,
      type: "run_finished",
      summary: `${who} finished on ${label}: ${run.status}`,
      data: { agent: agent?.handle ?? null, trigger: run.trigger, status: run.status },
    })
  }
  if (coderIsWaiting(run.taskId, agent?.agent_role ?? null, run.status)) {
    recordEvent({
      ...common,
      type: "agent_waiting",
      summary: `${who} stopped on ${label} without handing it off — the card needs a human`,
      data: { agent: agent?.handle ?? null, trigger: run.trigger },
    })
  }
}

export function finishRun(
  runId: number,
  input: { status: unknown; summary?: unknown; plain?: unknown; turnLimit?: unknown }
): Run {
  const db = getDb()
  const status = input.status === "failed" ? "failed" : input.status === "cancelled" ? "cancelled" : "done"
  const summary = cleanText(input.summary, "summary", { max: 20000 }) || null
  const result = db
    .prepare(
      "UPDATE agent_runs SET status = ?, summary = ?, finished_at = ? WHERE id = ? AND status = 'running'"
    )
    .run(status, summary, nowIso(), runId)
  if (Number(result.changes) === 0) throw new NotFoundError(`Run ${runId} is not running`)
  const run = getRun(runId)
  const boardId = boardOfTask(run.taskId)
  // Before anything else is handed out: a run the board is going to continue must keep its coder,
  // or `pullNextForCoders` below would give it the next Ready card first.
  const continued =
    status === "failed" && input.turnLimit === true && continueAfterTurnLimit(run.taskId, run.agentId)
  recordRunEnd(boardId, run, input.plain, continued)
  // A coder is free now — Ready may have something for it.
  const pulled = transaction(db, () => pullNextForCoders(boardId, null, null))
  emitChange({ scope: "runs", boardId, taskId: run.taskId })
  emitChange({ scope: "board", boardId, taskId: run.taskId })
  for (const taskId of pulled) emitChange({ scope: "thread", boardId, taskId })
  return run
}

/**
 * The watchdog: a run whose worker stopped reporting is closed as failed here.
 *
 * A run only leaves `running` because the worker says so, and the worker is a separate process
 * that can be killed, lose the board or fail while reporting a failure. Nothing then frees the
 * agent — it is "busy" with a run that no longer exists, and the card sits in In progress with
 * no one on it. So the board judges it by itself: no log, no finish, nothing for longer
 * than the worker's own run timeout plus a margin → failed, with a line in the card's chat.
 *
 * Cheap enough to run from the board's own polling (`claimRun`, `getState`): one indexed read
 * that finds nothing in the normal case.
 */
export function sweepLostRuns(graceMs = LOST_RUN_MS): number {
  const db = getDb()
  const cutoff = new Date(Date.now() - Math.max(graceMs, 0)).toISOString()
  const lost = db
    .prepare(
      "SELECT id, task_id FROM agent_runs WHERE status = 'running' AND COALESCE(heartbeat_at, started_at, created_at) <= ?"
    )
    .all(cutoff) as Array<{ id: number; task_id: string }>
  const minutes = Math.max(1, Math.round(graceMs / 60000))
  for (const run of lost) {
    insertSystemMessage(
      run.task_id,
      `The board lost this run: its worker reported nothing for over ${minutes} min, so the run is marked failed and the agent is free again. The card stays where it is — write in the chat to try again.`
    )
    emitChange({ scope: "thread", boardId: boardOfTask(run.task_id), taskId: run.task_id })
    finishRun(run.id, { status: "failed", summary: "The worker lost the run" })
  }
  return lost.length
}

/** Worker restarted mid-run: put stale running runs back in the queue. */
export function requeueRunningRuns(agentId: string): number {
  const result = getDb()
    .prepare("UPDATE agent_runs SET status = 'queued', started_at = NULL WHERE agent_id = ? AND status = 'running'")
    .run(agentId)
  if (Number(result.changes) > 0) emitChange({ scope: "runs" })
  return Number(result.changes)
}

// --- Telegram notifications --------------------------------------------------
//
// The bot is two-way: a notification goes out, and a reply to it has to find its way back to the
// card the notification was about. Telegram gives the reply the `message_id` of what it answers,
// so that id is all the board has to remember — one row per notification sent.

/**
 * Remember that Telegram message `messageId` was the notification about this card. Idempotent:
 * a message id is Telegram's, the board only ever sees each one once, and a retry must not fail.
 */
export function rememberTelegramNotification(input: {
  messageId: unknown
  taskId: unknown
  /**
   * The message on the board the notification is about — the agent's question for a "Question".
   * Left out, the board takes the card's last message that carries a `In short:` line, which is
   * the one a Review or a Done notification quotes; nothing like it and the link is to the card
   * alone, and a reaction on the notification then applies to the card.
   */
  boardMessageId?: unknown
}): { messageId: number; boardMessageId: number | null } {
  const messageId = Math.trunc(Number(input.messageId))
  if (!Number.isSafeInteger(messageId) || messageId <= 0) {
    throw new ValidationError("messageId must be a positive integer")
  }
  const taskId = typeof input.taskId === "string" ? input.taskId : ""
  // Checks the card exists and gives a clear 404 instead of a foreign-key error.
  getTask(taskId)
  const asked = Math.trunc(Number(input.boardMessageId))
  const boardMessageId =
    Number.isSafeInteger(asked) && asked > 0 ? asked : lastShortLineMessage(taskId)
  getDb()
    .prepare(
      "INSERT INTO telegram_notifications (message_id, task_id, board_message_id, created_at) VALUES (?, ?, ?, ?)" +
        " ON CONFLICT(message_id) DO UPDATE SET task_id = excluded.task_id, board_message_id = excluded.board_message_id"
    )
    .run(messageId, taskId, boardMessageId, nowIso())
  return { messageId, boardMessageId }
}

/**
 * The card's last chat message with a `In short:` line in it — what a notification about a Review
 * or a Done quotes, and therefore the message a reaction on that notification belongs on.
 */
function lastShortLineMessage(taskId: string): number | null {
  const rows = getDb()
    .prepare("SELECT id, text FROM messages WHERE task_id = ? AND kind = 'chat' ORDER BY id DESC LIMIT 20")
    .all(taskId) as Array<{ id: number; text: string }>
  return rows.find((row) => shortLine(row.text))?.id ?? null
}

/** Where a message from the bot can go: the card, its number and title — what the bot confirms with. */
export type TelegramTarget = {
  taskId: string
  ref: string | null
  title: string
  /** The card's message the notification was about; null = the notification was about the card. */
  boardMessageId?: number | null
  createdAt?: string
}

type TelegramTargetRow = {
  taskId: string
  title: string
  number: number | null
  key: string | null
  boardMessageId?: number | null
  createdAt?: string
}

function telegramTarget(row: TelegramTargetRow | undefined): TelegramTarget | null {
  if (!row) return null
  return {
    taskId: row.taskId,
    ref: taskRef(row.key, row.number),
    title: row.title,
    boardMessageId: row.boardMessageId ?? null,
    ...(row.createdAt ? { createdAt: row.createdAt } : {}),
  }
}

/**
 * Which card a Telegram notification was about — null when the board never sent that message,
 * or when the card it was about has been deleted since.
 */
export function taskOfTelegramNotification(messageId: number): TelegramTarget | null {
  if (!Number.isSafeInteger(messageId)) return null
  const row = getDb()
    .prepare(
      `SELECT n.task_id AS taskId, n.board_message_id AS boardMessageId, t.title AS title, t.number AS number, b."key" AS key
       FROM telegram_notifications n
       JOIN tasks t ON t.id = n.task_id
       JOIN boards b ON b.id = t.board_id
       WHERE n.message_id = ?`
    )
    .get(messageId) as TelegramTargetRow | undefined
  return telegramTarget(row)
}

/**
 * The card the last notification the bot sent was about, with the time it was sent: a message
 * with neither a reply nor a card number goes there, as long as it is still fresh (the bot
 * decides how fresh — `agents/telegram.mjs`).
 */
export function lastTelegramNotification(): TelegramTarget | null {
  const row = getDb()
    .prepare(
      `SELECT n.task_id AS taskId, n.created_at AS createdAt, n.board_message_id AS boardMessageId,
              t.title AS title, t.number AS number, b."key" AS key
       FROM telegram_notifications n
       JOIN tasks t ON t.id = n.task_id
       JOIN boards b ON b.id = t.board_id
       ORDER BY n.created_at DESC, n.message_id DESC
       LIMIT 1`
    )
    .get() as TelegramTargetRow | undefined
  return telegramTarget(row)
}

/**
 * `BI-69` → the card, case-insensitively: the owner writes the number in the text instead of
 * replying to a notification. An archived board or an archived card is still a card — the owner
 * naming it by number means that one — but a live card wins a number two boards share.
 */
export function taskByRef(ref: unknown): TelegramTarget | null {
  const match = typeof ref === "string" ? ref.trim().match(/^([A-Za-z][A-Za-z0-9]*)-(\d{1,9})$/) : null
  if (!match) return null
  const row = getDb()
    .prepare(
      `SELECT t.id AS taskId, t.title AS title, t.number AS number, b."key" AS key
       FROM tasks t
       JOIN boards b ON b.id = t.board_id
       WHERE lower(b."key") = lower(?) AND t.number = ?
       ORDER BY b.archived, t.archived
       LIMIT 1`
    )
    .get(match[1], Number(match[2])) as TelegramTargetRow | undefined
  return telegramTarget(row)
}
