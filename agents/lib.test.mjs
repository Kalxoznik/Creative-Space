// `node --test agents/` (or `npm test`). Guards the shapes of a dispatch reply that the
// Architect actually produces — the parser tolerates them on purpose, and a future edit to
// braceAfter / findPayloads would otherwise break them silently.

import test from "node:test"
import assert from "node:assert/strict"
import { parseReply, plainLine } from "./lib.mjs"

const dispatch = { trigger: "dispatch" }

test("the canonical ACTIONS line on a dispatch run", () => {
  const { reply, decision, problem } = parseReply(
    `Putting the parser fix first.\n\nACTIONS: {"assign": {"t_1": "coder", "t_2": "coder_fast"}, "order": ["t_1", "t_2"], "blocked_by": {"t_2": ["t_1"]}}`,
    dispatch
  )
  assert.equal(problem, null)
  assert.deepEqual(decision, { assign: { t_1: "coder", t_2: "coder_fast" }, order: ["t_1", "t_2"], blockedBy: { t_2: ["t_1"] } })
  assert.equal(reply, "Putting the parser fix first.")
  assert.ok(!reply.includes("ACTIONS"))
})

test("pretty-printed JSON on the lines after the marker", () => {
  const { reply, decision, problem } = parseReply(
    ["The queue decision.", "", "ACTIONS:", "```json", "{", '  "assign": { "t_1": "coder" },', '  "order": ["t_1"]', "}", "```"].join("\n"),
    dispatch
  )
  assert.equal(problem, null)
  assert.deepEqual(decision, { assign: { t_1: "coder" }, order: ["t_1"], blockedBy: {} })
  assert.equal(reply, "The queue decision.")
})

test("markdown emphasis around the marker", () => {
  const { decision, problem } = parseReply(`Done.\n\n**ACTIONS:** {"assign": {"t_1": "coder"}, "order": ["t_1"]}`, dispatch)
  assert.equal(problem, null)
  assert.deepEqual(decision.assign, { t_1: "coder" })
})

test("#ids and @handles as the prompt shows them", () => {
  const { decision } = parseReply(`ACTIONS: {"assign": {"#t_1": "@Coder"}, "order": ["#t_1"], "blocked_by": {"#t_2": "#t_1"}}`, dispatch)
  assert.deepEqual(decision, { assign: { t_1: "coder" }, order: ["t_1"], blockedBy: { t_2: ["t_1"] } })
})

test("a wrapper key, and the real line below a quoted example", () => {
  const raw = [
    "The format is: `ACTIONS: {\"assign\": {\"t_x\": \"coder\"}}` — an example, not a decision.",
    "",
    'ACTIONS: {"dispatch": {"assignments": {"t_9": "coder_fast"}, "sequence": ["t_9"]}}',
  ].join("\n")
  const { reply, decision, problem } = parseReply(raw, dispatch)
  assert.equal(problem, null)
  assert.deepEqual(decision, { assign: { t_9: "coder_fast" }, order: ["t_9"], blockedBy: {} })
  assert.ok(reply.startsWith("The format is:"))
})

test("an unparseable ACTIONS object says why", () => {
  const { decision, problem } = parseReply(`ACTIONS: {"assign": {"t_1": "coder"`, dispatch)
  assert.equal(decision, null)
  assert.match(problem, /never closes/)
})

test("a wrapped payload with nothing usable names the inner keys", () => {
  const { problem } = parseReply(`ACTIONS: {"dispatch": {"notes": "let me think"}}`, dispatch)
  assert.match(problem, /keys: dispatch/) // no action inside → no unwrap, and that is what is reported
  const second = parseReply(`ACTIONS: {"dispatch": {"move": "donee", "notes": "x"}}`, dispatch)
  assert.match(second.problem, /"donee"/)
})

test("a reply that merely ends with JSON does nothing and is no problem", () => {
  const raw = ["Here is what the config holds:", "", "```json", '{"move": "review", "create": [{"title": "x"}]}', "```"].join("\n")
  for (const options of [{ trigger: "column:in_progress" }, dispatch]) {
    const { reply, actions, decision, problem } = parseReply(raw, options)
    assert.deepEqual(actions, [], `actions for ${options.trigger}`)
    assert.equal(decision, null)
    assert.equal(problem, null)
    assert.equal(reply, raw)
  }
})

test("a dropped marker still dispatches, but only on a dispatch run", () => {
  const raw = `Here is the order.\n\n{"assign": {"t_1": "coder"}, "order": ["t_1"]}`
  const dispatched = parseReply(raw, dispatch)
  assert.deepEqual(dispatched.decision, { assign: { t_1: "coder" }, order: ["t_1"], blockedBy: {} })
  assert.equal(dispatched.reply, "Here is the order.")
  const elsewhere = parseReply(raw, { trigger: "review" })
  assert.equal(elsewhere.decision, null)
  assert.equal(elsewhere.reply, raw)
})

test("a coder asks for the owner", () => {
  const { reply, actions, problem } = parseReply(
    `Stopped: this needs a paid model call.\n\nACTIONS: {"needs": "owner", "reason": "paid_call", "text": "Run 200 model requests — that costs money"}`
  )
  assert.equal(problem, null)
  assert.deepEqual(actions, [
    { type: "needs_owner", reason: "paid_call", text: "Run 200 model requests — that costs money" },
  ])
  assert.equal(reply, "Stopped: this needs a paid model call.")
})

test("needs: the reason and the text nested inside it, and an unknown reason is a question", () => {
  const nested = parseReply(`Waiting.\n\nACTIONS: {"needs": {"reason": "deploy", "text": "Publish to prod?"}}`)
  assert.equal(nested.problem, null)
  assert.deepEqual(nested.actions, [{ type: "needs_owner", reason: "deploy", text: "Publish to prod?" }])

  const unknown = parseReply(`ACTIONS: {"needs": "owner", "reason": "budget", "text": "Two schema options"}`)
  assert.deepEqual(unknown.actions, [{ type: "needs_owner", reason: "question", text: "Two schema options" }])

  const bare = parseReply(`ACTIONS: {"needs": "owner"}`)
  assert.deepEqual(bare.actions, [{ type: "needs_owner", reason: "question", text: "" }])
})

test("needs something other than the owner says so and does nothing", () => {
  const { actions, problem } = parseReply(`ACTIONS: {"needs": "architect", "text": "take a look"}`)
  assert.deepEqual(actions, [])
  assert.match(problem, /only thing a card can need/)
})

test("needs and move in one line: both are parsed, needs first", () => {
  // The worker drops the move — the card waiting for the owner must not move.
  const { actions } = parseReply(`ACTIONS: {"move": "review", "needs": "owner", "reason": "deploy", "text": "Deploy?"}`)
  assert.deepEqual(actions, [
    { type: "needs_owner", reason: "deploy", text: "Deploy?" },
    { type: "move", to: "review" },
  ])
})

test("commit: the coder's subject travels with the move", () => {
  const { actions, problem } = parseReply(`Done.\n\nACTIONS: {"move": "review", "commit": "  Collapse long task\\ndescriptions  "}`)
  assert.equal(problem, null)
  assert.deepEqual(actions, [
    { type: "move", to: "review" },
    { type: "commit", subject: "Collapse long task descriptions" },
  ])
})

test("commit: an empty or over-long subject is refused, the move still goes through", () => {
  for (const commit of ["", "   ", "x".repeat(73), 42]) {
    const { actions, problem } = parseReply(`ACTIONS: ${JSON.stringify({ move: "review", commit })}`)
    assert.deepEqual(actions, [{ type: "move", to: "review" }])
    assert.match(problem, /"commit" must be/)
  }
  const exact = parseReply(`ACTIONS: ${JSON.stringify({ move: "review", commit: "x".repeat(72) })}`)
  assert.deepEqual(exact.actions[1], { type: "commit", subject: "x".repeat(72) })
})

test("the Architect closes a card only in the run the owner's own message started", () => {
  const raw = `Closing.\n\nACTIONS: {"move": "done"}`
  const asked = parseReply(raw, { trigger: "owner:42", role: "architect" })
  assert.equal(asked.problem, null)
  assert.deepEqual(asked.actions, [{ type: "move", to: "done" }])

  const onItsOwn = parseReply(raw, { trigger: "review", role: "architect" })
  assert.deepEqual(onItsOwn.actions, [])
  assert.match(onItsOwn.problem, /closed by the owner/)
  // Like any payload the board cannot use, the refused line stays in the reply and the worker
  // logs why nothing happened.
  assert.equal(onItsOwn.reply, raw)

  // Everybody else is unchanged: a coder's move to Done is the board's business, not the parser's.
  const coder = parseReply(raw, { trigger: "column:in_progress", role: "coder" })
  assert.deepEqual(coder.actions, [{ type: "move", to: "done" }])
})

test("a coder reply: move and create still work", () => {
  const { reply, actions, problem } = parseReply(
    `Done.\n\nACTIONS: {"move": "review", "create": [{"title": "Move the parser into tests", "assignee": "@coder"}]}`
  )
  assert.equal(problem, null)
  assert.deepEqual(actions, [
    { type: "create", cards: [{ title: "Move the parser into tests", assignee: "coder" }] },
    { type: "move", to: "review" },
  ])
  assert.equal(reply, "Done.")
})

// --- the owner's line --------------------------------------------------------

test("the `In short:` line is what the owner is told, and nothing else of the reply is", () => {
  const { reply, actions, plain } = parseReply(
    "Rewrote the reply parser and ran the check.\nFiles: agents/lib.mjs, src/server/feed.ts.\n\n" +
      "In short: Notifications now say what was done.\n\n" +
      `ACTIONS: {"move": "review"}`
  )
  assert.deepEqual(actions, [{ type: "move", to: "review" }])
  assert.equal(plain, "Notifications now say what was done.")
  // The line stays in the chat too — it is a sentence the agent wrote, not a hidden field.
  assert.ok(reply.includes("In short:"))
  // Nothing but that line is ever read for it: the paths in the reply stay in the reply.
  assert.ok(!plain.includes("agents/lib.mjs"))
})

test("no `In short:` line is the normal case: null, not an empty string", () => {
  assert.equal(parseReply("Fixed a typo in the label.").plain, null)
  assert.equal(plainLine("In short:"), null)
  assert.equal(plainLine(null), null)
})

test("the line is found through markdown, a bullet and the other wordings", () => {
  assert.equal(plainLine("- **In short:** Done, the card waits for review."), "Done, the card waits for review.")
  assert.equal(plainLine("Briefly: the card is ready for review."), "the card is ready for review.")
  // An agent that quotes the rule before following it: the last such line wins.
  assert.equal(plainLine("In short: an example\nMore work\nIn short: Rewrote the notifications."), "Rewrote the notifications.")
})

// Non-Latin input on purpose: an agent writing for a Russian-speaking owner translates the marker
// too, and the line must still be found.
test("the Russian marker is recognised as well", () => {
  assert.equal(plainLine("- **Коротко:** Готово, карточка ждёт ревью."), "Готово, карточка ждёт ревью.")
  assert.equal(plainLine("коротко: строчными"), "строчными")
})

test("the line is cut to 300 characters, and comes out as one line of plain words", () => {
  const long = plainLine(`In short: ${"x".repeat(400)}`)
  assert.equal(long.length, 300)
  assert.ok(long.endsWith("…"))
  assert.equal(plainLine("In short:  word   `and`   more\t"), "word and more")
})
