import fs from "node:fs"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { seedIfEmpty } from "./seed"

// The whole board lives in one SQLite file next to the project.
// Override with CS_DB_PATH if you want it elsewhere.
export const DB_PATH =
  process.env.CS_DB_PATH ?? path.join(process.cwd(), "data", "board.db")

const SCHEMA = `
CREATE TABLE IF NOT EXISTS boards (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT '/icons/layout-grid.svg',
  kind TEXT NOT NULL DEFAULT 'work',
  repo_path TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  architect_engine TEXT,
  coder_engine TEXT,
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
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  priority TEXT NOT NULL DEFAULT 'MEDIUM',
  attachments INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
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
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_task ON messages(task_id, id);

CREATE TABLE IF NOT EXISTS agent_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES members(id),
  trigger TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  log TEXT NOT NULL DEFAULT '',
  summary TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS agent_runs_status ON agent_runs(status, agent_id, id);
CREATE INDEX IF NOT EXISTS agent_runs_task ON agent_runs(task_id, id);
`

type GlobalWithDb = typeof globalThis & { __creativeSpaceDb?: DatabaseSync; __creativeSpaceSchema?: number }

/** Bump when migrate() learns a new step, so a hot-reloaded dev server applies it without a restart. */
const SCHEMA_VERSION = 4

function open(): DatabaseSync {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true })
  const db = new DatabaseSync(DB_PATH)
  db.exec("PRAGMA journal_mode = WAL")
  db.exec("PRAGMA foreign_keys = ON")
  db.exec("PRAGMA busy_timeout = 3000")
  db.exec(SCHEMA)
  migrate(db)
  seedIfEmpty(db)
  return db
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
  for (const column of ["architect_engine", "coder_engine"]) {
    if (!boardColumns.includes(column)) {
      db.exec(`ALTER TABLE boards ADD COLUMN ${column} TEXT`)
    }
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
}

/** One connection per process; cached on globalThis so dev-server HMR reuses it. */
export function getDb(): DatabaseSync {
  const g = globalThis as GlobalWithDb
  if (!g.__creativeSpaceDb) {
    g.__creativeSpaceDb = open()
    g.__creativeSpaceSchema = SCHEMA_VERSION
  } else if (g.__creativeSpaceSchema !== SCHEMA_VERSION) {
    // The code changed under a running dev server: catch the database up.
    g.__creativeSpaceDb.exec(SCHEMA)
    migrate(g.__creativeSpaceDb)
    g.__creativeSpaceSchema = SCHEMA_VERSION
  }
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
