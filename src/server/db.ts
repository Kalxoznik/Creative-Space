import fs from "node:fs"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { suggestBoardKey } from "./board-key"
import { seedIfEmpty } from "./seed"

// The whole board lives in one SQLite file next to the project.
// Override with CS_DB_PATH if you want it elsewhere.
export const DB_PATH =
  process.env.CS_DB_PATH ?? path.join(process.cwd(), "data", "board.db")

const SCHEMA = `
CREATE TABLE IF NOT EXISTS boards (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  -- Short prefix of the card number people see: the BI in BI-12.
  key TEXT,
  -- Numbers handed out so far. A counter, not MAX(number): a deleted card's number is gone.
  task_seq INTEGER NOT NULL DEFAULT 0,
  icon TEXT NOT NULL DEFAULT '/icons/layout-grid.svg',
  kind TEXT NOT NULL DEFAULT 'work',
  repo_path TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  architect_engine TEXT,
  coder_engine TEXT,
  check_command TEXT,
  -- 0 = this board runs without an architect: Ready goes straight to the coder, a green
  -- check goes straight to Review, and @architect wakes nobody here.
  architect_enabled INTEGER NOT NULL DEFAULT 1,
  -- 0 = the owner is not told about what happens here (macOS / Telegram notifications).
  notifications_enabled INTEGER NOT NULL DEFAULT 1,
  -- 0 = a notification from this board carries no agent text, only the card and the label.
  notifications_detailed INTEGER NOT NULL DEFAULT 1,
  -- 1 = the next Ready card starts only once nothing is in In progress or Review.
  one_card_at_a_time INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS columns (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'other',
  position INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS columns_board ON columns(board_id, position);

CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  handle TEXT NOT NULL UNIQUE,
  initials TEXT NOT NULL,
  tone TEXT NOT NULL DEFAULT 'amber',
  kind TEXT NOT NULL DEFAULT 'human',
  agent_role TEXT,
  is_owner INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  -- agent configuration (agents only)
  engine TEXT,
  model TEXT,
  effort TEXT,
  max_turns INTEGER,
  description TEXT NOT NULL DEFAULT '',
  instructions TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS board_members (
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (board_id, member_id)
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  column_id TEXT NOT NULL REFERENCES columns(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  -- Card number inside its board (board key + number = BI-12). Never reused, never renumbered.
  number INTEGER,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  attachments INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  -- The agent that created this card through the 'create' action; NULL = a person made it.
  created_by TEXT REFERENCES members(id),
  -- The card this one was split off from (the 'create' action); NULL = it stands on its own.
  -- Not a dependency: who waits for whom lives in task_blockers.
  parent_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  -- What the repository looked like when work on this card started (JSON, written by the
  -- worker). The commit after a hand-off is taken against this, not against the start of
  -- the last run — the work and the hand-off are often different runs.
  work_snapshot TEXT,
  -- The card is waiting for the owner: paid_call | corpus_write | deploy | question, with
  -- one line saying what for. NULL = nothing is waiting. While it is set no agent run is
  -- queued on this card; a human's message in the chat clears it.
  needs_owner_reason TEXT,
  needs_owner_text TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_column ON tasks(column_id, position);

CREATE TABLE IF NOT EXISTS task_assignees (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (task_id, member_id)
);

CREATE TABLE IF NOT EXISTS task_blockers (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  blocked_by TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, blocked_by)
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES members(id),
  kind TEXT NOT NULL DEFAULT 'chat',
  -- Where the message came in from, when it was not the board's own UI: 'telegram' = the owner
  -- answered a notification in the bot. NULL = typed on the board.
  source TEXT,
  -- The owner's own message in Telegram, when this is the one the bot brought in: the agent's
  -- answer goes back as a reply to it (agents/notify.mjs). NULL = it came from anywhere else.
  telegram_message_id INTEGER,
  -- When that answer was sent. One answer per message of theirs: everything the agents say on
  -- the card afterwards stays on the board.
  telegram_answered_at TEXT,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_task ON messages(task_id, id);

-- The owner answering with a reaction instead of a sentence. One reaction, 👍, and it says the
-- work is done. One row per (message, member, emoji) — putting the same reaction twice is the
-- same reaction. What it *means* is store.ts, not here.
CREATE TABLE IF NOT EXISTS message_reactions (
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (message_id, member_id, emoji)
);
CREATE INDEX IF NOT EXISTS message_reactions_message ON message_reactions(message_id);

-- Which card a Telegram notification was about, so a reply to it lands in that card's chat
-- (agents/telegram.mjs). In the file and not in the worker's memory on purpose: the owner
-- replies to a notification hours later, long after the worker was last restarted.
CREATE TABLE IF NOT EXISTS telegram_notifications (
  message_id INTEGER PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  -- The message on the board the notification is about: the agent's question for a "Question", the
  -- reply with the "In short:" line for a Review. A reaction on the notification becomes a
  -- reaction on this message; NULL = there was none, and the reaction applies to the card.
  board_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES members(id),
  trigger TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  log TEXT NOT NULL DEFAULT '',
  summary TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  -- Last time the worker reported progress on this run. The board's watchdog closes a run
  -- that stopped reporting (sweepLostRuns in store.ts), so a worker that dies mid-run does
  -- not leave the card's agent busy forever.
  heartbeat_at TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS agent_runs_status ON agent_runs(status, agent_id, id);
CREATE INDEX IF NOT EXISTS agent_runs_task ON agent_runs(task_id, id);

-- The board's event feed: what happened, in order, for a client that was not watching
-- (src/server/feed.ts). A deleted card keeps its lines, with task_id blanked out.
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  type TEXT NOT NULL,
  actor_id TEXT REFERENCES members(id) ON DELETE SET NULL,
  -- One line, no escape sequences; the details live in data (JSON).
  summary TEXT NOT NULL DEFAULT '',
  data TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS events_board ON events(board_id, id);
`

type GlobalWithDb = typeof globalThis & { __creativeSpaceDb?: DatabaseSync }

/**
 * What this build's schema is called. A stamp in the file, nothing more: it is written after a
 * catch-up and never read to decide whether to run one — see catchUp().
 */
export const SCHEMA_VERSION = 21

/** The feed is a tail, not an archive: anything older goes when the process opens the file. */
const EVENT_RETENTION_DAYS = 30

/** Open one board file, migrated and ready to query. Exported for tests; the board uses getDb(). */
export function openAt(file: string = DB_PATH): DatabaseSync {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec("PRAGMA journal_mode = WAL")
  db.exec("PRAGMA foreign_keys = ON")
  db.exec("PRAGMA busy_timeout = 3000")
  catchUp(db)
  pruneEvents(db)
  pruneTelegramLinks(db)
  seedIfEmpty(db)
  return db
}

/** The version stamp this *file* carries. Reported, compared, but never a reason to skip a step. */
function fileVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined
  return Number(row?.user_version ?? 0)
}

/**
 * Bring the file up to this build's schema: the schema, then the migrations, then the stamp.
 * Both halves run on every open, whatever the stamp says — every step is idempotent
 * (`IF NOT EXISTS`, a column check before every ALTER), so running them again costs a handful
 * of PRAGMAs and guarantees the file matches the code that is about to query it.
 *
 * The stamp used to gate this, and twice in one day it gated out a migration people needed: a
 * dev server picks up a half-finished `db.ts`, stamps the file with a version whose columns
 * were not written yet, and every later open believes the file is up to date.
 * A version number cannot describe a file written by code that no longer exists — the file's
 * own `PRAGMA table_info` can, and that is what migrate() asks.
 *
 * Returns true when the stamp was raised, i.e. the file was behind this build. The stamp only
 * ever goes up: a file written by a newer build keeps its number.
 */
function catchUp(db: DatabaseSync): boolean {
  const before = fileVersion(db)
  db.exec(SCHEMA)
  migrate(db)
  if (before < SCHEMA_VERSION) db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
  return before < SCHEMA_VERSION
}

/** Drop feed lines older than the retention window. Once per process, on open. */
export function pruneEvents(db: DatabaseSync): void {
  const cutoff = new Date(Date.now() - EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString()
  db.prepare("DELETE FROM events WHERE at < ?").run(cutoff)
}

/**
 * Drop the notification → card links older than the retention window. A notification nobody
 * replied to in a month is not going to be replied to; the same window as the feed it comes from.
 */
export function pruneTelegramLinks(db: DatabaseSync): void {
  const cutoff = new Date(Date.now() - EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString()
  db.prepare("DELETE FROM telegram_notifications WHERE created_at < ?").run(cutoff)
}

/** Additive migrations for databases created by earlier versions. */
function migrate(db: DatabaseSync): void {
  const boardColumns = (db.prepare("PRAGMA table_info(boards)").all() as Array<{ name: string }>).map(
    (c) => c.name
  )
  if (!boardColumns.includes("archived")) {
    db.exec("ALTER TABLE boards ADD COLUMN archived INTEGER NOT NULL DEFAULT 0")
  }
  const taskColumns = (db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map((c) => c.name)
  if (!taskColumns.includes("archived")) {
    db.exec("ALTER TABLE tasks ADD COLUMN archived INTEGER NOT NULL DEFAULT 0")
  }
  if (!taskColumns.includes("created_by")) {
    db.exec("ALTER TABLE tasks ADD COLUMN created_by TEXT REFERENCES members(id)")
  }
  if (!taskColumns.includes("parent_id")) {
    db.exec("ALTER TABLE tasks ADD COLUMN parent_id TEXT REFERENCES tasks(id) ON DELETE SET NULL")
  }
  if (!taskColumns.includes("work_snapshot")) {
    db.exec("ALTER TABLE tasks ADD COLUMN work_snapshot TEXT")
  }
  // The "waiting for the owner" flag; existing cards are not waiting for anything.
  if (!taskColumns.includes("needs_owner_reason")) {
    db.exec("ALTER TABLE tasks ADD COLUMN needs_owner_reason TEXT")
  }
  if (!taskColumns.includes("needs_owner_text")) {
    db.exec("ALTER TABLE tasks ADD COLUMN needs_owner_text TEXT NOT NULL DEFAULT ''")
  }
  for (const column of ["architect_engine", "coder_engine", "check_command"]) {
    if (!boardColumns.includes(column)) {
      db.exec(`ALTER TABLE boards ADD COLUMN ${column} TEXT`)
    }
  }
  // Existing boards keep their architect: the switch is off only where someone turns it off.
  if (!boardColumns.includes("architect_enabled")) {
    db.exec("ALTER TABLE boards ADD COLUMN architect_enabled INTEGER NOT NULL DEFAULT 1")
  }
  // Notifications are on where nobody said otherwise — a board that is worked on is a board
  // the owner wants to hear about.
  if (!boardColumns.includes("notifications_enabled")) {
    db.exec("ALTER TABLE boards ADD COLUMN notifications_enabled INTEGER NOT NULL DEFAULT 1")
  }
  // The agent's own line in a notification is on where nobody said otherwise: a notification
  // that says what happened is the point of having one.
  if (!boardColumns.includes("notifications_detailed")) {
    db.exec("ALTER TABLE boards ADD COLUMN notifications_detailed INTEGER NOT NULL DEFAULT 1")
  }
  // One card at a time is on for existing boards too. Nothing is moved by the migration: cards
  // already in In progress or Review just hold the queue until they reach Done.
  if (!boardColumns.includes("one_card_at_a_time")) {
    db.exec("ALTER TABLE boards ADD COLUMN one_card_at_a_time INTEGER NOT NULL DEFAULT 1")
  }
  // Messages from before the Telegram bot could write back: all of them were typed on the board.
  const messageColumns = (db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>).map((c) => c.name)
  if (!messageColumns.includes("source")) {
    db.exec("ALTER TABLE messages ADD COLUMN source TEXT")
  }
  // Messages from before the agent's answer went back to Telegram: none of them came in with a
  // Telegram message to answer, and none of them is owed an answer there.
  if (!messageColumns.includes("telegram_message_id")) {
    db.exec("ALTER TABLE messages ADD COLUMN telegram_message_id INTEGER")
  }
  if (!messageColumns.includes("telegram_answered_at")) {
    db.exec("ALTER TABLE messages ADD COLUMN telegram_answered_at TEXT")
  }
  // Notifications sent before the board remembered which message they were about: a reaction on
  // one of those applies to the card, which is what a NULL here says.
  const noteColumns = (
    db.prepare("PRAGMA table_info(telegram_notifications)").all() as Array<{ name: string }>
  ).map((c) => c.name)
  if (!noteColumns.includes("board_message_id")) {
    db.exec("ALTER TABLE telegram_notifications ADD COLUMN board_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL")
  }
  const runColumns = (db.prepare("PRAGMA table_info(agent_runs)").all() as Array<{ name: string }>).map((c) => c.name)
  if (!runColumns.includes("cancel_requested")) {
    db.exec("ALTER TABLE agent_runs ADD COLUMN cancel_requested INTEGER NOT NULL DEFAULT 0")
  }
  // Runs from before the watchdog: their last report is their start, which is all it needs.
  if (!runColumns.includes("heartbeat_at")) {
    db.exec("ALTER TABLE agent_runs ADD COLUMN heartbeat_at TEXT")
  }
  // The Coder runs on Claude Code now; rename the seeded member unless it was renamed by hand.
  db.prepare("UPDATE members SET name = 'Coder (Claude)', initials = 'CD' WHERE id = 'coder' AND name = 'Coder (Codex)'").run()
  // Databases from before the owner flag: the first human member is the owner.
  const memberColumns = (db.prepare("PRAGMA table_info(members)").all() as Array<{ name: string }>).map((c) => c.name)
  if (!memberColumns.includes("is_owner")) {
    db.exec("ALTER TABLE members ADD COLUMN is_owner INTEGER NOT NULL DEFAULT 0")
  }
  const owner = db.prepare("SELECT id FROM members WHERE is_owner = 1 LIMIT 1").get() as { id: string } | undefined
  if (!owner) {
    db.prepare(
      "UPDATE members SET is_owner = 1 WHERE id = (SELECT id FROM members WHERE kind = 'human' ORDER BY rowid LIMIT 1)"
    ).run()
  }
  // Agent configuration moved from the board (architect_engine / coder_engine) onto the agent itself.
  for (const [column, ddl] of [
    ["archived", "INTEGER NOT NULL DEFAULT 0"],
    ["engine", "TEXT"],
    ["model", "TEXT"],
    ["effort", "TEXT"],
    ["max_turns", "INTEGER"],
    ["description", "TEXT NOT NULL DEFAULT ''"],
    ["instructions", "TEXT NOT NULL DEFAULT ''"],
  ]) {
    if (!memberColumns.includes(column)) db.exec(`ALTER TABLE members ADD COLUMN ${column} ${ddl}`)
  }
  // Agents from before: Claude Code, like the worker's old default. A board that pinned Codex for a
  // role keeps that choice on the agent itself.
  db.prepare("UPDATE members SET engine = 'claude' WHERE kind = 'agent' AND engine IS NULL").run()
  for (const role of ["architect", "coder"]) {
    const pinned = db
      .prepare(`SELECT ${role}_engine AS e FROM boards WHERE ${role}_engine = 'codex' LIMIT 1`)
      .get() as { e: string } | undefined
    if (pinned) {
      db.prepare("UPDATE members SET engine = 'codex' WHERE id = ? AND kind = 'agent'").run(role)
      db.prepare(`UPDATE boards SET ${role}_engine = NULL`).run()
    }
  }
  db.prepare(
    "UPDATE members SET description = 'Plans tasks, dispatches the queue, reviews the Coder''s work' WHERE id = 'architect' AND kind = 'agent' AND description = ''"
  ).run()
  db.prepare(
    "UPDATE members SET description = 'General-purpose coder: implements cards end to end' WHERE id = 'coder' AND kind = 'agent' AND description = ''"
  ).run()
  // An architect is a member of every board, like the owner. Boards from before that rule,
  // or boards created while an architect was unchecked, get it back here.
  db.prepare(
    `INSERT OR IGNORE INTO board_members (board_id, member_id, position)
     SELECT b.id, m.id, (SELECT COALESCE(MAX(position), -1) + 1 FROM board_members WHERE board_id = b.id)
     FROM boards b, members m
     WHERE m.kind = 'agent' AND m.agent_role = 'architect' AND m.archived = 0`
  ).run()
  numberCards(db, boardColumns, taskColumns)
}

/**
 * Card numbers (`BI-12`) for a database that did not have them: a key per board, and a
 * number per card by creation order inside its board. Runs once — afterwards every board
 * has a key and every card a number, and the steps below find nothing to do.
 */
function numberCards(db: DatabaseSync, boardColumns: string[], taskColumns: string[]): void {
  if (!boardColumns.includes("key")) db.exec("ALTER TABLE boards ADD COLUMN key TEXT")
  if (!boardColumns.includes("task_seq")) {
    db.exec("ALTER TABLE boards ADD COLUMN task_seq INTEGER NOT NULL DEFAULT 0")
  }
  if (!taskColumns.includes("number")) db.exec("ALTER TABLE tasks ADD COLUMN number INTEGER")

  const boards = db
    .prepare(`SELECT id, name, "key" AS key FROM boards ORDER BY position, rowid`)
    .all() as Array<{ id: string; name: string; key: string | null }>
  // Archived boards keep their key too — their cards are still referred to in old chats.
  const taken = new Set(boards.map((board) => board.key).filter((key): key is string => !!key))
  for (const board of boards) {
    if (board.key) continue
    const key = suggestBoardKey(board.name, taken)
    taken.add(key)
    db.prepare(`UPDATE boards SET "key" = ? WHERE id = ?`).run(key, board.id)
  }

  // Oldest card first, so the numbers read like the board's history. Archived cards are
  // numbered as well: they are what the counter must not hand out twice.
  const unnumbered = db
    .prepare("SELECT id, board_id FROM tasks WHERE number IS NULL ORDER BY board_id, created_at, rowid")
    .all() as Array<{ id: string; board_id: string }>
  if (unnumbered.length > 0) {
    const next = new Map(
      (
        db.prepare("SELECT board_id, COALESCE(MAX(number), 0) AS n FROM tasks GROUP BY board_id").all() as Array<{
          board_id: string
          n: number
        }>
      ).map((row) => [row.board_id, row.n])
    )
    const setNumber = db.prepare("UPDATE tasks SET number = ? WHERE id = ?")
    for (const task of unnumbered) {
      const number = (next.get(task.board_id) ?? 0) + 1
      next.set(task.board_id, number)
      setNumber.run(number, task.id)
    }
  }
  // The counter catches up with the numbers that exist; it only ever goes up from here.
  db.exec(
    "UPDATE boards SET task_seq = MAX(task_seq, (SELECT COALESCE(MAX(number), 0) FROM tasks WHERE board_id = boards.id))"
  )
  // Not in SCHEMA: on an old database the column does not exist yet when SCHEMA is applied.
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS tasks_number ON tasks(board_id, number)")
}

/**
 * Has *this* module instance caught the file up yet? Not a cache of the file's state — a
 * dev-server reload gives a fresh instance with this back at false, which is exactly when a
 * connection cached on globalThis has to be run through the new code's migrations again.
 */
let caughtUp = false

/** One connection per process; cached on globalThis so dev-server HMR reuses it. */
export function getDb(): DatabaseSync {
  const g = globalThis as GlobalWithDb
  if (!g.__creativeSpaceDb) {
    g.__creativeSpaceDb = openAt()
  } else if (!caughtUp) {
    // The code changed under a running dev server. Re-run the migrations on the connection it
    // left behind: a schema this server cannot see is how a run once failed with a raw SQLite
    // error.
    if (catchUp(g.__creativeSpaceDb)) {
      console.log(`[db] ${DB_PATH} migrated to schema ${SCHEMA_VERSION} without a restart`)
    }
  }
  caughtUp = true
  return g.__creativeSpaceDb
}

export function nowIso(): string {
  return new Date().toISOString()
}

export function newId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8)
  const time = Date.now().toString(36)
  return `${prefix}_${time}${rand}`
}

/** Run `fn` inside a transaction; rolls back on throw. */
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE")
  try {
    const result = fn()
    db.exec("COMMIT")
    return result
  } catch (error) {
    db.exec("ROLLBACK")
    throw error
  }
}
