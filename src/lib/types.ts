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

/** Which CLI runs an agent. `stub` = no model calls (the worker's stub mode forces it for everyone). */
export type AgentEngine = "claude" | "codex" | "stub"
export const AGENT_ENGINES: AgentEngine[] = ["claude", "codex", "stub"]

/**
 * How hard the model thinks. Mapped per engine by the worker:
 * Claude Code `--effort low|medium|high|max`, Codex `model_reasoning_effort` low|medium|high|xhigh.
 * null = the CLI's own default.
 */
export type AgentEffort = "low" | "medium" | "high" | "max"
export const AGENT_EFFORTS: AgentEffort[] = ["low", "medium", "high", "max"]

/** Everything the worker needs to run an agent. Lives on the agent, not on the board. */
export type AgentConfig = {
  engine: AgentEngine
  /** Model name passed to the CLI (`--model` / `-m`); null = the CLI's default. */
  model: string | null
  effort: AgentEffort | null
  /** Turn limit per run (Claude Code `--max-turns`); null = the worker's default for the role. */
  maxTurns: number | null
  /** One line for people and for the Architect: what this agent is good for. */
  description: string
  /** Extra rules appended to the role prompt. */
  instructions: string
}

export type Member = {
  id: string
  name: string
  handle: string
  initials: string
  tone: AvatarTone
  kind: MemberKind
  agentRole: AgentRole | null
  /** The person this workspace belongs to — set up on first launch. */
  isOwner: boolean
  /** A removed agent: off every board, kept so its old messages still have an author. */
  archived: boolean
  /** Set for agents only. */
  agent: AgentConfig | null
}

export const AVATAR_TONES: AvatarTone[] = ["amber", "blue", "green", "purple"]

/** What the server knows about a project folder before a board is created on it. */
export type RepoCheck = {
  path: string
  exists: boolean
  isGit: boolean
  /** CLAUDE.md or AGENTS.md — the notes the agents read when they start in that folder. */
  hasAgentNotes: boolean
}

export type RunStatus = "queued" | "running" | "done" | "failed" | "cancelled"

/** What the board knows about the agent worker process, from its heartbeats. */
export type WorkerStatus = {
  online: boolean
  mode: "stub" | "live" | null
  seenAt: string | null
  /** CLI version per engine the worker checked; null = not found / not runnable. */
  engines: Record<string, string | null>
}

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
  archived: boolean
  assigneeIds: string[]
  /** Cards this one waits for (set by the Architect when it dispatches, or by hand). */
  blockedBy: string[]
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
  /** Shell command the worker runs after a coder hands a card to Review; null = no check. */
  checkCommand: string | null
  memberIds: string[]
  columns: Column[]
  /** Archived cards are hidden from the columns; see GET /api/boards/:id/archived */
  archivedCount: number
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
  /** Someone pressed Stop; the worker kills the process and marks the run cancelled. */
  cancelRequested: boolean
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
  worker: WorkerStatus
}

export type TaskThread = {
  task: Task
  messages: Message[]
  runs: Run[]
}

/** A card as the Architect sees it when it dispatches the queue. */
export type QueueCard = {
  id: string
  title: string
  description: string
  priority: Priority
  column: ColumnRole
  /** Handles of the members tagged on the card. */
  assignees: string[]
  blockedBy: string[]
}

/** Everything an agent needs for one run — returned by POST /api/agents/claim. */
export type RunContext = {
  run: Run
  task: Task
  agent: Member
  board: {
    id: string
    name: string
    repoPath: string | null
    checkCommand: string | null
    columns: Array<{ id: string; title: string; role: ColumnRole }>
  }
  members: Member[]
  thread: Message[]
  triggerMessage: Message | null
  /** Only for `dispatch` runs: the board's queue (Ready) and what is in progress. */
  queue: { ready: QueueCard[]; inProgress: QueueCard[] } | null
}

/** What the Architect decides for the queue — the worker posts it to POST /api/boards/:id/dispatch. */
export type DispatchDecision = {
  /** taskId → agent handle (a coder on the board). */
  assign: Record<string, string>
  /** Ready card ids, top first; cards left out keep their relative order after these. */
  order: string[]
  /** taskId → ids of the cards it must wait for. */
  blockedBy: Record<string, string[]>
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
