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

  // `claude -p --output-format json` prints one JSON object; on failures the
  // human-readable reason sits in `result` (e.g. an expired login).
  let parsed = null
  try {
    parsed = JSON.parse(stdout.trim())
  } catch {
    parsed = null
  }
  if (parsed && parsed.is_error) {
    const reason = typeof parsed.result === "string" ? parsed.result : "unknown error"
    const hint = /authenticat|oauth|log ?in/i.test(reason) ? " — run `claude` in a terminal and use /login, then restart the worker" : ""
    throw new Error(`Claude Code: ${reason}${hint}`)
  }
  if (code !== 0) {
    throw new Error(`claude exited with ${code}: ${(stderr || stdout).trim().slice(-600)}`)
  }
  const text = parsed && typeof parsed.result === "string" ? parsed.result : stdout.trim()
  const { reply, actions } = parseReply(text)
  return { reply, actions, summary: reply.slice(0, 300) }
}
