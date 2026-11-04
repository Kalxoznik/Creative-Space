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

/**
 * How capable — and how expensive — a coder is: a model plus an effort (`src/lib/tiers.ts`).
 * Coders only; an architect routes the work, it is not a tier.
 */
export type AgentTier = "fast" | "standard" | "strong"
export const AGENT_TIERS: AgentTier[] = ["fast", "standard", "strong"]

/** Everything the worker needs to run an agent. Lives on the agent, not on the board. */
export type AgentConfig = {
  engine: AgentEngine
  /** Model name passed to the CLI (`--model` / `-m`); null = the CLI's default. */
  model: string | null
  effort: AgentEffort | null
  /** Set for coders, null for an architect. Picking one in the editor fills model and effort. */
  tier: AgentTier | null
  /** Turn limit per run (Claude Code `--max-turns`); null = the worker's default for the role. */
  maxTurns: number | null
  /** How long one run may take before the worker kills it, in minutes; null = the worker's default (20). */
  runTimeoutMinutes: number | null
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

/** `timeout` = the worker killed the run at its agent's time limit; the work is left in the checkout. */
export type RunStatus = "queued" | "running" | "done" | "failed" | "cancelled" | "timeout"

/** The range the agent editor accepts for `runTimeoutMinutes`. */
export const RUN_TIMEOUT_MINUTES = { min: 5, max: 180, default: 20 }

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
 * answer by reading the code. And one the board sets itself: `agents_loop` — agents kept
 * waking each other with questions and answers (`wakeAsker` in the store) or with mentions and no
 * hand-off (`MAX_AGENT_CHAIN`), or the card kept coming back from review (`bounceCard`).
 */
export type NeedsOwnerReason = "paid_call" | "corpus_write" | "deploy" | "question" | "agents_loop"
export const NEEDS_OWNER_REASONS: NeedsOwnerReason[] = ["paid_call", "corpus_write", "deploy", "question", "agents_loop"]

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

/** A card's size, set at dispatch — it picks the coder tier: S → Fast, M → Standard, L → Strong. */
export type CardSize = "S" | "M" | "L"
export const CARD_SIZES: CardSize[] = ["S", "M", "L"]

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
  /** How big the Architect judged the card when it dispatched it; null = never sized. */
  size: CardSize | null
  commentCount: number
  agentStatus: AgentStatus | null
  /** Set = the card waits for the owner and wakes no agent; null = nothing is waiting. */
  needsOwner: NeedsOwner | null
  /**
   * How many times the Architect was woken because this card got stuck, of `MAX_SUPERVISIONS`;
   * the next time it is the owner's. Starts over on Done, Backlog or a human's answer.
   */
  supervisions: number
  /**
   * The card's own git worktree (`Board.parallelWork`): the branch its work is committed on, the
   * folder it is checked out in, and the branch it merges back into. null = the board's checkout.
   */
  worktree: { branch: string; path: string; base: string } | null
  createdAt: string
  updatedAt: string
}

/** Times the Architect steps in on a stuck card before the board asks the owner instead. */
export const MAX_SUPERVISIONS = 2

/**
 * Why a card got stuck — the last part of a `supervise:<runId>:<reason>` trigger.
 * `waiting` = the coder finished without handing the card off and without asking anybody.
 */
export type StuckReason = "failed" | "turn_limit" | "loop" | "timeout" | "lost" | "check_failed" | "waiting"

export const STUCK_LABELS: Record<StuckReason, string> = {
  failed: "the run failed",
  turn_limit: "the run ran out of turns",
  loop: "the run was stopped as a loop",
  timeout: "the run timed out",
  lost: "the worker lost the run",
  check_failed: "the check failed again after its retry",
  waiting: "the coder stopped without handing the card off",
}

export type Column = {
  id: string
  boardId: string
  title: string
  role: ColumnRole
  position: number
  tasks: Task[]
}

export type QueueRelease = "done" | "review"

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
  /** Selected architect, including while switched off; null if none is available. */
  architectId: string | null
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
   * in Review holds the queue until it is Done, unless `queueRelease` says otherwise. See
   * `queueHeld` in the store.
   */
  oneCardAtATime: boolean
  /**
   * With `oneCardAtATime` on, what frees the queue: 'done' = the card reaching Done (a card in
   * Review holds it), 'review' = the Architect moving it to Review, so a batch can pile up there.
   */
  queueRelease: QueueRelease
  /**
   * true = the Architect's approval of a hand-off puts the card straight into Done; false (the
   * default) = the card waits in Review until the owner moves it. See `updateTask` in the store.
   */
  autopilot: boolean
  /**
   * true = a card in In progress is worked on in its own git worktree, on branch `cs/<KEY>-<N>`,
   * and merged into the main branch when it is released (Done, or Review with `queueRelease`
   * 'review'). false (the default) = everything happens in the one checkout, as it always has.
   */
  parallelWork: boolean
  /** Run once in a fresh worktree before the coder starts (`npm ci`); null = nothing. */
  setupCommand: string | null
  /**
   * With `parallelWork` on: how many coder runs may work in the repository at the same time,
   * each in its own card's worktree (1–3, default 2), and — with `oneCardAtATime` — how many
   * cards may be in work before the queue holds. Ignored with `parallelWork` off.
   */
  maxCoders: number
  /** Coder runs executing right now in this board's repository (any board sharing it counts). */
  codersRunning: number
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
  architectId: string | null
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
  /** The size an earlier dispatch gave the card; null = not sized yet. */
  size: CardSize | null
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
    architectId: string | null
    architectEnabled: boolean
    checkCommand: string | null
    parallelWork: boolean
    /** `Board.maxCoders` (1–3): how many coders may work at once with Parallel work on. */
    maxCoders: number
    setupCommand: string | null
    columns: Array<{ id: string; title: string; role: ColumnRole }>
  }
  members: Member[]
  thread: Message[]
  triggerMessage: Message | null
  /** Only for `dispatch` runs: the board's queue (Ready) and what is in progress. */
  queue: { ready: QueueCard[]; inProgress: QueueCard[] } | null
  /** Only for the Architect's `supervise:` runs: the run that got stuck, and how it ended. */
  stuck: StuckRun | null
}

export type StuckRun = {
  runId: number
  reason: StuckReason
  /** Handle of the coder whose run it was. */
  agent: string
  trigger: string
  status: RunStatus
  summary: string | null
  /** The end of that run's log — its last steps and the worker's lines. */
  logTail: string
  /** Which intervention this is on the card (1-based), of `MAX_SUPERVISIONS`. */
  attempt: number
  max: number
}

/** What the Architect decides for the queue — the worker posts it to POST /api/boards/:id/dispatch. */
export type DispatchDecision = {
  /** taskId → agent handle (a coder on the board). */
  assign: Record<string, string>
  /** Ready card ids, top first; cards left out keep their relative order after these. */
  order: string[]
  /** taskId → ids of the cards it must wait for. */
  blockedBy: Record<string, string[]>
  /** taskId → the card's size (agents/prompts/dispatch.md: S → Fast, M → Standard, L → Strong). */
  size: Record<string, CardSize>
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
 * - `card_moved` `{ from, to, autopilot? }` — column roles; `autopilot: true` when Autopilot took
 *   the Architect's approval past Review to Done
 * - `run_started` / `run_finished` `{ agent, trigger, status }`
 * - `run_failed` `{ agent, trigger, error, timeout? }` — the first line of the failure, no escape
 *   sequences; `timeout: true` when the worker killed the run at its time limit (status `timeout`)
 * - `check_passed` / `check_failed` `{ command, exitCode }`
 * - `commit_made` `{ sha, files }` / `commit_skipped` `{ reason }`
 * - `agent_waiting` `{ agent }` — a coder's run ended without handing the card off: it asked
 *   something or got stuck, and nothing else is going to happen on that card by itself
 * - `agents_paused` `{ messages }` — the agent chain guard stopped the thread (older feeds only:
 *   the guard now stops the card with `needs_owner` reason `agents_loop`)
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
