// Opening the database always migrates it (`catchUp` in src/server/db.ts). The rule under test:
// the version stamp does not decide anything. A file stamped with the current version — or a
// newer one — but missing a column still gets the column, because that is how notifications
// broke twice: a dev server stamped a file from half-finished code (BI-60, BI-70).
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { after, before, describe, it } from "node:test"

// The boards table as it was before `notifications_enabled`, with everything else in place —
// a file an older (or half-finished) build would leave behind.
const BOARDS_WITHOUT_NOTIFICATIONS = `
CREATE TABLE boards (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key TEXT,
  task_seq INTEGER NOT NULL DEFAULT 0,
  icon TEXT NOT NULL DEFAULT '/icons/layout-grid.svg',
  kind TEXT NOT NULL DEFAULT 'work',
  repo_path TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  architect_enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
`

let dir
let db

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-db-"))
  process.env.CS_DB_PATH = path.join(dir, "board.db")
  db = await import("../src/server/db.ts")
})

after(() => fs.rmSync(dir, { recursive: true, force: true }))

function columns(file, table) {
  const handle = new DatabaseSync(file)
  try {
    return handle.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name)
  } finally {
    handle.close()
  }
}

/** A file stamped `version` whose boards table predates `notifications_enabled`. */
function stampedFile(name, version) {
  const file = path.join(dir, name)
  const handle = new DatabaseSync(file)
  handle.exec(BOARDS_WITHOUT_NOTIFICATIONS)
  handle.exec(`PRAGMA user_version = ${version}`)
  handle.close()
  return file
}

describe("opening a database", () => {
  it("adds a missing column to a file already stamped with the current version", () => {
    const file = stampedFile("stamped-current.db", db.SCHEMA_VERSION)
    assert.ok(!columns(file, "boards").includes("notifications_enabled"))
    const existing = new DatabaseSync(file)
    existing.exec("INSERT INTO boards (id, name) VALUES ('old', 'Old board')")
    existing.close()

    db.openAt(file).close()

    assert.ok(columns(file, "boards").includes("notifications_enabled"))
    // And the one after it: a live board gets every column it is missing, not just the last.
    assert.ok(columns(file, "boards").includes("notifications_detailed"))
    // One card at a time arrives switched on for a board that already exists.
    const handle = new DatabaseSync(file)
    const row = handle
      .prepare("SELECT one_card_at_a_time AS mode, queue_release AS release FROM boards WHERE id = 'old'")
      .get()
    handle.close()
    assert.equal(row.mode, 1)
    // …and keeps today's rule: the next card starts after Done.
    assert.equal(row.release, "done")
  })

  it("adds the reactions table and the notification's board message to a file from before them", () => {
    const file = path.join(dir, "no-reactions.db")
    const handle = new DatabaseSync(file)
    handle.exec(BOARDS_WITHOUT_NOTIFICATIONS)
    // The notification links as they were: the card, and nothing about which message.
    handle.exec(
      "CREATE TABLE telegram_notifications (message_id INTEGER PRIMARY KEY, task_id TEXT NOT NULL, created_at TEXT NOT NULL)"
    )
    handle.exec(`PRAGMA user_version = ${db.SCHEMA_VERSION}`)
    handle.close()

    db.openAt(file).close()

    assert.ok(columns(file, "telegram_notifications").includes("board_message_id"))
    assert.deepEqual(columns(file, "message_reactions"), ["message_id", "member_id", "emoji", "created_at"])
  })

  it("migrates a file stamped above this build, and leaves its stamp alone", () => {
    const ahead = db.SCHEMA_VERSION + 50
    const file = stampedFile("stamped-ahead.db", ahead)

    const handle = db.openAt(file)
    const stamp = handle.prepare("PRAGMA user_version").get().user_version
    handle.close()

    assert.ok(columns(file, "boards").includes("notifications_enabled"))
    assert.equal(stamp, ahead)
  })
})

describe("per-board architect migration", () => {
  it("preserves the first architect in each board's member order and does not repin other architects on reopen", () => {
    const file = path.join(dir, "architect-selection.db")
    const old = db.openAt(file)
    old.exec(`INSERT INTO members (id, name, handle, initials, kind, agent_role)
      VALUES ('second', 'Second', 'second', 'S', 'agent', 'architect')`)
    old.exec(`INSERT INTO board_members (board_id, member_id, position) VALUES ('creative-space', 'second', -1)`)
    old.exec(`INSERT INTO boards (id, name, architect_enabled) VALUES ('other', 'Other', 0)`)
    old.exec(`INSERT INTO board_members (board_id, member_id, position) VALUES ('other', 'architect', 0), ('other', 'second', 1)`)
    old.exec("ALTER TABLE boards DROP COLUMN architect_id")
    old.close()

    const migrated = db.openAt(file)
    assert.equal(migrated.prepare("SELECT architect_id FROM boards WHERE id = 'creative-space'").get().architect_id, "second")
    const off = migrated.prepare("SELECT architect_id, architect_enabled FROM boards WHERE id = 'other'").get()
    assert.equal(off.architect_id, "architect")
    assert.equal(off.architect_enabled, 0)
    migrated.exec("DELETE FROM board_members WHERE board_id = 'other' AND member_id = 'second'")
    migrated.exec("UPDATE boards SET architect_id = 'second' WHERE id = 'creative-space'")
    migrated.close()

    const reopened = db.openAt(file)
    assert.equal(reopened.prepare("SELECT architect_id FROM boards WHERE id = 'creative-space'").get().architect_id, "second")
    assert.equal(reopened.prepare("SELECT 1 FROM board_members WHERE board_id = 'other' AND member_id = 'second'").get(), undefined)
    reopened.close()
  })

  it("disables boards when the old database has no active architect", () => {
    const file = path.join(dir, "no-architect.db")
    const old = db.openAt(file)
    old.exec("UPDATE members SET archived = 1 WHERE agent_role = 'architect'")
    old.exec("ALTER TABLE boards DROP COLUMN architect_id")
    old.close()
    const migrated = db.openAt(file)
    const board = migrated.prepare("SELECT architect_id, architect_enabled FROM boards WHERE id = 'creative-space'").get()
    assert.equal(board.architect_id, null)
    assert.equal(board.architect_enabled, 0)
    migrated.close()
  })
})
