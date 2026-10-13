// The card digest (`src/server/digest.ts`): the shape an outside architect gets instead of the
// run logs, and the escape sequences it must not pass on — a CLI's colour, its cursor moves and
// its spinner frames are all in the log the check and the messages are read back from.
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, before, describe, it } from "node:test"

const BOARD = "creative-space"
const ESC = ""
let store
let digest
let dir

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-digest-"))
  process.env.CS_DB_PATH = path.join(dir, "board.db")
  store = await import("../src/server/store.ts")
  digest = await import("../src/server/digest.ts")
})

after(() => fs.rmSync(dir, { recursive: true, force: true }))

/** A card in In progress with a finished coder run whose log is `log`. */
function cardWithRun(title, log) {
  const task = store.createTask({
    boardId: BOARD,
    columnId: `${BOARD}:backlog`,
    title,
    assigneeIds: ["coder"],
  })
  store.updateTask(task.id, { columnRole: "in_progress" })
  const claimed = store.claimRun("coder")
  assert.equal(claimed?.task.id, task.id)
  if (log) store.appendRunLog(claimed.run.id, log)
  store.finishRun(claimed.run.id, { status: "done" })
  return task.id
}

describe("stripAnsi", () => {
  it("drops colour and cursor sequences, keeps the text", () => {
    assert.equal(digest.stripAnsi(`${ESC}[31mred${ESC}[0m text`), "red text")
    assert.equal(digest.stripAnsi(`${ESC}[2K${ESC}[1Gline`), "line")
    assert.equal(digest.stripAnsi(`${ESC}]0;a titledone`), "done")
  })

  it("keeps only the last frame of a carriage-return spinner", () => {
    assert.equal(digest.stripAnsi("⠋ building\r⠙ building\rdone\nnext"), "done\nnext")
  })

  it("leaves plain text alone", () => {
    assert.equal(digest.stripAnsi("a\nb\n"), "a\nb\n")
  })
})

describe("tailLines", () => {
  it("takes the last lines and ignores trailing blanks", () => {
    assert.equal(digest.tailLines("1\n2\n3\n4\n\n\n", 2), "3\n4")
  })

  it("returns the whole text when it is shorter than the tail", () => {
    assert.equal(digest.tailLines("only", 40), "only")
  })
})

describe("parseCheck", () => {
  it("reads a passing check out of a run log", () => {
    const check = digest.parseCheck(
      `${ESC}[32mhello${ESC}[0m\n\n[worker] check: npm test\nok 1\nok 2\n[worker] check passed\n`
    )
    assert.deepEqual(check, { command: "npm test", passed: true, exitCode: 0, tail: "ok 1\nok 2" })
  })

  it("reads a failing check with its exit code and output", () => {
    const check = digest.parseCheck(
      `[worker] check: npm run lint\n${ESC}[31merror${ESC}[0m: no-unused-vars\n[worker] check failed (exit 1) — the card stays in In progress\n`
    )
    assert.equal(check.passed, false)
    assert.equal(check.exitCode, 1)
    assert.equal(check.command, "npm run lint")
    assert.equal(check.tail, "error: no-unused-vars")
  })

  it("keeps at most 40 lines of output", () => {
    const output = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n")
    const check = digest.parseCheck(`[worker] check: npm test\n${output}\n[worker] check failed (exit 2)\n`)
    const lines = check.tail.split("\n")
    assert.equal(lines.length, 40)
    assert.equal(lines[0], "line 61")
    assert.equal(lines[39], "line 100")
  })

  it("a run stopped mid-check has no verdict", () => {
    const check = digest.parseCheck("[worker] check: npm test\nhalf way\n")
    assert.deepEqual(check, { command: "npm test", passed: null, exitCode: null, tail: "half way" })
  })

  it("takes the last check in the log and nothing from a log without one", () => {
    const check = digest.parseCheck(
      "[worker] check: npm run lint\n[worker] check failed (exit 1)\n[worker] check: npm test\nok\n[worker] check passed\n"
    )
    assert.equal(check.command, "npm test")
    assert.equal(digest.parseCheck("just an agent talking\n"), null)
  })
})

describe("parseCommit", () => {
  it("reads the sha and the files out of the board's commit note", () => {
    const commit = digest.parseCommit(
      "Committed `a1b2c3d` — 2 file(s):\n- `src/server/digest.ts`\n- `tests/digest.test.mjs`"
    )
    assert.deepEqual(commit, { sha: "a1b2c3d", files: ["src/server/digest.ts", "tests/digest.test.mjs"] })
  })

  it("a commit note without a sha still names its files", () => {
    assert.deepEqual(digest.parseCommit("Committed — 1 file(s):\n- `README.md`"), {
      sha: null,
      files: ["README.md"],
    })
  })

  it("any other message is not a commit", () => {
    assert.equal(digest.parseCommit("Check passed: npm test"), null)
  })
})

describe("getTaskDigest", () => {
  it("answers with the card's state, last run, check, commit and last messages", () => {
    const taskId = cardWithRun(
      "A card with a full story",
      `${ESC}[1mworking${ESC}[0m\n\n[worker] check: npm test\nok 1\n[worker] check passed\n`
    )
    store.addMessage({ taskId, authorId: "coder", text: "Done, see src/server/digest.ts" })
    store.addMessage({
      taskId,
      authorId: "coder",
      kind: "system",
      text: "Committed `0f1e2d3` — 1 file(s):\n- `src/server/digest.ts`",
    })

    const view = digest.getTaskDigest(taskId)
    assert.deepEqual(Object.keys(view).sort(), [
      "assignees",
      "check",
      "column",
      "commit",
      "lastMessages",
      "lastRun",
      "ref",
    ])
    assert.match(view.ref, /^[A-Z]+-\d+$/)
    assert.equal(view.column, "in_progress")
    assert.deepEqual(view.assignees, ["coder"])
    assert.equal(view.lastRun.agent, "coder")
    assert.equal(view.lastRun.trigger, "column:in_progress")
    assert.equal(view.lastRun.status, "done")
    assert.equal(typeof view.lastRun.startedAt, "string")
    assert.equal(typeof view.lastRun.finishedAt, "string")
    assert.deepEqual(view.check, { command: "npm test", passed: true, exitCode: 0, tail: "ok 1" })
    assert.deepEqual(view.commit, { sha: "0f1e2d3", files: ["src/server/digest.ts"] })
    assert.equal(view.lastMessages.length, 3)
    assert.deepEqual(view.lastMessages.at(-1), {
      author: "coder",
      kind: "system",
      text: "Committed `0f1e2d3` — 1 file(s):\n- `src/server/digest.ts`",
      createdAt: view.lastMessages.at(-1).createdAt,
    })
  })

  it("quotes at most 3 messages, shortened to 500 characters and free of escape sequences", () => {
    const taskId = cardWithRun("A talkative card", "")
    for (const text of ["first", "second", "third"]) {
      store.addMessage({ taskId, authorId: "coder", text })
    }
    store.addMessage({ taskId, authorId: "coder", text: `${ESC}[33m${"x".repeat(900)}${ESC}[0m` })

    const view = digest.getTaskDigest(taskId)
    assert.equal(view.lastMessages.length, 3)
    assert.deepEqual(
      view.lastMessages.map((m) => m.text.slice(0, 6)),
      ["second", "third", "xxxxxx"]
    )
    assert.equal(view.lastMessages.at(-1).text, "x".repeat(500))
  })

  it("what the card has not got yet is null", () => {
    const task = store.createTask({
      boardId: BOARD,
      columnId: `${BOARD}:backlog`,
      title: "An untouched card",
      assigneeIds: [],
    })
    const view = digest.getTaskDigest(task.id)
    assert.equal(view.column, "backlog")
    assert.equal(view.lastRun, null)
    assert.equal(view.check, null)
    assert.equal(view.commit, null)
    assert.deepEqual(view.assignees, [])
    assert.deepEqual(view.lastMessages, [])
  })

  it("an unknown card is a NotFoundError", () => {
    assert.throws(() => digest.getTaskDigest("t_nope"), store.NotFoundError)
  })
})
