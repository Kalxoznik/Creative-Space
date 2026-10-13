// Why a `claude -p --output-format json` run failed, read out of the envelope the CLI prints
// (`claudeFailure` in agents/adapters/claude.mjs). The rule under test: the reason is never
// "unknown error" when the JSON says anything at all — a run that ran out of turns writes
// nothing into `result` and used to be reported as a mystery.

import test from "node:test"
import assert from "node:assert/strict"
import { claudeFailure } from "./adapters/claude.mjs"

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
