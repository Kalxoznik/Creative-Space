// Shared helpers for the worker and its adapters. No dependencies.

import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

export const AGENTS_DIR = path.dirname(fileURLToPath(import.meta.url))
export const PROJECT_ROOT = path.resolve(AGENTS_DIR, "..")

const MOVE_TARGETS = new Set(["backlog", "ready", "in_progress", "review", "done"])

/** Role prompt from agents/prompts/<role>.md */
export async function loadRolePrompt(role) {
  return fs.readFile(path.join(AGENTS_DIR, "prompts", `${role}.md`), "utf8")
}

function memberLine(member) {
  const tag = member.kind === "agent" ? `agent, ${member.agentRole}` : "human"
  return `- @${member.handle} — ${member.name} (${tag})`
}

function formatThread(thread, members, limit = 40) {
  const byId = new Map(members.map((m) => [m.id, m]))
  const recent = thread.slice(-limit)
  if (recent.length === 0) return "(no messages yet)"
  return recent
    .map((message) => {
      const author = byId.get(message.authorId)
      const who = message.kind === "system" ? "system" : `@${author?.handle ?? message.authorId}`
      return `[${message.createdAt.slice(0, 16).replace("T", " ")}] ${who}: ${message.text}`
    })
    .join("\n")
}

/** Everything the model gets: role rules + board situation + the trigger. */
export async function buildPrompt(role, context) {
  const rolePrompt = await loadRolePrompt(role)
  const { task, board, members, thread, run, triggerMessage } = context
  const column = board.columns.find((c) => c.id === task.columnId)
  const lines = []

  lines.push(rolePrompt.trim())
  lines.push("")
  lines.push("---")
  lines.push(`Board: ${board.name}`)
  lines.push(`Columns: ${board.columns.map((c) => `${c.title} [${c.role}]`).join(" → ")}`)
  lines.push(`Repository: ${board.repoPath ?? PROJECT_ROOT}`)
  lines.push("Participants:")
  for (const member of members) lines.push(memberLine(member))
  lines.push("")
  lines.push(`Task #${task.id}: ${task.title}`)
  lines.push(`Column: ${column?.title ?? task.columnId} · Priority: ${task.priority}`)
  lines.push("Description:")
  lines.push(task.description || "(empty)")
  lines.push("")
  lines.push("Task chat so far:")
  lines.push(formatThread(thread, members))
  lines.push("")

  if (run.trigger.startsWith("mention:") && triggerMessage) {
    const byId = new Map(members.map((m) => [m.id, m]))
    const author = byId.get(triggerMessage.authorId)
    lines.push(`You were mentioned by @${author?.handle ?? triggerMessage.authorId}. Respond to that message.`)
  } else if (run.trigger === "column:in_progress") {
    if (role === "architect") {
      lines.push(
        "The task was moved to In progress and you are tagged on it. Do your part: make the task unambiguous — scope, files, acceptance criteria — and post it here. If implementation is needed, end by mentioning @coder with clear instructions; if the task is really a question for Max, ask @max instead."
      )
    } else {
      lines.push("The task was moved to In progress. Implement it now, as described above and in the chat.")
    }
  } else if (run.trigger === "column:review") {
    lines.push(
      "The task was moved to Review. Review the Coder's changes in the repository (git log / git diff, the files themselves) and give your verdict."
    )
  } else {
    lines.push(`Trigger: ${run.trigger}`)
  }
  lines.push("")
  lines.push("Write your reply for the task chat now.")
  return lines.join("\n")
}

/**
 * Split a model reply into the chat text and board actions.
 * The protocol: an optional last line `ACTIONS: {"move": "review"}`.
 */
export function parseReply(raw) {
  const text = (raw ?? "").trim()
  const lines = text.split("\n")
  const actions = []
  let cut = lines.length
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 3); i -= 1) {
    const line = lines[i].trim()
    const match = line.match(/^ACTIONS:\s*(\{.*\})\s*$/)
    if (!match) continue
    try {
      const parsed = JSON.parse(match[1])
      if (typeof parsed.move === "string" && MOVE_TARGETS.has(parsed.move)) {
        actions.push({ type: "move", to: parsed.move })
      }
    } catch {
      // malformed actions line — ignore it, keep the text
    }
    cut = i
    break
  }
  const reply = lines.slice(0, cut).join("\n").trim()
  return { reply, actions }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function firstName(member) {
  return (member?.name ?? "Agent").replace(/\s*\(.*\)\s*$/, "")
}
