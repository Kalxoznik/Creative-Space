// Stub adapter: exercises the whole loop (claim → log → reply → actions)
// without calling any model. Used with CS_AGENT_MODE=stub (the default).

import { sleep } from "../lib.mjs"

// Quote without live @mentions — an echoed mention would wake the other agent
// and the two stubs would ping-pong until the chain guard stops them.
function quote(text, max = 140) {
  const t = (text ?? "").replace(/\s+/g, " ").replace(/@(\w+)/g, "$1").trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

export async function runStub(role, context, { log, signal }) {
  const { task, run, triggerMessage, thread, members } = context
  const byId = new Map(members.map((m) => [m.id, m]))
  const human = members.find((m) => m.kind === "human")
  const handle = human ? `@${human.handle}` : "@owner"

  await log(`[stub ${role}] trigger=${run.trigger} task=${task.id}\n`)
  await sleep(1500, signal)
  await log(`[stub ${role}] reading ${thread.length} message(s) in the thread\n`)
  await sleep(1500, signal)

  if (role === "architect") {
    if (run.trigger === "dispatch") {
      // Round-robin over the board's coders; the second card waits for the first, so the
      // whole conveyor (assign → blocked → start) can be watched without a model.
      const coders = members.filter((m) => m.kind === "agent" && m.agentRole === "coder")
      const ready = context.queue?.ready ?? []
      const assign = {}
      const blockedBy = {}
      ready.forEach((card, index) => {
        if (coders.length > 0) assign[card.id] = coders[index % coders.length].handle
        if (index === 1) blockedBy[card.id] = [ready[0].id]
      })
      await log(`[stub architect] dispatching ${ready.length} Ready card(s) over ${coders.length} coder(s)\n`)
      return {
        reply: `[stub] Sorted the queue: ${ready.length} card(s) over ${coders.length} coder(s), in the order they are. In live mode I would read each card and pick the coder that fits it.`,
        actions: [],
        decision: { assign, order: ready.map((c) => c.id), blockedBy },
        summary: `Stub dispatch: ${ready.length} card(s).`,
      }
    }
    if (run.trigger === "column:review") {
      await log("[stub architect] pretending to run git diff\n")
      return {
        reply: `[stub] Review of «${task.title}»: in live mode I would read the diff here and list what is done and what is missing. ${handle} — move it to Done when you're happy, or send it back with a comment.`,
        actions: [],
        summary: "Stub review posted.",
      }
    }
    const asked = triggerMessage ? quote(triggerMessage.text) : ""
    const author = triggerMessage ? byId.get(triggerMessage.authorId) : null
    // Only humans get an @-reply; @-ing another agent would wake it again.
    const addressee = author ? (author.kind === "human" ? `@${author.handle}` : author.name) : handle
    return {
      reply: `[stub] ${addressee}, got it${asked ? `: «${asked}»` : ""}. In live mode I'd answer with a real plan for «${task.title}» — scope, files, acceptance criteria — and move it to Ready when it's clear enough for the coder.`,
      actions: [],
      summary: "Stub architect reply posted.",
    }
  }

  // coder
  if (run.trigger.startsWith("check:")) {
    await log("[stub coder] pretending to fix what the check complained about\n")
    await sleep(1500, signal)
    return {
      reply: "[stub] Fixed the check failure (in live mode: read the output, fix, re-run the check, commit). Moving to Review again.",
      actions: [{ type: "move", to: "review" }],
      summary: "Stub fix after a failed check — no code was changed.",
    }
  }
  if (run.trigger === "column:in_progress") {
    await log("[stub coder] pretending to implement the task\n")
    await sleep(process.env.CS_STUB_WORK_MS ? Number(process.env.CS_STUB_WORK_MS) : 2000, signal)
    await log("[stub coder] pretending to commit\n")
    return {
      reply: `[stub] Would implement «${task.title}» here: read the code, make the change, verify, commit. Moving to Review so the loop can be checked.`,
      actions: [{ type: "move", to: "review" }],
      summary: "Stub implementation — no code was changed.",
    }
  }
  const asked = triggerMessage ? quote(triggerMessage.text) : ""
  return {
    reply: `[stub] Noted${asked ? `: «${asked}»` : ""}. In live mode I'd act on this in the repository and report back here.`,
    actions: [],
    summary: "Stub coder reply posted.",
  }
}
