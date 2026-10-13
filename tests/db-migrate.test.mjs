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
    const row = handle.prepare("SELECT one_card_at_a_time AS mode FROM boards WHERE id = 'old'").get()
    handle.close()
    assert.equal(row.mode, 1)
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
