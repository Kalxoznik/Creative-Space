// Landing a card's worktree (Parallel work): its branch goes into the branch it was cut from, then
// the worktree and the branch are removed. The board does this itself, at the move that releases
// the card (`updateTask` in the store) — the worker only creates worktrees (agents/git.mjs).
//
// Synchronous on purpose: the move that lands a card may also start the next one, and that card's
// worktree must be cut from a main branch that already has this one in it. A merge and a
// `worktree remove` take a moment; nothing else on the board runs meanwhile anyway.
//
// A merge that does not apply cleanly changes nothing: it is aborted, and the branch, the worktree
// and the card's record of them stay as they were. A conflict comes back with the paths git could
// not merge — the store sends the card back to its coder with them (`landIfReleased`).
//
// Other cards' worktrees are never touched here: a card that is still being worked on picks up
// what landed only when it reaches its own merge, so nothing moves under a run in flight.

import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

export type CardWorktree = { branch: string; path: string; base: string }

export type LandOutcome =
  | { landed: true; how: "fast-forward" | "merge" | "nothing new"; kept: string | null }
  | { landed: false; reason: string; conflicts?: string[] }

const GIT_TIMEOUT_MS = 60_000

function git(repo: string, args: string[]): { code: number; out: string } {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", timeout: GIT_TIMEOUT_MS })
  return { code: result.status ?? 1, out: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() }
}

/** The last lines of git's own words — what the card's chat quotes when it refused. */
function tail(text: string): string {
  return text.split("\n").slice(-12).join("\n")
}

export function landWorktree(repo: string, worktree: CardWorktree): LandOutcome {
  const { branch, base } = worktree
  if (git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).code !== 0) {
    return { landed: false, reason: `the branch ${branch} does not exist` }
  }
  // The merge happens in the board's own checkout, so that checkout must be on the base branch:
  // merging into whatever the owner happens to have checked out would land the card elsewhere.
  const current = git(repo, ["symbolic-ref", "--quiet", "--short", "HEAD"])
  if (current.code !== 0 || current.out !== base) {
    return {
      landed: false,
      reason: `the repository is on ${current.code === 0 ? current.out : "a detached HEAD"}, not on ${base}`,
    }
  }

  let how: "fast-forward" | "merge" | "nothing new" = "merge"
  if (git(repo, ["merge-base", "--is-ancestor", branch, "HEAD"]).code === 0) how = "nothing new"
  else if (git(repo, ["merge-base", "--is-ancestor", "HEAD", branch]).code === 0) how = "fast-forward"
  if (how !== "nothing new") {
    const merged = git(repo, ["merge", "--no-edit", branch])
    if (merged.code !== 0) {
      // A merge that stopped on conflicts left the checkout half-merged; one git refused up front
      // (the owner's uncommitted edits in the way) left nothing to undo. Only the first is the
      // card's coder's to fix, so the conflicting paths are read before the abort clears them.
      let conflicts: string[] = []
      if (git(repo, ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"]).code === 0) {
        conflicts = git(repo, ["diff", "--name-only", "--diff-filter=U"]).out.split("\n").filter(Boolean)
        git(repo, ["merge", "--abort"])
      }
      return {
        landed: false,
        reason: tail(merged.out) || `git merge exited with ${merged.code}`,
        ...(conflicts.length > 0 ? { conflicts } : {}),
      }
    }
  }

  // No --force: anything uncommitted still in the worktree is work nobody has seen in git, and
  // deleting it quietly is the one thing this step must not do. The merge stands either way.
  git(repo, ["worktree", "prune"])
  const removed = git(repo, ["worktree", "remove", worktree.path])
  if (removed.code !== 0 && fs.existsSync(worktree.path)) {
    return { landed: true, how, kept: tail(removed.out) || "git worktree remove refused" }
  }
  const deleted = git(repo, ["branch", "-d", branch])
  return { landed: true, how, kept: deleted.code === 0 ? null : tail(deleted.out) }
}

// --- cleanup -------------------------------------------------------------------------------------
//
// A card that leaves the work without landing — archived, deleted, parked back in Backlog — takes
// its worktree and its branch with it: the owner put the work aside, and a folder per abandoned
// card next to the repository is how a day of parallel work ends up with gigabytes of copies.
// This is the one place the board removes with --force and `branch -D`, so nothing may be lost to
// it: the worker commits only at hand-off, and between hand-offs (a failed check, a stopped run, a
// review sent back) the card's work sits uncommitted in the folder. That is saved first, as the
// board's own commit on the branch, and the caller writes down the sha the branch ends on — one
// `git branch` brings all of it back.

export type DropOutcome =
  | { dropped: true; sha: string | null; saved: boolean }
  | { dropped: false; reason: string; foreign?: true }

/** The `cs/*` branches in the repository and the worktrees git knows about; null = not a repository. */
export function listCardWorktrees(
  repo: string
): { branches: string[]; worktrees: Array<{ path: string; branch: string | null }> } | null {
  if (git(repo, ["rev-parse", "--git-dir"]).code !== 0) return null
  git(repo, ["worktree", "prune"])
  const refs = git(repo, ["for-each-ref", "--format=%(refname:short)", "refs/heads/cs/"])
  const branches = refs.code === 0 ? refs.out.split("\n").filter(Boolean) : []
  const listed = git(repo, ["worktree", "list", "--porcelain"])
  const worktrees: Array<{ path: string; branch: string | null }> = []
  for (const block of listed.code === 0 ? listed.out.split("\n\n") : []) {
    const folder = block.match(/^worktree (.+)$/m)?.[1]
    if (!folder) continue
    worktrees.push({ path: folder, branch: block.match(/^branch refs\/heads\/(.+)$/m)?.[1] ?? null })
  }
  return { branches, worktrees }
}

/** Has everything on the branch reached `base` already? (A landing that kept its worktree.) */
export function branchMerged(repo: string, branch: string, base: string): boolean {
  return git(repo, ["merge-base", "--is-ancestor", `refs/heads/${branch}`, base]).code === 0
}

/**
 * Commit whatever is uncommitted in the worktree onto its branch, as the board: `add -A` leaves
 * ignored files out; no hooks and no signing, nothing that can stop a save on the way out.
 * null = nothing to save; { failed } = there was, and git would not commit it.
 */
function saveUncommitted(folder: string): { saved: true } | { failed: string } | null {
  const status = git(folder, ["status", "--porcelain"])
  if (status.code !== 0) return { failed: tail(status.out) || "git status failed" }
  if (!status.out) return null
  const added = git(folder, ["add", "-A"])
  if (added.code !== 0) return { failed: tail(added.out) || "git add failed" }
  const committed = git(folder, [
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--no-verify",
    "-q",
    "-m",
    "Save uncommitted work before removing the card's worktree",
    "-m",
    "Committed by Creative Space: the card left the work without landing.",
  ])
  return committed.code === 0 ? { saved: true } : { failed: tail(committed.out) || "git commit failed" }
}

/**
 * Is the folder inside `<repo>.worktrees/`? Compared as real paths: git lists worktrees that way.
 * The folder is the one `worktreePlan` makes — next to `repo` as given, not next to its real path:
 * a project opened through a symlink keeps its worktrees beside the link.
 */
function boardsFolder(repo: string, folder: string): boolean {
  const real = (p: string) => {
    try {
      return fs.realpathSync(p)
    } catch {
      return path.resolve(p)
    }
  }
  return real(folder).startsWith(`${real(`${path.resolve(repo)}.worktrees`)}${path.sep}`)
}

/**
 * Remove a card's worktree and delete its branch, after saving what is uncommitted in it — work
 * that could not be saved stops it, and nothing is removed. Only a folder inside
 * `<repo>.worktrees/` — where the board makes them (agents/git.mjs `worktreePlan`) — is the
 * board's: the main checkout or a worktree the owner made, even on a board-named branch, is left
 * alone whole — nothing committed in it, nothing removed, the branch kept (`foreign`).
 */
export function dropWorktree(repo: string, worktree: { branch: string; path: string | null }): DropOutcome {
  git(repo, ["worktree", "prune"])
  if (worktree.path && fs.existsSync(worktree.path) && !boardsFolder(repo, worktree.path)) {
    return { dropped: false, reason: `${worktree.path} is not a worktree the board made`, foreign: true }
  }
  let saved = false
  if (worktree.path && fs.existsSync(worktree.path)) {
    // Only on the card's own branch: a folder on anything else is not where the card's work is.
    const head = git(worktree.path, ["symbolic-ref", "--quiet", "--short", "HEAD"])
    if (head.code === 0 && head.out === worktree.branch) {
      const save = saveUncommitted(worktree.path)
      if (save && "failed" in save) {
        return { dropped: false, reason: `the uncommitted work in it could not be saved:\n${save.failed}` }
      }
      saved = save != null
    }
  }
  const sha = git(repo, ["rev-parse", "--short", "--verify", "--quiet", `refs/heads/${worktree.branch}`])
  if (worktree.path && fs.existsSync(worktree.path)) {
    // Twice: once for what is still left (untracked ignored files), once more for a locked worktree.
    const removed = git(repo, ["worktree", "remove", "--force", "--force", worktree.path])
    if (removed.code !== 0 && fs.existsSync(worktree.path)) {
      fs.rmSync(worktree.path, { recursive: true, force: true })
      git(repo, ["worktree", "prune"])
    }
  }
  if (sha.code === 0) {
    const deleted = git(repo, ["branch", "-D", worktree.branch])
    if (deleted.code !== 0) return { dropped: false, reason: tail(deleted.out) || "git branch -D refused" }
  }
  return { dropped: true, sha: sha.code === 0 ? sha.out : null, saved }
}
