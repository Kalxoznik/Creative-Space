// Codex CLI adapter — non-interactive `codex exec`. Used for the Coder: it may
// edit files and commit inside the repository (workspace-write sandbox).
// The agent's configuration sets the model (`-m`) and the effort level, passed as
// `-c model_reasoning_effort=…` (Creative Space "max" = Codex "xhigh").
//
// Requires Codex CLI installed and logged in on this machine:
//   npm i -g @openai/codex   →   codex login
// Override the binary with CS_CODEX_BIN.

import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { runCommand } from "./process.mjs"
import { buildPrompt, parseReply, PROJECT_ROOT } from "../lib.mjs"

const CODEX_EFFORT = { low: "low", medium: "medium", high: "high", max: "xhigh" }

export async function runCodex(role, context, { log, timeoutMs }) {
  const prompt = await buildPrompt(role, context)
  const cwd = context.board.repoPath ?? PROJECT_ROOT
  const bin = process.env.CS_CODEX_BIN ?? "codex"
  const config = context.agent?.agent ?? {}
  const model = config.model || process.env.CS_CODEX_MODEL
  const effort = config.effort ? CODEX_EFFORT[config.effort] : null
  const lastMessageFile = path.join(os.tmpdir(), `cs-codex-${context.run.id}.txt`)
  // Coder: workspace-write sandbox (--full-auto). Architect: read-only sandbox.
  const args = ["exec", ...(role === "coder" ? ["--full-auto"] : ["-s", "read-only"]), "--skip-git-repo-check", "-C", cwd, "-o", lastMessageFile]
  if (model) args.push("-m", model)
  if (effort) args.push("-c", `model_reasoning_effort="${effort}"`)
  args.push("-") // read the prompt from stdin

  await log(`$ ${bin} ${args.join(" ")}\n`)
  const { stdout, stderr, code } = await runCommand(bin, args, { cwd, stdin: prompt, log, timeoutMs })
  if (code !== 0) {
    throw new Error(`codex exited with ${code}: ${stderr.slice(-800) || stdout.slice(-800)}`)
  }

  let text = ""
  try {
    text = (await fs.readFile(lastMessageFile, "utf8")).trim()
    await fs.unlink(lastMessageFile).catch(() => {})
  } catch {
    // older codex without -o: fall back to the tail of stdout
    text = stdout.trim().split(/\n{2,}/).pop() ?? ""
  }
  const { reply, actions } = parseReply(text)
  return { reply, actions, summary: reply.slice(0, 300) }
}
