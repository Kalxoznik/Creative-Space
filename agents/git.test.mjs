// `npm test`. Drives the board's commit step against a real throwaway repository: the two
// things it must get right are "everything the run touched lands in the commit" (including a
// file that was already dirty before the run — a status code alone cannot see that edit) and
// "nothing the owner left uncommitted does".

import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { changedPaths, commitRun, git, gitSnapshot, parseSnapshot, serializeSnapshot } from "./git.mjs"

const QUIET = () => Promise.resolve()
const run = (repo, ...args) => git(repo, args, { log: QUIET })
const message = { subject: "Task", trailer: "Creative Space task #t_1\nAgent: Coder" }

/** A repository with one commit holding the given files, plus the usual local identity. */
async function repoWith(files) {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "cs-git-"))
  await run(repo, "init", "-q", "-b", "main")
  await run(repo, "config", "user.email", "coder@example.com")
  await run(repo, "config", "user.name", "Coder")
  await write(repo, files)
  await run(repo, "add", "-A")
  await run(repo, "commit", "-q", "-m", "base")
  return repo
}

async function write(repo, files) {
  for (const [file, body] of Object.entries(files)) {
    const target = path.join(repo, file)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, body)
  }
}

/** Paths in HEAD's commit, and the committed contents of one of them. */
async function committed(repo) {
  // --no-renames: the point here is which paths the commit touches, not how git pairs them up.
  const { stdout } = await run(repo, "show", "--pretty=format:", "--name-only", "--no-renames", "HEAD")
  return stdout.split("\n").filter(Boolean).sort()
}

const show = async (repo, file) => (await run(repo, "show", `HEAD:${file}`)).stdout

test("a file dirty before the run, edited again by the agent, lands in the commit", async () => {
  const repo = await repoWith({ "README.md": "base\n", "notes.md": "base\n" })
  // The owner's half-finished edit, there before the run starts.
  await write(repo, { "README.md": "owner\n" })
  const before = await gitSnapshot(repo)
  assert.equal(before.dirty.get("README.md")?.slice(0, 2), " M")

  // The agent appends to the same file: the status code stays ` M`, only the contents move.
  await write(repo, { "README.md": "owner\nagent\n" })
  const after = await gitSnapshot(repo)
  assert.equal(after.dirty.get("README.md")?.slice(0, 2), " M")
  assert.notEqual(after.dirty.get("README.md"), before.dirty.get("README.md"))

  const outcome = await commitRun(repo, message, before, { log: QUIET })
  assert.equal(outcome.committed, true)
  assert.deepEqual(outcome.paths, ["README.md"])
  assert.match(outcome.sha, /^[0-9a-f]{7,}$/)
  assert.deepEqual(await committed(repo), ["README.md"])
  assert.equal(await show(repo, "README.md"), "owner\nagent\n")
})

test("a file dirty before the run and untouched by the agent stays out of the commit", async () => {
  const repo = await repoWith({ "README.md": "base\n", "owner.md": "base\n" })
  await write(repo, { "owner.md": "owner's own work\n" })
  const before = await gitSnapshot(repo)

  await write(repo, { "README.md": "agent\n", "new.md": "agent\n" })
  const outcome = await commitRun(repo, message, before, { log: QUIET })
  assert.equal(outcome.committed, true)
  assert.deepEqual(await committed(repo), ["README.md", "new.md"].sort())
  // Still dirty, still the owner's.
  const left = await gitSnapshot(repo)
  assert.equal(left.dirty.get("owner.md")?.slice(0, 2), " M")
})

test("an untracked file the owner left is not swept in, even next to an edit of their file", async () => {
  const repo = await repoWith({ "README.md": "base\n" })
  await write(repo, { "scratch.txt": "owner's scratch\n", "README.md": "owner\n" })
  const before = await gitSnapshot(repo)

  await write(repo, { "README.md": "owner\nagent\n" })
  assert.equal((await commitRun(repo, message, before, { log: QUIET })).committed, true)
  assert.deepEqual(await committed(repo), ["README.md"])
  const left = await gitSnapshot(repo)
  assert.equal(left.dirty.get("scratch.txt")?.slice(0, 2), "??")
})

// `git status --porcelain` folds an untracked folder into one entry (`?? docs/`) unless asked
// otherwise. That entry has no contents to fingerprint, so every path in the same hashing batch
// used to lose its hash — and a tracked file that was already dirty fell out of the commit again,
// silently. The folder has to be in the tree both before and after for that to bite.
test("an untracked folder in the tree does not cost an edited file its place in the commit", async () => {
  const repo = await repoWith({ "AGENTS.md": "base\n" })
  await write(repo, { "notes/owner.md": "owner's own notes\n", "AGENTS.md": "owner\n" })
  const before = await gitSnapshot(repo)
  assert.equal(before.dirty.get("AGENTS.md")?.slice(0, 2), " M")
  // The folder is listed by its files, never as `notes/`.
  assert.ok(before.dirty.has("notes/owner.md"), [...before.dirty.keys()].join(" "))
  assert.ok(!before.dirty.has("notes/"))

  await write(repo, { "AGENTS.md": "owner\nagent\n", "docs/status.md": "agent\n" })
  const after = await gitSnapshot(repo)
  assert.equal(after.dirty.get("AGENTS.md")?.slice(0, 2), " M")
  assert.notEqual(after.dirty.get("AGENTS.md"), before.dirty.get("AGENTS.md"))

  assert.equal((await commitRun(repo, message, before, { log: QUIET })).committed, true)
  assert.deepEqual(await committed(repo), ["AGENTS.md", "docs/status.md"].sort())
  assert.equal(await show(repo, "AGENTS.md"), "owner\nagent\n")
  // The owner's folder is still theirs, and still uncommitted.
  assert.equal((await gitSnapshot(repo)).dirty.get("notes/owner.md")?.slice(0, 2), "??")
})

// An empty hand-off: the worker turns `skipped: "unchanged"` into a system line on the card and
// hands it on without a commit — "nothing to commit" must never read like a commit that landed.
test("a hand-off that changed nothing commits nothing, however dirty the tree was", async () => {
  const repo = await repoWith({ "README.md": "base\n" })
  await write(repo, { "README.md": "owner\n", "scratch.txt": "owner\n" })
  const before = await gitSnapshot(repo)
  const head = before.head

  assert.deepEqual(await commitRun(repo, message, before, { log: QUIET }), { skipped: "unchanged" })
  assert.equal((await gitSnapshot(repo)).head, head)
})

test("a deletion and a rename by the agent are seen as changes", async () => {
  const repo = await repoWith({ "gone.md": "base\n", "old.md": "base\n" })
  await write(repo, { "gone.md": "owner\n" }) // dirty before the run, then deleted by the agent
  const before = await gitSnapshot(repo)

  await fs.rm(path.join(repo, "gone.md"))
  await run(repo, "mv", "old.md", "new.md")
  assert.equal((await commitRun(repo, message, before, { log: QUIET })).committed, true)
  assert.deepEqual(await committed(repo), ["gone.md", "new.md", "old.md"].sort())
})

test("a folder that is not a repository is left alone", async () => {
  const plain = await fs.mkdtemp(path.join(os.tmpdir(), "cs-plain-"))
  const before = await gitSnapshot(plain)
  assert.equal(before.isRepo, false)
  assert.deepEqual(await commitRun(plain, message, before, { log: QUIET }), { skipped: "not-a-repo" })
})

// The bug this exists for: the worker used to snapshot the tree at the start of every run, so a
// card whose work happened in run #1 and whose hand-off came in run #2 (a chat message starts a
// new run) was committed against a tree that already held the work — "nothing to commit", card
// to Review, no commit. The snapshot now belongs to the card and travels between runs as JSON.
test("work in one run and the hand-off in the next still land in one commit", async () => {
  const repo = await repoWith({ "README.md": "base\n", "owner.md": "base\n" })
  await write(repo, { "owner.md": "owner's own work\n" })

  // Run #1: offers its snapshot, the board keeps it on the card, the agent writes the code.
  const kept = serializeSnapshot(await gitSnapshot(repo))
  await write(repo, { "README.md": "agent\n", "docs/new.md": "agent\n" })

  // Run #2 (a chat message): its own snapshot sees nothing new — the card's is the one to use.
  const ownSnapshot = await gitSnapshot(repo)
  assert.deepEqual(changedPaths(ownSnapshot, await gitSnapshot(repo)), [])

  const before = parseSnapshot(kept)
  assert.equal(before.isRepo, true)
  const outcome = await commitRun(repo, message, before, { log: QUIET })
  assert.equal(outcome.committed, true)
  assert.deepEqual(outcome.paths.sort(), ["README.md", "docs/new.md"])
  assert.deepEqual(await committed(repo), ["README.md", "docs/new.md"].sort())
  // The rule the hand-off must not break: the owner's own edit is still theirs.
  assert.equal((await gitSnapshot(repo)).dirty.get("owner.md")?.slice(0, 2), " M")
})

test("a snapshot survives the round trip through the card, and junk is refused", async () => {
  const repo = await repoWith({ "README.md": "base\n" })
  await write(repo, { "README.md": "owner\n", "scratch.txt": "owner\n" })
  const before = await gitSnapshot(repo)

  const back = parseSnapshot(serializeSnapshot(before))
  assert.equal(back.isRepo, true)
  assert.equal(back.head, before.head)
  assert.deepEqual([...back.dirty], [...before.dirty])

  for (const junk of [null, "", "not json", "[]", '{"dirty":"nope"}']) {
    assert.equal(parseSnapshot(junk), null, `parsed ${junk}`)
  }
})
