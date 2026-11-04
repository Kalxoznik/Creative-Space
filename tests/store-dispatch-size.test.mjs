// Card size at dispatch (docs/features/cost-aware-routing.md, item 2): `applyDispatch` stores
// the S/M/L the Architect gave each Ready card, resolves `BI-12` refs like it does for assign,
// reports the ids it cannot match, and leaves the size of every card it does not name alone.
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, before, describe, it } from "node:test"

let dir
let store
let board

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-dispatch-size-"))
  process.env.CS_DB_PATH = path.join(dir, "board.db")
  store = await import("../src/server/store.ts")
  board = store.createBoard({ name: "Sizes", repoPath: dir })
})

after(() => fs.rmSync(dir, { recursive: true, force: true }))

const columnOf = (role) => store.getState().boards.find((b) => b.id === board.id).columns.find((c) => c.role === role).id
const sizeOf = (taskId) => store.getTask(taskId).size
/** An untagged Ready card: the dispatch below names no coder, so nothing is pulled into work. */
function readyCard(title) {
  const id = store.createTask({ boardId: board.id, columnId: columnOf("backlog"), title }).id
  store.updateTask(id, { columnRole: "ready" })
  return id
}
const refOf = (taskId) => `${board.key}-${store.getTask(taskId).number}`

describe("the size on a card", () => {
  let first
  let second
  let third

  it("starts out empty", () => {
    first = readyCard("Copy change")
    second = readyCard("New panel")
    third = readyCard("Rework the queue")
    assert.equal(sizeOf(first), null)
  })

  it("is saved for the cards the decision sizes, by id or by ref, in any case", () => {
    const outcome = store.applyDispatch(board.id, {
      actorId: "architect",
      size: { [first]: "S", [refOf(second)]: "m" },
    })
    assert.deepEqual(outcome.unresolved, [])
    assert.equal(sizeOf(first), "S")
    assert.equal(sizeOf(second), "M")
    assert.equal(sizeOf(third), null)
  })

  it("is left alone on the cards a later decision does not name", () => {
    store.applyDispatch(board.id, { actorId: "architect", size: { [third]: "L" }, order: [third, first, second] })
    assert.equal(sizeOf(first), "S")
    assert.equal(sizeOf(second), "M")
    assert.equal(sizeOf(third), "L")
  })

  it("a bad size or an unknown card does not break the rest of the decision", () => {
    const outcome = store.applyDispatch(board.id, {
      actorId: "architect",
      size: { [first]: "XL", [second]: "L", [`${board.key}-999`]: "S" },
      order: [second, first, third],
    })
    assert.deepEqual(outcome.unresolved, [`${board.key}-999`])
    assert.equal(sizeOf(first), "S")
    assert.equal(sizeOf(second), "L")
    const ready = store
      .getState()
      .boards.find((b) => b.id === board.id)
      .columns.find((c) => c.role === "ready")
      .tasks.map((t) => t.id)
    assert.deepEqual(ready, [second, first, third])
  })
})
