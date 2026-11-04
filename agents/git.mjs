// The board's commit step: what the work on a card changed in the checkout, and nothing else.
// "On a card", not "in a run": the snapshot the commit is taken against is the one from the
// start of the work (the board keeps it on the card), so a hand-off in a later run still
// commits what an earlier one wrote.
//
// Lives apart from worker.mjs so it can be exercised against a real throwaway repository
// in agents/git.test.mjs — the invariant here (the owner's own uncommitted work never ends
// up in an agent's commit) is not something to verify by reading.

import { constants as fsConstants } from "node:fs"
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
  // A merge in progress (a card whose branch is being brought up to date, `startMerge`) can only
  // be concluded by committing the whole index — git refuses a partial commit during a merge. The
  // index then holds the merge and the work on top of it, all of it the card's: before the merge
  // the card's worktree was clean. It is committed even when it changed no file (every conflict
  // resolved to this side): the merge itself is what lets the branch land.
  const merging = await inMerge(repo, { signal })
  if (paths.length === 0 && !merging) {
    await log("[worker] nothing to commit\n")
    return { skipped: "unchanged" }
  }

  await log(`[worker] committing ${paths.length} path(s)${merging ? " and the merge in progress" : ""}: ${paths.join(" ")}\n`)
  // `git add` refuses a path that is neither on disk nor in the index — the old side of a
  // rename the agent staged itself. The index already holds those correctly and `git commit`
  // does take them by pathspec, so the rename still lands as one commit.
  const listed = paths.length > 0 ? await git(repo, ["ls-files", "-z", "--", ...paths], { log: QUIET, signal }) : { stdout: "" }
  const tracked = new Set(listed.stdout.split("\0").filter(Boolean))
  const addable = []
  for (const file of paths) {
    if (tracked.has(file) || (await exists(path.join(repo, file)))) addable.push(file)
  }
  if (addable.length > 0) {
    const staged = await git(repo, ["add", "-A", "--", ...addable], { log, signal })
    if (staged.code !== 0) return { failed: staged.code, output: `${staged.stdout}${staged.stderr}` }
  }
  // `git add` marks a file with conflict markers still in it as resolved, so those are looked
  // for first — a merge committed with them in is the one thing to avoid here.
  if (merging) {
    const unresolved = await mergeLeftovers(repo, { signal })
    if (unresolved.length > 0) {
      return { failed: 1, output: `Unresolved merge conflicts left in:\n${unresolved.map((file) => `- ${file}`).join("\n")}` }
    }
  }
  const commit = await git(
    repo,
    ["commit", "-m", message.subject, "-m", message.trailer, ...(merging ? [] : ["--", ...paths])],
    { log, signal }
  )
  if (commit.code !== 0) return { failed: commit.code, output: `${commit.stdout}${commit.stderr}` }
  const sha = await git(repo, ["rev-parse", "--short", "HEAD"], { log: QUIET, signal })
  return {
    committed: true,
    sha: sha.code === 0 ? sha.stdout.trim() : null,
    paths,
    left: await trackedLeftovers(repo, { signal }),
  }
}

// --- a worktree per card (Parallel work) --------------------------------------------------------
//
// With the board's Parallel work on, a card in In progress gets its own checkout: a git worktree
// on branch `cs/<KEY>-<N>`, cut from the branch the board's checkout is on, in a folder *next to*
// the repository — inside it, the repository's own status, search and build would all see it.
// The worker makes it here; the board merges and removes it when the card is released
// (src/server/worktree.ts).

/** The card's branch and folder: `cs/BI-120` in `<repo>.worktrees/BI-120`. */
export function worktreePlan(repo, ref) {
  return { branch: `cs/${ref}`, path: path.join(`${path.resolve(repo)}.worktrees`, ref) }
}

/**
 * Make the card's worktree, or find the one it already has. `base` is the branch to cut it from:
 * the one the board's checkout is on when null. Resolves with { path, branch, base, fresh,
 * newBranch } — `fresh` = the folder was made just now (so the setup command has not run in it),
 * `newBranch` = so was the branch — or with { failed } saying why not.
 */
export async function prepareWorktree(repo, plan, { base = null, signal } = {}) {
  const opts = { log: QUIET, signal }
  if (!base) {
    const head = await git(repo, ["symbolic-ref", "--quiet", "--short", "HEAD"], opts)
    if (head.code !== 0) return { failed: `${repo} is on a detached HEAD — there is no branch to cut the card's from` }
    base = head.stdout.trim()
  }
  // A worktree whose folder was deleted by hand stays registered and blocks its branch.
  await git(repo, ["worktree", "prune"], opts)
  if (await exists(plan.path)) {
    const on = await git(plan.path, ["symbolic-ref", "--quiet", "--short", "HEAD"], opts)
    if (on.code === 0 && on.stdout.trim() === plan.branch) {
      return { path: plan.path, branch: plan.branch, base, fresh: false, newBranch: false }
    }
    return { failed: `${plan.path} already exists and is not a checkout of ${plan.branch}` }
  }
  await fs.mkdir(path.dirname(plan.path), { recursive: true })
  const known = await git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${plan.branch}`], opts)
  const newBranch = known.code !== 0
  const added = await git(
    repo,
    newBranch ? ["worktree", "add", "-b", plan.branch, plan.path, base] : ["worktree", "add", plan.path, plan.branch],
    opts
  )
  if (added.code !== 0) return { failed: `${added.stdout}${added.stderr}`.trim() || `git worktree add exited with ${added.code}` }
  return { path: plan.path, branch: plan.branch, base, fresh: true, newBranch }
}

/**
 * Take back a worktree made for a run that never got going (its setup failed): the next run
 * starts from a fresh one and runs the setup again. Its branch goes too when it was new — nothing
 * can be on it yet.
 */
export async function discardWorktree(repo, made, { signal } = {}) {
  const opts = { log: QUIET, signal }
  await git(repo, ["worktree", "remove", "--force", made.path], opts)
  if (made.newBranch) await git(repo, ["branch", "-D", made.branch], opts)
}

// --- node_modules in a fresh worktree -----------------------------------------------------------
//
// A worktree is a checkout, not a copy: it has no node_modules, so the coder's typecheck and the
// board's check fail in it. A board with a setup command (`npm ci`) gets a real install. Without
// one, the repository's own node_modules is cloned copy-on-write — `cp -c` on macOS (APFS),
// `--reflink=always` elsewhere: seconds, and no disk until a file in it changes. A filesystem
// that cannot clone gets nothing rather than a full copy: gigabytes per card is what the clone is
// there to avoid, and the setup command is the way to ask for a real install.

/** A clone of a big node_modules is metadata only, but there are a lot of files. */
const CLONE_TIMEOUT_MS = 5 * 60_000

/**
 * Clone `<repo>/node_modules` into the worktree. Resolves with { cloned, ms }, { skipped } saying
 * why there was nothing to do, or { failed } with cp's words (and nothing left half-copied).
 */
export async function cloneNodeModules(repo, worktreePath, { signal } = {}) {
  const from = path.join(repo, "node_modules")
  const to = path.join(worktreePath, "node_modules")
  if (process.platform === "win32") return { skipped: "no copy-on-write clone on Windows" }
  if (!(await isDirectory(from))) return { skipped: "the repository has no node_modules" }
  if (await exists(to)) return { skipped: "the worktree has node_modules already" }
  // Not ignored, it would be the card's to commit: thousands of files nobody wrote.
  if ((await git(worktreePath, ["check-ignore", "-q", "node_modules/"], { log: QUIET, signal })).code !== 0) {
    return { skipped: "node_modules is not git-ignored" }
  }
  // `cp -c` on a disk that cannot clone quietly makes a full copy instead (man cp: "cp will
  // fallback to using copyfile(2)"); one file cloned with FICLONE_FORCE fails there instead.
  if (!(await canClone(from, worktreePath))) return { skipped: "the disk cannot clone" }
  const args = process.platform === "darwin" ? ["-c", "-R", from, to] : ["-R", "--reflink=always", from, to]
  const started = Date.now()
  const { code, stdout, stderr } = await runCommand("cp", args, { log: QUIET, timeoutMs: CLONE_TIMEOUT_MS, signal })
  if (code !== 0) {
    await fs.rm(to, { recursive: true, force: true })
    return { failed: `${stdout}${stderr}`.trim().split("\n").slice(-3).join("\n") || `cp exited with ${code}` }
  }
  return { cloned: true, ms: Date.now() - started }
}

/**
 * Does `cp` clone from `from` into `into`, rather than copy? One file of `from` cloned with
 * FICLONE_FORCE answers it: it fails where the disk cannot clone. Node on macOS does not
 * implement the forced clone at all (ENOSYS, APFS or not), so there the answer is what
 * clonefile(2) needs: both on the same APFS volume. macOS numbers a filesystem type when it
 * registers, so APFS is the type of `/` (APFS on every macOS the board runs on), not a constant.
 */
async function canClone(from, into) {
  const sample = await firstFile(from, 4)
  if (!sample) return false
  const probe = path.join(into, `.cs-clone-probe-${process.pid}`)
  try {
    await fs.copyFile(sample, probe, fsConstants.COPYFILE_FICLONE_FORCE)
    return true
  } catch (error) {
    if (process.platform !== "darwin" || error?.code !== "ENOSYS") return false
    try {
      const [source, target, volume, root] = await Promise.all([
        fs.stat(from),
        fs.stat(into),
        fs.statfs(into),
        fs.statfs("/"),
      ])
      return source.dev === target.dev && volume.type === root.type
    } catch {
      return false
    }
  } finally {
    await fs.rm(probe, { force: true })
  }
}

/** A regular file somewhere in the first `depth` levels of the folder, or null. */
async function firstFile(dir, depth) {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return null
  }
  const file = entries.find((e) => e.isFile())
  if (file) return path.join(dir, file.name)
  if (depth <= 1) return null
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const found = await firstFile(path.join(dir, entry.name), depth - 1)
    if (found) return found
  }
  return null
}

/**
 * Bytes a folder takes on disk, leaving out the folders named in `skip` — a cloned node_modules
 * shares the repository's blocks, and counting it at full size would report disk nobody spent.
 */
export async function diskUsage(dir, { skip = [] } = {}) {
  let total = 0
  const walk = async (folder) => {
    let entries
    try {
      entries = await fs.readdir(folder, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const file = path.join(folder, entry.name)
      if (entry.isDirectory()) {
        if (!(folder === dir && skip.includes(entry.name))) await walk(file)
        continue
      }
      try {
        const stat = await fs.lstat(file)
        total += stat.blocks != null ? stat.blocks * 512 : stat.size
      } catch {
        // Gone meanwhile: nothing to count.
      }
    }
  }
  await walk(dir)
  return total
}

async function isDirectory(dir) {
  try {
    return (await fs.stat(dir)).isDirectory()
  } catch {
    return false
  }
}

// --- bringing a card's branch up to date (a merge conflict on landing) --------------------------
//
// When the board could not land a card's branch because it conflicts with its base, the card's
// coder gets a `conflict:` run (src/server/store.ts). The worker starts the merge of the base into
// the branch itself, before the agent runs: a worktree's git directory sits inside the main
// repository's `.git`, outside the folder a sandboxed engine (Codex) may write, so the agent could
// not start it — but it can edit the files with the conflict markers in them. The commit step
// then concludes the merge (`commitRun`).

/** Is a merge in progress in this checkout? */
export async function inMerge(repo, { signal } = {}) {
  const head = await git(repo, ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"], { log: QUIET, signal })
  return head.code === 0
}

/** Paths a merge in progress still has unresolved: unmerged in the index, or with conflict markers. */
export async function mergeLeftovers(repo, { signal } = {}) {
  const unmerged = await git(repo, ["diff", "--name-only", "--diff-filter=U"], { log: QUIET, signal })
  const files = new Set(unmerged.stdout.split("\n").filter(Boolean))
  // `--check` also reports whitespace errors; only its conflict-marker lines matter here.
  const checked = await git(repo, ["diff", "--cached", "--check"], { log: QUIET, signal })
  for (const line of checked.stdout.split("\n")) {
    const marker = line.match(/^(.+?):\d+: leftover conflict marker/)
    if (marker) files.add(marker[1])
  }
  return [...files]
}

/**
 * Merge `base` into the branch checked out in `repo`, stopping before the commit. Resolves with
 * { started, conflicts } — `conflicts` the paths left for the agent to resolve — or { already }
 * when a merge is under way from an earlier run, { upToDate } when the branch has the base in it
 * already, or { failed } with git's words when it would not start (a dirty tree in the way).
 */
export async function startMerge(repo, base, { log, signal } = {}) {
  if (await inMerge(repo, { signal })) return { already: true }
  if ((await git(repo, ["merge-base", "--is-ancestor", base, "HEAD"], { log: QUIET, signal })).code === 0) {
    return { upToDate: true }
  }
  const merged = await git(repo, ["merge", "--no-commit", "--no-ff", base], { log: log ?? QUIET, signal })
  if (!(await inMerge(repo, { signal }))) {
    return { failed: `${merged.stdout}${merged.stderr}`.trim() || `git merge exited with ${merged.code}` }
  }
  const unmerged = await git(repo, ["diff", "--name-only", "--diff-filter=U"], { log: QUIET, signal })
  return { started: true, conflicts: unmerged.stdout.split("\n").filter(Boolean) }
}

/**
 * Tracked files still modified after the commit. They may be the owner's own edits — or work on
 * the card the commit failed to see (a lost "before" left six files behind on UG-39). Either way
 * the card's chat lists them: a commit that silently leaves work out is the failure to avoid.
 * Untracked files are not listed — build output and scratch files would drown the real ones.
 */
export async function trackedLeftovers(repo, { signal } = {}) {
  const status = await git(repo, ["status", "--porcelain", "-z", "--untracked-files=no"], { log: QUIET, signal })
  if (status.code !== 0) return []
  return [...parseStatus(status.stdout).keys()]
}
