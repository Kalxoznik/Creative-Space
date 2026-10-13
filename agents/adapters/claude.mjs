// Claude Code adapter — headless `claude -p`.
//   architect: may read the repository (Read/Grep/Glob, read-only git), not edit it.
//   coder:     may edit files and run git/npm/node — edits are auto-accepted.
// The agent's configuration (Agents in the sidebar) sets the model, the effort level
// (`--effort low|medium|high|max`) and the turn limit.
//
// Requires Claude Code installed and logged in on this machine:
//   https://docs.claude.com/en/docs/claude-code
// Override the binary with CS_CLAUDE_BIN.

import { runCommand } from "./process.mjs"
import { buildPrompt, parseReply, PROJECT_ROOT } from "../lib.mjs"

/** One line out of whatever the CLI put in an error slot — a string, or `{ message }`. */
function oneLine(value) {
  if (typeof value === "string") return value.trim()
  if (value && typeof value === "object") {
    for (const key of ["message", "error", "text"]) {
      if (typeof value[key] === "string") return value[key].trim()
    }
  }
  return ""
}

/**
 * Why a `claude -p --output-format json` run is an error, in words — plus whether the turn
 * limit is what stopped it.
 *
 * Only a *friendly* failure (an expired login) writes its reason into `result`; a run that ran
 * out of turns writes none at all — `subtype: "error_max_turns"` with
 * `errors: ["Reached maximum number of turns (80)"]` is everything there is. Reading `result`
 * alone is how two coder runs reported "unknown error" for a limit they simply hit.
 *
 * `plain` is the owner's `In short:` line for a failure the agent never got to write one for;
 * `maxTurns` tells the worker the work is unfinished but on disk, not lost.
 */
export function claudeFailure(parsed, limit = null) {
  const subtype = typeof parsed?.subtype === "string" ? parsed.subtype : ""
  if (subtype === "error_max_turns") {
    const turns = Number(parsed?.num_turns) || Number(limit) || null
    const said = `Hit the turn limit${turns ? ` (${turns})` : ""}. The work is left in the working tree.`
    return { reason: said, plain: said, maxTurns: true }
  }
  const errors = Array.isArray(parsed?.errors) ? parsed.errors.map(oneLine).filter(Boolean) : []
  const reason =
    oneLine(parsed?.result) ||
    errors.join("; ") ||
    // `error_during_execution` → "during execution": still thin, but it is what the CLI knows.
    subtype.replace(/^error_/, "").replaceAll("_", " ").trim() ||
    "unknown error"
  return { reason, plain: null, maxTurns: false }
}

export async function runClaude(role, context, { log, timeoutMs, signal }) {
  const prompt = await buildPrompt(role, context)
  const cwd = context.board.repoPath ?? PROJECT_ROOT
  const bin = process.env.CS_CLAUDE_BIN ?? "claude"
  const config = context.agent?.agent ?? {}
  const model = config.model || process.env.CS_CLAUDE_MODEL
  const maxTurns = String(config.maxTurns ?? process.env.CS_CLAUDE_MAX_TURNS ?? (role === "coder" ? 80 : 20))
  const args = ["-p", "--output-format", "json"]
  if (role === "coder") {
    args.push(
      "--permission-mode",
      "acceptEdits",
      "--allowedTools",
      "Read,Edit,Write,MultiEdit,Grep,Glob,Bash(git:*),Bash(npm:*),Bash(npx:*),Bash(node:*),Bash(ls:*),Bash(cat:*)",
      "--max-turns",
      maxTurns
    )
  } else {
    args.push(
      "--allowedTools",
      "Read,Grep,Glob,Bash(git log:*),Bash(git diff:*),Bash(git show:*),Bash(git status:*)",
      "--max-turns",
      maxTurns
    )
  }
  if (model) args.push("--model", model)
  // Same names on both sides: low / medium / high / max.
  if (config.effort) args.push("--effort", config.effort)

  await log(`$ ${bin} ${args.join(" ")}\n(cwd: ${cwd})\n`)
  const { stdout, stderr, code } = await runCommand(bin, args, { cwd, stdin: prompt, log, timeoutMs, signal })
  if (signal?.aborted) throw new Error("stopped")

  // `claude -p --output-format json` prints one JSON object; why a run failed is spread over
  // `result`, `errors` and `subtype` — see claudeFailure.
  let parsed = null
  try {
    parsed = JSON.parse(stdout.trim())
  } catch {
    parsed = null
  }
  if (parsed && parsed.is_error) {
    const { reason, plain, maxTurns: atTurnLimit } = claudeFailure(parsed, maxTurns)
    const hint = /authenticat|oauth|log ?in/i.test(reason) ? " — run `claude` in a terminal and use /login, then restart the worker" : ""
    const error = new Error(`Claude Code: ${reason}${hint}`)
    // The worker reads both: `plain` is what the owner is told, `maxTurns` whether this run is
    // worth continuing from the working tree instead of only reporting it.
    if (plain) error.plain = plain
    if (atTurnLimit) error.maxTurns = true
    throw error
  }
  if (code !== 0) {
    throw new Error(`claude exited with ${code}: ${(stderr || stdout).trim().slice(-600)}`)
  }
  const text = parsed && typeof parsed.result === "string" ? parsed.result : stdout.trim()
  const { reply, actions, decision, problem, plain } = parseReply(text, { trigger: context.run?.trigger, role })
  return { reply, actions, decision, problem, plain, raw: text, summary: reply.slice(0, 300) }
}
