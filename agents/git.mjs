// The board's commit step: what the work on a card changed in the checkout, and nothing else.
// "On a card", not "in a run": the snapshot the commit is taken against is the one from the
// start of the work (the board keeps it on the card), so a hand-off in a later run still
// commits what an earlier one wrote.
//
// Lives apart from worker.mjs so it can be exercised against a real throwaway repository
// in agents/git.test.mjs — the invariant here (the owner's own uncommitted work never ends
// up in an agent's commit) is not something to verify by reading.

import fs from "node:fs/promises"
import path from "node:path"
import { runCommand } from "./adapters/process.mjs"

/** git status / add / commit are local and fast; a minute means something is wrong. */
const GIT_TIMEOUT_MS = 60_000
/** Paths per `git hash-object` call — long argument lists have an OS limit. */
const HASH_BATCH = 200

/** Run git in the repository. Resolves with { code, stdout, stderr } — never throws on a non-zero exit. */
export function git(repo, args, { log, signal }) {
  return runCommand("git", ["-C", repo, ...args], { log, timeoutMs: GIT_TIMEOUT_MS, signal })
}

/** Status and HEAD are plumbing — they don't belong in the run log. */
const QUIET = () => Promise.resolve()

async function exists(file) {
  try {
    await fs.lstat(file)
    return true
  } catch {
    return false
  }
}

/** Only a regular file has contents `git hash-object` can take — a directory or a symlink does not. */
async function isRegularFile(file) {
  try {
    return (await fs.lstat(file)).isFile()
  } catch {
    return false
  }
}

/**
 * `git status --porcelain -z` as path → status. Renames and copies carry two paths;
 * both ends are recorded, so a rename done by the agent is seen as a change on either side.
 */
export function parseStatus(raw) {
  const fields = raw.split("\0")
  const dirty = new Map()
  for (let i = 0; i < fields.length; i += 1) {
    const entry = fields[i]
    if (entry.length < 4) continue
    const code = entry.slice(0, 2)
    const to = entry.slice(3)
    if (code[0] === "R" || code[0] === "C") {
      i += 1
      const from = fields[i] ?? ""
      dirty.set(to, `${code} ${from}`)
      if (from) dirty.set(from, `${code} → ${to}`)
    } else {
      dirty.set(to, code)
    }
  }
  return dirty
}

/**
 * One blob hash per path, in order, or null when git could not hash the batch as asked.
 * --no-filters: we compare one snapshot against another, so a smudge/clean filter would only
 * add a way for two identical trees to hash differently.
 */
async function hashObject(repo, batch, { signal }) {
  const out = await git(repo, ["hash-object", "--no-filters", "--", ...batch], { log: QUIET, signal })
  if (out.code !== 0) return null
  const lines = out.stdout.split("\n").filter(Boolean)
  return lines.length === batch.length ? lines : null
}

/** Makes every "could not hash this" unique — see worktreeHashes. */
let unknowns = 0

/**
 * Blob hashes of the given paths' working-tree contents, as path → hash. Paths with no contents
 * to hash right now (a deletion, the old side of a rename) are left out, and the caller reads
 * them as "-".
 *
 * A path we *should* have been able to hash but could not must never end up reading like one of
 * those: "-" before and "-" after compares equal, which is the same silent "nothing changed"
 * this module exists to prevent. Such a path gets a value unique to this call instead, so it
 * always counts as changed — a path wrongly in the commit is loud, one wrongly left out is not.
 */
async function worktreeHashes(repo, files, { signal }) {
  const hashes = new Map()
  const present = []
  for (const file of files) {
    if (await isRegularFile(path.join(repo, file))) present.push(file)
  }
  for (let i = 0; i < present.length; i += HASH_BATCH) {
    const batch = present.slice(i, i + HASH_BATCH)
    const lines = await hashObject(repo, batch, { signal })
    if (lines) {
      batch.forEach((file, index) => hashes.set(file, lines[index]))
      continue
    }
    // One unhashable path must not cost the rest of the batch its hashes: retry one at a time.
    for (const file of batch) {
      const one = await hashObject(repo, [file], { signal })
      hashes.set(file, one ? one[0] : `unknown-${(unknowns += 1)}`)
    }
  }
  return hashes
}

/**
 * What the working tree looks like right now: which paths are dirty, what is in them, and
 * where HEAD is. `dirty` maps a path to a fingerprint — the status code plus the hash of the
 * file's current contents — because the status code alone cannot tell "the owner's edit" from
 * "the owner's edit, then the agent's on top of it": both read ` M`.
 *
 * `isRepo: false` when the folder is not a git checkout, or git could not be run at all — the
 * commit is then skipped rather than guessed at.
 */
export async function gitSnapshot(repo, { signal } = {}) {
  const empty = { isRepo: false, dirty: new Map(), head: null }
  try {
    // --untracked-files=all: by default git reports an untracked folder as the single entry
    // `?? docs/`, which has no contents to fingerprint — so a run that adds a file inside a
    // folder that already existed looks identical before and after. We need the files.
    const status = await git(repo, ["status", "--porcelain", "-z", "--untracked-files=all"], { log: QUIET, signal })
    if (status.code !== 0) return empty
    const head = await git(repo, ["rev-parse", "HEAD"], { log: QUIET, signal })
    const codes = parseStatus(status.stdout)
    const hashes = await worktreeHashes(repo, [...codes.keys()], { signal })
    const dirty = new Map()
    for (const [file, code] of codes) dirty.set(file, `${code} ${hashes.get(file) ?? "-"}`)
    return { isRepo: true, dirty, head: head.code === 0 ? head.stdout.trim() : null }
  } catch {
    return empty
  }
}

/**
 * A snapshot as text, so the board can keep it on the card between runs — the work and the
 * hand-off that commits it are usually two different runs.
 */
export function serializeSnapshot(snapshot) {
  return JSON.stringify({ isRepo: snapshot.isRepo, head: snapshot.head, dirty: [...snapshot.dirty] })
}

/** A snapshot back from `serializeSnapshot`, or null when the text is not one. */
export function parseSnapshot(raw) {
  if (typeof raw !== "string" || !raw) return null
  try {
    const data = JSON.parse(raw)
    if (!data || typeof data !== "object" || !Array.isArray(data.dirty)) return null
    const dirty = new Map()
    for (const entry of data.dirty) {
      if (Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "string") {
        dirty.set(entry[0], entry[1])
      }
    }
    return { isRepo: data.isRepo === true, dirty, head: typeof data.head === "string" ? data.head : null }
  } catch {
    return null
  }
}

/** Paths whose dirty fingerprint the run changed — appeared, or the same status over new contents. */
export function changedPaths(before, after) {
  return [...after.dirty].filter(([file, print]) => before.dirty.get(file) !== print).map(([file]) => file)
}

/**
 * Commit what changed since `before`, and only that. The owner's own uncommitted work stays
 * untouched — `git add -A` over the whole tree would quietly sweep it in.
 *
 * Resolves with { committed, sha, paths } on success, { skipped: "not-a-repo" | "unchanged" }
 * when there is nothing to do, or { failed, output } when git refused. Both "unchanged" and a
 * refusal keep the card where it is — only the caller knows how to say so in the chat.
 */
export async function commitRun(repo, message, before, { log, signal }) {
  if (!before.isRepo) {
    await log(`[worker] ${repo} is not a git repository — skipping the commit\n`)
    return { skipped: "not-a-repo" }
  }
  const after = await gitSnapshot(repo, { signal })
  if (after.head && before.head && after.head !== before.head) {
    await log("[worker] the agent committed on its own — committing whatever it left behind\n")
  }
  const paths = changedPaths(before, after)
  if (paths.length === 0) {
    await log("[worker] nothing to commit\n")
    return { skipped: "unchanged" }
  }

  await log(`[worker] committing ${paths.length} path(s): ${paths.join(" ")}\n`)
  // `git add` refuses a path that is neither on disk nor in the index — the old side of a
  // rename the agent staged itself. The index already holds those correctly and `git commit`
  // does take them by pathspec, so the rename still lands as one commit.
  const listed = await git(repo, ["ls-files", "-z", "--", ...paths], { log: QUIET, signal })
  const tracked = new Set(listed.stdout.split("\0").filter(Boolean))
  const addable = []
  for (const file of paths) {
    if (tracked.has(file) || (await exists(path.join(repo, file)))) addable.push(file)
  }
  if (addable.length > 0) {
    const staged = await git(repo, ["add", "-A", "--", ...addable], { log, signal })
    if (staged.code !== 0) return { failed: staged.code, output: `${staged.stdout}${staged.stderr}` }
  }
  const commit = await git(repo, ["commit", "-m", message.subject, "-m", message.trailer, "--", ...paths], { log, signal })
  if (commit.code !== 0) return { failed: commit.code, output: `${commit.stdout}${commit.stderr}` }
  const sha = await git(repo, ["rev-parse", "--short", "HEAD"], { log: QUIET, signal })
  return { committed: true, sha: sha.code === 0 ? sha.stdout.trim() : null, paths }
}
