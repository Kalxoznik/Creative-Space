// Board-level loops (`bounceCard` and the agent chain in src/server/store.ts, BI-120). The rules
// under test: a card whose hand-off comes back — check failed, the review asked for changes,
// Review → In progress — more than 3 times stops on the owner's word with `agents_loop`, and so
// does a card where agents keep mentioning each other with nothing handed off. A human moving the
// card back is counted but stops nothing; a human letting the card go on starts the count over.
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, before, describe, it } from "node:test"

const BOARD = "creative-space"
let store
let feed
let dir

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-loops-"))
  process.env.CS_DB_PATH = path.join(dir, "board.db")
  store = await import("../src/server/store.ts")
  feed = await import("../src/server/feed.ts")
})

after(() => fs.rmSync(dir, { recursive: true, force: true }))

const cursor = () => feed.listBoardEvents(BOARD, { limit: 500 }).cursor
const eventsSince = (from, taskId) =>
  feed.listBoardEvents(BOARD, { since: from, limit: 500 }).events.filter((e) => e.taskId === taskId)
const queued = (taskId, agentId) =>
  store.listRuns(taskId).filter((r) => r.status === "queued" && (!agentId || r.agentId === agentId))

/** A card in In progress, the coder's run on it claimed and running. */
function working(title) {
  const taskId = store.createTask({ boardId: BOARD, columnId: `${BOARD}:backlog`, title, assigneeIds: ["coder"] }).id
  store.updateTask(taskId, { columnRole: "in_progress" })
  const claimed = store.claimRun("coder")
  assert.ok(claimed, "the coder claimed no run on the card")
  return { taskId, runId: claimed.run.id }
}

/** Leave the board quiet for the next case. */
function finish(taskId) {
  for (const run of store.listRuns(taskId)) {
    if (run.status === "queued") store.cancelRun(run.id)
    else if (run.status === "running") store.finishRun(run.id, { status: "done" })
  }
  store.updateTask(taskId, { archived: true })
}

/**
 * The coder answers the review and hands off, the Architect reviews and sends it back; returns the
 * coder's next run, if any. From the second round on the answer wakes the Architect (`reply:`).
 */
function roundTrip(taskId, coderRunId) {
  store.addMessage({ taskId, authorId: "coder", text: "Fixed it, the check is green" })
  store.updateTask(taskId, { columnRole: "review", actorId: "coder" })
  store.finishRun(coderRunId, { status: "done" })
  const review = store.claimRun("architect")
  assert.ok(review, "the Architect had no review to claim")
  assert.equal(review.run.trigger, "review")
  store.addMessage({ taskId, authorId: "architect", text: "@coder the counter is off by one, fix it" })
  store.finishRun(review.run.id, { status: "done" })
  return store.claimRun("coder")
}

const failCheck = (taskId) => store.reportCheck(taskId, { actorId: "coder", command: "npm test", exitCode: 1, output: "not ok 1" })

describe("a card that keeps coming back from review", () => {
  it("goes round three times, and the fourth stops it on the owner's word", () => {
    const { taskId, runId } = working("A card the review keeps sending back")
    let run = runId
    for (let round = 1; round <= 3; round += 1) {
      const next = roundTrip(taskId, run)
      assert.ok(next, `round ${round}: the coder was not woken by the review`)
      assert.equal(store.getTask(taskId).needsOwner, null)
      run = next.run.id
    }
    const at = cursor()
    const fourth = roundTrip(taskId, run)
    assert.equal(fourth, null, "the coder must not be woken a fourth time")
    const needs = store.getTask(taskId).needsOwner
    assert.equal(needs?.reason, "agents_loop")
    assert.match(needs.text, /came back from review 4 times .*the review asked for changes/)
    const flagged = eventsSince(at, taskId).find((e) => e.type === "needs_owner")
    assert.ok(flagged, "the owner is notified through the feed")
    finish(taskId)
  })

  it("gives the Architect one run for a fix round: the review, not the answer and the review", () => {
    const { taskId, runId } = working("A card fixed after the review")
    const fix = roundTrip(taskId, runId)
    assert.ok(fix)
    store.addMessage({ taskId, authorId: "coder", text: "Fixed the off-by-one" })
    assert.match(queued(taskId, "architect")[0]?.trigger ?? "", /^reply:/, "the answer woke the Architect")
    store.updateTask(taskId, { columnRole: "review", actorId: "coder" })
    store.finishRun(fix.run.id, { status: "done" })
    assert.deepEqual(queued(taskId, "architect").map((r) => r.trigger), ["review"], "the hand-off leaves only the review")
    const review = store.claimRun("architect")
    assert.equal(review?.run.trigger, "review")
    store.addMessage({ taskId, authorId: "architect", text: "@coder the last row is still off" })
    store.finishRun(review.run.id, { status: "done" })
    assert.equal(store.claimRun("architect"), null, "the Architect has no second run for that hand-off")
    const second = store.claimRun("coder")
    assert.ok(second, "the send-back woke the coder")
    // That was the second round: two more and the card stops on the fourth.
    const next = roundTrip(taskId, second.run.id)
    assert.ok(next, "round 3: the coder was not woken")
    assert.equal(roundTrip(taskId, next.run.id), null, "the fourth send-back stops the card")
    assert.equal(store.getTask(taskId).needsOwner?.reason, "agents_loop")
    finish(taskId)
  })

  it("counts the verdict of a reply run that started before the hand-off, and drops the review behind it", () => {
    const { taskId, runId } = working("A card the Architect answers while it is handed off")
    const fix = roundTrip(taskId, runId)
    assert.ok(fix)
    store.addMessage({ taskId, authorId: "coder", text: "Fixed the off-by-one" })
    const reply = store.claimRun("architect")
    assert.match(reply?.run.trigger ?? "", /^reply:/)
    store.updateTask(taskId, { columnRole: "review", actorId: "coder" })
    store.finishRun(fix.run.id, { status: "done" })
    assert.deepEqual(queued(taskId, "architect").map((r) => r.trigger), ["review"])
    store.addMessage({ taskId, authorId: "architect", text: "@coder still off by one in the last row" })
    store.finishRun(reply.run.id, { status: "done" })
    assert.equal(queued(taskId, "architect").length, 0, "the review queued behind the verdict is cancelled")
    const next = store.claimRun("coder")
    assert.ok(next, "the send-back woke the coder")
    // That was the second round: two more and the card stops on the fourth.
    const third = roundTrip(taskId, next.run.id)
    assert.ok(third, "round 3: the coder was not woken")
    assert.equal(roundTrip(taskId, third.run.id), null, "the fourth send-back stops the card")
    assert.equal(store.getTask(taskId).needsOwner?.reason, "agents_loop")
    finish(taskId)
  })

  it("counts failed checks too: no retry and no new tier past the limit", () => {
    const { taskId } = working("A card whose check keeps failing")
    for (let n = 0; n < 3; n += 1) {
      failCheck(taskId)
      assert.equal(store.getTask(taskId).needsOwner, null)
    }
    const fourth = failCheck(taskId)
    assert.deepEqual(fourth, { retry: false, escalating: false })
    assert.equal(store.getTask(taskId).needsOwner?.reason, "agents_loop")
    assert.equal(queued(taskId).length, 0, "nothing is left queued on the card")
    finish(taskId)
  })

  it("counts a human moving the card back without stopping it, and starts over once a human lets it go on", () => {
    const { taskId } = working("A card the owner drags back")
    for (let n = 0; n < 3; n += 1) failCheck(taskId)
    store.updateTask(taskId, { columnRole: "review" })
    store.updateTask(taskId, { columnRole: "in_progress" })
    assert.equal(store.getTask(taskId).needsOwner, null, "the owner's own move stops nothing")
    // The next agent bounce is over the limit.
    failCheck(taskId)
    assert.equal(store.getTask(taskId).needsOwner?.reason, "agents_loop")
    // The owner answers in the chat: the flag is off and the card gets its rounds again.
    store.addMessage({ taskId, authorId: "owner", text: "@coder try the other approach" })
    assert.equal(store.getTask(taskId).needsOwner, null)
    failCheck(taskId)
    assert.equal(store.getTask(taskId).needsOwner, null)
    finish(taskId)
  })
})

describe("agents mentioning each other on one card", () => {
  it("stop the card on the owner's word after six messages with no hand-off", () => {
    const { taskId, runId } = working("A card the agents talk in circles on")
    store.finishRun(runId, { status: "done" })
    const at = cursor()
    for (let n = 0; n < 3; n += 1) {
      store.addMessage({ taskId, authorId: "architect", text: `@coder what about case ${n}?` })
      store.addMessage({ taskId, authorId: "coder", text: `@architect case ${n} is covered, I think` })
    }
    for (const run of queued(taskId)) store.cancelRun(run.id)
    store.addMessage({ taskId, authorId: "architect", text: "@coder and case 3?" })
    const needs = store.getTask(taskId).needsOwner
    assert.equal(needs?.reason, "agents_loop")
    assert.match(needs.text, /6 messages in a row/)
    assert.equal(queued(taskId).length, 0, "the seventh mention woke nobody")
    assert.ok(eventsSince(at, taskId).some((e) => e.type === "needs_owner"))
    finish(taskId)
  })

  it("start counting over after a hand-off", () => {
    const { taskId, runId } = working("A card with a long but honest thread")
    for (let n = 0; n < 5; n += 1) store.addMessage({ taskId, authorId: n % 2 ? "coder" : "architect", text: `note ${n}` })
    store.updateTask(taskId, { columnRole: "review", actorId: "coder" })
    store.finishRun(runId, { status: "done" })
    const review = store.claimRun("architect")
    assert.ok(review)
    store.addMessage({ taskId, authorId: "architect", text: "@coder one small thing left" })
    store.addMessage({ taskId, authorId: "coder", text: "@architect done, see the diff" })
    assert.equal(store.getTask(taskId).needsOwner, null)
    finish(taskId)
  })
})
