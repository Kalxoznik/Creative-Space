import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, test } from "node:test"

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-app-first-run-"))
process.env.CS_APP = "1"
process.env.CS_DB_PATH = path.join(dir, "board.db")
process.env.CS_UPLOADS_DIR = path.join(dir, "images")
process.env.CREATIVE_SPACE_PROJECTS_DIR = path.join(dir, "projects")
const store = await import("../src/server/store.ts")
const { getDb, openAt } = await import("../src/server/db.ts")
const { saveImage, readImage } = await import("../src/server/uploads.ts")
after(() => {
  getDb().close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test("a fresh app workspace keeps profiles but has no sample boards, cards or runs", () => {
  const state = store.getState()
  assert.equal(state.boards.length, 0)
  assert.ok(state.members.some((m) => m.isOwner))
  assert.equal(state.members.filter((m) => m.kind === "agent").length, 2)
  for (const table of ["boards", "tasks", "agent_runs"]) {
    assert.equal(getDb().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0)
  }
  const reopened = openAt(process.env.CS_DB_PATH)
  assert.equal(reopened.prepare("SELECT COUNT(*) AS n FROM boards").get().n, 0)
  reopened.close()
})

test("dev still gets its seed; app mode never deletes an existing board", () => {
  const file = path.join(dir, "dev.db")
  delete process.env.CS_APP
  const dev = openAt(file)
  assert.equal(dev.prepare("SELECT COUNT(*) AS n FROM tasks").get().n, 3)
  dev.close()
  process.env.CS_APP = "1"
  const app = openAt(file)
  assert.equal(app.prepare("SELECT COUNT(*) AS n FROM tasks").get().n, 3)
  app.close()
})

test("a new project makes its folder without a card or an agent run", () => {
  const board = store.createBoard({ name: "Empty project", createRepo: true })
  assert.ok(fs.existsSync(path.join(board.repoPath, ".git")))
  assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM tasks WHERE board_id = ?").get(board.id).n, 0)
  assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM agent_runs").get().n, 0)
})

test("app create/update reject a missing, relative, unavailable or bundled project before changing members", () => {
  const bundle = path.join(dir, "Creative Space.app", "Contents")
  fs.mkdirSync(bundle, { recursive: true })
  fs.writeFileSync(path.join(bundle, "Info.plist"), "<plist/>")
  const alias = path.join(dir, "bundle-link")
  fs.symlinkSync(bundle, alias)
  const board = store.createBoard({ name: "Valid project", repoPath: dir })
  const before = store.getState().boards.find((b) => b.id === board.id).memberIds
  for (const repoPath of [null, "", ".", path.join(dir, "missing"), bundle, alias]) {
    assert.throws(() => store.createBoard({ name: "Invalid", repoPath }), /project folder|existing folder/)
    assert.throws(() => store.updateBoard(board.id, { repoPath, memberIds: [] }), /project folder|existing folder/)
    const unchanged = store.getState().boards.find((b) => b.id === board.id)
    assert.equal(unchanged.repoPath, dir)
    assert.deepEqual(unchanged.memberIds, before)
  }
  const domain = path.join(dir, "acme.app")
  fs.mkdirSync(domain)
  assert.doesNotThrow(() => store.createBoard({ name: "Domain named", repoPath: domain }))
  process.env.CREATIVE_SPACE_PROJECTS_DIR = path.join(alias, "projects")
  assert.throws(() => store.createBoard({ name: "Bundled", createRepo: true }), /outside the app bundle/)
  assert.equal(fs.existsSync(path.join(alias, "projects")), false)
  process.env.CREATIVE_SPACE_PROJECTS_DIR = path.join(dir, "projects")
})

test("old boards without folders cannot enqueue or claim; the card explains why", () => {
  const board = store.createBoard({ name: "Old board", repoPath: dir })
  const task = store.createTask({ boardId: board.id, columnId: `${board.id}:backlog`, title: "Legacy card", assigneeIds: ["coder"] })
  store.addMessage({ taskId: task.id, text: "@coder start" })
  assert.ok(store.listRuns(task.id).some((r) => r.status === "queued"))
  getDb().prepare("UPDATE boards SET repo_path = NULL WHERE id = ?").run(board.id)
  assert.equal(store.claimRun("coder"), null)
  assert.ok(store.listRuns(task.id).every((r) => r.status === "cancelled"))
  store.addMessage({ taskId: task.id, text: "@coder try again" })
  store.updateTask(task.id, { columnRole: "ready" })
  store.addMessage({ taskId: task.id, text: "@architect help" })
  assert.ok(store.listRuns(task.id).every((r) => r.status === "cancelled"))
  const notes = store.getThread(task.id).messages.filter((m) => m.text.startsWith("Agent not started:"))
  assert.equal(notes.length, 1)
  assert.match(notes[0].text, /Board settings/)
  store.updateBoard(board.id, { repoPath: dir })
  store.addMessage({ taskId: task.id, text: "@coder folder fixed" })
  assert.ok(store.claimRun("coder"))
})

test("a board without a folder can still be archived and unarchived, but not re-configured around the gap", () => {
  const board = store.createBoard({ name: "Folderless", repoPath: dir })
  getDb().prepare("UPDATE boards SET repo_path = NULL WHERE id = ?").run(board.id)
  assert.equal(store.updateBoard(board.id, { archived: true }).archived, true)
  assert.equal(store.updateBoard(board.id, { archived: false }).archived, false)
  assert.throws(() => store.updateBoard(board.id, { repoPath: "" }), /project folder|existing folder/)
  assert.throws(() => store.updateBoard(board.id, { memberIds: ["coder"] }), /project folder|existing folder/)
})

test("uploads use the configured external directory for both writes and reads", async () => {
  const bytes = new Uint8Array([137, 80, 78, 71])
  const saved = await saveImage(new Blob([bytes], { type: "image/png" }))
  assert.equal(path.dirname(saved.path), process.env.CS_UPLOADS_DIR)
  assert.deepEqual((await readImage(saved.name)).data, Buffer.from(bytes))
  await assert.rejects(readImage("../board.db"), /Image not found/)
})
