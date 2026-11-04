// Parallel work, step one: a git worktree per card. The worker makes the card's worktree
// (`plannedWorktree` / `prepareWorktree`), the coder's work is committed there, and the board lands
// it when the card is released (`landIfReleased` in src/server/store.ts) — merged into the main
// branch, worktree and branch removed. With the switch off nothing of this happens at all.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, before, describe, it } from "node:test"
import { commitRun, gitSnapshot, parseSnapshot, prepareWorktree, serializeSnapshot, startMerge } from "../agents/git.mjs"
import { plannedWorktree } from "../agents/worker.mjs"

const BOARD = "creative-space"
const QUIET = () => Promise.resolve()
const CODER = { id: "coder", agentRole: "coder" }
const message = { subject: "Card work", trailer: "Creative Space task #t_1\nAgent: Coder" }
let store
let dir

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-worktree-"))
  process.env.CS_DB_PATH = path.join(dir, "board.db")
  store = await import("../src/server/store.ts")
})

after(() => fs.rmSync(dir, { recursive: true, force: true }))

const git = (repo, ...args) => execFileSync("git", ["-C", repo, ...args]).toString().trim()

function repoWith(files) {
  const repo = fs.mkdtempSync(path.join(dir, "repo-"))
  git(repo, "init", "-q", "-b", "main")
  git(repo, "config", "user.email", "coder@example.com")
  git(repo, "config", "user.name", "Coder")
  write(repo, files)
  git(repo, "add", "-A")
  git(repo, "commit", "-q", "-m", "base")
  return repo
}

function write(repo, files) {
  for (const [file, body] of Object.entries(files)) fs.writeFileSync(path.join(repo, file), body)
}

function useRepo(repo, patch = {}) {
  store.updateBoard(BOARD, { repoPath: repo, parallelWork: true, queueRelease: "done", ...patch })
}

/** What the worker is handed when it claims a run on the card. */
function contextFor(taskId) {
  const task = store.getTask(taskId)
  const board = store.getState().boards.find((b) => b.id === task.boardId)
  return { task, board }
}

function workingCard(title) {
  const task = store.createTask({ boardId: BOARD, columnId: `${BOARD}:backlog`, title, assigneeIds: ["coder"] })
  store.updateTask(task.id, { columnRole: "in_progress" })
  return task.id
}

/** The worker's part: the card's worktree, recorded on the card, and the snapshot taken there. */
async function openCard(repo, taskId) {
  const plan = plannedWorktree(CODER, contextFor(taskId))
  assert.ok(plan, "a coder on an In progress card gets a worktree")
  const made = await prepareWorktree(repo, plan)
  assert.equal(made.failed, undefined, made.failed)
  store.recordWorktree(taskId, { branch: made.branch, path: made.path, base: made.base })
  const { snapshot } = store.keepWorkSnapshot(taskId, serializeSnapshot(await gitSnapshot(made.path)))
  return { made, before: parseSnapshot(snapshot) }
}

const lastSystem = (taskId) => store.listMessages(taskId).filter((m) => m.kind === "system").at(-1)?.text ?? ""
const branches = (repo) => git(repo, "branch", "--format=%(refname:short)").split("\n")

describe("Parallel work on: a card goes through its own worktree", () => {
  it("creates the worktree next to the repo, commits there, merges on Done and cleans up", async () => {
    const repo = repoWith({ "app.txt": "base\n" })
    useRepo(repo)
    const taskId = workingCard("Worktree card")
    const { made, before: snap } = await openCard(repo, taskId)
    const ref = store.getTask(taskId).number

    assert.equal(made.branch, `cs/${contextFor(taskId).board.key}-${ref}`)
    assert.equal(path.dirname(made.path), `${path.resolve(repo)}.worktrees`)
    assert.equal(made.base, "main")
    assert.deepEqual(store.getTask(taskId).worktree, { branch: made.branch, path: made.path, base: "main" })

    write(made.path, { "app.txt": "card work\n" })
    const outcome = await commitRun(made.path, message, snap, { log: QUIET })
    assert.equal(outcome.committed, true)
    // The commit is on the card's branch; main has not moved yet.
    assert.equal(fs.readFileSync(path.join(repo, "app.txt"), "utf8"), "base\n")
    assert.equal(git(repo, "log", "-1", "--format=%s", made.branch), "Card work")

    store.updateTask(taskId, { columnRole: "done" })
    assert.equal(git(repo, "log", "-1", "--format=%s", "main"), "Card work")
    assert.equal(fs.readFileSync(path.join(repo, "app.txt"), "utf8"), "card work\n")
    assert.equal(fs.existsSync(made.path), false)
    assert.ok(!branches(repo).includes(made.branch))
    assert.equal(store.getTask(taskId).worktree, null)
    assert.match(lastSystem(taskId), /Merged `cs\/.*` into `main` \(fast-forward\)/)
  })

  it("makes a merge commit when main moved on meanwhile", async () => {
    const repo = repoWith({ "a.txt": "base\n", "b.txt": "base\n" })
    useRepo(repo)
    const taskId = workingCard("Main moved on")
    const { made, before: snap } = await openCard(repo, taskId)
    write(made.path, { "a.txt": "card\n" })
    await commitRun(made.path, message, snap, { log: QUIET })
    write(repo, { "b.txt": "owner\n" })
    git(repo, "commit", "-q", "-am", "owner's commit")

    store.updateTask(taskId, { columnRole: "done" })
    assert.equal(fs.readFileSync(path.join(repo, "a.txt"), "utf8"), "card\n")
    assert.equal(fs.readFileSync(path.join(repo, "b.txt"), "utf8"), "owner\n")
    assert.equal(git(repo, "rev-list", "--count", "--merges", "main"), "1")
    assert.equal(store.getTask(taskId).worktree, null)
  })

  it("leaves everything as it is when git refuses the merge for another reason", async () => {
    const repo = repoWith({ "app.txt": "base\n" })
    useRepo(repo)
    const taskId = workingCard("Wrong branch card")
    const { made, before: snap } = await openCard(repo, taskId)
    write(made.path, { "app.txt": "card\n" })
    await commitRun(made.path, message, snap, { log: QUIET })
    git(repo, "checkout", "-q", "-b", "elsewhere")

    store.updateTask(taskId, { columnRole: "done" })
    assert.equal(store.getTask(taskId).columnId, `${BOARD}:done`)
    assert.ok(store.getTask(taskId).worktree)
    assert.match(lastSystem(taskId), /Could not merge `cs\/.*` into `main`[\s\S]*not on main/)
    git(repo, "checkout", "-q", "main")
  })
})

// Parallel 4/5: a card whose branch conflicts with what landed on main meanwhile goes back to its
// coder (`sendBackForConflict`), the worker starts the merge of main into the branch (`startMerge`),
// the commit step concludes it, and the next release lands it with both sides in.
describe("a merge conflict on landing", () => {
  /** A card whose finished work conflicts with a commit that reached main after it was cut. */
  async function conflictingCard(title) {
    const repo = repoWith({ "app.txt": "one\ntwo\nthree\n" })
    store.updateBoard(BOARD, { repoPath: repo, parallelWork: true, queueRelease: "done" })
    const taskId = workingCard(title)
    const { made, before: snap } = await openCard(repo, taskId)
    write(made.path, { "app.txt": "one\ncard\nthree\n" })
    await commitRun(made.path, message, snap, { log: QUIET })
    write(repo, { "app.txt": "one\nother card\nthree\n", "other.txt": "other\n" })
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "the other card")
    return { repo, taskId, made }
  }

  const conflictRuns = (taskId) =>
    store.listRuns(taskId).filter((r) => r.trigger.startsWith("conflict:") && r.status === "queued")

  it("aborts the merge and sends the card back to its coder with the conflicting files", async () => {
    const { repo, taskId, made } = await conflictingCard("Conflict card")
    const head = git(repo, "rev-parse", "main")

    store.updateTask(taskId, { columnRole: "done" })
    assert.equal(git(repo, "rev-parse", "main"), head)
    assert.equal(git(repo, "status", "--porcelain"), "")
    assert.ok(fs.existsSync(made.path))
    assert.ok(store.getTask(taskId).worktree)
    assert.equal(store.getTask(taskId).columnId, `${BOARD}:in_progress`)
    const note = lastSystem(taskId)
    assert.match(note, /Could not merge `cs\/.*` into `main` — it conflicts/)
    assert.match(note, /- `app\.txt`/)
    assert.doesNotMatch(note, /other\.txt/)
    const runs = conflictRuns(taskId)
    assert.equal(runs.length, 1)
    assert.equal(runs[0].agentId, "coder")
  })

  it("lands both cards' work after the coder resolves it", async () => {
    const { repo, taskId, made } = await conflictingCard("Resolved card")
    store.updateTask(taskId, { columnRole: "done" })

    // The worker's part of the conflict run: snapshot, then the merge of main into the branch.
    const snap = await gitSnapshot(made.path)
    const merge = await startMerge(made.path, "main", { log: QUIET })
    assert.deepEqual(merge, { started: true, conflicts: ["app.txt"] })
    // A commit with the markers still in is refused.
    const early = await commitRun(made.path, message, snap, { log: QUIET })
    assert.ok(early.failed !== undefined)
    assert.match(early.output, /app\.txt/)
    // The coder's part: keep both.
    write(made.path, { "app.txt": "one\ncard\nother card\nthree\n" })
    const outcome = await commitRun(made.path, message, snap, { log: QUIET })
    assert.equal(outcome.committed, true, outcome.output)
    assert.equal(git(made.path, "rev-list", "--count", "--merges", "HEAD"), "1")

    store.updateTask(taskId, { columnRole: "done" })
    assert.equal(fs.readFileSync(path.join(repo, "app.txt"), "utf8"), "one\ncard\nother card\nthree\n")
    assert.equal(fs.readFileSync(path.join(repo, "other.txt"), "utf8"), "other\n")
    assert.equal(store.getTask(taskId).worktree, null)
    assert.match(lastSystem(taskId), /Merged `cs\/.*` into `main`/)
  })

  it("asks the owner when it conflicts again after one round", async () => {
    const { taskId } = await conflictingCard("Conflicts twice")
    store.updateTask(taskId, { columnRole: "done" })
    assert.equal(conflictRuns(taskId).length, 1)
    // The coder's round changed nothing that settles it; the card is released once more.
    store.updateTask(taskId, { columnRole: "done" })
    assert.equal(store.getTask(taskId).columnId, `${BOARD}:in_progress`)
    assert.equal(store.getTask(taskId).needsOwner?.reason, "question")
    assert.equal(conflictRuns(taskId).length, 0)
  })
})

describe("Parallel work on: more of a card's way", () => {

  it("lands on the Architect's approval when Review releases the queue", async () => {
    const repo = repoWith({ "app.txt": "base\n" })
    useRepo(repo, { queueRelease: "review" })
    const taskId = workingCard("Review releases")
    const { made, before: snap } = await openCard(repo, taskId)
    write(made.path, { "app.txt": "card\n" })
    await commitRun(made.path, message, snap, { log: QUIET })

    store.updateTask(taskId, { columnRole: "review", actorId: "architect" })
    assert.equal(fs.readFileSync(path.join(repo, "app.txt"), "utf8"), "card\n")
    assert.equal(store.getTask(taskId).worktree, null)
  })

  it("does not land a card that only reached Review when Done releases the queue", async () => {
    const repo = repoWith({ "app.txt": "base\n" })
    useRepo(repo)
    const taskId = workingCard("Review holds")
    await openCard(repo, taskId)
    store.updateTask(taskId, { columnRole: "review" })
    assert.ok(store.getTask(taskId).worktree)
  })
})

// A card blocked by a card with a worktree waits until that card's branch is on main: the
// hand-off and a Review that still holds the queue are not enough (`isBlocked`). Each case on
// its own board, so the coder is free of the cards above; One card at a time is off, so only
// the blocker holds the dependent card back.
describe("a card blocked by a card with a worktree", () => {
  const roleOf = (taskId) => {
    const task = store.getTask(taskId)
    return store
      .getState()
      .boards.find((b) => b.id === task.boardId)
      .columns.find((c) => c.id === task.columnId).role
  }
  function endRuns(taskId) {
    for (const run of store.listRuns(taskId)) {
      if (run.status === "queued") store.cancelRun(run.id)
      else if (run.status === "running") store.finishRun(run.id, { status: "done" })
    }
  }
  function chain(repo, parallelWork) {
    const board = store.createBoard({ name: `Chained ${parallelWork ? "on" : "off"}`, repoPath: repo })
    store.updateBoard(board.id, { parallelWork, oneCardAtATime: false, queueRelease: "done" })
    const backlog = `${board.id}:backlog`
    const first = store.createTask({ boardId: board.id, columnId: backlog, title: "Writes the feature file", assigneeIds: ["coder"] }).id
    store.updateTask(first, { columnRole: "in_progress" })
    const second = store.createTask({ boardId: board.id, columnId: backlog, title: "Reads it", assigneeIds: ["coder"] }).id
    store.updateTask(second, { blockedBy: [first], columnRole: "ready" })
    return { first, second }
  }

  it("starts only once the blocker is Done, cut from a main that has its commit", async () => {
    const repo = repoWith({ "app.txt": "base\n" })
    const { first, second } = chain(repo, true)
    const { made, before: snap } = await openCard(repo, first)
    write(made.path, { "feature.md": "the plan\n" })
    await commitRun(made.path, message, snap, { log: QUIET })

    endRuns(first)
    store.updateTask(first, { columnRole: "review", actorId: "coder" })
    assert.equal(roleOf(first), "in_progress", "handed off, the Architect reviews it there")
    assert.equal(roleOf(second), "ready", "the hand-off is not enough: the commit is still on the branch")

    endRuns(first)
    store.updateTask(first, { columnRole: "review", actorId: "architect" })
    assert.equal(roleOf(first), "review")
    assert.equal(roleOf(second), "ready", "Review does not release the queue here")

    store.updateTask(first, { columnRole: "done" })
    assert.equal(roleOf(second), "in_progress")
    assert.equal(fs.readFileSync(path.join(repo, "feature.md"), "utf8"), "the plan\n")
    const plan = plannedWorktree(CODER, contextFor(second))
    const next = await prepareWorktree(repo, plan)
    assert.equal(fs.readFileSync(path.join(next.path, "feature.md"), "utf8"), "the plan\n")
  })

  it("sends the dependent back to Ready when the blocker conflicts on Done, and starts it once both are on main", async () => {
    const repo = repoWith({ "app.txt": "one\ntwo\nthree\n" })
    const { first, second } = chain(repo, true)
    const { made, before: snap } = await openCard(repo, first)
    write(made.path, { "app.txt": "one\ncard\nthree\n" })
    await commitRun(made.path, message, snap, { log: QUIET })
    write(repo, { "app.txt": "one\nother card\nthree\n" })
    git(repo, "commit", "-q", "-am", "the other card")
    // Someone asked the Architect on the waiting card; that answer must survive the requeue.
    store.addMessage({ taskId: second, text: "@architect what does this card wait for?" })
    const asked = store.listRuns(second).find((r) => r.agentId === "architect" && r.status === "queued")
    assert.ok(asked)

    endRuns(first)
    store.updateTask(first, { columnRole: "done" })
    assert.equal(roleOf(first), "in_progress", "the blocker conflicted and went back")
    assert.equal(roleOf(second), "ready", "the pull that the release made is undone")
    assert.equal(store.getTask(second).position, 0)
    const runs = store.listRuns(second)
    assert.ok(runs.some((r) => r.agentId === "coder" && r.status === "cancelled"), "the pull's coder run is cancelled")
    assert.deepEqual(
      runs.filter((r) => r.status === "queued").map((r) => r.id),
      [asked.id],
      "only the Architect's answer is still queued"
    )
    assert.match(lastSystem(second), /waits for it again/)
    store.cancelRun(asked.id)

    // The blocker's conflict round: the worker starts the merge, the coder keeps both sides.
    endRuns(first)
    const roundSnap = await gitSnapshot(made.path)
    await startMerge(made.path, "main", { log: QUIET })
    write(made.path, { "app.txt": "one\ncard\nother card\nthree\n" })
    assert.equal((await commitRun(made.path, message, roundSnap, { log: QUIET })).committed, true)

    store.updateTask(first, { columnRole: "done" })
    assert.equal(roleOf(second), "in_progress")
    const next = await prepareWorktree(repo, plannedWorktree(CODER, contextFor(second)))
    assert.equal(fs.readFileSync(path.join(next.path, "app.txt"), "utf8"), "one\ncard\nother card\nthree\n")
  })

  it("lands a card waiting in Review when the release switches to the Architect's approval", async () => {
    const repo = repoWith({ "app.txt": "base\n" })
    const { first, second } = chain(repo, true)
    const { made, before: snap } = await openCard(repo, first)
    write(made.path, { "feature.md": "the plan\n" })
    await commitRun(made.path, message, snap, { log: QUIET })
    endRuns(first)
    store.updateTask(first, { columnRole: "review", actorId: "coder" })
    endRuns(first)
    store.updateTask(first, { columnRole: "review", actorId: "architect" })
    assert.equal(roleOf(second), "ready")

    const boardId = store.getTask(first).boardId
    store.updateBoard(boardId, { queueRelease: "review" })
    assert.equal(git(repo, "log", "-1", "--format=%s", "main"), "Card work")
    assert.equal(fs.existsSync(made.path), false)
    assert.equal(store.getTask(first).worktree, null)
    assert.equal(roleOf(second), "in_progress")
    const merged = store.listMessages(first).filter((m) => /Merged/.test(m.text)).length
    store.updateBoard(boardId, { queueRelease: "review" })
    assert.equal(store.listMessages(first).filter((m) => /Merged/.test(m.text)).length, merged, "a re-save lands nothing again")
  })

  it("with Parallel work off, starts at the blocker's hand-off as before", () => {
    const repo = repoWith({ "app.txt": "base\n" })
    const { first, second } = chain(repo, false)
    endRuns(first)
    store.updateTask(first, { columnRole: "review", actorId: "coder" })
    assert.equal(roleOf(first), "in_progress")
    assert.equal(roleOf(second), "in_progress")
  })
})

// Parallel 5/5: a card that leaves the work without landing takes its worktree and branch with it,
// and the worker's start-up sweep (`sweepWorktrees`) removes whatever no card needs any more.
describe("cleaning up worktrees", () => {
  async function cardWithWork(repo, title) {
    const taskId = workingCard(title)
    const { made, before: snap } = await openCard(repo, taskId)
    write(made.path, { "app.txt": `${title}\n` })
    await commitRun(made.path, message, snap, { log: QUIET })
    return { taskId, made, sha: git(repo, "rev-parse", "--short", made.branch) }
  }

  it("removes them when the card is archived, and says how to get the branch back", async () => {
    const repo = repoWith({ "app.txt": "base\n" })
    useRepo(repo)
    const { taskId, made, sha } = await cardWithWork(repo, "Archived card")
    store.updateTask(taskId, { archived: true })
    assert.equal(fs.existsSync(made.path), false)
    assert.ok(!branches(repo).includes(made.branch))
    assert.equal(store.getTask(taskId).worktree, null)
    assert.ok(lastSystem(taskId).includes(`git branch ${made.branch} ${sha}`))
    assert.equal(git(repo, "log", "-1", "--format=%s", "main"), "base")
  })

  it("removes them when the card goes back to Backlog, and when it is deleted", async () => {
    const repo = repoWith({ "app.txt": "base\n" })
    useRepo(repo)
    const parked = await cardWithWork(repo, "Parked card")
    store.updateTask(parked.taskId, { columnRole: "backlog" })
    assert.equal(fs.existsSync(parked.made.path), false)
    assert.ok(!branches(repo).includes(parked.made.branch))
    assert.equal(store.getTask(parked.taskId).worktree, null)

    const deleted = await cardWithWork(repo, "Deleted card")
    store.deleteTask(deleted.taskId)
    assert.equal(fs.existsSync(deleted.made.path), false)
    assert.ok(!branches(repo).includes(deleted.made.branch))
  })

  it("saves uncommitted work as a commit on the branch before it removes the worktree", async () => {
    const repo = repoWith({ "app.txt": "base\n" })
    useRepo(repo)
    const { taskId, made } = await cardWithWork(repo, "Half-done card")
    // After the hand-off commit: a review sent back, a stopped run — work nobody committed yet.
    write(made.path, { "app.txt": "unsaved edit\n", "new.txt": "unsaved file\n" })
    store.updateTask(taskId, { columnRole: "backlog" })
    assert.equal(fs.existsSync(made.path), false)
    assert.ok(!branches(repo).includes(made.branch))
    const sha = lastSystem(taskId).match(/ended on `([0-9a-f]+)`/)?.[1]
    assert.ok(sha, lastSystem(taskId))
    assert.equal(git(repo, "show", `${sha}:app.txt`), "unsaved edit")
    assert.equal(git(repo, "show", `${sha}:new.txt`), "unsaved file")
    assert.ok(lastSystem(taskId).includes(`git branch ${made.branch} ${sha}`))
  })

  it("keeps the folder of a card parked mid-run until the run ends", async () => {
    const repo = repoWith({ "app.txt": "base\n" })
    useRepo(repo)
    const { taskId, made } = await cardWithWork(repo, "Busy card")
    // Earlier cards' runs are still queued for the same coder: let them go first.
    let claimed = store.claimRun("coder")
    while (claimed && claimed.task.id !== taskId) {
      store.finishRun(claimed.run.id, { status: "done" })
      claimed = store.claimRun("coder")
    }
    assert.equal(claimed?.task.id, taskId)
    store.updateTask(taskId, { columnRole: "backlog" })
    assert.ok(fs.existsSync(made.path), "a run is still working there")
    assert.ok(branches(repo).includes(made.branch))
    store.finishRun(claimed.run.id, { status: "done" })
    assert.equal(fs.existsSync(made.path), false)
    assert.ok(!branches(repo).includes(made.branch))
    assert.equal(store.getTask(taskId).worktree, null)
  })

  it("removes them in a repository opened through a symlink to its folder", async () => {
    const real = repoWith({ "app.txt": "base\n" })
    const link = `${real}-link`
    fs.symlinkSync(real, link)
    useRepo(link)
    const { taskId, made } = await cardWithWork(link, "Linked card")
    assert.ok(made.path.startsWith(`${link}.worktrees${path.sep}`), made.path)
    store.updateTask(taskId, { columnRole: "backlog" })
    assert.equal(fs.existsSync(made.path), false, lastSystem(taskId))
    assert.ok(!branches(real).includes(made.branch))
    assert.equal(store.getTask(taskId).worktree, null)
  })

  it("keeps the branch of an approved card whose landing failed when it is archived", async () => {
    const repo = repoWith({ "app.txt": "base\n" })
    useRepo(repo)
    const { taskId, made } = await cardWithWork(repo, "Approved card")
    // The board's checkout is elsewhere: the landing refuses and the card keeps its branch.
    git(repo, "checkout", "-q", "-b", "owner/elsewhere")
    store.updateTask(taskId, { columnRole: "done" })
    assert.ok(store.getTask(taskId).worktree)
    store.updateTask(taskId, { archived: true })
    assert.ok(branches(repo).includes(made.branch))
    assert.ok(fs.existsSync(made.path))
    store.sweepWorktrees()
    assert.ok(branches(repo).includes(made.branch))
    git(repo, "checkout", "-q", "main")
  })

  it("keeps a card's worktree while it is In progress or Ready", async () => {
    const repo = repoWith({ "app.txt": "base\n" })
    useRepo(repo)
    const { taskId, made } = await cardWithWork(repo, "Live card")
    store.updateTask(taskId, { columnRole: "ready" })
    assert.ok(fs.existsSync(made.path))
    assert.ok(store.getTask(taskId).worktree)
  })

  it("sweeps branches and worktrees no live card needs, and keeps the live ones", async () => {
    const repo = repoWith({ "app.txt": "base\n" })
    useRepo(repo)
    const live = await cardWithWork(repo, "Still working")
    const key = store.getState().boards.find((b) => b.id === BOARD).key
    // Left over from a card deleted mid-run, or one whose landing kept its branch.
    const strayPath = `${path.resolve(repo)}.worktrees/${key}-9404`
    git(repo, "worktree", "add", "-q", "-b", `cs/${key}-9404`, strayPath, "main")
    write(strayPath, { "app.txt": "stray edit\n" })
    git(repo, "branch", "cs/t_deadbeef42", "main")
    const owners = `${path.resolve(repo)}.worktrees/owner-own`
    git(repo, "worktree", "add", "-q", "-b", "owner/own", owners, "main")
    // `cs/*`, but not a name this board makes: someone else's.
    git(repo, "branch", "cs/someone-elses", "main")

    const { dropped, failed } = store.sweepWorktrees()
    assert.deepEqual(failed, [])
    const stray = dropped.find((d) => d.branch === `cs/${key}-9404`)
    assert.ok(stray?.sha, JSON.stringify(dropped))
    assert.equal(git(repo, "show", `${stray.sha}:app.txt`), "stray edit")
    assert.ok(dropped.some((d) => d.branch === "cs/t_deadbeef42"))
    assert.equal(fs.existsSync(strayPath), false)
    assert.ok(!branches(repo).includes(`cs/${key}-9404`) && !branches(repo).includes("cs/t_deadbeef42"))
    assert.ok(fs.existsSync(live.made.path))
    assert.ok(branches(repo).includes(live.made.branch))
    // Not the board's: never touched.
    assert.ok(fs.existsSync(owners))
    assert.ok(branches(repo).includes("owner/own"))
    assert.ok(branches(repo).includes("cs/someone-elses"))
  })

  it("leaves the owner's own checkouts alone, even on a board-named branch", () => {
    const repo = repoWith({ "app.txt": "base\n" })
    useRepo(repo)
    const key = store.getState().boards.find((b) => b.id === BOARD).key
    // The owner does a card by hand in the main checkout, on the name the card shows.
    git(repo, "checkout", "-q", "-b", `cs/${key}-9405`)
    write(repo, { "app.txt": "owner's edit\n" })
    // And a worktree of their own, outside `<repo>.worktrees/`.
    const theirs = `${path.resolve(repo)}-mine`
    git(repo, "worktree", "add", "-q", "-b", `cs/${key}-9406`, theirs, "main")
    write(theirs, { "app.txt": "their worktree edit\n" })
    const head = git(repo, "rev-parse", "HEAD")

    const { dropped, failed } = store.sweepWorktrees()
    assert.deepEqual(failed, [])
    assert.ok(!dropped.some((d) => d.branch.endsWith("-9405") || d.branch.endsWith("-9406")), JSON.stringify(dropped))
    assert.equal(git(repo, "rev-parse", "HEAD"), head)
    assert.equal(git(repo, "status", "--porcelain"), "M app.txt")
    assert.equal(git(theirs, "status", "--porcelain"), "M app.txt")
    assert.equal(git(theirs, "rev-parse", "HEAD"), git(repo, "rev-parse", "main"))
    assert.ok(branches(repo).includes(`cs/${key}-9405`) && branches(repo).includes(`cs/${key}-9406`))
    git(repo, "checkout", "-q", "-f", "main")
  })
})

describe("Parallel work off: nothing changes", () => {
  it("plans no worktree and Done touches no git", async () => {
    const repo = repoWith({ "app.txt": "base\n" })
    useRepo(repo, { parallelWork: false })
    const taskId = workingCard("Plain card")
    assert.equal(plannedWorktree(CODER, contextFor(taskId)), null)
    assert.equal(contextFor(taskId).board.parallelWork, false)

    write(repo, { "app.txt": "card work\n" })
    const head = git(repo, "rev-parse", "HEAD")
    const messages = store.listMessages(taskId).length
    store.updateTask(taskId, { columnRole: "done" })
    assert.equal(git(repo, "rev-parse", "HEAD"), head)
    assert.equal(fs.existsSync(`${path.resolve(repo)}.worktrees`), false)
    assert.ok(!store.listMessages(taskId).slice(messages).some((m) => /merge/i.test(m.text)))
  })

  it("plans none for an Architect, or for a card outside In progress", () => {
    const repo = repoWith({ "app.txt": "base\n" })
    useRepo(repo)
    const taskId = store.createTask({ boardId: BOARD, columnId: `${BOARD}:backlog`, title: "Backlog card" }).id
    assert.equal(plannedWorktree(CODER, contextFor(taskId)), null)
    store.updateTask(taskId, { columnRole: "in_progress" })
    assert.equal(plannedWorktree({ agentRole: "architect" }, contextFor(taskId)), null)
  })
})
