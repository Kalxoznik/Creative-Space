// Claude Code adapter — headless `claude -p`.
//   architect: may read the repository (Read/Grep/Glob, read-only git), not edit it.
//   coder:     may edit files and run git/npm/node — edits are auto-accepted.
//
// Requires Claude Code installed and logged in on this machine:
//   https://docs.claude.com/en/docs/claude-code
// Override the binary with CS_CLAUDE_BIN.

import { runCommand } from "./process.mjs"
import { buildPrompt, parseReply, PROJECT_ROOT } from "../lib.mjs"

export async function runClaude(role, context, { log, timeoutMs }) {
  const prompt = await buildPrompt(role, context)
  const cwd = context.board.repoPath ?? PROJECT_ROOT
  const bin = process.env.CS_CLAUDE_BIN ?? "claude"
  const model = process.env.CS_CLAUDE_MODEL
  const args = ["-p", "--output-format", "json"]
  if (role === "coder") {
    args.push(
      "--permission-mode",
      "acceptEdits",
      "--allowedTools",
      "Read,Edit,Write,MultiEdit,Grep,Glob,Bash(git:*),Bash(npm:*),Bash(npx:*),Bash(node:*),Bash(ls:*),Bash(cat:*)",
      "--max-turns",
      process.env.CS_CLAUDE_MAX_TURNS ?? "80"
    )
  } else {
    args.push(
      "--allowedTools",
      "Read,Grep,Glob,Bash(git log:*),Bash(git diff:*),Bash(git show:*),Bash(git status:*)",
      "--max-turns",
      process.env.CS_CLAUDE_MAX_TURNS ?? "20"
    )
  }
  if (model) args.push("--model", model)

  await log(`$ ${bin} ${args.join(" ")}\n(cwd: ${cwd})\n`)
  const { stdout, stderr, code } = await runCommand(bin, args, { cwd, stdin: prompt, log, timeoutMs })
  if (code !== 0) {
    throw new Error(`claude exited with ${code}: ${stderr.slice(-800) || stdout.slice(-800)}`)
  }

  let text = stdout.trim()
  try {
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed.result === "string") text = parsed.result
    if (parsed && parsed.is_error) throw new Error(`claude reported an error: ${text.slice(0, 500)}`)
  } catch (error) {
    if (error instanceof SyntaxError) {
      // Not JSON — treat stdout as the reply.
    } else {
      throw error
    }
  }
  const { reply, actions } = parseReply(text)
  return { reply, actions, summary: reply.slice(0, 300) }
}
