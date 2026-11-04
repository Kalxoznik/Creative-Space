// One-step escalation (docs/features/cost-aware-routing.md, item 3). When a coder's check fails
// after its one retry, `reportCheck` queues an Architect run (`escalate:<messageId>`) if the card
// can go up a tier; the Architect's `escalate` action (`escalateTask`) is then accepted only to a
// coder of the closest higher tier on the board, once per card. A card that cannot go up is
// supervised by the Architect (`supervise:`, tests/store-supervise.test.mjs); without an
// Architect it is the owner's, as before.
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, before, describe, it } from "node:test"

let dir
let store
let fast
let standard
let strong

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-escalation-"))
  process.env.CS_DB_PATH = path.join(dir, "board.db")
  store = await import("../src/server/store.ts")
  fast = store.createAgent({ name: "Quick", handle: "quick", role: "coder", engine: "stub", tier: "fast" })
  standard = store.createAgent({ name: "Steady", handle: "steady", role: "coder", engine: "stub", tier: "standard" })
  strong = store.createAgent({ name: "Heavy", handle: "heavy", role: "coder", engine: "stub", tier: "strong" })
})

after(() => fs.rmSync(dir, { recursive: true, force: true }))

const boardWith = (name, coders, extra = {}) =>
  store.createBoard({ name, repoPath: path.join(dir, name), memberIds: coders.map((c) => c.id), ...extra })
const columnOf = (boardId, role) =>
  store.getState().boards.find((b) => b.id === boardId).columns.find((c) => c.role === role).id
const triggersOf = (taskId, agentId) =>
  store
    .listRuns(taskId)
    .filter((run) => run.agentId === agentId && run.status !== "cancelled")
    .map((run) => run.trigger)
const lastText = (taskId) => store.listMessages(taskId).at(-1).text
/** The runs still waiting on a card, gone — so the next test's `claimRun` finds its own card. */
const dropQueued = (taskId) => {
  for (const run of store.listRuns(taskId)) if (run.status === "queued") store.cancelRun(run.id)
}

/** A card tagged with `coder`, put straight into In progress — its column run is queued. */
function cardInWork(boardId, coder, title = "Some work") {
  const id = store.createTask({ boardId, columnId: columnOf(boardId, "backlog"), title, assigneeIds: [coder.id] }).id
  store.updateTask(id, { columnRole: "in_progress" })
  return id
}

/** `coder` runs once and its check fails, as the worker reports it: while the run is still going. */
function failOnce(taskId, coder) {
  const context = store.claimRun(coder.id)
  assert.ok(context, `${coder.handle} has a run to claim`)
  assert.equal(context.task.id, taskId)
  const outcome = store.reportCheck(taskId, { actorId: coder.id, command: "npm test", exitCode: 1, output: "not ok 1" })
  store.finishRun(context.run.id, { status: "done" })
  return outcome
}

/** The first failure, its retry, and the retry's failure. Returns what the second report said. */
function failTwice(taskId, coder) {
  assert.equal(failOnce(taskId, coder).retry, true)
  return failOnce(taskId, coder)
}

/** The Architect's escalate run on the card runs; the action is posted while it does. */
function escalate(taskId, to, reason = "the change needs a stronger model") {
  const context = store.claimRun("architect")
  try {
    return store.escalateTask(taskId, { actorId: "architect", to: to.handle, reason })
  } finally {
    if (context) store.finishRun(context.run.id, { status: "done" })
  }
}

describe("a Fast coder whose check fails twice", () => {
  let board
  let card

  it("gets one retry, then the Architect is asked instead of a human", () => {
    board = boardWith("Three tiers", [fast, standard, strong])
    card = cardInWork(board.id, fast)
    const second = failTwice(card, fast)
    assert.deepEqual(second, { retry: false, escalating: true })
    const coderRuns = triggersOf(card, fast.id)
    assert.equal(coderRuns.length, 2)
    assert.equal(coderRuns.filter((t) => /^check:\d+$/.test(t)).length, 1)
    const architectRuns = triggersOf(card, "architect")
    assert.equal(architectRuns.length, 1)
    assert.match(architectRuns[0], /^escalate:\d+$/)
    assert.match(lastText(card), /Architect.* is looking at whether a Standard coder should take it over/)
    assert.doesNotMatch(lastText(card), /a human needs to look/)
  })

  it("is refused a jump to Strong while a Standard coder is on the board", () => {
    assert.throws(() => escalate(card, strong), /Standard/)
    assert.deepEqual(store.getTask(card).assigneeIds, [fast.id])
  })

  it("goes to the Standard coder: the tag swaps, the chat says why, its run is queued", () => {
    // The refused attempt above used up the Architect's run; the board still has the offer open.
    const outcome = store.escalateTask(card, { actorId: "architect", to: "@Steady", reason: "the fix is past a small model" })
    assert.equal(outcome.from, "quick")
    assert.equal(outcome.to, "steady")
    assert.deepEqual(store.getTask(card).assigneeIds, [standard.id])
    assert.equal(lastText(card), "Quick (Fast) → Steady (Standard): the fix is past a small model")
    const runs = triggersOf(card, standard.id)
    assert.equal(runs.length, 1)
    assert.match(runs[0], /^escalate:\d+$/)
    const column = store.getState().boards.find((b) => b.id === board.id).columns.find((c) => c.id === store.getTask(card).columnId)
    assert.equal(column.role, "in_progress")
  })

  it("a second escalation of the same card is refused", () => {
    assert.throws(() => store.escalateTask(card, { actorId: "architect", to: "heavy", reason: "again" }), /already gone up/)
  })

  it("when the Standard coder's check fails after its retry too, the Architect supervises it", () => {
    const second = failTwice(card, standard)
    assert.deepEqual(second, { retry: false, escalating: false })
    assert.match(lastText(card), /^Stuck: the check failed again after its retry\. .* \(1 of 2\)\.$/)
    const architectRuns = triggersOf(card, "architect")
    assert.equal(architectRuns.length, 2)
    assert.equal(architectRuns.filter((t) => /^supervise:\d+:check_failed$/.test(t)).length, 1)
    dropQueued(card)
  })
})

describe("who may escalate, and when", () => {
  it("only the board's Architect, and only after the retry failed", () => {
    const board = boardWith("Rules", [fast, standard])
    const card = cardInWork(board.id, fast, "Rules card")
    assert.throws(() => store.escalateTask(card, { actorId: fast.id, to: "steady" }), /Only the board's Architect/)
    assert.equal(failOnce(card, fast).retry, true)
    assert.throws(() => store.escalateTask(card, { actorId: "architect", to: "steady" }), /failed again after its retry/)
    store.finishRun(store.claimRun(fast.id).run.id, { status: "done" })
    dropQueued(card)
  })

  it("not while the card waits for the owner — the one escalation is not spent on nobody", () => {
    const board = boardWith("Waiting", [fast, standard])
    const card = cardInWork(board.id, fast, "Waiting card")
    assert.equal(failTwice(card, fast).escalating, true)
    // The Architect's reply carries both `needs: owner` and `escalate`; the flag goes on first.
    const context = store.claimRun("architect")
    store.setNeedsOwner(card, { actorId: "architect", reason: "question", text: "Is the spec right?" })
    assert.throws(() => store.escalateTask(card, { actorId: "architect", to: "steady" }), /waits for the owner/)
    store.finishRun(context.run.id, { status: "done" })
    assert.deepEqual(store.getTask(card).assigneeIds, [fast.id])
    assert.equal(triggersOf(card, standard.id).length, 0)
  })
})

describe("the Architect switched off mid-escalation", () => {
  const switchedOff = /switched off before it decided/

  it("a queued escalate run: the card goes to the owner", () => {
    const board = boardWith("Off while queued", [fast, standard])
    const card = cardInWork(board.id, fast, "Queued card")
    assert.equal(failTwice(card, fast).escalating, true)
    store.updateBoard(board.id, { architectEnabled: false })
    assert.equal(store.getTask(card).needsOwner?.reason, "question")
    assert.match(store.getTask(card).needsOwner.text, switchedOff)
    assert.deepEqual(triggersOf(card, "architect"), [])
  })

  it("a running escalate run: the card goes to the owner, and its late escalate is refused", () => {
    const board = boardWith("Off while running", [fast, standard])
    const card = cardInWork(board.id, fast, "Running card")
    assert.equal(failTwice(card, fast).escalating, true)
    const context = store.claimRun("architect")
    assert.equal(context.task.id, card)
    store.updateBoard(board.id, { architectEnabled: false })
    assert.match(store.getTask(card).needsOwner?.text ?? "", switchedOff)
    assert.throws(() => store.escalateTask(card, { actorId: "architect", to: "steady" }), /Only the board's Architect/)
    store.finishRun(context.run.id, { status: "done" })
    assert.deepEqual(store.getTask(card).assigneeIds, [fast.id])
  })

  it("leaves a card alone whose escalation already landed", () => {
    const board = boardWith("Off after the swap", [fast, standard])
    const card = cardInWork(board.id, fast, "Swapped card")
    failTwice(card, fast)
    const context = store.claimRun("architect")
    store.escalateTask(card, { actorId: "architect", to: "steady" })
    store.updateBoard(board.id, { architectEnabled: false })
    store.finishRun(context.run.id, { status: "done" })
    assert.equal(store.getTask(card).needsOwner, null)
    assert.equal(triggersOf(card, standard.id).length, 1)
  })
})

describe("the check_failed event", () => {
  it("says when the Architect is escalating, so the owner is not told yet", async () => {
    const { listBoardEvents } = await import("../src/server/feed.ts")
    const board = boardWith("Events", [fast, standard])
    const card = cardInWork(board.id, fast, "Events card")
    failTwice(card, fast)
    const failed = listBoardEvents(board.id, { limit: 200 })
      .events.filter((e) => e.taskId === card && e.type === "check_failed")
      .map((e) => e.data.escalating === true)
    assert.deepEqual(failed, [false, true])
  })
})

describe("no step up to take", () => {
  it("a Strong coder failing twice queues no escalation — the Architect supervises instead", () => {
    const board = boardWith("Strong only", [fast, standard, strong])
    const card = cardInWork(board.id, strong)
    assert.deepEqual(failTwice(card, strong), { retry: false, escalating: false })
    const architectRuns = triggersOf(card, "architect")
    assert.equal(architectRuns.length, 1)
    assert.match(architectRuns[0], /^supervise:\d+:check_failed$/)
    const texts = store.listMessages(card).map((m) => m.text)
    assert.ok(texts.some((t) => /Already retried once\.$/.test(t)))
    assert.ok(!texts.some((t) => /a human needs to look/.test(t)))
    dropQueued(card)
  })

  it("no coder above the failed one → the Architect supervises", () => {
    const board = boardWith("Fast only", [fast])
    const card = cardInWork(board.id, fast)
    assert.deepEqual(failTwice(card, fast), { retry: false, escalating: false })
    assert.match(triggersOf(card, "architect").join(" "), /^supervise:\d+:check_failed$/)
    dropQueued(card)
  })

  it("no Architect → as today", () => {
    const board = boardWith("No architect", [fast, standard], { architectEnabled: false })
    const card = cardInWork(board.id, fast)
    assert.deepEqual(failTwice(card, fast), { retry: false, escalating: false })
    assert.match(lastText(card), /a human needs to look/)
  })
})

describe("the closest higher tier present", () => {
  it("Fast → Strong when the board has no Standard coder", () => {
    const board = boardWith("Fast and strong", [fast, strong])
    const card = cardInWork(board.id, fast)
    failTwice(card, fast)
    assert.match(lastText(card), /a Strong coder should take it over/)
    escalate(card, strong)
    assert.deepEqual(store.getTask(card).assigneeIds, [strong.id])
    assert.match(lastText(card), /^Quick \(Fast\) → Heavy \(Strong\): /)
  })
})
