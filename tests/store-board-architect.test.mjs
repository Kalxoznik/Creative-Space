import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, afterEach, before, it } from "node:test"

let dir
let store
let second
const cards = []
let sequence = 0
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-board-architect-"))
  process.env.CS_DB_PATH = path.join(dir, "board.db")
  store = await import("../src/server/store.ts")
  second = store.createAgent({ name: "Second Architect", handle: "second", role: "architect", engine: "stub" })
})
afterEach(() => {
  for (const id of cards.splice(0)) {
    store.updateTask(id, { archived: true })
    for (const run of store.listRuns(id)) {
      if (run.status === "queued") store.cancelRun(run.id)
      if (run.status === "running") store.finishRun(run.id, { status: "done" })
    }
  }
})
after(() => fs.rmSync(dir, { recursive: true, force: true }))

const board = (extra = {}) => store.createBoard({
  name: `Board ${++sequence}`, repoPath: path.join(dir, `repo-${sequence}`), memberIds: ["coder"], ...extra,
})
const current = (id) => store.getState().boards.find((b) => b.id === id)
const role = (id) => current(store.getTask(id).boardId).columns.find((c) => c.id === store.getTask(id).columnId).role
function card(b, columnRole = "backlog", assigneeIds = []) {
  const task = store.createTask({ boardId: b.id, columnId: b.columns.find((c) => c.role === columnRole).id,
    title: `Work ${cards.length}`, assigneeIds })
  cards.push(task.id)
  return task.id
}
const pending = (id) => store.listRuns(id).filter((r) => r.status === "queued" || r.status === "running")
const messages = (id) => store.listMessages(id).map((m) => m.text).join("\n")

it("defaults to the first architect, pins only the chosen one and never adds new architects everywhere", () => {
  const b = board()
  assert.equal(b.architectId, "architect")
  assert.equal(store.listBoardSummaries().find((x) => x.id === b.id).architectId, "architect")
  assert.ok(b.memberIds.includes("architect"))
  assert.ok(!b.memberIds.includes(second.id))
  assert.ok(!current("creative-space").memberIds.includes(second.id))
  const chosen = store.updateBoard(b.id, { architectId: second.id, memberIds: [] })
  assert.deepEqual(new Set(chosen.memberIds), new Set([store.ownerId(), second.id]))
  assert.equal(store.updateBoard(b.id, { memberIds: [] }).architectId, second.id)
  assert.ok(current(b.id).memberIds.includes(second.id))
  assert.throws(() => store.updateBoard(b.id, { architectId: "coder" }), /active Architect/)
  assert.throws(() => board({ architectId: "missing" }), /active Architect/)
})

it("runs dispatch and review concurrently on different boards, one run per architect", () => {
  const a = board()
  const b = board({ architectId: second.id })
  const dispatch = card(a, "ready")
  const review = card(b, "in_progress", ["coder"])
  store.updateTask(review, { columnRole: "review", actorId: "coder" })
  const firstRun = store.claimRun("architect")
  const secondRun = store.claimRun(second.id)
  assert.equal(firstRun.task.id, dispatch)
  assert.equal(firstRun.run.trigger, "dispatch")
  assert.equal(secondRun.task.id, review)
  assert.equal(secondRun.run.trigger, "review")
  assert.equal(store.getRun(firstRun.run.id).status, "running")
  assert.equal(store.getRun(secondRun.run.id).status, "running")
  assert.equal(store.claimRun("architect"), null)
  assert.equal(store.claimRun(second.id), null)
})

it("allows other architects to answer mentions but only the selected one to dispatch or approve", () => {
  const b = board({ architectId: second.id, memberIds: ["architect", "coder"] })
  const id = card(b)
  store.addMessage({ taskId: id, text: "@architect give me your opinion" })
  assert.deepEqual(pending(id).map((r) => r.agentId), ["architect"])
  assert.throws(() => store.applyDispatch(b.id, { actorId: "architect" }), /board's Architect/)
  assert.throws(() => store.escalateTask(id, { actorId: "architect", to: "coder" }), /board's Architect/)
  assert.throws(() => store.reassignTask(id, { actorId: "architect", to: "coder" }), /board's Architect/)
  assert.throws(() => store.updateTask(id, { actorId: "architect", columnRole: "review" }), /board's Architect/)
  assert.equal(store.applyDispatch(b.id, { actorId: second.id }).assigned, 0)
  const defaults = store.createTask({ boardId: b.id, title: "Default participants" })
  cards.push(defaults.id)
  assert.deepEqual(defaults.assigneeIds, [second.id, store.ownerId()])
})

it("routes owner messages and answers to needs-owner to only the chosen architect", () => {
  const b = board({ architectId: second.id, memberIds: ["architect", "coder"] })
  const id = card(b)
  store.setNeedsOwner(id, { actorId: "coder", reason: "question", text: "Which option?" })
  store.addMessage({ taskId: id, text: "Use the first option" })
  assert.equal(store.getTask(id).needsOwner, null)
  assert.deepEqual(pending(id).map((r) => r.agentId), [second.id])
  assert.match(pending(id)[0].trigger, /^owner:/)
})

it("keeps consulting architects' follow-ups in Backlog without chaining or dispatch", () => {
  const b = board({ architectId: second.id, memberIds: ["architect", "coder"] })
  const id = card(b)
  const drafts = [{ title: "First follow-up" }, { title: "Second follow-up" }]
  const consulting = store.createAgentTasks(id, { actorId: "architect", cards: drafts, column: "ready" }).tasks
  cards.push(...consulting.map((task) => task.id))
  for (const task of consulting) {
    assert.equal(role(task.id), "backlog")
    assert.deepEqual(task.blockedBy, [])
    assert.deepEqual(pending(task.id), [])
  }
  const selected = store.createAgentTasks(id, { actorId: second.id, cards: drafts, column: "ready" }).tasks
  cards.push(...selected.map((task) => task.id))
  assert.ok(selected.every((task) => role(task.id) === "ready"))
  assert.deepEqual(selected[1].blockedBy, [selected[0].id])
  assert.deepEqual(pending(selected[0].id).map((r) => [r.agentId, r.trigger]), [[second.id, "dispatch"]])
})

it("dispatches the released queue with the selected architect", () => {
  const b = board({ architectId: second.id, memberIds: ["architect", "coder"] })
  const holding = card(b, "in_progress", ["coder"])
  const waiting = card(b, "ready")
  assert.equal(pending(waiting).length, 0)
  store.updateTask(holding, { columnRole: "done" })
  assert.deepEqual(pending(waiting).map((r) => [r.agentId, r.trigger]), [[second.id, "dispatch"]])
})

it("sends failed retries and stuck coder runs to the chosen architect", () => {
  const fast = store.createAgent({ name: "Fast", handle: "fast", role: "coder", engine: "stub", tier: "fast" })
  const b = board({ architectId: second.id, memberIds: ["architect", "coder", fast.id] })
  const id = card(b, "in_progress", [fast.id])
  for (let attempt = 0; attempt < 2; attempt++) {
    const run = store.claimRun(fast.id)
    assert.equal(run.task.id, id)
    store.reportCheck(id, { actorId: fast.id, command: "false", exitCode: 1, output: "failed" })
    store.finishRun(run.run.id, { status: "done" })
  }
  assert.deepEqual(pending(id).map((r) => r.agentId), [second.id])
  assert.match(pending(id)[0].trigger, /^escalate:/)
  const other = board({ architectId: second.id, memberIds: ["architect", "coder"] })
  const stuck = card(other, "in_progress", ["coder"])
  const run = store.claimRun("coder")
  assert.equal(run.task.id, stuck)
  store.finishRun(run.run.id, { status: "failed", summary: "CLI failed" })
  assert.deepEqual(pending(stuck).map((r) => r.agentId), [second.id])
  assert.match(pending(stuck)[0].trigger, /^supervise:/)
})

it("transfers queued reviews on selection changes and refuses changes during a running architect job", () => {
  const b = board()
  const mention = card(b)
  store.addMessage({ taskId: mention, text: "@architect give me your opinion" })
  const id = card(b, "in_progress", ["coder"])
  store.updateTask(id, { columnRole: "review", actorId: "coder" })
  store.updateBoard(b.id, { architectId: second.id })
  assert.deepEqual(pending(id).filter((r) => r.trigger === "review").map((r) => r.agentId), [second.id])
  assert.match(messages(id), /Board Architect changed:.*Second Architect/)
  assert.doesNotMatch(messages(mention), /Board Architect changed:/)
  assert.deepEqual(pending(mention).map((r) => r.agentId), ["architect"])
  assert.equal(store.claimRun(second.id).task.id, id)
  assert.throws(() => store.updateBoard(b.id, { architectId: "architect", memberIds: [] }), /Architect is running/)
  assert.ok(current(b.id).memberIds.includes("coder"))
})

it("falls back on deletion, preserves a pending review and explains the change", () => {
  const disposable = store.createAgent({ name: "Disposable", handle: "disposable", role: "architect", engine: "stub" })
  const b = board({ architectId: disposable.id })
  const id = card(b, "in_progress", ["coder"])
  const done = card(b, "done")
  const backlog = card(b)
  const ready = card(b, "ready")
  const ownerReply = card(b)
  store.addMessage({ taskId: ownerReply, text: "Please consider this" })
  const mention = card(b)
  store.addMessage({ taskId: mention, text: "@disposable give me your opinion" })
  const doneBefore = messages(done)
  const backlogBefore = messages(backlog)
  store.updateTask(id, { columnRole: "review", actorId: "coder" })
  store.removeAgent(disposable.id)
  assert.equal(current(b.id).architectId, "architect")
  assert.ok(current(b.id).memberIds.includes("architect"))
  assert.ok(!current(b.id).memberIds.includes(disposable.id))
  assert.deepEqual(pending(id).filter((r) => r.trigger === "review").map((r) => r.agentId), ["architect"])
  assert.match(messages(id), /Board Architect changed: Disposable → Architect/)
  assert.equal(messages(done), doneBefore)
  assert.equal(messages(backlog), backlogBefore)
  assert.match(messages(ready), /Board Architect changed:/)
  assert.match(messages(ownerReply), /Board Architect changed:/)
  assert.deepEqual(pending(ownerReply).map((r) => r.agentId), ["architect"])
  assert.match(messages(mention), /Board Architect changed:/)
  assert.deepEqual(pending(mention), [])
})

it("also falls back when the selected architect becomes a coder", () => {
  const changed = store.createAgent({ name: "Changing", handle: "changing", role: "architect", engine: "stub" })
  const b = board({ architectId: changed.id })
  store.updateAgent(changed.id, { role: "coder" })
  assert.equal(current(b.id).architectId, "architect")
})

it("uses architect-off behavior after deleting the last architect, releasing reviews and stranded escalations", () => {
  store.removeAgent(second.id)
  const b = board()
  const backlog = card(b)
  store.addMessage({ taskId: backlog, text: "@architect give me your opinion" })
  const review = card(b, "in_progress", ["coder"])
  store.updateTask(review, { columnRole: "review", actorId: "coder" })
  const stuckBoard = board()
  const stuck = card(stuckBoard, "in_progress", ["coder"])
  // A real failed retry queues supervision (the highest tier has no escalation target).
  for (const r of pending(review)) if (r.agentId === "coder") store.cancelRun(r.id)
  for (let attempt = 0; attempt < 2; attempt++) {
    const run = store.claimRun("coder")
    assert.equal(run.task.id, stuck)
    store.reportCheck(stuck, { actorId: "coder", command: "false", exitCode: 1, output: "failed" })
    store.finishRun(run.run.id, { status: "done" })
  }
  store.removeAgent("architect")
  assert.equal(current(b.id).architectId, null)
  assert.equal(current(b.id).architectEnabled, false)
  assert.equal(role(review), "review")
  assert.equal(store.getTask(stuck).needsOwner.reason, "question")
  assert.match(messages(review), /Architect changed:.*→ none/)
  assert.match(messages(backlog), /Architect changed:.*→ none/)
  assert.deepEqual(pending(backlog), [])
  const without = board()
  assert.equal(without.architectEnabled, false)
  const direct = card(without, "ready")
  assert.equal(role(direct), "in_progress")
})
