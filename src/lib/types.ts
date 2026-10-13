// Shared types for the board — used by the API routes, the client and the agent worker.

export type AvatarTone =
  | "amber"
  | "blue"
  | "green"
  | "purple"
  | "rose"
  | "teal"
  | "lime"
  | "indigo"
  | "pink"
  | "slate"

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

export const AVATAR_TONES: AvatarTone[] = [
  "amber",
  "blue",
  "green",
  "purple",
  "rose",
  "teal",
  "lime",
  "indigo",
  "pink",
  "slate",
]

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

/**
 * Why a card is waiting for the owner. The three things an agent must not do on its own —
 * spend money on a model call, write to the corpus, deploy — plus a question it cannot
 * answer by reading the code.
 */
export type NeedsOwnerReason = "paid_call" | "corpus_write" | "deploy" | "question"
export const NEEDS_OWNER_REASONS: NeedsOwnerReason[] = ["paid_call", "corpus_write", "deploy", "question"]

/**
 * A card stopped on the owner's word (`ACTIONS: {"needs": "owner", …}`). The card does not
 * move; while this is set no agent run is queued on it, and the first message from a human in
 * its chat clears it.
 */
export type NeedsOwner = {
  reason: NeedsOwnerReason
  /** One line: what exactly the owner has to say yes to. */
  text: string
}

export type Task = {
  id: string
  boardId: string
  columnId: string
  position: number
  /**
   * Card number inside its board: with the board's key this is the `BI-12` people and
   * agents say out loud. `id` stays the only identifier the API knows.
   */
  number: number
  title: string
  description: string
  attachments: number
  archived: boolean
  /** Id of the agent that created this card with the `create` action; null = a person made it. */
  createdBy: string | null
  /**
   * The card this one was split off from with the `create` action; null = it stands on its own.
   * Not a dependency — who waits for whom is `blockedBy`.
   */
  parentId: string | null
  assigneeIds: string[]
  /** Cards this one waits for (set by the Architect when it dispatches, or by hand). */
  blockedBy: string[]
  commentCount: number
  agentStatus: AgentStatus | null
  /** Set = the card waits for the owner and wakes no agent; null = nothing is waiting. */
  needsOwner: NeedsOwner | null
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
  /** Prefix of the card numbers on this board — the `BI` in `BI-12`. */
  key: string
  icon: string
  kind: BoardKind
  repoPath: string | null
  archived: boolean
  /** Shell command the worker runs after a coder hands a card to Review; null = no check. */
  checkCommand: string | null
  /**
   * false = this board has no architect of its own (somebody plans and reviews it from the
   * outside): Ready goes straight to the card's coder without a dispatch, a coder that
   * finishes puts its card in Review itself, and @architect starts nothing here.
   */
  architectEnabled: boolean
  /** false = the owner hears nothing from this board; see `agents/notify.mjs`. */
  notificationsEnabled: boolean
  /**
   * false = a notification from this board carries the card number, the label and the title
   * only, never the agent's `In short:` line — for a board whose text must not go to Telegram.
   */
  notificationsDetailed: boolean
  /**
   * true = the next Ready card starts only when no card is in In progress or Review: the card
   * in Review holds the queue until it is Done. See `queueHeld` in the store.
   */
  oneCardAtATime: boolean
  memberIds: string[]
  columns: Column[]
  /** Archived cards are hidden from the columns; see GET /api/boards/:id/archived */
  archivedCount: number
}

/**
 * A board without its cards — GET /api/boards. What a client that only needs to know which
 * boards exist and how they are set up gets, instead of the whole state: the notifier asks for
 * this list every few seconds to know whose feed to read.
 */
export type BoardSummary = {
  id: string
  name: string
  key: string
  archived: boolean
  architectEnabled: boolean
  notificationsEnabled: boolean
  notificationsDetailed: boolean
}

export type MessageKind = "chat" | "system"

/**
 * Where a message came in from, when it was not the board's own UI. `telegram` = the owner
 * answered a notification in the bot (`agents/telegram.mjs`); the UI marks those. `reaction` is
 * history: the board used to write a message of its own when the owner answered a question with
 * a reaction, and boards that are older than BI-79 still have those lines in their chats.
 */
export type MessageSource = "telegram" | "reaction"
export const MESSAGE_SOURCES: MessageSource[] = ["telegram", "reaction"]

export type Message = {
  id: number
  taskId: string
  authorId: string
  kind: MessageKind
  /** null = typed on the board. */
  source: MessageSource | null
  text: string
  createdAt: string
}

/**
 * The one reaction the board knows: 👍 = «the work is done, move it to Done». One and not five,
 * because a reaction is a gesture and a gesture can carry one meaning — a question of an agent's
 * the owner answers in words.
 */
export type ReactionEmoji = "👍"
export const REACTIONS: ReactionEmoji[] = ["👍"]

/** One reaction on one message. A member may put each emoji on a message once. */
export type Reaction = {
  messageId: number
  taskId: string
  memberId: string
  emoji: ReactionEmoji
  createdAt: string
}

/**
 * What the board did about a reaction, beyond storing it. Only the owner's reactions mean
 * anything; everybody else's are a mark on the message.
 *
 * - `none` — a mark, nobody woken: anybody else's 👍, or the owner's on a card outside Review
 * - `done` — the owner's 👍 on a card in Review: the board closes the card itself, no run
 */
export type ReactionEffect = "none" | "done"

/** `reaction` is null when there was no board message to put it on — see `ReactionEffect`. */
export type ReactionResult = { reaction: Reaction | null; effect: ReactionEffect }

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
  /** Every reaction on the card's messages, oldest first — the UI groups them per message. */
  reactions: Reaction[]
}

/** A card as the Architect sees it when it dispatches the queue. */
export type QueueCard = {
  id: string
  /** `BI-12` — what the Architect writes when it talks about the card. */
  ref: string
  title: string
  description: string
  column: ColumnRole
  /** Handles of the members tagged on the card. */
  assignees: string[]
  blockedBy: string[]
  /** Id of the card this one was split off from; null = it stands on its own. */
  parentId: string | null
}

/** Everything an agent needs for one run — returned by POST /api/agents/claim. */
export type RunContext = {
  run: Run
  task: Task
  agent: Member
  board: {
    id: string
    name: string
    /** Card-number prefix: the agent refers to cards as `<key>-<task.number>`. */
    key: string
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

/**
 * A card in one short read — GET /api/tasks/:id/digest, for an architect that works from
 * outside the board and should not have to wade through run logs. Everything is derived from
 * what the board already has; an object that has no answer yet is null, a list is empty.
 */
export type TaskDigest = {
  /** `BI-12`; null if the board has no key or the card no number. */
  ref: string | null
  column: ColumnRole
  /** Handles of the members tagged on the card. */
  assignees: string[]
  lastRun: {
    /** Handle of the agent that ran. */
    agent: string | null
    trigger: string
    status: RunStatus
    startedAt: string | null
    finishedAt: string | null
  } | null
  /** The card's latest run of the board's check command. `passed` null = it never finished. */
  check: {
    passed: boolean | null
    command: string
    exitCode: number | null
    /** The last lines of the check's output, without escape sequences. */
    tail: string
  } | null
  /** The last commit the board made for this card. */
  commit: { sha: string | null; files: string[] } | null
  /** The last few messages on the card, oldest first, without escape sequences and shortened. */
  lastMessages: Array<{
    /** Handle of the author. */
    author: string | null
    kind: MessageKind
    text: string
    createdAt: string
  }>
}

/**
 * What the board's stored feed can say happened — GET /api/events. One type per thing a
 * client that was not watching needs to hear about; `data` carries the details per type:
 *
 * - `card_moved` `{ from, to }` — column roles
 * - `run_started` / `run_finished` `{ agent, trigger, status }`
 * - `run_failed` `{ agent, trigger, error }` — the first line of the failure, no escape sequences
 * - `check_passed` / `check_failed` `{ command, exitCode }`
 * - `commit_made` `{ sha, files }` / `commit_skipped` `{ reason }`
 * - `agent_waiting` `{ agent }` — a coder's run ended without handing the card off: it asked
 *   something or got stuck, and nothing else is going to happen on that card by itself
 * - `agents_paused` `{ messages }` — the agent chain guard stopped the thread
 * - `needs_owner` `{ reason, text, cleared }` — a card stopped on the owner's word, and the
 *   line again with `cleared: true` when a human let it go on
 * - `owner_message` `{ author, messageId }` — the owner wrote on a card without tagging anybody
 *   on a board whose architect is switched off: nothing ran, and the architect outside the
 *   board is the one that has to answer. The text is not in the line — it is in the card's chat
 * - `owner_mentioned` `{ author, messageId }` — somebody on a card tagged the owner by handle,
 *   which the prompts allow for one thing only: a question only they can answer. `plain` carries
 *   the author's own `In short:` line (or, failing that, the first words of the message)
 * - `agent_answered` `{ author, messageId, replyTo, answer }` — an agent answered a message the
 *   owner sent in from Telegram, so that answer goes back to Telegram: `replyTo` is the owner's
 *   own Telegram message id and `answer` the agent's words for them (`agents/notify.mjs`). One
 *   line per message of theirs — the agents' further talk on the card stays on the board
 * - `reaction_added` / `reaction_removed` `{ emoji, messageId, effect }` — somebody put a
 *   reaction on a message, or took it off. Never notified about: what the board *does* about a
 *   reaction (`effect`) shows up as the line of whatever it did — a card moved, a run queued
 */
export type BoardEventType =
  | "card_moved"
  | "run_started"
  | "run_finished"
  | "run_failed"
  | "check_passed"
  | "check_failed"
  | "commit_made"
  | "commit_skipped"
  | "agent_waiting"
  | "agents_paused"
  | "needs_owner"
  | "owner_message"
  | "owner_mentioned"
  | "agent_answered"
  | "reaction_added"
  | "reaction_removed"

export const BOARD_EVENT_TYPES: BoardEventType[] = [
  "card_moved",
  "run_started",
  "run_finished",
  "run_failed",
  "check_passed",
  "check_failed",
  "commit_made",
  "commit_skipped",
  "agent_waiting",
  "agents_paused",
  "needs_owner",
  "owner_message",
  "owner_mentioned",
  "agent_answered",
  "reaction_added",
  "reaction_removed",
]

/** One line of the board's history. `id` only ever grows — it is what `since` counts in. */
export type BoardEvent = {
  id: number
  at: string
  boardId: string
  /** null = about the board as a whole, or the card has been deleted since. */
  taskId: string | null
  /** `BI-12`, while the card is still there. */
  ref: string | null
  /** The card's title as it is now, shortened — null when the event is about the board. */
  title: string | null
  type: BoardEventType
  /** Handle of whoever caused it; null = the board itself, or a person who left no trace. */
  actor: string | null
  /** The whole event in one line, without escape sequences — never a log tail. */
  summary: string
  /**
   * The agent's own line about what happened, in the owner's language and without code, paths
   * or logs (`In short: …` in its reply) — null when it wrote none. The only part of an event a
   * notification quotes; see `agents/notify.mjs`.
   */
  plain: string | null
  data: Record<string, unknown>
}

/** `cursor` is the `since` for the next request: the last id handed out, not the newest id. */
export type EventFeed = { events: BoardEvent[]; cursor: number }

export const COLUMN_ROLES: ColumnRole[] = [
  "backlog",
  "ready",
  "in_progress",
  "review",
  "done",
  "other",
]
