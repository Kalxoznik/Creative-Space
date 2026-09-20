import fs from "node:fs"
import path from "node:path"
import { getDb, newId, nowIso, transaction } from "./db"
import { emitChange } from "./events"
import { WORK_COLUMNS } from "./seed"
import type {
  AgentConfig,
  AgentEffort,
  AgentEngine,
  AgentRole,
  AgentStatus,
  AvatarTone,
  Board,
  BoardState,
  Column,
  ColumnRole,
  DispatchDecision,
  Member,
  Message,
  MessageKind,
  Priority,
  QueueCard,
  RepoCheck,
  Run,
  RunContext,
  RunStatus,
  Task,
  TaskThread,
} from "@/lib/types"
import { AGENT_EFFORTS, AGENT_ENGINES, AVATAR_TONES, COLUMN_ROLES, PRIORITIES } from "@/lib/types"

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

/** Consecutive agent messages allowed before agents pause and wait for a human. */
const MAX_AGENT_CHAIN = 6

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
  icon: string
  kind: string
  repo_path: string | null
  position: number
  archived: number
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
  title: string
  description: string
  priority: string
  attachments: number
  archived: number
  created_at: string
  updated_at: string
}

type MessageRow = {
  id: number
  task_id: string
  author_id: string
  kind: string
  text: string
  created_at: string
}

type RunRow = {
  id: number
  task_id: string
  agent_id: string
  trigger: string
  status: string
  log: string
  summary: string | null
  created_at: string
  started_at: string | null
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
  agentStatus: AgentStatus | null
): Task {
  return {
    id: row.id,
    boardId: row.board_id,
    columnId: row.column_id,
    position: row.position,
    title: row.title,
    description: row.description,
    priority: row.priority as Priority,
    attachments: row.attachments,
    archived: row.archived === 1,
    assigneeIds,
    blockedBy,
    commentCount,
    agentStatus,
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
      : null
  )
}

export function getState(): BoardState {
  const db = getDb()
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
        active.get(row.id) ?? null
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
    icon: row.icon,
    kind: row.kind as Board["kind"],
    repoPath: row.repo_path,
    archived: row.archived === 1,
    memberIds: membersByBoard.get(row.id) ?? [],
    columns: columnsByBoard.get(row.id) ?? [],
    archivedCount: archivedCounts.get(row.id) ?? 0,
  }))

  return { me, members, boards }
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

export function getThread(taskId: string): TaskThread {
  return { task: getTask(taskId), messages: listMessages(taskId), runs: listRuns(taskId) }
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

/** The live agents on a board, in board order — the first coder is the board's default coder. */
function boardAgents(boardId: string): Member[] {
  const rows = getDb()
    .prepare(
      "SELECT m.* FROM members m JOIN board_members bm ON bm.member_id = m.id WHERE bm.board_id = ? AND m.kind = 'agent' AND m.archived = 0 ORDER BY bm.position"
    )
    .all(boardId) as MemberRow[]
  return rows.map(toMember)
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

/** A card waits while any of its blockers is still open (not in Review / Done, not archived). */
function isBlocked(taskId: string): boolean {
  const rows = getDb()
    .prepare(
      "SELECT t.archived, c.role FROM task_blockers b JOIN tasks t ON t.id = b.blocked_by JOIN columns c ON c.id = t.column_id WHERE b.task_id = ?"
    )
    .all(taskId) as Array<{ archived: number; role: string }>
  return rows.some((r) => r.archived === 0 && r.role !== "review" && r.role !== "done")
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

function assertPriority(value: unknown): Priority {
  if (typeof value !== "string" || !PRIORITIES.includes(value as Priority)) {
    throw new ValidationError(`Invalid priority: ${String(value)}`)
  }
  return value as Priority
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

function insertSystemMessage(taskId: string, text: string): void {
  getDb()
    .prepare("INSERT INTO messages (task_id, author_id, kind, text, created_at) VALUES (?, ?, 'system', ?, ?)")
    .run(taskId, ownerId(), text, nowIso())
}

function enqueueRun(taskId: string, agentId: string, trigger: string): number | null {
  const db = getDb()
  // Don't stack identical triggers while one is still waiting.
  const existing = db
    .prepare(
      "SELECT id FROM agent_runs WHERE task_id = ? AND agent_id = ? AND trigger = ? AND status = 'queued'"
    )
    .get(taskId, agentId, trigger) as { id: number } | undefined
  if (existing) return existing.id
  const result = db
    .prepare(
      "INSERT INTO agent_runs (task_id, agent_id, trigger, status, created_at) VALUES (?, ?, ?, 'queued', ?)"
    )
    .run(taskId, agentId, trigger, nowIso())
  return Number(result.lastInsertRowid)
}

function cancelQueuedColumnRuns(taskId: string): void {
  getDb()
    .prepare(
      "UPDATE agent_runs SET status = 'cancelled', finished_at = ? WHERE task_id = ? AND status = 'queued' AND trigger LIKE 'column:%'"
    )
    .run(nowIso(), taskId)
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

// ---------------------------------------------------------------------------
// Writes: boards and tasks

/** Title + description of the card that gets a fresh project described for the agents. */
const STARTER_CARD = {
  title: "Write CLAUDE.md for this project",
  description:
    "Describe this project for the agents that will work in it: what it is, the stack, the folder structure, how to run it, how to type-check / lint / test, and any conventions you can see in the code. Write it to CLAUDE.md in the repository root (and copy it to AGENTS.md so Codex reads it too). Keep it short and factual — a page at most. Commit it.",
}

export function createBoard(input: {
  name: unknown
  repoPath?: unknown
  memberIds?: unknown
  starterCard?: unknown
}): Board {
  const db = getDb()
  const name = cleanText(input.name, "name", { required: true, max: 80 })
  const repoPath = cleanText(input.repoPath, "repoPath", { max: 500 }) || null
  const members = listMembers().filter((m) => !m.archived)
  const known = new Set(members.map((m) => m.id))
  // Members: the owner always; agents as chosen (every agent by default).
  const wanted = Array.isArray(input.memberIds)
    ? input.memberIds.filter((v): v is string => typeof v === "string" && known.has(v))
    : members.filter((m) => m.kind === "agent").map((m) => m.id)
  const memberIds = [ownerId(), ...wanted.filter((id) => id !== ownerId())]
  const firstCoder = memberIds.find((id) => members.find((m) => m.id === id)?.agentRole === "coder") ?? null
  const id = newId("b")
  transaction(db, () => {
    const pos = db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM boards").get() as { p: number }
    db.prepare(
      "INSERT INTO boards (id, name, icon, kind, repo_path, position) VALUES (?, ?, '/icons/layout-grid.svg', 'work', ?, ?)"
    ).run(id, name, repoPath, pos.p)
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
    createTask({ boardId: id, columnId: `${id}:ready`, ...STARTER_CARD, assigneeIds: [firstCoder] })
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

export function updateBoard(
  boardId: string,
  patch: { name?: unknown; repoPath?: unknown; archived?: unknown; memberIds?: unknown }
): Board {
  const db = getDb()
  const current = db.prepare("SELECT id FROM boards WHERE id = ?").get(boardId) as { id: string } | undefined
  if (!current) throw new NotFoundError(`Board ${boardId} not found`)
  if (Array.isArray(patch.memberIds)) {
    // Which people and agents take part in this board. The owner always stays.
    const wanted = new Set(patch.memberIds.filter((v): v is string => typeof v === "string"))
    wanted.add(ownerId())
    const known = new Set(listMembers().filter((m) => !m.archived).map((m) => m.id))
    transaction(db, () => {
      db.prepare("DELETE FROM board_members WHERE board_id = ?").run(boardId)
      let position = 0
      for (const memberId of [ownerId(), ...Array.from(wanted).filter((id) => id !== ownerId())]) {
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
  if (patch.repoPath !== undefined) {
    fields.push("repo_path = ?")
    values.push(cleanText(patch.repoPath, "repoPath", { max: 500 }) || null)
  }
  if (patch.archived !== undefined) {
    fields.push("archived = ?")
    values.push(patch.archived ? 1 : 0)
  }
  if (fields.length > 0) {
    db.prepare(`UPDATE boards SET ${fields.join(", ")} WHERE id = ?`).run(...values, boardId)
  }
  // A coder that just joined the board may find Ready waiting for it.
  const pulled = transaction(db, () => pullNextForCoders(boardId, null, null))
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
  priority?: unknown
  assigneeIds?: unknown
}): Task {
  const db = getDb()
  const boardId = cleanText(input.boardId, "boardId", { required: true })
  const board = db.prepare("SELECT id FROM boards WHERE id = ?").get(boardId) as { id: string } | undefined
  if (!board) throw new NotFoundError(`Board ${boardId} not found`)

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
  const priority = input.priority == null ? "MEDIUM" : assertPriority(input.priority)
  const assigneeIds = Array.isArray(input.assigneeIds)
    ? input.assigneeIds.filter((v): v is string => typeof v === "string")
    : []

  const id = newId("t")
  const at = nowIso()
  let pulled: string[] = []
  transaction(db, () => {
    const pos = db
      .prepare("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM tasks WHERE column_id = ?")
      .get(columnId) as { p: number }
    db.prepare(
      "INSERT INTO tasks (id, board_id, column_id, position, title, description, priority, attachments, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)"
    ).run(id, boardId, columnId, pos.p, title, description, priority, at, at)
    setAssignees(id, assigneeIds)
    const role = columnRole(columnId)
    triggerColumnRuns(id, boardId, null, role)
    if (role === "ready") pulled = pullNextForCoders(boardId, null, null)
  })
  emitChange({ scope: "board", boardId, taskId: id })
  for (const taskId of pulled) emitChange({ scope: "thread", boardId, taskId })
  return getTask(id)
}

export function updateTask(
  taskId: string,
  patch: {
    title?: unknown
    description?: unknown
    priority?: unknown
    assigneeIds?: unknown
    columnId?: unknown
    columnRole?: unknown
    position?: unknown
    archived?: unknown
    /** Ids of cards this one waits for. */
    blockedBy?: unknown
    /** Who moved the card (an agent id, set by the worker). Humans move from the UI and leave it empty. */
    actorId?: unknown
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
  if (patch.priority !== undefined) {
    fields.push("priority = ?")
    values.push(assertPriority(patch.priority))
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
  const position = typeof patch.position === "number" && patch.position >= 0 ? Math.floor(patch.position) : null
  const moving = targetColumnId != null || position != null
  const actor = typeof patch.actorId === "string" ? boardAgents(current.board_id).find((a) => a.id === patch.actorId) ?? null : null

  let pulled: string[] = []
  transaction(db, () => {
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
    if (moving) {
      const fromColumn = current.column_id
      const toColumn = targetColumnId ?? fromColumn
      placeTask(taskId, toColumn, position)
      if (fromColumn !== toColumn) {
        renumber(fromColumn)
        const fromRole = columnRole(fromColumn)
        const toRole = columnRole(toColumn)
        cancelQueuedColumnRuns(taskId)
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
    if (
      !handedOff &&
      (moving || patch.archived !== undefined || Array.isArray(patch.assigneeIds) || Array.isArray(patch.blockedBy))
    ) {
      pulled = pullNextForCoders(current.board_id, null, null)
    }
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
// per repository at a time (see claimRun): they share one checkout.

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

/** Free = no run queued or running for it on this board, and none of its cards in In progress. */
function coderIsFree(boardId: string, view: CoderView, ignoreTaskId: string | null): boolean {
  const db = getDb()
  const active = db
    .prepare(
      "SELECT 1 FROM agent_runs r JOIN tasks t ON t.id = r.task_id WHERE r.agent_id = ? AND t.board_id = ? AND r.status IN ('queued','running') AND r.task_id != ? LIMIT 1"
    )
    .get(view.coder.id, boardId, ignoreTaskId ?? "")
  if (active) return false
  const workColumn = columnByRole(boardId, "in_progress")
  if (!workColumn) return false
  const inWork = db
    .prepare("SELECT id FROM tasks WHERE column_id = ? AND archived = 0 AND id != ?")
    .all(workColumn, ignoreTaskId ?? "") as Array<{ id: string }>
  return !inWork.some((t) => cardIsFor(t.id, view, { pulling: false }))
}

/**
 * Give every free coder on the board its next card from the queue.
 * `handedOff` is the card `actorId` just finished (its run is still marked running, and
 * Backlog counts as the queue when the board has no Ready list).
 * Returns the ids of the cards that moved to In progress.
 */
function pullNextForCoders(boardId: string, handedOff: TaskRow | null, actorId: string | null): string[] {
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
      (task) => !pulled.includes(task.id) && cardIsFor(task.id, view, { pulling: true }) && !isBlocked(task.id)
    )
    if (!next) return
    placeTask(next.id, workColumn, null)
    renumber(queue)
    cancelQueuedColumnRuns(next.id)
    triggerColumnRuns(next.id, boardId, columnRole(queue), "in_progress", {
      note:
        handedOff && coder.id === actorId
          ? `${coder.name} finished “${handedOff.title}” and takes this card next.`
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
    db.prepare("DELETE FROM tasks WHERE id = ?").run(taskId)
    renumber(columnId)
    pulled = pullNextForCoders(boardId, null, null)
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
  return rows.map((row) =>
    toTask(row, assignees.get(row.id) ?? [], blockers.get(row.id) ?? [], counts.get(row.id) ?? 0, null)
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
 * Review → the architect, if it is on the board.
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
    if (architect && coder && enqueueDispatch(taskId, boardId, architect)) {
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
  } else if (toRole === "review") {
    if (architect) {
      enqueueRun(taskId, architect.id, "column:review")
      insertSystemMessage(taskId, note ?? `${moved("Review")} — ${architect.name} reviews it.`)
    } else if (actorName) {
      insertSystemMessage(taskId, note ?? `${moved("Review")}.`)
    }
  } else if (toRole === "done" && actorName) {
    insertSystemMessage(taskId, note ?? `${moved("Done")}.`)
  }
}

// ---------------------------------------------------------------------------
// Writes: chat

const MENTION_RE = /@([a-z0-9_]+)/gi

export function addMessage(input: {
  taskId: string
  authorId?: unknown
  text: unknown
  kind?: unknown
  /** false = an agent's note that does not make it a participant of the card (dispatch replies). */
  participant?: unknown
}): Message {
  const db = getDb()
  const taskId = input.taskId
  const boardId = boardOfTask(taskId)
  const authorId = typeof input.authorId === "string" && input.authorId ? input.authorId : ownerId()
  const author = db.prepare("SELECT * FROM members WHERE id = ?").get(authorId) as MemberRow | undefined
  if (!author) throw new ValidationError(`Unknown author ${authorId}`)
  const kind: MessageKind = input.kind === "system" ? "system" : "chat"
  const text = cleanText(input.text, "text", { required: true, max: 20000 })

  let messageId = 0
  transaction(db, () => {
    const result = db
      .prepare("INSERT INTO messages (task_id, author_id, kind, text, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(taskId, authorId, kind, text, nowIso())
    messageId = Number(result.lastInsertRowid)
    if (kind === "chat") {
      // Once an agent posts, its assigned task shows it as a participant.
      if (author.kind === "agent" && input.participant !== false) {
        db.prepare(
          "INSERT OR IGNORE INTO task_assignees (task_id, member_id, position) VALUES (?, ?, (SELECT COALESCE(MAX(position), -1) + 1 FROM task_assignees WHERE task_id = ?))"
        ).run(taskId, authorId, taskId)
      }
      triggerMentions(taskId, boardId, toMember(author), text, messageId)
    }
  })
  emitChange({ scope: "thread", boardId, taskId })
  emitChange({ scope: "board", boardId, taskId })
  const row = db.prepare("SELECT * FROM messages WHERE id = ?").get(messageId) as MessageRow
  return toMessage(row)
}

function triggerMentions(
  taskId: string,
  boardId: string,
  author: Member,
  text: string,
  messageId: number
): void {
  const agents = boardAgents(boardId)
  if (agents.length === 0) return
  const handles = new Set(Array.from(text.matchAll(MENTION_RE), (m) => m[1].toLowerCase()))
  const mentioned = agents.filter((a) => handles.has(a.handle.toLowerCase()) && a.id !== author.id)
  if (mentioned.length === 0) return

  if (author.kind === "agent" && agentChainLength(taskId) >= MAX_AGENT_CHAIN) {
    insertSystemMessage(
      taskId,
      `Agents paused after ${MAX_AGENT_CHAIN} messages in a row — waiting for a human to weigh in.`
    )
    return
  }
  for (const agent of mentioned) {
    enqueueRun(taskId, agent.id, `mention:${messageId}`)
  }
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

function queueCard(row: TaskRow, handleOf: Map<string, string>): QueueCard {
  const assignees = (
    getDb().prepare("SELECT member_id FROM task_assignees WHERE task_id = ? ORDER BY position").all(row.id) as Array<{
      member_id: string
    }>
  )
    .map((r) => handleOf.get(r.member_id))
    .filter((h): h is string => !!h)
  return {
    id: row.id,
    title: row.title,
    description: row.description.length > 800 ? `${row.description.slice(0, 800)}…` : row.description,
    priority: row.priority as Priority,
    column: columnRole(row.column_id),
    assignees,
    blockedBy: blockersOf(row.id),
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
    db.prepare("UPDATE agent_runs SET status = 'running', started_at = ? WHERE id = ?").run(nowIso(), next.id)
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
  const mentionId = run.trigger.startsWith("mention:") ? Number(run.trigger.slice(8)) : null
  const triggerMessage = mentionId ? (thread.find((m) => m.id === mentionId) ?? null) : null

  let queue: RunContext["queue"] = null
  if (run.trigger === "dispatch") {
    const handleOf = new Map(memberRows.map((m) => [m.id, m.handle]))
    const cardsIn = (role: ColumnRole): QueueCard[] => {
      const columnId = columnByRole(task.boardId, role)
      if (!columnId) return []
      const rows = db
        .prepare("SELECT * FROM tasks WHERE column_id = ? AND archived = 0 ORDER BY position, updated_at")
        .all(columnId) as TaskRow[]
      return rows.map((row) => queueCard(row, handleOf))
    }
    queue = { ready: cardsIn("ready"), inProgress: cardsIn("in_progress") }
  }

  emitChange({ scope: "runs", boardId: task.boardId, taskId: task.id })
  emitChange({ scope: "board", boardId: task.boardId, taskId: task.id })
  return {
    run,
    task,
    agent: toMember(agent),
    board: {
      id: boardRow.id,
      name: boardRow.name,
      repoPath: boardRow.repo_path,
      columns,
    },
    members: memberRows.map(toMember),
    thread,
    triggerMessage,
    queue,
  }
}

/**
 * The Architect's verdict on the queue: who takes which Ready card, in what order, and
 * what waits for what. Applied in one transaction, then the conveyor runs. Cards the
 * decision does not mention keep their tags, blockers and relative order.
 */
export function applyDispatch(
  boardId: string,
  input: { actorId: unknown; assign?: unknown; order?: unknown; blockedBy?: unknown }
): { assigned: number; pulled: string[] } {
  const db = getDb()
  const board = db.prepare("SELECT id FROM boards WHERE id = ?").get(boardId) as { id: string } | undefined
  if (!board) throw new NotFoundError(`Board ${boardId} not found`)
  const agents = boardAgents(boardId)
  const actor = agents.find((a) => a.id === input.actorId && a.agentRole === "architect")
  if (!actor) throw new ValidationError("Only an Architect on this board can dispatch its queue")
  const readyColumn = columnByRole(boardId, "ready")
  if (!readyColumn) throw new ValidationError("Board has no Ready list")

  const decision: DispatchDecision = { assign: {}, order: [], blockedBy: {} }
  if (input.assign && typeof input.assign === "object") {
    for (const [taskId, handle] of Object.entries(input.assign as Record<string, unknown>)) {
      if (typeof handle === "string") decision.assign[taskId] = handle.replace(/^@/, "").toLowerCase()
    }
  }
  if (Array.isArray(input.order)) decision.order = input.order.filter((v): v is string => typeof v === "string")
  if (input.blockedBy && typeof input.blockedBy === "object") {
    for (const [taskId, ids] of Object.entries(input.blockedBy as Record<string, unknown>)) {
      if (Array.isArray(ids)) decision.blockedBy[taskId] = ids.filter((v): v is string => typeof v === "string")
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
      if (!coder || !readySet.has(taskId)) continue
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
      if (!readySet.has(taskId)) continue
      const accepted = setBlockers(taskId, boardId, ids)
      if (accepted.length > 0) {
        note(taskId, `waits for ${accepted.map((id) => `“${titles.get(id) ?? id}”`).join(", ")}`)
      }
    }
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
  return { assigned, pulled }
}

export function appendRunLog(runId: number, chunk: string): Run {
  const db = getDb()
  const text = typeof chunk === "string" ? chunk : ""
  const result = db
    .prepare("UPDATE agent_runs SET log = log || ? WHERE id = ? AND status = 'running'")
    .run(text, runId)
  if (Number(result.changes) === 0) throw new NotFoundError(`Run ${runId} is not running`)
  const run = getRun(runId)
  emitChange({ scope: "runs", taskId: run.taskId })
  return run
}

export function finishRun(runId: number, input: { status: unknown; summary?: unknown }): Run {
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
  // A coder is free now — Ready may have something for it.
  const pulled = transaction(db, () => pullNextForCoders(boardId, null, null))
  emitChange({ scope: "runs", boardId, taskId: run.taskId })
  emitChange({ scope: "board", boardId, taskId: run.taskId })
  for (const taskId of pulled) emitChange({ scope: "thread", boardId, taskId })
  return run
}

/** Worker restarted mid-run: put stale running runs back in the queue. */
export function requeueRunningRuns(agentId: string): number {
  const result = getDb()
    .prepare("UPDATE agent_runs SET status = 'queued', started_at = NULL WHERE agent_id = ? AND status = 'running'")
    .run(agentId)
  if (Number(result.changes) > 0) emitChange({ scope: "runs" })
  return Number(result.changes)
}
