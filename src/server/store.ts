import { getDb, newId, nowIso, transaction } from "./db"
import { emitChange } from "./events"
import { WORK_COLUMNS } from "./seed"
import type {
  AgentStatus,
  Board,
  BoardState,
  Column,
  ColumnRole,
  Member,
  Message,
  MessageKind,
  Priority,
  Run,
  RunContext,
  RunStatus,
  Task,
  TaskThread,
} from "@/lib/types"
import { COLUMN_ROLES, PRIORITIES } from "@/lib/types"

// All reads and writes go through here. Rules that make the board an agent
// tool (mention → run, column → run, agent chain guard) live here too, so the
// API routes stay thin.

export const ME_ID = "max"

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
}

type BoardRow = {
  id: string
  name: string
  icon: string
  kind: string
  repo_path: string | null
  position: number
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
    assigneeIds,
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
  const me = members.find((m) => m.id === ME_ID) ?? members[0]
  const boardRows = db.prepare("SELECT * FROM boards ORDER BY position, rowid").all() as BoardRow[]
  const columnRows = db
    .prepare("SELECT * FROM columns ORDER BY board_id, position, rowid")
    .all() as ColumnRow[]
  const taskRows = db
    .prepare("SELECT * FROM tasks ORDER BY column_id, position, rowid")
    .all() as TaskRow[]
  const boardMemberRows = db
    .prepare("SELECT board_id, member_id FROM board_members ORDER BY board_id, position")
    .all() as Array<{ board_id: string; member_id: string }>

  const assignees = assigneesByTask()
  const counts = commentCounts()
  const active = activeRunsByTask()

  const tasksByColumn = new Map<string, Task[]>()
  for (const row of taskRows) {
    const list = tasksByColumn.get(row.column_id) ?? []
    list.push(
      toTask(row, assignees.get(row.id) ?? [], counts.get(row.id) ?? 0, active.get(row.id) ?? null)
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
    memberIds: membersByBoard.get(row.id) ?? [],
    columns: columnsByBoard.get(row.id) ?? [],
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

function boardAgents(boardId: string): Member[] {
  const rows = getDb()
    .prepare(
      "SELECT m.* FROM members m JOIN board_members bm ON bm.member_id = m.id WHERE bm.board_id = ? AND m.kind = 'agent' ORDER BY bm.position"
    )
    .all(boardId) as MemberRow[]
  return rows.map(toMember)
}

function renumber(columnId: string): void {
  const db = getDb()
  const rows = db
    .prepare("SELECT id FROM tasks WHERE column_id = ? ORDER BY position, updated_at")
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
    .run(taskId, ME_ID, text, nowIso())
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

// ---------------------------------------------------------------------------
// Writes: boards and tasks

export function createBoard(input: { name: unknown; repoPath?: unknown }): Board {
  const db = getDb()
  const name = cleanText(input.name, "name", { required: true, max: 80 })
  const repoPath = cleanText(input.repoPath, "repoPath", { max: 500 }) || null
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
    ;[ME_ID, "architect", "coder"].forEach((memberId, index) => {
      db.prepare(
        "INSERT OR IGNORE INTO board_members (board_id, member_id, position) VALUES (?, ?, ?)"
      ).run(id, memberId, index)
    })
  })
  emitChange({ scope: "board", boardId: id })
  const board = getState().boards.find((b) => b.id === id)
  if (!board) throw new NotFoundError("Board vanished after insert")
  return board
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
  transaction(db, () => {
    const pos = db
      .prepare("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM tasks WHERE column_id = ?")
      .get(columnId) as { p: number }
    db.prepare(
      "INSERT INTO tasks (id, board_id, column_id, position, title, description, priority, attachments, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)"
    ).run(id, boardId, columnId, pos.p, title, description, priority, at, at)
    setAssignees(id, assigneeIds)
    triggerColumnRuns(id, boardId, null, columnRole(columnId))
  })
  emitChange({ scope: "board", boardId, taskId: id })
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
  }
): Task {
  const db = getDb()
  const current = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as TaskRow | undefined
  if (!current) throw new NotFoundError(`Task ${taskId} not found`)

  const fields: string[] = []
  const values: Array<string | number> = []
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
    if (moving) {
      const fromColumn = current.column_id
      const toColumn = targetColumnId ?? fromColumn
      const others = (
        db
          .prepare("SELECT id FROM tasks WHERE column_id = ? AND id != ? ORDER BY position, updated_at")
          .all(toColumn, taskId) as Array<{ id: string }>
      ).map((r) => r.id)
      const index = position == null ? others.length : Math.min(position, others.length)
      others.splice(index, 0, taskId)
      const update = db.prepare("UPDATE tasks SET column_id = ?, position = ?, updated_at = ? WHERE id = ?")
      const at = nowIso()
      others.forEach((id, i) => update.run(toColumn, i, at, id))
      if (fromColumn !== toColumn) {
        renumber(fromColumn)
        const fromRole = columnRole(fromColumn)
        const toRole = columnRole(toColumn)
        cancelQueuedColumnRuns(taskId)
        triggerColumnRuns(taskId, current.board_id, fromRole, toRole)
      }
    }
  })
  emitChange({ scope: "board", boardId: current.board_id, taskId })
  if (moving && targetColumnId && targetColumnId !== current.column_id) {
    emitChange({ scope: "thread", boardId: current.board_id, taskId })
  }
  return getTask(taskId)
}

export function deleteTask(taskId: string): void {
  const boardId = boardOfTask(taskId)
  const db = getDb()
  const columnId = (db.prepare("SELECT column_id FROM tasks WHERE id = ?").get(taskId) as { column_id: string })
    .column_id
  transaction(db, () => {
    db.prepare("DELETE FROM tasks WHERE id = ?").run(taskId)
    renumber(columnId)
  })
  emitChange({ scope: "board", boardId, taskId })
}

/** Column transitions that wake an agent. */
function triggerColumnRuns(
  taskId: string,
  boardId: string,
  fromRole: ColumnRole | null,
  toRole: ColumnRole
): void {
  if (fromRole === toRole) return
  const agents = boardAgents(boardId)
  const coder = agents.find((a) => a.agentRole === "coder")
  const architect = agents.find((a) => a.agentRole === "architect")
  if (toRole === "in_progress" && coder) {
    enqueueRun(taskId, coder.id, "column:in_progress")
    insertSystemMessage(taskId, `Moved to In progress — ${coder.name} picks it up.`)
  } else if (toRole === "review" && architect) {
    enqueueRun(taskId, architect.id, "column:review")
    insertSystemMessage(taskId, `Moved to Review — ${architect.name} reviews it.`)
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
}): Message {
  const db = getDb()
  const taskId = input.taskId
  const boardId = boardOfTask(taskId)
  const authorId = typeof input.authorId === "string" && input.authorId ? input.authorId : ME_ID
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
      if (author.kind === "agent") {
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

/** Hand the oldest queued run for this agent to the worker — one at a time per agent. */
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
    const next = db
      .prepare("SELECT * FROM agent_runs WHERE agent_id = ? AND status = 'queued' ORDER BY id LIMIT 1")
      .get(agentId) as RunRow | undefined
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

  emitChange({ scope: "runs", boardId: task.boardId, taskId: task.id })
  emitChange({ scope: "board", boardId: task.boardId, taskId: task.id })
  return {
    run,
    task,
    board: { id: boardRow.id, name: boardRow.name, repoPath: boardRow.repo_path, columns },
    members: memberRows.map(toMember),
    thread,
    triggerMessage,
  }
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
  emitChange({ scope: "runs", boardId, taskId: run.taskId })
  emitChange({ scope: "board", boardId, taskId: run.taskId })
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
