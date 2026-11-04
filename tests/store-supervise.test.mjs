// The Architect supervising a stuck card (`superviseStuckCard` in src/server/store.ts, BI-124).
// The rules under test: every way a coder's card gets stuck wakes the board's Architect once
// (`supervise:<runId>:<reason>`), at most `MAX_SUPERVISIONS` times per card — the next time the
// card goes to the owner; the Architect may hand a stuck card to another coder (`reassignTask`);
// and Autopilot decides whether its approval leaves a card in Review or takes it to Done.
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, before, describe, it } from "node:test"

let dir
let store
let feed
let board
let other

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-supervise-"))
  process.env.CS_DB_PATH = path.join(dir, "board.db")
  store = await import("../src/server/store.ts")
  feed = await import("../src/server/feed.ts")
  other = store.createAgent({ name: "Other", handle: "other", role: "coder", engine: "stub", tier: "standard" })
  const coder = store.listMembers().find((m) => m.id === "coder")
  board = store.createBoard({ name: "Supervised", repoPath: path.join(dir, "repo"), memberIds: [coder.id, other.id] })
})

after(() => fs.rmSync(dir, { recursive: true, force: true }))

const columnOf = (role) => store.getState().boards.find((b) => b.id === board.id).columns.find((c) => c.role === role).id
const owner = () => store.listMembers().find((m) => m.isOwner)
const queued = (taskId) => store.listRuns(taskId).filter((r) => r.status === "queued")
const supervises = (taskId) =>
  store
    .listRuns(taskId)
    .filter((r) => r.trigger.startsWith("supervise:") && r.status !== "cancelled")
    .map((r) => r.trigger)

/** A card tagged with the coder in In progress, its run claimed and running. */
function working(title, coder = "coder") {
  const taskId = store.createTask({ boardId: board.id, columnId: columnOf("backlog"), title, assigneeIds: [coder] }).id
  store.updateTask(taskId, { columnRole: "in_progress" })
  const claimed = store.claimRun(coder)
  assert.ok(claimed, `${coder} claimed no run on the card`)
  assert.equal(claimed.task.id, taskId)
  return { taskId, runId: claimed.run.id }
}

/** The Architect's supervise run starts and ends with no decision posted — the card is free again. */
function supervise(taskId) {
  const context = store.claimRun("architect")
  assert.ok(context, "the Architect has no run to claim")
  assert.equal(context.task.id, taskId)
  store.finishRun(context.run.id, { status: "done" })
  return context
}

/** Leave the board quiet for the next case. */
function finish(taskId) {
  for (const run of store.listRuns(taskId)) {
    if (run.status === "queued") store.cancelRun(run.id)
    else if (run.status === "running") store.finishRun(run.id, { status: "done" })
  }
  if (store.getTask(taskId).needsOwner) store.clearNeedsOwner(taskId)
  store.updateTask(taskId, { archived: true })
}

describe("each way a card gets stuck wakes the Architect once", () => {
  const ends = {
    failed: { status: "failed", summary: "claude exited with 1" },
    turn_limit: { status: "failed", summary: "Hit the turn limit (80).", maxTurns: true },
    loop: { status: "failed", summary: "Stopped as a loop.", loop: true },
    timeout: { status: "timeout", summary: "Stopped by the run timeout (60 min)." },
    lost: { status: "failed", summary: "The worker lost the run", lost: true },
    waiting: { status: "done", summary: "Looked around, did nothing" },
  }
  for (const [reason, end] of Object.entries(ends)) {
    it(reason, () => {
      const { taskId, runId } = working(`A card stuck: ${reason}`)
      const at = feed.listBoardEvents(board.id, { limit: 500 }).cursor
      store.finishRun(runId, end)

      assert.deepEqual(supervises(taskId), [`supervise:${runId}:${reason}`])
      assert.equal(store.getTask(taskId).supervisions, 1)
      assert.match(store.listMessages(taskId).at(-1).text, /^Stuck: .*\(1 of 2\)/)
      // The Architect gets the stuck run in its prompt.
      const context = store.claimRun("architect")
      assert.equal(context.stuck.runId, runId)
      assert.equal(context.stuck.reason, reason)
      assert.equal(context.stuck.attempt, 1)
      // The owner is not told about the failure: the Architect looks first.
      const ended = feed
        .listBoardEvents(board.id, { since: at, limit: 500 })
        .events.find((e) => e.taskId === taskId && e.type === "run_failed")
      if (end.status !== "done") assert.equal(ended.data.supervised, true)
      // The Architect's own run ending wakes nothing more.
      store.finishRun(context.run.id, { status: "done" })
      assert.equal(supervises(taskId).length, 1)
      finish(taskId)
    })
  }

  it("check_failed: the retry's check fails and there is no tier to go up to", () => {
    const { taskId } = working("A card whose check keeps failing")
    const report = () => store.reportCheck(taskId, { actorId: "coder", command: "npm test", exitCode: 1, output: "not ok 1" })
    assert.equal(report().retry, true)
    store.finishRun(store.listRuns(taskId).find((r) => r.status === "running").id, { status: "done" })
    const retry = store.claimRun("coder")
    assert.match(retry.run.trigger, /^check:\d+$/)

    assert.equal(report().retry, false)
    store.finishRun(retry.run.id, { status: "done" })

    assert.deepEqual(supervises(taskId), [`supervise:${retry.run.id}:check_failed`], "woken once, not again on the run's end")
    finish(taskId)
  })

  it("leaves alone a coder that asked a human, or that a human woke", () => {
    const { taskId, runId } = working("A card whose coder asked the owner")
    store.addMessage({ taskId, authorId: "coder", text: `@${owner().handle} which of the two shapes?` })
    store.finishRun(runId, { status: "done" })
    assert.deepEqual(supervises(taskId), [])
    finish(taskId)
  })

  it("leaves alone a coder that handed the card off — the review flow is untouched", () => {
    const { taskId, runId } = working("A card handed off")
    store.updateTask(taskId, { columnRole: "review", actorId: "coder" })
    store.finishRun(runId, { status: "done" })
    assert.deepEqual(supervises(taskId), [])
    assert.equal(queued(taskId).length, 1, "the Architect's review is the one run waiting")
    assert.equal(queued(taskId)[0].agentId, "architect")
    assert.doesNotMatch(queued(taskId)[0].trigger, /^supervise:/)
    finish(taskId)
  })
})

describe("at most two interventions per card", () => {
  it("asks the owner the third time", () => {
    const { taskId, runId } = working("A card that keeps getting stuck")
    store.finishRun(runId, { status: "failed", summary: "broke" })
    supervise(taskId)
    // The Architect's hint wakes the coder again; it breaks again.
    store.addMessage({ taskId, authorId: "architect", text: "@coder the test needs the fixture" })
    const second = store.claimRun("coder")
    store.finishRun(second.run.id, { status: "failed", summary: "broke again" })
    assert.equal(store.getTask(taskId).supervisions, 2)
    supervise(taskId)
    store.addMessage({ taskId, authorId: "architect", text: "@coder try the other approach" })
    const third = store.claimRun("coder")

    store.finishRun(third.run.id, { status: "failed", summary: "broke a third time" })

    assert.equal(supervises(taskId).length, 2, "the Architect was woken a third time")
    const task = store.getTask(taskId)
    assert.equal(task.needsOwner?.reason, "question")
    assert.match(task.needsOwner.text, /stepped in 2 times/)
    finish(taskId)
  })

  it("starts over when a human answers", () => {
    const { taskId, runId } = working("A card the owner unblocks")
    store.finishRun(runId, { status: "failed", summary: "broke" })
    supervise(taskId)
    store.setNeedsOwner(taskId, { actorId: "architect", reason: "question", text: "is the env broken?" })
    store.addMessage({ taskId, authorId: owner().id, text: "fixed the env, go on" })
    assert.equal(store.getTask(taskId).needsOwner, null)
    assert.equal(store.getTask(taskId).supervisions, 0)
    finish(taskId)
  })
})

describe("reassigning a stuck card", () => {
  it("hands it to another coder, who starts on it", () => {
    const { taskId, runId } = working("A card for another coder")
    store.finishRun(runId, { status: "failed", summary: "broke" })
    const context = store.claimRun("architect")
    const outcome = store.reassignTask(taskId, { actorId: "architect", to: "@other", reason: "knows this code" })
    store.finishRun(context.run.id, { status: "done" })

    assert.deepEqual(outcome.from, "coder")
    assert.equal(outcome.to, "other")
    assert.deepEqual(store.getTask(taskId).assigneeIds, [other.id])
    assert.match(queued(taskId).find((r) => r.agentId === other.id).trigger, /^reassign:\d+$/)
    finish(taskId)
  })

  it("refuses the same coder, and a card nobody was woken on", () => {
    const { taskId, runId } = working("A card the Architect may not swap")
    assert.throws(() => store.reassignTask(taskId, { actorId: "architect", to: "other" }), /stuck card/)
    store.finishRun(runId, { status: "failed", summary: "broke" })
    assert.throws(() => store.reassignTask(taskId, { actorId: "architect", to: "coder" }), /already has this card/)
    assert.throws(() => store.reassignTask(taskId, { actorId: "coder", to: "other" }), /Architect/)
    finish(taskId)
  })
})

describe("Autopilot", () => {
  /** The coder hands the card off and the Architect approves it. */
  function approve(title) {
    const { taskId, runId } = working(title)
    store.updateTask(taskId, { columnRole: "review", actorId: "coder" })
    store.finishRun(runId, { status: "done" })
    const review = store.claimRun("architect")
    assert.equal(review.task.id, taskId)
    store.updateTask(taskId, { columnRole: "review", actorId: "architect" })
    store.finishRun(review.run.id, { status: "done" })
    return taskId
  }

  it("is off by default: an approved card waits in Review", () => {
    assert.equal(store.getState().boards.find((b) => b.id === board.id).autopilot, false)
    const taskId = approve("A card approved with Autopilot off")
    assert.equal(store.getTask(taskId).columnId, columnOf("review"))
    finish(taskId)
  })

  it("on: the Architect's approval takes the card to Done", () => {
    store.updateBoard(board.id, { autopilot: true })
    try {
      assert.equal(store.getState().boards.find((b) => b.id === board.id).autopilot, true)
      const at = feed.listBoardEvents(board.id, { limit: 500 }).cursor
      const taskId = approve("A card approved with Autopilot on")
      assert.equal(store.getTask(taskId).columnId, columnOf("done"))
      assert.ok(store.listMessages(taskId).some((m) => /Autopilot is on/.test(m.text)))
      // The notifier tells the owner about it like a Review, title and all.
      const moved = feed
        .listBoardEvents(board.id, { since: at, limit: 500 })
        .events.find((e) => e.taskId === taskId && e.type === "card_moved" && e.data.to === "done")
      assert.equal(moved.data.autopilot, true)
      finish(taskId)
    } finally {
      store.updateBoard(board.id, { autopilot: false })
    }
  })

  it("on: an Architect move to Review from any run but the hand-off review stays in Review", () => {
    store.updateBoard(board.id, { autopilot: true })
    try {
      // A supervise run: nothing was checked or committed behind this move.
      const stuck = working("A stuck card the Architect calls finished")
      store.finishRun(stuck.runId, { status: "done", summary: "Looked around, did nothing" })
      const context = store.claimRun("architect")
      assert.match(context.run.trigger, /^supervise:/)
      store.updateTask(stuck.taskId, { columnRole: "review", actorId: "architect" })
      store.finishRun(context.run.id, { status: "done" })
      assert.equal(store.getTask(stuck.taskId).columnId, columnOf("review"))
      finish(stuck.taskId)

      // A mention run.
      const mentioned = working("A card the owner asks about")
      store.addMessage({ taskId: mentioned.taskId, authorId: "coder", text: `@${owner().handle} is this enough?` })
      store.finishRun(mentioned.runId, { status: "done", summary: "Asked the owner" })
      store.addMessage({ taskId: mentioned.taskId, authorId: owner().id, text: "@architect is this one finished?" })
      const asked = store.claimRun("architect")
      assert.equal(asked.task.id, mentioned.taskId)
      assert.match(asked.run.trigger, /^mention:/)
      store.updateTask(mentioned.taskId, { columnRole: "review", actorId: "architect" })
      store.finishRun(asked.run.id, { status: "done" })
      assert.equal(store.getTask(mentioned.taskId).columnId, columnOf("review"))
      finish(mentioned.taskId)
    } finally {
      store.updateBoard(board.id, { autopilot: false })
    }
  })

  it("on: the approval of a second round lands in Done though it comes from the reply wake", () => {
    store.updateBoard(board.id, { autopilot: true })
    try {
      const { taskId, runId } = working("A card approved after a fix round")
      store.updateTask(taskId, { columnRole: "review", actorId: "coder" })
      store.finishRun(runId, { status: "done" })
      const review = store.claimRun("architect")
      assert.equal(review.run.trigger, "review")
      store.addMessage({ taskId, authorId: "architect", text: "@coder one more thing: rename the flag" })
      store.finishRun(review.run.id, { status: "done" })

      // The coder fixes it, answers and hands off: its answer wakes the Architect, and that run
      // starts before the hand-off lands (a still queued one would be cancelled by it).
      const fix = store.claimRun("coder")
      assert.equal(fix.task.id, taskId)
      store.addMessage({ taskId, authorId: "coder", text: "Renamed the flag." })
      const next = store.claimRun("architect")
      assert.match(next.run.trigger, /^reply:/)
      store.updateTask(taskId, { columnRole: "review", actorId: "coder" })
      store.finishRun(fix.run.id, { status: "done" })
      assert.ok(queued(taskId).some((r) => r.trigger === "review"), "the review waits behind the reply wake")

      store.updateTask(taskId, { columnRole: "review", actorId: "architect" })
      store.finishRun(next.run.id, { status: "done" })
      assert.equal(store.getTask(taskId).columnId, columnOf("done"))
      finish(taskId)
    } finally {
      store.updateBoard(board.id, { autopilot: false })
    }
  })

  it("on: the owner moving a card to Review still leaves it there", () => {
    store.updateBoard(board.id, { autopilot: true })
    try {
      const taskId = store.createTask({ boardId: board.id, columnId: columnOf("backlog"), title: "Moved by hand" }).id
      store.updateTask(taskId, { columnRole: "review" })
      assert.equal(store.getTask(taskId).columnId, columnOf("review"))
      finish(taskId)
    } finally {
      store.updateBoard(board.id, { autopilot: false })
    }
  })
})
