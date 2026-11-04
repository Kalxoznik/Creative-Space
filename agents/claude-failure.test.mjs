// Why a `claude -p --output-format json` run failed, read out of the envelope the CLI prints
// (`claudeFailure` in agents/adapters/claude.mjs). The rule under test: the reason is never
// "unknown error" when the JSON says anything at all — a run that ran out of turns writes
// nothing into `result` and used to be reported as a mystery.

import test from "node:test"
import assert from "node:assert/strict"
import { claudeFailure } from "./adapters/claude.mjs"
import { codexFailure } from "./adapters/codex.mjs"

test("the turn limit is named, with the number of turns and where the work is", () => {
  const { reason, plain, maxTurns } = claudeFailure(
    {
      type: "result",
      subtype: "error_max_turns",
      is_error: true,
      num_turns: 80,
      errors: ["Reached maximum number of turns (80)"],
    },
    "80"
  )
  assert.equal(maxTurns, true)
  assert.match(reason, /turn limit \(80\)/)
  assert.match(reason, /working tree/)
  assert.doesNotMatch(reason, /unknown/)
  // The owner's `In short:` line for a run that never got far enough to write one itself.
  assert.match(plain, /turn limit \(80\)/)
})

test("the limit from the agent's configuration stands in when the envelope has no count", () => {
  const { reason } = claudeFailure({ subtype: "error_max_turns", is_error: true }, "40")
  assert.match(reason, /turn limit \(40\)/)
})

test("a friendly failure still reads out of result", () => {
  const { reason, maxTurns, plain } = claudeFailure({
    is_error: true,
    subtype: "error",
    result: "Invalid API key · Please run /login",
  })
  assert.equal(reason, "Invalid API key · Please run /login")
  assert.equal(maxTurns, false)
  assert.equal(plain, null)
})

test("with no result, errors[] is the reason — strings or { message }", () => {
  assert.equal(
    claudeFailure({ is_error: true, errors: ["Reached the context window", { message: "and gave up" }] }).reason,
    "Reached the context window; and gave up"
  )
})

test("with nothing but a subtype, the subtype is the reason", () => {
  assert.equal(claudeFailure({ is_error: true, subtype: "error_during_execution" }).reason, "during execution")
})

test("an envelope that says nothing is the only 'unknown error' left", () => {
  assert.equal(claudeFailure({ is_error: true }).reason, "unknown error")
})

// A model the CLI turns down fails the run by name — never a quiet retry on the default model.
test("a model Claude Code rejects is named, with the engine and where to fix it", () => {
  const failure = claudeFailure(
    {
      is_error: true,
      subtype: "success",
      result:
        "There's an issue with the selected model (claude-nonsense). It may not exist or you may not have access to it. Run --model to pick a different model.",
    },
    "80",
    "claude-nonsense"
  )
  assert.equal(failure.modelRejected, true)
  assert.equal(failure.reason, "Claude Code rejected model claude-nonsense — pick another on the Agents page")
  assert.equal(failure.plain, failure.reason)
  // The same words as an API error out of errors[].
  assert.equal(
    claudeFailure(
      { is_error: true, errors: ['API Error: 404 {"type":"error","error":{"type":"not_found_error","message":"model: x"}}'] },
      null,
      "x"
    ).reason,
    "Claude Code rejected model x — pick another on the Agents page"
  )
  // Without a model of the agent's own there is nothing to name: the CLI's words stand.
  assert.equal(claudeFailure({ is_error: true, result: "There's an issue with the selected model" }).modelRejected, undefined)
})

test("a model Codex rejects is named the same way; any other failure keeps codex's own words", () => {
  const rejected = codexFailure(
    1,
    "ERROR: unexpected status 400 Bad Request: {\"detail\":\"The 'gpt-nope' model is not supported when using Codex with a ChatGPT account.\"}",
    "",
    "gpt-nope"
  )
  assert.equal(rejected.message, "Codex rejected model gpt-nope — pick another on the Agents page")
  assert.equal(rejected.plain, rejected.message)
  const other = codexFailure(2, "error: not logged in", "", "gpt-6.1-sol")
  assert.equal(other.message, "codex exited with 2: error: not logged in")
  assert.equal(other.plain, undefined)
  assert.equal(codexFailure(1, "", "", null).message, "codex exited with 1 without saying why")
})

test("a rejected model quoted in the agent's own activity is not codex's error", () => {
  // The agent read a test that quotes a rejection, then the run died on a usage limit.
  const quoted = "ERROR: unexpected status 400 Bad Request: {\"detail\":\"The 'gpt-nope' model is not supported.\"}"
  const activity = `exec\nsed -n '85,100p' agents/claude-failure.test.mjs\n    "${quoted}",\n${quoted}\n`
  const failure = codexFailure(1, `${activity}ERROR: You've hit your usage limit. Try again later.`, "", "gpt-6.1-sol")
  assert.match(failure.message, /^codex exited with 1: .*usage limit/s)
  assert.equal(failure.plain, undefined)
})
