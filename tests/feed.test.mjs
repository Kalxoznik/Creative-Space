// The board's stored event feed (src/server/feed.ts): every type is written where the thing
// it describes happens, a summary is one line of plain text, and since/limit/cursor let a
// client that was away read the feed exactly once.
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, before, describe, it } from "node:test"

const BOARD = "creative-space"
/** The seeded board's key — `suggestBoardKey("Creative Space")`. */
const BOARD_KEY = "CS"
const ESC = ""
let store
let feed
let dir

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-feed-"))
  process.env.CS_DB_PATH = path.join(dir, "board.db")
  store = await import("../src/server/store.ts")
  feed = await import("../src/server/feed.ts")
})

after(() => fs.rmSync(dir, { recursive: true, force: true }))

/** A card in Backlog, tagged for the coder. */
function card(title) {
  return store.createTask({
    boardId: BOARD,
    columnId: `${BOARD}:backlog`,
    title,
    assigneeIds: ["coder"],
  }).id
}

/** Where the feed is right now: everything after this is what the case under test caused. */
function cursor() {
  return feed.listBoardEvents(BOARD, { limit: 500 }).cursor
}

/** The events this card got after `from`, oldest first. */
function since(from, taskId = null) {
  const { events } = feed.listBoardEvents(BOARD, { since: from, limit: 500 })
  return taskId ? events.filter((e) => e.taskId === taskId) : events
}

const typesOf = (events) => events.map((e) => e.type)
const pick = (events, type) => events.find((e) => e.type === type)

/** Free the coder again, so the next case starts from a quiet board. */
function finish(taskId) {
  for (const run of store.listRuns(taskId)) {
    if (run.status === "queued") store.cancelRun(run.id)
    else if (run.status === "running") store.finishRun(run.id, { status: "done" })
  }
  store.updateTask(taskId, { archived: true })
}

describe("what the feed records, and where", () => {
  it("a card changing column writes card_moved with its two column roles", () => {
    const taskId = card("A card that moves")
    const at = cursor()
    store.updateTask(taskId, { columnRole: "in_progress" })

    const moved = pick(since(at, taskId), "card_moved")
    assert.ok(moved, "a move writes card_moved")
    assert.deepEqual(moved.data, { from: "backlog", to: "in_progress" })
    assert.equal(moved.ref, `${BOARD_KEY}-${store.getTask(taskId).number}`)
    // The title comes with the line: a client that names the card (the notifications) needs
    // no second request for it.
    assert.equal(moved.title, "A card that moves")
    assert.match(moved.summary, /A card that moves/)
    finish(taskId)
  })

  it("a title too long for a notification is cut to 60 characters", () => {
    const long = `A card whose title is far too long to fit in a notification ${"x".repeat(80)}`
    const taskId = card(long)
    const at = cursor()
    store.updateTask(taskId, { columnRole: "in_progress" })

    const moved = pick(since(at, taskId), "card_moved")
    assert.equal(moved.title.length, 60)
    assert.ok(moved.title.endsWith("…"))
    assert.ok(long.startsWith(moved.title.slice(0, -1)))
    finish(taskId)
  })

  it("the agent's own line rides along with the move, in plain words and cut to 300", () => {
    const taskId = card("A card handed off with a word about it")
    const at = cursor()
    store.updateTask(taskId, {
      columnRole: "review",
      actorId: "coder",
      plain: `Rewrote the notifications.\nNow you can see what was done. ${"x".repeat(400)}`,
    })

    const moved = pick(since(at, taskId), "card_moved")
    assert.equal(moved.plain.length, 300)
    assert.ok(moved.plain.startsWith("Rewrote the notifications. Now you can see what was done."))
    assert.ok(moved.plain.endsWith("…"))
    assert.equal(/[\n\r]/.test(moved.plain), false, "one line, like a summary")
    finish(taskId)
  })

  it("a move nobody wrote a line for has none: the notification says what it always said", () => {
    const taskId = card("A card a person dragged")
    const at = cursor()
    store.updateTask(taskId, { columnRole: "review" })

    assert.equal(pick(since(at, taskId), "card_moved").plain, null)
    finish(taskId)
  })

  it("needs_owner carries the agent's line, not the question it asked the board", () => {
    const taskId = card("A card waiting for the owner")
    store.updateTask(taskId, { columnRole: "in_progress" })
    const at = cursor()
    store.setNeedsOwner(taskId, {
      actorId: "coder",
      reason: "question",
      text: "notificationsDetailed default: on or off?",
      plain: "Need to decide whether detailed notifications are on by default.",
    })

    const asked = pick(since(at, taskId), "needs_owner")
    assert.equal(asked.plain, "Need to decide whether detailed notifications are on by default.")
    assert.ok(!asked.plain.includes("notificationsDetailed"))
    store.clearNeedsOwner(taskId)
    finish(taskId)
  })

  it("a failed run carries the line the agent managed to write before it fell over", () => {
    const taskId = card("A card whose run failed with a word about it")
    store.updateTask(taskId, { columnRole: "in_progress" })
    const claimed = store.claimRun("coder")
    const at = cursor()
    store.finishRun(claimed.run.id, {
      status: "failed",
      summary: "Error: ENOENT /Users/max/secret/path.ts:14",
      plain: "The run failed on the check; the changes are left in the working tree.",
    })

    const failed = pick(since(at, taskId), "run_failed")
    assert.equal(failed.plain, "The run failed on the check; the changes are left in the working tree.")
    assert.ok(!failed.plain.includes("/Users/max"))
    finish(taskId)
  })

  it("claiming a run writes run_started; finishing it writes run_finished", () => {
    const taskId = card("A card with a run on it")
    store.updateTask(taskId, { columnRole: "in_progress" })
    const at = cursor()

    const claimed = store.claimRun("coder")
    assert.equal(claimed?.task.id, taskId)
    const started = pick(since(at, taskId), "run_started")
    assert.ok(started)
    assert.equal(started.actor, "coder")
    assert.deepEqual(started.data, { agent: "coder", trigger: "column:in_progress" })

    store.finishRun(claimed.run.id, { status: "done", summary: "done here" })
    const finished = pick(since(at, taskId), "run_finished")
    assert.ok(finished)
    assert.equal(finished.data.status, "done")
    assert.equal(finished.data.agent, "coder")
    finish(taskId)
  })

  it("a coder run that ends without handing the card off writes agent_waiting", () => {
    const taskId = card("A card the coder got stuck on")
    store.updateTask(taskId, { columnRole: "in_progress" })
    const at = cursor()
    const claimed = store.claimRun("coder")
    store.finishRun(claimed.run.id, { status: "done", summary: "I have a question" })

    // The card is still in In progress and nothing is queued on it: that is the whole signal.
    assert.deepEqual(typesOf(since(at, taskId)), ["run_started", "run_finished", "agent_waiting"])
    finish(taskId)
  })

  it("a hand-off is not agent_waiting: the review run is what happens next", () => {
    const taskId = card("A card handed off properly")
    store.updateTask(taskId, { columnRole: "in_progress" })
    const claimed = store.claimRun("coder")
    const at = cursor()
    store.updateTask(taskId, { columnRole: "review", actorId: "coder" })
    store.finishRun(claimed.run.id, { status: "done", summary: "done" })

    assert.ok(!pick(since(at, taskId), "agent_waiting"))
    finish(taskId)
  })

  it("a failed run writes run_failed with the first line of the error, no escape sequences", () => {
    const taskId = card("A card whose run blew up")
    store.updateTask(taskId, { columnRole: "in_progress" })
    const at = cursor()
    const claimed = store.claimRun("coder")
    store.finishRun(claimed.run.id, {
      status: "failed",
      summary: `${ESC}[31mclaude: not logged in${ESC}[0m\nRun 'claude' to log in\nand then try again`,
    })

    const failed = pick(since(at, taskId), "run_failed")
    assert.ok(failed)
    assert.equal(failed.data.error, "claude: not logged in")
    assert.equal(failed.summary.includes(ESC), false)
    assert.equal(failed.summary.includes("try again"), false, "only the first line reaches the summary")
    finish(taskId)
  })

  it("the board's check writes check_passed / check_failed with the command and the exit code", () => {
    const passing = card("A card whose check passes")
    let at = cursor()
    store.reportCheck(passing, { actorId: "coder", command: "npm test", exitCode: 0, output: "" })
    const passed = pick(since(at, passing), "check_passed")
    assert.ok(passed)
    assert.deepEqual(passed.data, { command: "npm test", exitCode: 0 })

    const failing = card("A card whose check fails")
    at = cursor()
    store.reportCheck(failing, {
      actorId: "coder",
      command: "npm test",
      exitCode: 2,
      output: `${ESC}[2K⠋ running\r1 failing\n  TypeError: x is not a function\n    at foo.ts:1`,
    })
    const failed = pick(since(at, failing), "check_failed")
    assert.ok(failed)
    assert.deepEqual(failed.data, { command: "npm test", exitCode: 2 })
    // The output is in the card's chat and in the run log; the feed only says it failed.
    assert.equal(failed.summary.includes("TypeError"), false)
    finish(failing)
    finish(passing)
  })

  it("the commit step writes commit_made with the sha and the files, or commit_skipped with the reason", () => {
    const taskId = card("A card that gets committed")
    let at = cursor()
    store.reportCommit(taskId, { actorId: "coder", sha: "deadbee", files: ["src/a.ts", "src/b.ts"] })
    const made = pick(since(at, taskId), "commit_made")
    assert.ok(made)
    assert.equal(made.data.sha, "deadbee")
    assert.deepEqual(made.data.files, ["src/a.ts", "src/b.ts"])

    at = cursor()
    store.reportCommit(taskId, { actorId: "coder", skipped: "nothing to commit" })
    const skipped = pick(since(at, taskId), "commit_skipped")
    assert.ok(skipped)
    assert.deepEqual(skipped.data, { reason: "nothing to commit" })
    finish(taskId)
  })

  it("the agent chain guard writes agents_paused", () => {
    const taskId = card("A card the agents talked themselves out on")
    const at = cursor()
    for (let n = 0; n < 6; n += 1) {
      store.addMessage({ taskId, authorId: "architect", text: `thinking out loud ${n}` })
    }
    store.addMessage({ taskId, authorId: "architect", text: "@coder over to you" })

    const paused = pick(since(at, taskId), "agents_paused")
    assert.ok(paused, "the 7th agent message in a row is where the chain stops")
    assert.equal(paused.data.messages, 6)
    finish(taskId)
  })
})

describe("reading the feed", () => {
  it("since / limit / cursor walk the feed once, in order", () => {
    const all = feed.listBoardEvents(BOARD, { since: 0, limit: 500 })
    assert.ok(all.events.length > 6, "the cases above left a feed to page through")
    assert.equal(all.cursor, all.events[all.events.length - 1].id)
    assert.deepEqual(
      all.events.map((e) => e.id),
      [...all.events.map((e) => e.id)].sort((a, b) => a - b),
      "oldest first"
    )

    const first = feed.listBoardEvents(BOARD, { since: 0, limit: 3 })
    assert.equal(first.events.length, 3)
    assert.equal(first.cursor, first.events[2].id)
    const next = feed.listBoardEvents(BOARD, { since: first.cursor, limit: 3 })
    assert.equal(next.events[0].id, all.events[3].id, "no overlap and no gap")

    // Nothing new: the cursor stays where the client left it.
    const tail = feed.listBoardEvents(BOARD, { since: all.cursor })
    assert.deepEqual(tail.events, [])
    assert.equal(tail.cursor, all.cursor)
  })

  it("defaults to 50 events and takes the board by key or by id", () => {
    const byId = feed.listBoardEvents(BOARD, { since: 0 })
    assert.ok(byId.events.length <= 50)
    const byKey = feed.listBoardEvents(BOARD_KEY.toLowerCase(), { since: 0 })
    assert.deepEqual(
      byKey.events.map((e) => e.id),
      byId.events.map((e) => e.id)
    )
    assert.equal(feed.listBoardEvents("no-such-board", {}), null)
  })

  it("keeps 30 days: anything older is dropped when the board file is opened", async () => {
    const db = await import("../src/server/db.ts")
    const handle = db.getDb()
    const age = (days) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
    const insert = handle.prepare(
      "INSERT INTO events (at, board_id, task_id, type, actor_id, summary, data) VALUES (?, ?, NULL, 'needs_owner', NULL, ?, '{}')"
    )
    insert.run(age(31), BOARD, "a month and a day ago")
    insert.run(age(29), BOARD, "twenty-nine days ago")

    db.pruneEvents(handle)
    const summaries = feed.listBoardEvents(BOARD, { since: 0, limit: 500 }).events.map((e) => e.summary)
    assert.equal(summaries.includes("a month and a day ago"), false)
    assert.equal(summaries.includes("twenty-nine days ago"), true)
  })

  it("no summary carries escape sequences, newlines or a log tail", () => {
    const { events } = feed.listBoardEvents(BOARD, { since: 0, limit: 500 })
    for (const event of events) {
      assert.equal(event.summary.includes(ESC), false, `${event.type}: escape sequence in the summary`)
      assert.equal(/[\n\r]/.test(event.summary), false, `${event.type}: more than one line`)
      assert.ok(event.summary.length > 0 && event.summary.length <= 200, `${event.type}: ${event.summary.length} chars`)
    }
  })
})
