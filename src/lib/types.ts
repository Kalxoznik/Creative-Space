// Shared types for the board — used by the API routes, the client and the agent worker.

export type Priority = "NEW" | "LOW" | "MEDIUM" | "HIGH"

export type AvatarTone = "amber" | "blue" | "green" | "purple"

export type MemberKind = "human" | "agent"

export type AgentRole = "architect" | "coder"

/** Semantic role of a column — the agent worker reacts to these, not to titles. */
export type ColumnRole =
  | "backlog"
  | "ready"
  | "in_progress"
  | "review"
  | "done"
  | "other"

export type BoardKind = "work" | "demo"

export type Member = {
  id: string
  name: string
  handle: string
  initials: string
  tone: AvatarTone
  kind: MemberKind
  agentRole: AgentRole | null
}

export type RunStatus = "queued" | "running" | "done" | "failed" | "cancelled"

export type AgentStatus = {
  runId: number
  agentId: string
  status: "queued" | "running"
  trigger: string
}

export type Task = {
  id: string
  boardId: string
  columnId: string
  position: number
  title: string
  description: string
  priority: Priority
  attachments: number
  assigneeIds: string[]
  commentCount: number
  agentStatus: AgentStatus | null
  createdAt: string
  updatedAt: string
}

export type Column = {
  id: string
  boardId: string
  title: string
  role: ColumnRole
  position: number
  tasks: Task[]
}

export type Board = {
  id: string
  name: string
  icon: string
  kind: BoardKind
  repoPath: string | null
  archived: boolean
  memberIds: string[]
  columns: Column[]
}

export type MessageKind = "chat" | "system"

export type Message = {
  id: number
  taskId: string
  authorId: string
  kind: MessageKind
  text: string
  createdAt: string
}

export type Run = {
  id: number
  taskId: string
  agentId: string
  trigger: string
  status: RunStatus
  log: string
  summary: string | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
}

export type BoardState = {
  me: Member
  members: Member[]
  boards: Board[]
}

export type TaskThread = {
  task: Task
  messages: Message[]
  runs: Run[]
}

/** Everything an agent needs for one run — returned by POST /api/agents/claim. */
export type RunContext = {
  run: Run
  task: Task
  board: {
    id: string
    name: string
    repoPath: string | null
    columns: Array<{ id: string; title: string; role: ColumnRole }>
  }
  members: Member[]
  thread: Message[]
  triggerMessage: Message | null
}

export const PRIORITIES: Priority[] = ["NEW", "LOW", "MEDIUM", "HIGH"]

export const COLUMN_ROLES: ColumnRole[] = [
  "backlog",
  "ready",
  "in_progress",
  "review",
  "done",
  "other",
]
