// A card boiled down to one short read — for an architect that works from outside the board
// (a chat with the owner) and would otherwise have to pull hundreds of kilobytes of run log,
// ANSI and all, to find out what happened on it.
//
// Everything here is derived, nothing is stored: the board already records the check and the
// commit, but it records them as text the worker wrote — the check section of a run log and the
// "Committed …" system message. This module reads those back; it never writes.

import { getDb } from "./db"
import { getTask, listMembers, listMessages, listRuns } from "./store"
import { stripAnsi, tailLines } from "@/lib/plain-text"
import { taskRef } from "@/lib/task-ref"
import type { ColumnRole, Member, TaskDigest } from "@/lib/types"

// Both helpers live in @/lib/plain-text now — the event feed quotes CLI output too, and it
// cannot import this module (it is written from the store, which this module reads).
export { stripAnsi, tailLines }

/** Lines of check output the digest carries — enough for the failing assertion and its context. */
const CHECK_TAIL_LINES = 40
/** Characters per quoted message; a long reply is cut at the end, where it matters least. */
const MESSAGE_MAX = 500
const MESSAGES_SHOWN = 3

/**
 * The board's check inside a run log. The worker frames it — `[worker] check: <command>`, then
 * the command's own output, then `check passed` / `check failed (exit N)` — so the frame is what
 * we look for. A run stopped mid-check has no closing line: `passed` is then null, not false.
 */
export function parseCheck(log: string): TaskDigest["check"] {
  const plain = stripAnsi(log)
  const starts = [...plain.matchAll(/^\[worker\] check: (.+)$/gm)]
  const start = starts[starts.length - 1]
  if (!start) return null
  const body = plain.slice((start.index ?? 0) + start[0].length)
  const passed = body.match(/^\[worker\] check passed$/m)
  const failed = body.match(/^\[worker\] check failed \(exit (-?\d+)\)/m)
  const end = passed ?? failed
  const output = end ? body.slice(0, end.index) : body
  return {
    command: start[1].trim(),
    passed: end ? Boolean(passed) : null,
    exitCode: passed ? 0 : failed ? Number(failed[1]) : null,
    tail: tailLines(output, CHECK_TAIL_LINES),
  }
}

/**
 * The commit the board made for this card, from the system message the worker posts for it
 * (`Committed \`sha\` — N file(s):` and a `- \`path\`` per file). The sha is nowhere else: the
 * worker reads it with a quiet `git rev-parse` that never reaches the run log.
 */
export function parseCommit(text: string): TaskDigest["commit"] {
  const head = text.match(/^Committed(?: `([0-9a-f]+)`)? — \d+ file\(s\):/m)
  if (!head) return null
  const files = [...text.matchAll(/^- `(.+)`$/gm)].map((m) => m[1])
  return { sha: head[1] ?? null, files }
}

function handleOf(members: Map<string, Member>, id: string | null): string | null {
  if (!id) return null
  return members.get(id)?.handle ?? null
}

/** Read-only: the card's state, its last run, the check, the commit and the last few messages. */
export function getTaskDigest(taskId: string): TaskDigest {
  const task = getTask(taskId)
  const members = new Map(listMembers().map((m) => [m.id, m]))
  const place = getDb()
    .prepare(
      "SELECT c.role AS role, b.key AS key FROM tasks t JOIN columns c ON c.id = t.column_id JOIN boards b ON b.id = t.board_id WHERE t.id = ?"
    )
    .get(taskId) as { role: string; key: string } | undefined

  // Newest first (`listRuns`), so the first log with a check section is the card's latest check.
  const runs = listRuns(taskId)
  const last = runs[0] ?? null
  let check: TaskDigest["check"] = null
  for (const run of runs) {
    check = parseCheck(run.log)
    if (check) break
  }

  const messages = listMessages(taskId)
  const commit =
    messages
      .map((message) => parseCommit(message.text))
      .filter((found) => found !== null)
      .pop() ?? null

  return {
    ref: taskRef(place?.key ?? null, task.number),
    column: (place?.role as ColumnRole | undefined) ?? "other",
    assignees: task.assigneeIds.map((id) => handleOf(members, id)).filter((h): h is string => h !== null),
    lastRun: last
      ? {
          agent: handleOf(members, last.agentId),
          trigger: last.trigger,
          status: last.status,
          startedAt: last.startedAt,
          finishedAt: last.finishedAt,
        }
      : null,
    check,
    commit,
    lastMessages: messages.slice(-MESSAGES_SHOWN).map((message) => ({
      author: handleOf(members, message.authorId),
      kind: message.kind,
      text: stripAnsi(message.text).slice(0, MESSAGE_MAX),
      createdAt: message.createdAt,
    })),
  }
}
