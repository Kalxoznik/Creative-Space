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
  if (member.kind !== "agent") return `- @${member.handle} — ${member.name} (human)`
  const config = member.agent ?? {}
  const about = [config.description, config.engine, config.model, config.effort && `effort ${config.effort}`]
    .filter(Boolean)
    .join("; ")
  return `- @${member.handle} — ${member.name} (agent, ${member.agentRole}${about ? `: ${about}` : ""})`
}

function queueLine(card) {
  const bits = [`priority ${card.priority}`]
  if (card.assignees.length > 0) bits.push(`tagged ${card.assignees.map((h) => `@${h}`).join(" ")}`)
  else bits.push("untagged")
  if (card.blockedBy.length > 0) bits.push(`waits for ${card.blockedBy.join(", ")}`)
  const description = (card.description || "").replace(/\s+/g, " ").trim()
  return `- ${card.id} “${card.title}” (${bits.join(", ")})${description ? `\n    ${description}` : ""}`
}

/** Pasted images are stored as /api/uploads/<name>; the model needs a file it can open. */
function withImagePaths(text) {
  const dir = process.env.CS_UPLOADS_DIR ?? path.join(PROJECT_ROOT, "uploads")
  return text.replace(/!\[([^\]]*)\]\(\/api\/uploads\/([a-z0-9]+\.(?:png|jpg|gif|webp))\)/g, (_match, alt, name) =>
    `[${alt || "image"}: ${path.join(dir, name)}]`
  )
}

function formatThread(thread, members, limit = 40) {
  const byId = new Map(members.map((m) => [m.id, m]))
  const recent = thread.slice(-limit)
  if (recent.length === 0) return "(no messages yet)"
  return recent
    .map((message) => {
      const author = byId.get(message.authorId)
      const who = message.kind === "system" ? "system" : `@${author?.handle ?? message.authorId}`
      return `[${message.createdAt.slice(0, 16).replace("T", " ")}] ${who}: ${withImagePaths(message.text)}`
    })
    .join("\n")
}

/** Everything the model gets: role rules + the agent's own instructions + board situation + the trigger. */
export async function buildPrompt(role, context) {
  const { task, board, members, thread, run, triggerMessage, agent, queue } = context
  const owner = members.find((m) => m.isOwner) ?? members.find((m) => m.kind === "human") ?? { name: "the owner", handle: "owner" }
  const fill = (text) =>
    text
      .replaceAll("{{owner}}", owner.name || "the owner")
      .replaceAll("{{ownerHandle}}", owner.handle)
      .replaceAll("{{agent}}", agent?.name ?? role)
      .replaceAll("{{agentHandle}}", agent?.handle ?? role)
  const rolePrompt = fill(await loadRolePrompt(role))
  const column = board.columns.find((c) => c.id === task.columnId)
  const lines = []

  lines.push(rolePrompt.trim())
  const instructions = (agent?.agent?.instructions ?? "").trim()
  if (instructions) {
    lines.push("")
    lines.push(`Additional instructions from ${owner.name || "the owner"} for you specifically:`)
    lines.push(instructions)
  }
  if (run.trigger === "dispatch") {
    lines.push("")
    lines.push(fill(await loadRolePrompt("dispatch")).trim())
  }
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
  lines.push(withImagePaths(task.description || "(empty)"))
  lines.push("")
  lines.push("Task chat so far:")
  lines.push(formatThread(thread, members))
  lines.push("")

  if (run.trigger === "dispatch" && queue) {
    lines.push("Ready — the queue, top first:")
    lines.push(queue.ready.length > 0 ? queue.ready.map(queueLine).join("\n") : "(empty)")
    lines.push("")
    lines.push("In progress right now:")
    lines.push(queue.inProgress.length > 0 ? queue.inProgress.map(queueLine).join("\n") : "(nothing)")
    lines.push("")
    lines.push(
      `Task #${task.id} above is the card that just entered Ready. Dispatch the whole Ready queue now: for every Ready card decide which coder takes it, put the cards in the order they should be done, and mark which cards must wait for which. Then write the reply for this card's chat.`
    )
  } else if (run.trigger.startsWith("mention:") && triggerMessage) {
    const byId = new Map(members.map((m) => [m.id, m]))
    const author = byId.get(triggerMessage.authorId)
    lines.push(`You were mentioned by @${author?.handle ?? triggerMessage.authorId}. Respond to that message.`)
  } else if (run.trigger === "column:in_progress") {
    if (role === "architect") {
      lines.push(
        `The task was moved to In progress and you are tagged on it. Do your part: make the task unambiguous — scope, files, acceptance criteria — and post it here. If implementation is needed, end by mentioning @coder with clear instructions; if the task is really a question for the owner, ask @${owner.handle} instead.`
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
 * Split a model reply into the chat text, board actions and (for dispatch runs) the
 * queue decision. The protocol: an optional last line
 *   `ACTIONS: {"move": "review"}`
 *   `ACTIONS: {"assign": {"t_1": "coder"}, "order": ["t_1", "t_2"], "blocked_by": {"t_2": ["t_1"]}}`
 * Trailing blank lines and code fences around the line are tolerated.
 */
export function parseReply(raw) {
  const text = (raw ?? "").trim()
  const lines = text.split("\n")
  const actions = []
  let decision = null
  let cut = lines.length
  let looked = 0
  for (let i = lines.length - 1; i >= 0 && looked < 5; i -= 1) {
    const line = lines[i].trim()
    if (!line || /^`{3,}/.test(line)) continue
    looked += 1
    const match = line.match(/^ACTIONS:\s*(\{.*\})\s*$/)
    if (!match) continue
    try {
      const parsed = JSON.parse(match[1])
      if (typeof parsed.move === "string" && MOVE_TARGETS.has(parsed.move)) {
        actions.push({ type: "move", to: parsed.move })
      }
      if (parsed.assign || parsed.order || parsed.blocked_by || parsed.blockedBy) {
        decision = {
          assign: parsed.assign && typeof parsed.assign === "object" ? parsed.assign : {},
          order: Array.isArray(parsed.order) ? parsed.order : [],
          blockedBy: (parsed.blocked_by ?? parsed.blockedBy) && typeof (parsed.blocked_by ?? parsed.blockedBy) === "object" ? (parsed.blocked_by ?? parsed.blockedBy) : {},
        }
      }
    } catch {
      // malformed actions line — ignore it, keep the text
    }
    cut = i
    break
  }
  // Drop a code fence that only wrapped the ACTIONS line.
  let reply = lines.slice(0, cut).join("\n").trim()
  if (cut < lines.length && /^`{3,}\w*$/.test(reply.split("\n").pop() ?? "")) {
    reply = reply.split("\n").slice(0, -1).join("\n").trim()
  }
  return { reply, actions, decision }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function firstName(member) {
  return (member?.name ?? "Agent").replace(/\s*\(.*\)\s*$/, "")
}
